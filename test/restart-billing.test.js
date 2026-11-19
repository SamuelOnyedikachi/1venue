'use strict';
// Restart / wallet / orphan billing: rooms come back without charging the downtime
// gap, GET /api/wallet is read-only, and unrestorable sessions are closed after
// the adopt grace without a debit. Needs DATABASE_URL or DB_DRIVER=sqlite.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { promisify } = require('node:util');
const execFile = promisify(require('node:child_process').execFile);
const { boot, client, signupPayload, fundTestWallet } = require('./helpers/server');

const skip = !process.env.DATABASE_URL && process.env.DB_DRIVER !== 'sqlite' ? 'set DATABASE_URL or DB_DRIVER=sqlite' : false;
const root = path.join(__dirname, '..');

function isolatedEnv(extra = {}) {
  const env = {
    RESTART_ADOPT_GRACE_MS: '0',
    SNAPSHOT_INTERVAL_MS: '0',
    SHUTDOWN_GRACE_MS: '200',
    ...extra,
  };
  if (process.env.DB_DRIVER === 'sqlite') {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'venue-rb-'));
    env.DB_DRIVER = 'sqlite';
    env.SQLITE_PATH = path.join(dir, 't.sqlite');
    env.STORAGE_DIR = path.join(dir, 'up');
  }
  return env;
}

async function sql(env, query, params = []) {
  const script = "const db=require('./db'); db.ensureReady().then(()=>db.q(process.argv[1], JSON.parse(process.argv[2]||'[]'))).then(r=>{process.stdout.write(JSON.stringify(r.rows||[]));return db.close();}).catch(e=>{console.error(e.stack||e.message);process.exit(1);});";
  const { stdout } = await execFile(process.execPath, ['-e', script, query, JSON.stringify(params)], {
    cwd: root,
    env: { ...process.env, ...env },
    timeout: 20000,
  });
  return JSON.parse(stdout || '[]');
}

async function nodeEval(env, source) {
  const { stdout, stderr } = await execFile(process.execPath, ['-e', source], {
    cwd: root,
    env: { ...process.env, ...env },
    timeout: 20000,
  });
  if (stderr && /error/i.test(stderr) && !stdout) throw new Error(stderr);
  return stdout;
}

test('restart with an open session does not bill the downtime gap and the meeting is joinable', { skip, timeout: 60000 }, async () => {
  const env = isolatedEnv();
  let s = await boot(env);
  try {
    const host = client(s.base);
    await host.post('/api/signup', signupPayload());
    await fundTestWallet(s.base, host.jar.header(), 120, env);
    const created = await host.post('/api/create', { name: 'Gap check', participantName: 'Host Person' });
    assert.equal(created.status, 200, JSON.stringify(created.body));
    const { code } = created.body;
    const before = (await host.get('/api/wallet')).body.balanceCredits;
    assert.equal(before, 120);
    const gapMs = 120000;
    await s.stop();
    const past = Date.now() - gapMs;
    await sql(env, 'UPDATE credit_billing_sessions SET free_until_ms=$1, accounted_ms=$1, charged_units=0 WHERE code=$2', [past, code]);
    s = await boot(env);
    const host2 = client(s.base);
    // same cookie jar so /api/wallet and /api/join work as the host
    host2.jar = host.jar;
    const wallet = await client(s.base, host.jar).get('/api/wallet');
    assert.equal(wallet.status, 200);
    assert.equal(wallet.body.balanceCredits, 120, 'downtime gap must not be billed');
    const rows = await sql(env, 'SELECT charged_units, accounted_ms, state FROM credit_billing_sessions WHERE code=$1', [code]);
    assert.equal(Number(rows[0].charged_units), 0, 'no debit for the downtime gap');
    assert.equal(rows[0].state, 'active');
    assert.ok(Number(rows[0].accounted_ms) >= past + gapMs - 5000, 'accounted_ms should have jumped to resume time');
    const joined = await client(s.base, host.jar).post('/api/join', { code, participantName: 'Host Person' });
    assert.ok(joined.status === 200 || joined.status === 409 || joined.status === 403, 'restored meeting should be joinable, got ' + joined.status + ' ' + JSON.stringify(joined.body));
    const meeting = await fetch(s.base + '/api/meeting/' + code).then(async (r) => ({ status: r.status, body: await r.json() }));
    assert.equal(meeting.status, 200, JSON.stringify(meeting.body));
    assert.equal(meeting.body.name, 'Gap check');
  } finally {
    await s.stop();
  }
});

