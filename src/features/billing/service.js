/**
 * Billing: subscription checkout, verification/settlement, renewals with grace, short-link add-ons,
 * admin plan changes. Money rules mirror the credit wallet (src/features/wallet): every grant is
 * re-verified with Paystack, references are unique, provider transaction ids are unique.
 */
const crypto = require('node:crypto');
const { q, tx } = require('../../../db');
const plans = require('../../lib/plans');
const gateway = require('../wallet/paystack');
const fail = (status, message) => Object.assign(new Error(message), { status });
const one = async (sql, args) => (await q(sql, args)).rows[0] || null;
const iso = (d) => (d == null ? null : new Date(d).toISOString());
const DAY = 86400000;

// ---------------------------------------------------------------- shapes
const paymentOut = (p) => ({ reference: p.reference, kind: p.kind, plan: p.plan || null, interval: p.billing_interval || null, slugTier: p.slug_tier || null, venueId: p.venue_id || null,
  priceKobo: Number(p.price_kobo), currency: p.currency, status: p.status, createdAt: p.created_at, paidAt: p.paid_at, authorizationUrl: p.authorization_url || null });
function subOut(sub, now = Date.now()) {
  if (!sub) return null;
  return { plan: sub.plan, effectivePlan: plans.effectivePlan(sub, now), interval: sub.billing_interval, status: sub.status, source: sub.source,
    periodStart: iso(sub.current_period_start), periodEnd: iso(sub.current_period_end), graceUntil: iso(sub.grace_until),
    cancelAtPeriodEnd: !!sub.cancel_at_period_end, pendingPlan: sub.pending_plan || null, pendingInterval: sub.pending_interval || null,
    card: sub.card_last4 ? { last4: sub.card_last4, brand: sub.card_brand || null, exp: sub.card_exp || null } : null,
    autoRenew: !!sub.authorization_code && !sub.cancel_at_period_end && ['active', 'past_due'].includes(sub.status) };
}
const getPayment = (ref) => one('SELECT * FROM billing_payments WHERE reference=$1', [ref]);
async function audit(c, userId, actorId, action, detail) {
  const run = c ? (s, a) => c.query(s, a) : q;
  await run('INSERT INTO plan_audit (user_id, actor_user_id, action, detail) VALUES ($1,$2,$3,$4)', [userId, actorId || null, action, detail ? JSON.stringify(detail) : null]);
}
function notify(userId, title, intro) {
  one('SELECT email, display_name FROM users WHERE id=$1', [userId]).then((u) => {
    if (!u || !u.email) return;
    const config = require('../../config');
    require('../mail/mailer').sendLater('billingNotice', u.email, { name: u.display_name, title, intro, link: new URL('/billing', config.PUBLIC_URL || 'https://1venue.live').href });
  }).catch(() => {});
}

