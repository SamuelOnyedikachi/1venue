/**
 * Debit or credit a wallet, spending plan credits first, then purchased credits.
 * Plan credits are granted monthly and unused ones expire at the next grant.
 * Purchased / welcome credits never expire.
 */
const rates = require('./rates');
const { UNITS_PER_CREDIT: U, fail } = require('./rules');

const credits = (units) => Number(units || 0) / U;

function addMonth(from) {
  return require('../../lib/plans').addInterval(from, 'month');
}

async function lockWallet(c, userId) {
  if (!(await c.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [userId])).rows[0]) {
    throw fail(409, 'Billing account is unavailable');
  }
  await c.query('INSERT INTO credit_wallets(user_id) VALUES($1) ON CONFLICT DO NOTHING', [userId]);
  return (await c.query('SELECT * FROM credit_wallets WHERE user_id=$1 FOR UPDATE', [userId])).rows[0];
}

function snapshot(row) {
  const balance = Number(row?.balance_units || 0);
  const plan = Math.min(balance, Math.max(0, Number(row?.plan_balance_units || 0)));
  const purchased = Math.max(0, balance - plan);
  const grant = Number(row?.plan_grant_units || 0);
  const used = Number(row?.period_used_units || 0);
  return {
    balanceUnits: balance,
    planUnits: plan,
    purchasedUnits: purchased,
    planGrantUnits: grant,
    periodUsedUnits: used,
    planPeriodStart: row?.plan_period_start || null,
    planPeriodEnd: row?.plan_period_end || null,
    balanceCredits: credits(balance),
    planCredits: credits(plan),
    purchasedCredits: credits(purchased),
    planGrantCredits: credits(grant),
    usedThisPeriodCredits: credits(used),
  };
}

async function expirePlanLocked(c, row, now, reason = 'plan_expire') {
  const leftover = Math.max(0, Number(row.plan_balance_units || 0));
  if (!leftover) {
    await c.query('UPDATE credit_wallets SET plan_balance_units=0, plan_grant_units=0, plan_period_start=NULL, plan_period_end=NULL, period_used_units=0, updated_at=NOW() WHERE user_id=$1', [row.user_id]);
    return { ...row, plan_balance_units: 0, plan_grant_units: 0, plan_period_start: null, plan_period_end: null, period_used_units: 0 };
  }
  const nextBal = Math.max(0, Number(row.balance_units) - leftover);
  await c.query('UPDATE credit_wallets SET balance_units=$2, plan_balance_units=0, plan_grant_units=0, plan_period_start=NULL, plan_period_end=NULL, period_used_units=0, updated_at=NOW() WHERE user_id=$1', [row.user_id, nextBal]);
  await c.query("INSERT INTO credit_ledger(user_id,kind,delta_units,balance_after_units) VALUES($1,$2,$3,$4)", [row.user_id, reason, -leftover, nextBal]);
  return { ...row, balance_units: nextBal, plan_balance_units: 0, plan_grant_units: 0, plan_period_start: null, plan_period_end: null, period_used_units: 0 };
}

async function grantPlanLocked(c, row, grantUnits, now) {
  const start = now instanceof Date ? now : new Date(now);
  const end = addMonth(start);
  const leftover = Math.max(0, Number(row.plan_balance_units || 0));
  const afterExpire = Math.max(0, Number(row.balance_units) - leftover);
  if (leftover) {
    await c.query("INSERT INTO credit_ledger(user_id,kind,delta_units,balance_after_units) VALUES($1,'plan_expire',$2,$3)", [row.user_id, -leftover, afterExpire]);
  }
  const nextBal = afterExpire + grantUnits;
  await c.query(`UPDATE credit_wallets SET balance_units=$2, plan_balance_units=$3, plan_grant_units=$3,
    plan_period_start=$4, plan_period_end=$5, period_used_units=0, updated_at=NOW() WHERE user_id=$1`,
    [row.user_id, nextBal, grantUnits, start.toISOString(), end.toISOString()]);
  if (grantUnits) {
    await c.query("INSERT INTO credit_ledger(user_id,kind,delta_units,balance_after_units) VALUES($1,'plan_grant',$2,$3)", [row.user_id, grantUnits, nextBal]);
  }
  return { ...row, balance_units: nextBal, plan_balance_units: grantUnits, plan_grant_units: grantUnits, plan_period_start: start, plan_period_end: end, period_used_units: 0 };
}

/** Refresh monthly plan credits if the period has ended (or the person just subscribed). */
async function syncPlanLocked(c, userId, now = new Date()) {
  let row = await lockWallet(c, userId);
  const plans = require('../../lib/plans');
  const ent = await plans.entitlements(userId);
  const grantCredits = (ent.limits && ent.limits.includedCredits != null) ? Number(ent.limits.includedCredits) : rates.includedCredits(ent.plan);
  const grantUnits = grantCredits * U;
  const end = row.plan_period_end ? new Date(row.plan_period_end) : null;
  const inPeriod = end && !Number.isNaN(end.getTime()) && now < end;
  if (grantUnits <= 0) {
    if (Number(row.plan_balance_units || 0) > 0 && !inPeriod) row = await expirePlanLocked(c, row, now);
    return row;
  }
  const needsGrant = !inPeriod || Number(row.plan_grant_units || 0) !== grantUnits;
  // Mid-period upgrade/downgrade: start a fresh monthly grant of the current allotment.
  if (!inPeriod) return grantPlanLocked(c, row, grantUnits, now);
  if (needsGrant && Number(row.plan_grant_units || 0) !== grantUnits) return grantPlanLocked(c, row, grantUnits, now);
  return row;
}