test('GET /api/wallet does not settle an active billing session', { skip, timeout: 60000 }, async () => {
  const env = isolatedEnv();
  const s = await boot(env);
  try {
    const host = client(s.base);
    await host.post('/api/signup', signupPayload());
    await fundTestWallet(s.base, host.jar.header(), 120, env);
    const created = await host.post('/api/create', { name: 'Wallet poll', participantName: 'Host Person' });
    assert.equal(created.status, 200);
    const { code } = created.body;
    await s.stop();
    const past = Date.now() - 180000;
    await sql(env, 'UPDATE credit_billing_sessions SET free_until_ms=$1, accounted_ms=$1, charged_units=0 WHERE code=$2', [past, code]);
    const out = await nodeEval(env, `
      const db=require('./db');
      const data=require('./src/features/wallet/billing-data');
      (async()=>{
        await db.ensureReady();
        const row=(await db.q('SELECT id,user_id,accounted_ms,charged_units FROM credit_billing_sessions WHERE code=$1',[${JSON.stringify(code)}])).rows[0];
        const before=Number(row.accounted_ms);
        const walletBefore=Number((await db.q('SELECT balance_units FROM credit_wallets WHERE user_id=$1',[row.user_id])).rows[0].balance_units);
        await data.current(row.user_id, Date.now());
        const after=(await db.q('SELECT accounted_ms,charged_units FROM credit_billing_sessions WHERE id=$1',[row.id])).rows[0];
        const walletAfter=Number((await db.q('SELECT balance_units FROM credit_wallets WHERE user_id=$1',[row.user_id])).rows[0].balance_units);
        if(Number(after.accounted_ms)!==before) throw new Error('current() changed accounted_ms');
        if(Number(after.charged_units)!==0) throw new Error('current() charged');
        if(walletAfter!==walletBefore) throw new Error('current() changed wallet');
        await db.close();
        process.stdout.write('ok');
      })().catch(e=>{console.error(e.stack||e.message);process.exit(1);});
    `);
    assert.equal(out.trim(), 'ok');
  } finally {
    await s.stop();
  }
});

test('orphaned billing session is closed after adopt grace without charging', { skip, timeout: 60000 }, async () => {
  const env = isolatedEnv({ RESTART_ADOPT_GRACE_MS: '0' });
  let s = await boot(env);
  try {
    const host = client(s.base);
    await host.post('/api/signup', signupPayload());
    await fundTestWallet(s.base, host.jar.header(), 120, env);
    const created = await host.post('/api/create', { name: 'Orphan', participantName: 'Host Person' });
    assert.equal(created.status, 200);
    const { code } = created.body;
    await s.stop();
    const past = Date.now() - 180000;
    await sql(env, "UPDATE meeting_history SET ended_at=$1 WHERE code=$2 AND ended_at IS NULL", [new Date().toISOString(), code]);
    await sql(env, "UPDATE credit_billing_sessions SET owner_id='dead-worker', free_until_ms=$1, accounted_ms=$1, charged_units=0 WHERE code=$2", [past, code]);
    s = await boot(env);
    const deadline = Date.now() + 8000;
    let row;
    while (Date.now() < deadline) {
      row = (await sql(env, 'SELECT state, end_reason, charged_units FROM credit_billing_sessions WHERE code=$1', [code]))[0];
      if (row && row.state !== 'active') break;
      await new Promise((r) => setTimeout(r, 200));
    }
    assert.ok(row, 'billing row missing');
    assert.notEqual(row.state, 'active', 'orphan should be closed');
    assert.equal(row.end_reason, 'restart-lost');
    assert.equal(Number(row.charged_units), 0);
    const wallet = await sql(env, 'SELECT balance_units FROM credit_wallets LIMIT 1');
    assert.equal(Number(wallet[0].balance_units), 120 * 60000);
  } finally {
    await s.stop();
  }
});

