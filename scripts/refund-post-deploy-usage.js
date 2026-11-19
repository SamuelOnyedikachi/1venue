#!/usr/bin/env node
'use strict';
/**
 * Refund credit_ledger usage that was billed after a cutoff (for example a
 * deploy that charged while rooms were down).
 *
 *   node scripts/refund-post-deploy-usage.js <cutoff_ms>
 *   node scripts/refund-post-deploy-usage.js <cutoff_ms> --apply
 *
 * cutoff_ms is a Unix timestamp in milliseconds. Only the portion of each
 * kind='usage' row that falls after the cutoff is summed, per user and
 * billing session. Dry-run (the default) prints the totals. --apply credits
 * each wallet and inserts a kind='refund' ledger row with through_ms = cutoff,
 * which is unique per session, so re-running the same cutoff is a no-op.
 */
const path = require('path');
process.chdir(path.join(__dirname, '..'));

function parseArgs(argv) {
  const args = argv.slice(2);
  const apply = args.includes('--apply');
  const rest = args.filter((a) => a !== '--apply');
  if (!rest.length || rest.includes('-h') || rest.includes('--help')) {
    console.log(`Usage: node scripts/refund-post-deploy-usage.js <cutoff_ms> [--apply]

  cutoff_ms   Unix time in milliseconds. Usage with through_ms after this is
              refunded (only the portion after the cutoff).
  --apply     Credit wallets and insert kind='refund' ledger rows.
              Default is a dry-run.

  Example: node scripts/refund-post-deploy-usage.js 1732010400000
           node scripts/refund-post-deploy-usage.js 1732010400000 --apply`);
    process.exit(rest.length ? 0 : 1);
  }
  const raw = rest[0];
  const cutoff = Number(raw);
  if (!Number.isFinite(cutoff) || cutoff <= 0) {
    console.error('cutoff_ms must be a positive Unix timestamp in milliseconds');
    process.exit(1);
  }
  return { cutoff: Math.floor(cutoff), apply };
}

/** Portion of a usage debit that falls after cutoff. */
function portionAfter(throughMs, deltaUnits, cutoff) {
  const debit = -Number(deltaUnits); // usage deltas are negative
  const through = Number(throughMs);
  const previous = through - debit;
  return Math.max(0, through - Math.max(previous, cutoff));
}

async function loadRows(db, cutoff) {
  const r = await db.q(
    `SELECT l.id, l.user_id, l.billing_session_id, l.through_ms, l.delta_units,
            s.code
       FROM credit_ledger l
       JOIN credit_billing_sessions s ON s.id = l.billing_session_id
      WHERE l.kind = 'usage' AND l.billing_session_id IS NOT NULL
        AND l.through_ms > $1
      ORDER BY l.user_id, l.billing_session_id, l.id`,
    [cutoff]
  );
  const bySession = new Map();
  for (const row of r.rows) {
    const units = portionAfter(row.through_ms, row.delta_units, cutoff);
    if (units <= 0) continue;
    const key = String(row.billing_session_id);
    const cur = bySession.get(key) || {
      userId: Number(row.user_id),
      sessionId: Number(row.billing_session_id),
      code: row.code,
      units: 0,
      rows: 0,
    };
    cur.units += units;
    cur.rows += 1;
    bySession.set(key, cur);
  }
  return [...bySession.values()];
}

async function alreadyRefunded(db, sessionId, cutoff) {
  const r = await db.q(
    "SELECT id FROM credit_ledger WHERE billing_session_id=$1 AND kind='refund' AND through_ms=$2",
    [sessionId, cutoff]
  );
  return r.rows[0] || null;
}

async function applyRefund(db, item, cutoff) {
  if (await alreadyRefunded(db, item.sessionId, cutoff)) return { skipped: true, units: item.units };
  return db.tx(async (c) => {
    if (item.userId != null) {
      const user = (await c.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [item.userId])).rows[0];
      if (!user) return { skipped: true, units: 0, reason: 'missing-user' };
    }
    const existing = (await c.query(
      "SELECT id FROM credit_ledger WHERE billing_session_id=$1 AND kind='refund' AND through_ms=$2",
      [item.sessionId, cutoff]
    )).rows[0];
    if (existing) return { skipped: true, units: item.units };
    await c.query('INSERT INTO credit_wallets(user_id,balance_units) VALUES($1,0) ON CONFLICT(user_id) DO NOTHING', [item.userId]);
    const wallet = (await c.query('SELECT balance_units FROM credit_wallets WHERE user_id=$1 FOR UPDATE', [item.userId])).rows[0];
    const next = Math.max(0, Number(wallet?.balance_units || 0) + item.units);
    await c.query('UPDATE credit_wallets SET balance_units=$2, updated_at=NOW() WHERE user_id=$1', [item.userId, next]);
    await c.query(
      "INSERT INTO credit_ledger(user_id,billing_session_id,through_ms,kind,delta_units,balance_after_units) VALUES($1,$2,$3,'refund',$4,$5)",
      [item.userId, item.sessionId, cutoff, item.units, next]
    );
    return { skipped: false, units: item.units, balanceAfter: next };
  });
}

async function main() {
  const { cutoff, apply } = parseArgs(process.argv);
  const db = require('../db');
  await db.ensureReady();
  try {
    const items = await loadRows(db, cutoff);
    if (!items.length) {
      console.log(`No usage after cutoff ${cutoff} (${new Date(cutoff).toISOString()}).`);
      return;
    }
    const byUser = new Map();
    for (const it of items) {
      const u = byUser.get(it.userId) || { userId: it.userId, units: 0, sessions: 0 };
      u.units += it.units;
      u.sessions += 1;
      byUser.set(it.userId, u);
    }
    console.log(`${apply ? 'APPLY' : 'DRY-RUN'} cutoff=${cutoff} (${new Date(cutoff).toISOString()})`);
    console.log('user_id\tsession_id\tcode\trefund_units\trefund_credits\tusage_rows');
    let total = 0;
    for (const it of items) {
      total += it.units;
      const credits = (it.units / 60000).toFixed(4);
      console.log(`${it.userId}\t${it.sessionId}\t${it.code}\t${it.units}\t${credits}\t${it.rows}`);
    }
    console.log(`\n${items.length} session(s), ${byUser.size} user(s), ${total} units (${(total / 60000).toFixed(4)} credits).`);
    if (!apply) {
      console.log('Re-run with --apply to credit wallets and write kind=refund ledger rows.');
      return;
    }
    let applied = 0, skipped = 0, units = 0;
    for (const it of items) {
      const out = await applyRefund(db, it, cutoff);
      if (out.skipped) skipped++;
      else { applied++; units += out.units; }
    }
    console.log(`Applied ${applied} refund(s) (${units} units); skipped ${skipped} already present.`);
  } finally {
    await db.close().catch(() => {});
  }
}

main().catch((e) => { console.error(e.stack || e.message); process.exit(1); });
