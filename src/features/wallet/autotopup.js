/**
 * Credit auto top-up (for accounts without a paid plan).
 *
 * Settings live in auto_topups (one row per user). The card is never seen by 1venue: the person buys
 * the top-up pack once through the gateway's hosted checkout ("Add card"); on success we keep only the
 * gateway's reusable authorization token + last4/brand/expiry for display.
 *
 * After every wallet debit (billing-data settle) maybeAfterDebit() runs. A top-up happens when:
 *   enabled, a saved card, balance < threshold, not a subscriber, this month's auto top-ups + pack <= cap,
 *   and no other top-up is running for the user (single-flight claim on running_ref: an UPDATE ... WHERE
 *   running_ref IS NULL, so two servers / two ticks can never both charge).
 * The charge is charge_authorization for pack price + processing fee, then the normal verify + settle
 * (credit_payments.source = 'auto_topup', unique reference, provider id unique), so it is a purchase like
 * any other. AUTO_TOPUP_MAX_FAILURES failed charges in a row (default 3) turn it off and email the user.
 */
const crypto = require('node:crypto');
const { q } = require('../../../db');
const config = require('../../config');
const data = require('./data');
const gateway = require('./paystack');
const { quote, UNITS_PER_CREDIT: U, fail } = require('./rules');

const one = async (sql, args) => (await q(sql, args)).rows[0] || null;
const maxFailures = () => Math.max(1, Number(process.env.AUTO_TOPUP_MAX_FAILURES) || 3);
const retryMs = () => Math.max(0, Number(process.env.AUTO_TOPUP_RETRY_MS ?? 3600000));
const STALE_MS = 10 * 60000; // a claim older than this belongs to a crashed run
const iso = (d) => (d == null ? null : new Date(d).toISOString());