// ---------------------------------------------------------------- checkout
async function createPayment(user, f, mode) {
  const ref = '1vb-' + crypto.randomBytes(16).toString('hex');
  return one(`INSERT INTO billing_payments (reference,user_id,kind,plan,billing_interval,venue_id,slug_tier,payer_email,price_kobo,provider_mode)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`, [ref, user.id, f.kind, f.plan || null, f.interval || null, f.venueId || null, f.slugTier || null, String(user.email).toLowerCase(), f.priceKobo, mode]);
}
function callbackUrl(s) { return new URL('/billing', s.callback).href; }
async function initialize(user, fields) {
  const s = gateway.settings();
  if (!s.enabled) throw fail(503, 'Payments are not available yet');
  if (!user.email) throw fail(400, 'Add an email address to your account before paying');
  if (!Number.isSafeInteger(fields.priceKobo) || fields.priceKobo < 100) throw fail(503, 'This purchase is not available right now');
  const payment = await createPayment(user, fields, s.mode);
  const result = await gateway.call('/transaction/initialize', { email: payment.payer_email, amount: Number(payment.price_kobo), currency: 'NGN', reference: payment.reference, callback_url: callbackUrl(s),
    ...(fields.kind === 'subscription' ? { channels: ['card'] } : {}), // renewals need a reusable card authorization
    metadata: { billing_reference: payment.reference, user_id: String(user.id), kind: fields.kind, plan: fields.plan || null, interval: fields.interval || null, slug_tier: fields.slugTier || null } });
  if (result.reference !== payment.reference) throw fail(502, 'Paystack returned an unexpected payment reference');
  const url = gateway.checkoutUrl(result.authorization_url, s);
  await q('UPDATE billing_payments SET authorization_url=$2 WHERE reference=$1', [payment.reference, url]);
  return { ...paymentOut(payment), authorizationUrl: url };
}
async function startCheckout(user, { plan, interval } = {}) {
  if (!plans.PAID.includes(plan)) throw fail(400, 'Choose Premium or Organisation');
  if (!plans.INTERVALS.includes(interval)) throw fail(400, 'Choose monthly or annual billing');
  const settings = await plans.getSettings();
  const ent = await plans.entitlements(user.id, { settings });
  const sub = ent.subscription;
  if (plans.planRank(plan) < plans.planRank(ent.plan)) throw fail(409, 'To move to a lower plan, schedule the change from Billing. It takes effect at the end of your current period.');
  if (sub && ent.plan === plan && sub.billing_interval === interval && sub.status === 'active' && sub.source === 'paystack') throw fail(409, 'You are already on this plan');
  return initialize(user, { kind: 'subscription', plan, interval, priceKobo: plans.priceFor(settings, plan, interval) });
}
async function startSlugAddon(user, { venueSlug, tier } = {}) {
  if (!['slug3', 'slug2'].includes(tier)) throw fail(400, 'Choose the slug3 or slug2 add-on');
  const venues = require('../venues/data');
  const v = await venues.getVenueBySlug(String(venueSlug || '').toLowerCase());
  if (!v || v.ownerUserId !== user.id) throw fail(404, 'Venue not found');
  if (v.archived) throw fail(403, 'This venue is archived on your current plan');
  const settings = await plans.getSettings();
  const ent = await plans.entitlements(user.id, { settings });
  if (!plans.PAID.includes(ent.plan)) throw fail(403, 'Short links need a Premium or Organisation plan');
  const rank = { none: 0, slug3: 1, slug2: 2 };
  if (rank[v.slugTier] >= rank[tier]) throw fail(409, 'This venue already has that add-on');
  return initialize(user, { kind: 'slug_addon', venueId: v.id, slugTier: tier, priceKobo: settings.slugAddons[tier] });
}