test('refund-post-deploy-usage.js dry-run and idempotent --apply', { skip, timeout: 60000 }, async () => {
  const env = isolatedEnv();
  const s = await boot(env);
  try {
    const host = client(s.base);
    await host.post('/api/signup', signupPayload());
    await fundTestWallet(s.base, host.jar.header(), 120, env);
    const created = await host.post('/api/create', { name: 'Refund', participantName: 'Host Person' });
    assert.equal(created.status, 200);
    const { code } = created.body;
    await s.stop();
    const session = (await sql(env, 'SELECT id, user_id FROM credit_billing_sessions WHERE code=$1', [code]))[0];
    const cutoff = Date.now() - 60000;
    const through = cutoff + 30000; // 30s after cutoff = 30000 units = 0.5 credit
    await sql(env, "UPDATE credit_wallets SET balance_units=$1 WHERE user_id=$2", [120 * 60000 - 30000, session.user_id]);
    await sql(env, "INSERT INTO credit_ledger(user_id,billing_session_id,through_ms,kind,delta_units,balance_after_units) VALUES($1,$2,$3,'usage',$4,$5)",
      [session.user_id, session.id, through, -30000, 120 * 60000 - 30000]);

    const dry = await execFile(process.execPath, ['scripts/refund-post-deploy-usage.js', String(cutoff)], {
      cwd: root, env: { ...process.env, ...env }, timeout: 20000,
    });
    assert.match(dry.stdout, /DRY-RUN/);
    assert.match(dry.stdout, /30000/);
    const mid = await sql(env, 'SELECT balance_units FROM credit_wallets WHERE user_id=$1', [session.user_id]);
    assert.equal(Number(mid[0].balance_units), 120 * 60000 - 30000, 'dry-run must not credit');

    const applied = await execFile(process.execPath, ['scripts/refund-post-deploy-usage.js', String(cutoff), '--apply'], {
      cwd: root, env: { ...process.env, ...env }, timeout: 20000,
    });
    assert.match(applied.stdout, /Applied 1/);
    const after = await sql(env, 'SELECT balance_units FROM credit_wallets WHERE user_id=$1', [session.user_id]);
    assert.equal(Number(after[0].balance_units), 120 * 60000);
    const ledgers = await sql(env, "SELECT kind, delta_units, through_ms FROM credit_ledger WHERE billing_session_id=$1 AND kind='refund'", [session.id]);
    assert.equal(ledgers.length, 1);
    assert.equal(Number(ledgers[0].delta_units), 30000);
    assert.equal(Number(ledgers[0].through_ms), cutoff);

    const again = await execFile(process.execPath, ['scripts/refund-post-deploy-usage.js', String(cutoff), '--apply'], {
      cwd: root, env: { ...process.env, ...env }, timeout: 20000,
    });
    assert.match(again.stdout, /skipped 1/);
    const againBal = await sql(env, 'SELECT balance_units FROM credit_wallets WHERE user_id=$1', [session.user_id]);
    assert.equal(Number(againBal[0].balance_units), 120 * 60000);
    const ledgers2 = await sql(env, "SELECT id FROM credit_ledger WHERE billing_session_id=$1 AND kind='refund'", [session.id]);
    assert.equal(ledgers2.length, 1);
  } finally {
    await s.stop();
  }
});