async function syncPlan(userId, now) {
  const db = require('../../../db');
  return db.tx((c) => syncPlanLocked(c, userId, now || new Date()));
}

/**
 * Debit `units` (positive) from the wallet. Spends plan credits first.
 * opts.kind defaults to 'usage'. Returns { debit, wallet, snapshot }.
 */
async function debitLocked(c, userId, units, { kind = 'usage', now = new Date(), throughMs = null, billingSessionId = null, extra = {} } = {}) {
  const need = Math.max(0, Math.floor(Number(units) || 0));
  let row = await syncPlanLocked(c, userId, now instanceof Date ? now : new Date(now));
  if (!need) return { debit: 0, wallet: row, snapshot: snapshot(row) };
  const available = Number(row.balance_units || 0);
  if (available < need) {
    throw fail(402, 'Add credits to continue.', { topUp: true, expose: true, balanceCredits: credits(available), needCredits: credits(need) });
  }
  const planUnits = Math.max(0, Number(row.plan_balance_units || 0));
  const fromPlan = Math.min(planUnits, need);
  const nextPlan = planUnits - fromPlan;
  const nextBal = available - need;
  const nextUsed = Number(row.period_used_units || 0) + need;
  const updated = (await c.query(`UPDATE credit_wallets SET balance_units=$2, plan_balance_units=$3, period_used_units=$4, updated_at=NOW()
    WHERE user_id=$1 RETURNING *`, [userId, nextBal, nextPlan, nextUsed])).rows[0];
  const cols = ['user_id', 'kind', 'delta_units', 'balance_after_units'];
  const vals = [userId, kind, -need, nextBal];
  if (throughMs != null) { cols.push('through_ms'); vals.push(throughMs); }
  if (billingSessionId != null) { cols.push('billing_session_id'); vals.push(billingSessionId); }
  for (const [k, v] of Object.entries(extra)) { cols.push(k); vals.push(v); }
  const ph = vals.map((_, i) => `$${i + 1}`).join(',');
  await c.query(`INSERT INTO credit_ledger(${cols.join(',')}) VALUES(${ph})`, vals);
  return { debit: need, wallet: updated, snapshot: snapshot(updated) };
}

/** Credit `units` (positive) as purchased credits (never expire). */
async function creditLocked(c, userId, units, { kind = 'purchase', paymentId = null, extra = {} } = {}) {
  const add = Math.max(0, Math.floor(Number(units) || 0));
  const row = await lockWallet(c, userId);
  if (!add) return { credit: 0, wallet: row, snapshot: snapshot(row) };
  const nextBal = Number(row.balance_units || 0) + add;
  const updated = (await c.query('UPDATE credit_wallets SET balance_units=$2, updated_at=NOW() WHERE user_id=$1 RETURNING *', [userId, nextBal])).rows[0];
  const cols = ['user_id', 'kind', 'delta_units', 'balance_after_units'];
  const vals = [userId, kind, add, nextBal];
  if (paymentId != null) { cols.push('payment_id'); vals.push(paymentId); }
  for (const [k, v] of Object.entries(extra)) { cols.push(k); vals.push(v); }
  const ph = vals.map((_, i) => `$${i + 1}`).join(',');
  await c.query(`INSERT INTO credit_ledger(${cols.join(',')}) VALUES(${ph})`, vals);
  return { credit: add, wallet: updated, snapshot: snapshot(updated) };
}

async function refundLocked(c, userId, units, opts = {}) {
  return creditLocked(c, userId, units, { kind: opts.kind || 'refund', extra: opts.extra || {} });
}

function usageView(row, subscription) {
  const s = snapshot(row);
  const grant = s.planGrantUnits;
  const purchased = s.purchasedUnits;
  const used = s.periodUsedUnits;
  const left = s.balanceUnits;
  const capacity = grant + purchased + Math.max(0, used - grant); // spent purchased counts in the period total
  const of = Math.max(capacity, used + left);
  const renew = subscription && (subscription.current_period_end || subscription.periodEnd);
  return {
    ...s,
    used: s.usedThisPeriodCredits,
    left: s.balanceCredits,
    of: credits(of),
    percentUsed: of ? Math.min(100, Math.round((used / of) * 1000) / 10) : 0,
    periodEnd: s.planPeriodEnd,
    renewalDate: renew || s.planPeriodEnd,
  };
}

module.exports = {
  lockWallet, snapshot, syncPlanLocked, syncPlan, debitLocked, creditLocked, refundLocked, usageView, addMonth,
};