// ---------------------------------------------------------------- verification and settlement
async function mark(ref, status, error = null) {
  await q("UPDATE billing_payments SET status=$2,last_error=$3 WHERE reference=$1 AND status<>'paid'", [ref, status, error]);
}
function validVerified(payment, result) {
  const meta = gateway.metadata(result.metadata);
  const requested = result.requested_amount == null ? result.amount : result.requested_amount;
  const idOk = typeof result.id === 'number' ? Number.isSafeInteger(result.id) && result.id > 0 : typeof result.id === 'string' && /^[1-9]\d{0,29}$/.test(result.id);
  const fees = result.fees == null ? 0 : result.fees;
  return idOk && Number.isSafeInteger(result.amount) && Number.isSafeInteger(fees) && fees >= 0
    && requested === Number(payment.price_kobo) && result.amount - fees >= Number(payment.price_kobo)
    && result.currency === payment.currency && result.domain === payment.provider_mode
    && typeof result.customer?.email === 'string' && result.customer.email.toLowerCase() === payment.payer_email
    && meta.billing_reference === payment.reference && String(meta.user_id) === String(payment.user_id);
}
function reusableCard(result) {
  const a = result && result.authorization;
  if (!a || a.reusable !== true || typeof a.authorization_code !== 'string' || !/^AUTH_[\w-]{4,80}$/.test(a.authorization_code)) return null;
  if (a.channel && a.channel !== 'card') return null;
  const exp = a.exp_month && a.exp_year ? `${String(a.exp_month).padStart(2, '0')}/${String(a.exp_year).slice(-2)}` : null;
  return { code: a.authorization_code, last4: /^\d{4}$/.test(String(a.last4 || '')) ? String(a.last4) : null, brand: a.card_type ? String(a.card_type).trim().slice(0, 30) : null, exp };
}
async function confirm(payment) {
  if (payment.status === 'paid') return paymentOut(payment);
  const result = await gateway.call('/transaction/verify/' + encodeURIComponent(payment.reference));
  if (result.reference !== payment.reference) throw fail(502, 'Paystack returned an unexpected payment reference');
  if (result.status !== 'success') {
    const status = ['failed', 'abandoned', 'reversed'].includes(result.status) ? 'failed' : 'pending';
    await mark(payment.reference, status, status === 'failed' ? String(result.gateway_response || result.status).slice(0, 200) : null);
    return { ...paymentOut(payment), status };
  }
  if (!validVerified(payment, result)) {
    await mark(payment.reference, 'review', 'verification_mismatch');
    throw fail(409, 'The verified payment details do not match this purchase. Your plan was not changed.');
  }
  try { return await settle(payment, result); }
  catch (e) {
    if (e.code === '23505') { await mark(payment.reference, 'review', 'duplicate_provider_transaction'); throw fail(409, 'This transaction has already been assigned to another purchase'); }
    throw e;
  }
}
async function settle(purchase, verified, now = new Date()) {
  const card = reusableCard(verified);
  const out = await tx(async (c) => {
    const user = (await c.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [purchase.user_id])).rows[0];
    if (!user) throw fail(409, 'This payment needs support review because its account is unavailable');
    const p = (await c.query('SELECT * FROM billing_payments WHERE reference=$1 FOR UPDATE', [purchase.reference])).rows[0];
    if (p.status === 'paid') return { payment: p, plan: null };
    const paid = (await c.query(`UPDATE billing_payments SET status='paid',provider_id=$2,amount_paid_kobo=$3,fee_paid_kobo=$4,paid_at=NOW(),last_error=NULL WHERE id=$1 RETURNING *`,
      [p.id, String(verified.id), verified.amount, verified.fees || 0])).rows[0];
    const authSet = card ? ', authorization_code=$9, card_last4=$10, card_brand=$11, card_exp=$12, auth_email=$13' : '';
    const authArgs = card ? [card.code, card.last4, card.brand, card.exp, p.payer_email] : [];
    if (p.kind === 'subscription' || p.kind === 'renewal') {
      const sub = (await c.query('SELECT * FROM subscriptions WHERE user_id=$1 FOR UPDATE', [user.id])).rows[0];
      let start = now;
      // Renewals continue from the old period end unless the plan already expired; an upgrade or new plan starts fresh.
      if (p.kind === 'renewal' && sub && sub.current_period_end && sub.status !== 'expired') start = new Date(sub.current_period_end);
      const end = plans.addInterval(start, p.billing_interval);
      const args = [user.id, p.plan, p.billing_interval, start, end, p.kind === 'renewal' ? (sub && sub.source) || 'paystack' : 'paystack', now, now, ...authArgs];
      if (sub) await c.query(`UPDATE subscriptions SET plan=$2, billing_interval=$3, status='active', source=$6, current_period_start=$4, current_period_end=$5, grace_until=NULL,
          cancel_at_period_end=FALSE, pending_plan=NULL, pending_interval=NULL, renew_attempts=0, last_attempt_at=$7, updated_at=$8${authSet} WHERE user_id=$1`, args);
      else await c.query(`INSERT INTO subscriptions (user_id, plan, billing_interval, status, source, current_period_start, current_period_end, last_attempt_at, updated_at${card ? ', authorization_code, card_last4, card_brand, card_exp, auth_email' : ''})
          VALUES ($1,$2,$3,'active',$6,$4,$5,$7,$8${card ? ',$9,$10,$11,$12,$13' : ''})`, args);
      await c.query('UPDATE users SET plan=$2 WHERE id=$1', [user.id, p.plan]);
      await c.query('INSERT INTO plan_audit (user_id, actor_user_id, action, detail) VALUES ($1,NULL,$2,$3)', [user.id, p.kind === 'renewal' ? 'renewed' : 'subscribed', JSON.stringify({ plan: p.plan, interval: p.billing_interval, reference: p.reference, until: end.toISOString() })]);
      return { payment: paid, plan: p.plan };
    }
    if (p.kind === 'slug_addon') {
      const r = await c.query("UPDATE venues SET slug_tier=$3 WHERE id=$1 AND owner_user_id=$2 AND (slug_tier='none' OR $3='slug2')", [p.venue_id, user.id, p.slug_tier]);
      if (!r.rowCount) await c.query("UPDATE billing_payments SET last_error='venue_unavailable' WHERE id=$1", [p.id]);
      await c.query('INSERT INTO plan_audit (user_id, actor_user_id, action, detail) VALUES ($1,NULL,$2,$3)', [user.id, 'slug_addon', JSON.stringify({ venueId: p.venue_id, tier: p.slug_tier, reference: p.reference })]);
    }
    return { payment: paid, plan: null };
  });
  if (out.plan) await syncVenues(purchase.user_id).catch((e) => console.warn('[billing] venue sync', e.message));
  return paymentOut(out.payment);
}
/** Re-apply the current plan to the user's venues (archive extras or restore them, park/restore clean links). */
async function syncVenues(userId) {
  try { require('../../lib/auth').forgetUser(userId); } catch (_) {} // session payload carries users.plan
  const ent = await plans.entitlements(userId);
  return require('../venues/data').applyPlanToVenues(userId, ent.plan, ent.limits.venues);
}