function out(r, extra = {}) {
  const row = r || {};
  return {
    enabled: !!Number(row.enabled || 0), thresholdCredits: Number(row.threshold_credits || 20), packCredits: Number(row.pack_credits || 60), monthlyCapCredits: Number(row.monthly_cap_credits || 240),
    card: row.authorization_code ? { last4: row.card_last4 || null, brand: row.card_brand || null, exp: row.card_exp || null } : null,
    failures: Number(row.failures || 0), lastRunAt: iso(row.last_run_at), lastStatus: row.last_status || null, lastError: row.last_error || null, lastReference: row.last_reference || null, ...extra,
  };
}
async function isSubscriber(userId) {
  const plans = require('../../lib/plans');
  const ent = await plans.entitlements(userId);
  return plans.PAID.includes(ent.plan);
}
async function monthUsedUnits(userId, now = new Date()) {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const r = await one("SELECT COALESCE(SUM(credit_units),0) AS n FROM credit_payments WHERE user_id=$1 AND source='auto_topup' AND status IN ('paid','pending','review') AND created_at >= $2", [userId, start]);
  return Number(r ? r.n : 0);
}
async function get(userId) {
  const row = await one('SELECT * FROM auto_topups WHERE user_id=$1', [userId]);
  const subscriber = await isSubscriber(userId);
  const used = await monthUsedUnits(userId);
  return out(row, { subscriber, usedThisMonthCredits: used / U, packQuote: quote(Number(row?.pack_credits || 60)), purchasesEnabled: gateway.enabled() });
}
const intIn = (v, lo, hi, what) => { const n = Number(v); if (!Number.isSafeInteger(n) || n < lo || n > hi) throw fail(400, `${what} must be a whole number from ${lo} to ${hi}`); return n; };
async function save(userId, body = {}) {
  if (await isSubscriber(userId)) throw fail(409, 'Your plan covers meeting time, so auto top-up is not needed');
  const cur = await one('SELECT * FROM auto_topups WHERE user_id=$1', [userId]);
  const threshold = body.thresholdCredits == null ? Number(cur?.threshold_credits || 20) : intIn(body.thresholdCredits, 1, 100000, 'The threshold');
  const pack = body.packCredits == null ? Number(cur?.pack_credits || 60) : intIn(body.packCredits, 1, 100000, 'The top-up amount');
  const cap = body.monthlyCapCredits == null ? Number(cur?.monthly_cap_credits || 240) : intIn(body.monthlyCapCredits, 1, 1000000, 'The monthly cap');
  if (cap < pack) throw fail(400, 'The monthly cap must be at least one top-up');
  quote(pack);
  const enabled = body.enabled == null ? Number(cur?.enabled || 0) : body.enabled ? 1 : 0;
  if (enabled && !cur?.authorization_code) throw fail(409, 'Add a card first');
  await q(`INSERT INTO auto_topups (user_id, enabled, threshold_credits, pack_credits, monthly_cap_credits, failures, updated_at) VALUES ($1,$2,$3,$4,$5,0,NOW())
    ON CONFLICT (user_id) DO UPDATE SET enabled=EXCLUDED.enabled, threshold_credits=EXCLUDED.threshold_credits, pack_credits=EXCLUDED.pack_credits, monthly_cap_credits=EXCLUDED.monthly_cap_credits,
      failures=CASE WHEN EXCLUDED.enabled=1 AND auto_topups.enabled=0 THEN 0 ELSE auto_topups.failures END, updated_at=NOW()`, [userId, enabled, threshold, pack, cap]);
  return get(userId);
}
/** "Add card": buy the pack once through hosted checkout; the reusable token is kept on success. */
async function startCardSetup(user) {
  if (await isSubscriber(user.id)) throw fail(409, 'Your plan covers meeting time, so auto top-up is not needed');
  const cur = await one('SELECT pack_credits FROM auto_topups WHERE user_id=$1', [user.id]);
  return gateway.initialize(user, Number(cur?.pack_credits || 60), { source: 'auto_topup_setup' });
}
async function removeCard(userId) {
  await q("UPDATE auto_topups SET enabled=0, authorization_code=NULL, card_last4=NULL, card_brand=NULL, card_exp=NULL, auth_email=NULL, updated_at=NOW() WHERE user_id=$1", [userId]);
  return get(userId);
}
function reusableCard(result) {
  const a = result && result.authorization;
  if (!a || a.reusable !== true || typeof a.authorization_code !== 'string' || !/^AUTH_[\w-]{4,80}$/.test(a.authorization_code)) return null;
  if (a.channel && a.channel !== 'card') return null;
  const exp = a.exp_month && a.exp_year ? `${String(a.exp_month).padStart(2, '0')}/${String(a.exp_year).slice(-2)}` : null;
  return { code: a.authorization_code, last4: /^\d{4}$/.test(String(a.last4 || '')) ? String(a.last4) : null, brand: a.card_type ? String(a.card_type).trim().slice(0, 30) : null, exp };
}
async function saveCardFrom(payment, verified) {
  const card = reusableCard(verified);
  if (!card) return false;
  await q(`INSERT INTO auto_topups (user_id, enabled, authorization_code, card_last4, card_brand, card_exp, auth_email, failures, last_status, updated_at) VALUES ($1,1,$2,$3,$4,$5,$6,0,'card_saved',NOW())
    ON CONFLICT (user_id) DO UPDATE SET enabled=1, authorization_code=EXCLUDED.authorization_code, card_last4=EXCLUDED.card_last4, card_brand=EXCLUDED.card_brand, card_exp=EXCLUDED.card_exp, auth_email=EXCLUDED.auth_email, failures=0, last_status='card_saved', last_error=NULL, updated_at=NOW()`,
  [payment.user_id, card.code, card.last4, card.brand, card.exp, verified.customer?.email ? String(verified.customer.email).toLowerCase() : payment.payer_email]);
  return true;
}
function notify(userId, title, intro) {
  one('SELECT email, display_name FROM users WHERE id=$1', [userId]).then((u) => {
    if (!u || !u.email) return;
    require('../mail/mailer').sendLater('walletNotice', u.email, { name: u.display_name, title, intro, link: new URL('/wallet', config.PUBLIC_URL || 'https://1venue.live').href });
  }).catch(() => {});
}
async function claim(userId, now) {
  const ref = 'run-' + crypto.randomBytes(8).toString('hex');
  const r = await one(`UPDATE auto_topups SET running_ref=$2, running_since_ms=$3 WHERE user_id=$1 AND enabled=1 AND authorization_code IS NOT NULL
    AND (running_ref IS NULL OR running_since_ms < $4) RETURNING *`, [userId, ref, now, now - STALE_MS]);
  return r && r.running_ref === ref ? r : null;
}
async function finish(userId, ref, fields) {
  const sets = Object.keys(fields).map((k, i) => `${k}=$${i + 3}`).join(', ');
  await q(`UPDATE auto_topups SET running_ref=NULL, running_since_ms=NULL${sets ? ', ' + sets : ''}, updated_at=NOW() WHERE user_id=$1 AND running_ref=$2`, [userId, ref, ...Object.values(fields)]);
}
/** One attempt. Returns a short status string (for tests and logs). */
async function run(userId, { now = Date.now() } = {}) {
  const row = await claim(userId, now);
  if (!row) return 'busy_or_off';
  const ref = row.running_ref;
  try {
    if (row.last_status === 'failed' && row.last_run_at && now - new Date(row.last_run_at).getTime() < retryMs()) { await finish(userId, ref, {}); return 'retry_later'; }
    if (await isSubscriber(userId)) { await finish(userId, ref, { last_status: 'subscriber' }); return 'subscriber'; }
    const bal = Number((await one('SELECT balance_units FROM credit_wallets WHERE user_id=$1', [userId]))?.balance_units || 0);
    if (bal >= Number(row.threshold_credits) * U) { await finish(userId, ref, {}); return 'not_needed'; }
    const pack = Number(row.pack_credits);
    if ((await monthUsedUnits(userId, new Date(now))) + pack * U > Number(row.monthly_cap_credits) * U) {
      if (row.last_status !== 'cap_reached') notify(userId, 'Auto top-up paused for this month', `Your monthly auto top-up cap of ${row.monthly_cap_credits} credits is reached. Top up from your wallet, or raise the cap in Settings.`);
      await finish(userId, ref, { last_status: 'cap_reached', last_run_at: new Date(now) });
      return 'cap_reached';
    }
    let s; try { s = gateway.settings(); } catch { s = null; }
    if (!s || !s.enabled) { await finish(userId, ref, {}); return 'payments_disabled'; }
    const user = await one('SELECT id, email FROM users WHERE id=$1', [userId]);
    if (!user) { await finish(userId, ref, {}); return 'no_user'; }
    const payment = await data.createPayment({ id: user.id, email: row.auth_email || user.email }, quote(pack), s.mode, { source: 'auto_topup' });
    const res = await gateway.call('/transaction/charge_authorization', { email: payment.payer_email, amount: Number(payment.price_kobo), currency: 'NGN', authorization_code: row.authorization_code, reference: payment.reference,
      metadata: { wallet_reference: payment.reference, user_id: String(user.id), kind: 'auto_topup', subtotal_kobo: payment.subtotal_kobo, processing_fee_kobo: payment.processing_fee_kobo } }, { raw: true });
    if (res.ok && res.data && res.data.status === 'success') {
      let paid = null;
      try { paid = await gateway.confirm(payment); } catch (e) { if (e.status !== 409) throw e; }
      if (paid && paid.status === 'paid') {
        await finish(userId, ref, { failures: 0, last_status: 'paid', last_error: null, last_run_at: new Date(now), last_reference: payment.reference });
        notify(userId, `Auto top-up: ${pack} credits added`, `Your balance fell below ${row.threshold_credits} credits, so we added ${pack} credits and charged your saved card (reference ${payment.reference}).`);
        return 'paid';
      }
    } else if (res.ok && res.data && ['pending', 'ongoing', 'processing'].includes(res.data.status)) {
      await finish(userId, ref, { last_status: 'pending', last_run_at: new Date(now), last_reference: payment.reference });
      return 'pending';
    }
    const why = String((res.data && res.data.gateway_response) || res.message || 'declined').slice(0, 200);
    await data.mark(payment.reference, 'failed', why);
    const failures = Number(row.failures || 0) + 1;
    const off = failures >= maxFailures();
    await finish(userId, ref, { failures, last_status: 'failed', last_error: why, last_run_at: new Date(now), last_reference: payment.reference, ...(off ? { enabled: 0 } : {}) });
    notify(userId, off ? 'Auto top-up turned off' : 'Auto top-up failed', off ? `We could not charge your saved card ${failures} times in a row (${why}), so auto top-up is now off. Check your card and turn it back on in Settings.` : `We could not charge your saved card (${why}). We will try again later.`);
    return off ? 'disabled' : 'failed';
  } catch (e) {
    await finish(userId, ref, { last_status: 'error', last_error: String(e.message || 'error').slice(0, 200), last_run_at: new Date(now) }).catch(() => {});
    throw e;
  }
}
const inflight = new Set();
/** Cheap check after a debit; the real work runs off the request path. */
function maybeAfterDebit(userId, balanceUnits) {
  if (!userId || inflight.has(userId) || process.env.AUTO_TOPUP === 'false') return;
  inflight.add(userId);
  setImmediate(async () => {
    try {
      const row = await one('SELECT enabled, threshold_credits, authorization_code FROM auto_topups WHERE user_id=$1', [userId]);
      if (!row || !Number(row.enabled) || !row.authorization_code) return;
      if (balanceUnits != null && balanceUnits >= Number(row.threshold_credits) * U) return;
      await run(userId);
    } catch (e) { console.error('[autotopup]', userId, e.status || e.code || e.message); }
    finally { inflight.delete(userId); }
  });
}
module.exports = { get, save, startCardSetup, removeCard, saveCardFrom, reusableCard, run, maybeAfterDebit, monthUsedUnits };
