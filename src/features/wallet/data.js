const crypto = require('node:crypto');
const { q, tx } = require('../../../db');
const { UNITS_PER_CREDIT: U, fail } = require('./rules');
const one = async (sql, args) => (await q(sql, args)).rows[0] || null;
const credits = (value) => Number(value) / U;
const paymentOut = (p) => ({ reference: p.reference, credits: credits(p.credit_units), priceKobo: Number(p.price_kobo), subtotalKobo: Number(p.subtotal_kobo ?? p.price_kobo), feeKobo: Number(p.processing_fee_kobo || 0), feePercent: p.fee_percent == null ? 0 : Number(p.fee_percent), displayCurrency: p.display_currency || p.currency, displayTotalMinor: p.display_total_minor == null ? Number(p.price_kobo) : Number(p.display_total_minor), source: p.source || 'checkout', currency: p.currency, status: p.status, createdAt: p.created_at, paidAt: p.paid_at, authorizationUrl: p.authorization_url || null });
const getPayment = (ref) => one('SELECT * FROM credit_payments WHERE reference=$1', [ref]);
async function claimWelcomeNotice(userId) {
  return tx(async (c) => {
    const welcome = (await c.query("SELECT delta_units FROM credit_ledger WHERE user_id=$1 AND kind='welcome' LIMIT 1", [userId])).rows[0];
    if (!welcome) return { show: false };
    const claimed = (await c.query('UPDATE credit_wallets SET welcome_notice_shown_at=NOW() WHERE user_id=$1 AND welcome_notice_shown_at IS NULL RETURNING user_id', [userId])).rows[0];
    return { show: !!claimed, credits: credits(welcome.delta_units) };
  });
}
async function balance(userId) {
  const row = await one('SELECT balance_units FROM credit_wallets WHERE user_id=$1', [userId]);
  return credits(row ? row.balance_units : 0);
}
async function createPayment(user, quote, mode, { source = 'checkout' } = {}) {
  const ref = (source === 'checkout' ? '1v-' : '1va-') + crypto.randomBytes(16).toString('hex');
  // price_kobo is the amount charged: the credits' price plus the processing fee (PROCESSING_FEE_PERCENT).
  const m = await require('../../lib/money').checkoutAmounts(user.id, quote.priceKobo);
  return one(`INSERT INTO credit_payments (reference,user_id,payer_email,credit_units,price_kobo,provider_mode,subtotal_kobo,processing_fee_kobo,fee_percent,display_currency,display_total_minor,fx_rate,source)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`, [ref, user.id, user.email.toLowerCase(), quote.credits * U, m.total, mode, m.subtotal, m.fee, m.percent, m.displayCurrency, m.displayTotal, m.fxRate, source]);
}
async function checkoutReady(ref, url) {
  await q('UPDATE credit_payments SET authorization_url=$2 WHERE reference=$1', [ref, url]);
}
async function mark(ref, status, error = null) {
  await q("UPDATE credit_payments SET status=$2,last_error=$3 WHERE reference=$1 AND status<>'paid'", [ref, status, error]);
}
async function settle(purchase, verified) {
  return tx(async (c) => {
    // Lock the account before the wallet so account deletion and settlement agree on ownership.
    const user = (await c.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [purchase.user_id])).rows[0];
    if (!user) throw fail(409, 'This payment needs support review because its account is unavailable');
    const payment = (await c.query('SELECT * FROM credit_payments WHERE reference=$1 FOR UPDATE', [purchase.reference])).rows[0];
    if (payment.status === 'paid') return paymentOut(payment);
    await require('./billing-data').reconcileLocked(c, user.id);
    await c.query('INSERT INTO credit_wallets(user_id) VALUES ($1) ON CONFLICT DO NOTHING', [user.id]);
    const wallet = (await c.query(`UPDATE credit_wallets SET balance_units=balance_units+$2,updated_at=NOW()
      WHERE user_id=$1 AND balance_units<=$3 RETURNING balance_units`, [user.id, Number(payment.credit_units), Number.MAX_SAFE_INTEGER - Number(payment.credit_units)])).rows[0];
    if (!wallet) throw fail(409, 'This purchase would exceed the wallet balance limit');
    const paid = (await c.query(`UPDATE credit_payments SET status='paid',provider_id=$2,amount_paid_kobo=$3,fee_paid_kobo=$4,paid_at=NOW(),last_error=NULL
      WHERE id=$1 RETURNING *`, [payment.id, String(verified.id), verified.amount, verified.fees])).rows[0];
    await c.query(`INSERT INTO credit_ledger(user_id,payment_id,kind,delta_units,balance_after_units)
      VALUES ($1,$2,'purchase',$3,$4)`, [user.id, payment.id, payment.credit_units, wallet.balance_units]);
    return paymentOut(paid);
  });
}
async function payments(userId, before) {
  if (before != null && (!/^\d{1,15}$/.test(String(before)) || Number(before) < 1)) throw fail(400, 'Invalid purchase page');
  const rows = (await q(`SELECT * FROM credit_payments WHERE user_id=$1 ${before ? 'AND id<$2' : ''} ORDER BY id DESC LIMIT 51`, before ? [userId, before] : [userId])).rows;
  const page = rows.slice(0, 50);
  return { payments: page.map(paymentOut), nextBefore: rows.length > 50 ? String(page[page.length - 1].id) : null };
}
async function history(userId, before) {
  if (before != null && (!/^\d{1,15}$/.test(String(before)) || Number(before) < 1)) throw fail(400, 'Invalid history page');
  const rows = (await q(`WITH usage_entries AS (
      SELECT MAX(l.id) AS id,l.user_id,SUM(l.delta_units) AS delta_units,
        (SELECT latest.balance_after_units FROM credit_ledger latest
          WHERE latest.user_id=l.user_id AND latest.billing_session_id=l.billing_session_id
          ORDER BY latest.id DESC LIMIT 1) AS balance_after_units,
        b.code AS meeting_code,m.name AS meeting_name,MAX(l.created_at) AS created_at
      FROM credit_ledger l JOIN credit_billing_sessions b ON b.id=l.billing_session_id
      LEFT JOIN meeting_history m ON m.id=b.history_id
      WHERE l.user_id=$1 AND l.kind='usage' AND l.billing_session_id IS NOT NULL
      GROUP BY l.user_id,l.billing_session_id,b.code,m.name
    ), history_entries AS (
      SELECT l.id,l.user_id,l.kind,l.delta_units,l.balance_after_units,p.reference,
        NULL AS meeting_code,NULL AS meeting_name,l.created_at
      FROM credit_ledger l LEFT JOIN credit_payments p ON p.id=l.payment_id
      WHERE l.user_id=$1 AND l.kind='purchase'
      UNION ALL
      SELECT id,user_id,'usage',delta_units,balance_after_units,NULL,meeting_code,meeting_name,created_at
      FROM usage_entries
      UNION ALL
      SELECT l.id,l.user_id,l.kind,l.delta_units,l.balance_after_units,NULL,NULL,NULL,l.created_at
      FROM credit_ledger l
      WHERE l.user_id=$1 AND l.kind='welcome'
      UNION ALL
      SELECT l.id,l.user_id,l.kind,l.delta_units,l.balance_after_units,NULL,b.code,m.name,l.created_at
      FROM credit_ledger l JOIN paid_meeting_entries e ON e.id=l.paid_entry_id
      JOIN paid_meeting_sessions b ON b.code=e.code LEFT JOIN meeting_history m ON m.id=b.history_id
      WHERE l.user_id=$1 AND l.kind IN ('entry','entry_refund')
      UNION ALL
      SELECT l.id,l.user_id,l.kind,l.delta_units,l.balance_after_units,NULL,b.code,m.name,l.created_at
      FROM credit_ledger l JOIN paid_meeting_extensions x ON x.id=l.paid_extension_id
      JOIN paid_meeting_sessions b ON b.code=x.code LEFT JOIN meeting_history m ON m.id=b.history_id
      WHERE l.user_id=$1 AND l.kind='extension'
      UNION ALL
      SELECT l.id,l.user_id,l.kind,l.delta_units,l.balance_after_units,NULL,NULL,NULL,l.created_at
      FROM credit_ledger l WHERE l.user_id=$1 AND l.kind='earning_transfer'
      UNION ALL
      SELECT l.id,l.user_id,l.kind,l.delta_units,l.balance_after_units,NULL,b.code,NULL,l.created_at
      FROM credit_ledger l LEFT JOIN credit_billing_sessions b ON b.id=l.billing_session_id
      WHERE l.user_id=$1 AND l.kind='usage' AND l.billing_session_id IS NULL
    )
    SELECT * FROM history_entries ${before ? 'WHERE id<$2' : ''} ORDER BY id DESC LIMIT 31`, before ? [userId, before] : [userId])).rows;
  const page = rows.slice(0, 30);
  return { entries: page.map((r) => ({ id: String(r.id), type: r.kind, credits: credits(r.delta_units), balanceAfter: credits(r.balance_after_units), reference: r.reference, meetingCode: r.meeting_code || null, meetingName: r.meeting_name || null, createdAt: r.created_at })), nextBefore: rows.length > 30 ? String(page[page.length - 1].id) : null };
}
async function assertCanDelete(c, userId) {
  const wallet = (await c.query('SELECT balance_units FROM credit_wallets WHERE user_id=$1', [userId])).rows[0];
  const unsettled = (await c.query("SELECT 1 FROM credit_payments WHERE user_id=$1 AND status IN ('pending','review') LIMIT 1", [userId])).rows[0];
  const active = (await c.query("SELECT id FROM credit_billing_sessions WHERE user_id=$1 AND state<>'closed' LIMIT 1", [userId])).rows[0];
  if (Number(wallet?.balance_units || 0) > 0 || unsettled || active) throw fail(409, 'Resolve your credit balance and unfinished purchases before deleting your account. Please contact support if you need help.');
}
module.exports = { assertCanDelete, balance, claimWelcomeNotice, createPayment, getPayment, checkoutReady, mark, settle, payments, history, paymentOut };