// ---------------------------------------------------------------- renewals, grace and expiry
async function claim(subId, now) {
  const r = await q('UPDATE subscriptions SET locked_until=$2 WHERE id=$1 AND (locked_until IS NULL OR locked_until < $3)', [subId, new Date(now.getTime() + 5 * 60000), now]);
  return r.rowCount === 1;
}
const release = (subId) => q('UPDATE subscriptions SET locked_until=NULL WHERE id=$1', [subId]);
async function expire(sub, reason, actorId = null) {
  await q("UPDATE subscriptions SET status='expired', grace_until=NULL, cancel_at_period_end=FALSE, pending_plan=NULL, pending_interval=NULL, updated_at=NOW() WHERE id=$1", [sub.id]);
  await q("UPDATE users SET plan='free' WHERE id=$1", [sub.user_id]);
  const changes = await syncVenues(sub.user_id);
  await audit(null, sub.user_id, actorId, 'expired', { from: sub.plan, reason, ...changes });
  if (!actorId) notify(sub.user_id, 'Your plan has ended', `Your ${sub.plan} plan has ended and your account is now on Free. Extra venues were archived, not deleted, and come back when you upgrade again.`);
  return 'expired';
}
async function renewalFailed(sub, now, settings, why) {
  const graceUntil = sub.grace_until ? new Date(sub.grace_until) : new Date(new Date(sub.current_period_end).getTime() + settings.graceDays * DAY);
  await q("UPDATE subscriptions SET status='past_due', grace_until=$2, renew_attempts=renew_attempts+1, last_attempt_at=$3, updated_at=NOW() WHERE id=$1", [sub.id, graceUntil, now]);
  if (!sub.renew_attempts) {
    await audit(null, sub.user_id, null, 'renewal_failed', { reason: why, graceUntil: graceUntil.toISOString() });
    notify(sub.user_id, 'We could not renew your plan', `We could not charge your saved card for your ${sub.plan} plan. You keep your plan until ${graceUntil.toUTCString()}. Pay from the Billing page to keep it.`);
  }
  return 'grace';
}
/** Decide and act on one due subscription. Returns what happened (for tests and logs). */
async function handleDue(sub, now = new Date(), settings) {
  settings = settings || await plans.getSettings();
  const end = new Date(sub.current_period_end);
  if (end > now) return 'not_due';
  if (sub.status === 'comp') return expire(sub, 'admin_grant_ended');
  if (sub.status === 'cancelled' || sub.cancel_at_period_end || sub.pending_plan === 'free') return expire(sub, 'cancelled');
  if (sub.grace_until && new Date(sub.grace_until) <= now) return expire(sub, 'grace_ended');
  if (sub.last_attempt_at && now - new Date(sub.last_attempt_at) < 20 * 3600000 && sub.status === 'past_due') return 'waiting';
  if (!sub.authorization_code) return renewalFailed(sub, now, settings, 'no_saved_card');
  const plan = plans.PAID.includes(sub.pending_plan) ? sub.pending_plan : sub.plan;
  const interval = sub.pending_interval || sub.billing_interval;
  const priceKobo = plans.priceFor(settings, plan, interval);
  let s;
  try { s = gateway.settings(); } catch (_) { s = null; }
  if (!s || !s.enabled) return 'payments_disabled'; // retry next tick; grace clock is not started without an attempt
  const user = await one('SELECT id, email FROM users WHERE id=$1', [sub.user_id]);
  if (!user) return 'no_user';
  const payment = await createPayment({ id: user.id, email: sub.auth_email || user.email }, { kind: 'renewal', plan, interval, priceKobo }, s.mode);
  const res = await gateway.call('/transaction/charge_authorization', { email: payment.payer_email, amount: Number(payment.price_kobo), currency: 'NGN', authorization_code: sub.authorization_code, reference: payment.reference,
    metadata: { billing_reference: payment.reference, user_id: String(user.id), kind: 'renewal', plan, interval } }, { raw: true });
  if (res.ok && res.data && res.data.status === 'success') {
    try {
      const out = await confirm(payment);
      if (out.status === 'paid') return 'renewed';
    } catch (e) { if (e.status !== 409) throw e; return renewalFailed(sub, now, settings, 'verification_mismatch'); }
  }
  if (res.ok && res.data && ['pending', 'ongoing', 'processing'].includes(res.data.status)) {
    await q('UPDATE subscriptions SET last_attempt_at=$2 WHERE id=$1', [sub.id, now]);
    return 'pending';
  }
  await mark(payment.reference, 'failed', (res.data && res.data.gateway_response) || res.message || 'declined');
  return renewalFailed(sub, now, settings, (res.data && res.data.gateway_response) || res.message || 'declined');
}
async function processDue(now = new Date()) {
  const settings = await plans.getSettings();
  const rows = (await q("SELECT * FROM subscriptions WHERE status IN ('active','past_due','cancelled','comp') AND current_period_end IS NOT NULL AND current_period_end <= $1 ORDER BY current_period_end LIMIT 100", [now])).rows;
  const results = [];
  for (const sub of rows) {
    if (!(await claim(sub.id, now))) continue;
    try { results.push({ userId: sub.user_id, result: await handleDue(sub, now, settings) }); }
    catch (e) { console.error('[billing] renewal', sub.id, e.status || e.code || e.message); results.push({ userId: sub.user_id, result: 'error' }); }
    finally { await release(sub.id).catch(() => {}); }
  }
  return results;
}
let timer = null;
function startWorker() {
  if (timer || process.env.BILLING_WORKER === 'false') return null;
  const every = Math.max(60000, Number(process.env.BILLING_RENEW_INTERVAL_MS) || 10 * 60000);
  timer = setInterval(() => { processDue().catch((e) => console.error('[billing] worker', e.message)); }, every);
  timer.unref();
  return timer;
}

// ---------------------------------------------------------------- self-serve changes
async function cancel(userId, on = true) {
  const sub = await plans.subscriptionOf(userId);
  if (!sub || !['active', 'past_due'].includes(sub.status)) throw fail(409, 'You have no renewing plan');
  await q('UPDATE subscriptions SET cancel_at_period_end=$2, pending_plan=NULL, pending_interval=NULL, updated_at=NOW() WHERE id=$1', [sub.id, !!on]);
  await audit(null, userId, userId, on ? 'cancel_at_period_end' : 'resume', null);
  return subOut(await plans.subscriptionOf(userId));
}
/** Downgrades and interval switches take effect at period end (no proration). */
async function scheduleChange(userId, { plan, interval } = {}) {
  const sub = await plans.subscriptionOf(userId);
  if (!sub || !['active', 'past_due'].includes(sub.status)) throw fail(409, 'You have no renewing plan to change');
  if (plan === 'free') return cancel(userId, true);
  if (!plans.PAID.includes(plan) || !plans.INTERVALS.includes(interval)) throw fail(400, 'Choose a plan and billing interval');
  if (plans.planRank(plan) > plans.planRank(sub.plan)) throw fail(409, 'Upgrades start straight away. Use Upgrade to pay for the new plan.');
  const same = plan === sub.plan && interval === sub.billing_interval;
  await q('UPDATE subscriptions SET pending_plan=$2, pending_interval=$3, cancel_at_period_end=FALSE, updated_at=NOW() WHERE id=$1', [sub.id, same ? null : plan, same ? null : interval]);
  await audit(null, userId, userId, 'scheduled_change', { plan, interval });
  return subOut(await plans.subscriptionOf(userId));
}

// ---------------------------------------------------------------- admin
async function adminSetPlan(actorId, userId, { plan, periodEnd, overrides, reason } = {}) {
  const target = await one('SELECT id FROM users WHERE id=$1', [userId]);
  if (!target) throw fail(404, 'User not found');
  if (overrides !== undefined) {
    const clean = overrides ? plans.parseOverrides(overrides) : null;
    await q('UPDATE users SET plan_overrides=$2 WHERE id=$1', [userId, clean && Object.keys(clean).length ? JSON.stringify(clean) : null]);
    await audit(null, userId, actorId, 'overrides', { overrides: clean, reason: reason || null });
  }
  if (plan !== undefined) {
    if (!plans.PLAN_IDS.includes(plan)) throw fail(400, 'Unknown plan');
    const sub = await plans.subscriptionOf(userId);
    if (plan === 'free') {
      if (sub && sub.status !== 'expired') await expire(sub, reason || 'admin', actorId);
      else await q("UPDATE users SET plan='free' WHERE id=$1", [userId]);
    } else {
      const end = periodEnd ? new Date(periodEnd) : null;
      if (end && (Number.isNaN(end.getTime()) || end <= new Date())) throw fail(400, 'The end date must be in the future');
      const now = new Date();
      if (sub) await q(`UPDATE subscriptions SET plan=$2, status='comp', source='admin', current_period_start=$3, current_period_end=$4, grace_until=NULL, cancel_at_period_end=FALSE,
          pending_plan=NULL, pending_interval=NULL, renew_attempts=0, updated_at=NOW() WHERE user_id=$1`, [userId, plan, now, end]);
      else await q(`INSERT INTO subscriptions (user_id, plan, billing_interval, status, source, current_period_start, current_period_end) VALUES ($1,$2,'month','comp','admin',$3,$4)`, [userId, plan, now, end]);
      await q('UPDATE users SET plan=$2 WHERE id=$1', [userId, plan]);
      await audit(null, userId, actorId, 'admin_plan', { plan, until: end ? end.toISOString() : null, reason: reason || null, previous: sub ? sub.plan + '/' + sub.status : 'free' });
    }
  }
  await syncVenues(userId);
  return adminUser(userId);
}
async function adminSetVenueTier(actorId, venueId, tier, reason) {
  if (!plans.SLUG_TIERS.includes(tier)) throw fail(400, 'Unknown slug tier');
  const v = await require('../venues/data').setVenueSlugTier(venueId, tier);
  if (!v) throw fail(404, 'Venue not found');
  await audit(null, v.ownerUserId, actorId, 'admin_slug_tier', { venueId, tier, reason: reason || null });
  return v;
}
async function adminSearch(term) {
  const t = String(term || '').trim().toLowerCase().replace(/^@/, '').slice(0, 80);
  const rows = (await q(`SELECT u.id, u.email, u.username, u.display_name, u.plan, s.status, s.current_period_end FROM users u LEFT JOIN subscriptions s ON s.user_id=u.id
    WHERE ($1='' OR lower(u.email) LIKE $2 OR lower(COALESCE(u.username,'')) LIKE $2 OR lower(COALESCE(u.display_name,'')) LIKE $2) ORDER BY u.id DESC LIMIT 25`, [t, `%${t.replace(/[%_\\]/g, '')}%`])).rows;
  return rows.map((r) => ({ id: r.id, email: r.email, username: r.username, name: r.display_name, plan: r.plan, status: r.status || null, periodEnd: iso(r.current_period_end) }));
}
async function adminUser(userId) {
  const u = await one('SELECT id, email, username, display_name FROM users WHERE id=$1', [userId]);
  if (!u) throw fail(404, 'User not found');
  const ent = await plans.entitlements(userId);
  const [payments, auditRows, venueRows] = await Promise.all([
    q('SELECT * FROM billing_payments WHERE user_id=$1 ORDER BY id DESC LIMIT 30', [userId]),
    q('SELECT * FROM plan_audit WHERE user_id=$1 ORDER BY id DESC LIMIT 30', [userId]),
    q('SELECT id, slug, name, slug_tier, reserved_slug, archived_at FROM venues WHERE owner_user_id=$1 ORDER BY created_at', [userId]),
  ]);
  return { user: { id: u.id, email: u.email, username: u.username, name: u.display_name }, plan: ent.plan, limits: ent.limits, overrides: ent.overrides, subscription: subOut(ent.subscription),
    payments: payments.rows.map(paymentOut), audit: auditRows.rows.map((r) => ({ action: r.action, actorId: r.actor_user_id, detail: r.detail ? JSON.parse(r.detail) : null, at: r.created_at })),
    venues: venueRows.rows.map((v) => ({ id: v.id, slug: v.slug, name: v.name, slugTier: v.slug_tier, reservedSlug: v.reserved_slug, archived: !!v.archived_at })) };
}

// ---------------------------------------------------------------- summaries
async function summary(userId) {
  const settings = await plans.getSettings();
  const ent = await plans.entitlements(userId, { settings });
  const [venues, aiUsed, payments] = await Promise.all([
    require('../venues/data').activeVenueCount(userId), plans.aiUsed(userId),
    q('SELECT * FROM billing_payments WHERE user_id=$1 ORDER BY id DESC LIMIT 50', [userId]),
  ]);
  return { plan: ent.plan, limits: ent.limits, usage: { venues, aiUsed, aiLeft: Math.max(0, ent.limits.aiDaily - aiUsed) }, subscription: subOut(ent.subscription),
    payments: payments.rows.map(paymentOut), purchasesEnabled: gateway.enabled() };
}
async function publicPlans() {
  const s = await plans.getSettings();
  return { currency: 'NGN', plans: plans.PLAN_IDS.map((id) => ({ id, ...plans.limitsFor(s, id), priceMonthKobo: s.plans[id].priceMonthKobo, priceYearKobo: s.plans[id].priceYearKobo })),
    aiWeights: s.aiWeights, slugAddons: s.slugAddons, graceDays: s.graceDays, purchasesEnabled: gateway.enabled() };
}
async function assertCanDelete(c, userId) {
  const unsettled = (await c.query("SELECT 1 FROM billing_payments WHERE user_id=$1 AND status IN ('pending','review') AND kind<>'renewal' LIMIT 1", [userId])).rows[0];
  if (unsettled) throw fail(409, 'Finish or cancel your unfinished plan payments before deleting your account. Please contact support if you need help.');
}

module.exports = { paymentOut, subOut, getPayment, startCheckout, startSlugAddon, confirm, settle, syncVenues, handleDue, processDue, startWorker, cancel, scheduleChange,
  adminSetPlan, adminSetVenueTier, adminSearch, adminUser, summary, publicPlans, assertCanDelete, reusableCard, validVerified, expire };
