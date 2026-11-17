'use strict';
process.env.PROCESSING_FEE_PERCENT = '0'; // these suites pin the original price maths; the fee is covered in test/settings-wallet.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const http = require('node:http');
const { spawnSync } = require('node:child_process');
const { boot, client, signupPayload } = require('./helpers/server');
const skip = !process.env.DATABASE_URL && process.env.DB_DRIVER !== 'sqlite' ? 'set DATABASE_URL or DB_DRIVER=sqlite' : false;
const rules = require('../src/features/wallet/rules');
const { verifyWebhook } = require('../src/features/wallet/paystack');
const secretKey = 'sk_test_wallet_fixture';
const webhookSecret = 'whsec_wallet_fixture';
const signed = (raw, t = Math.floor(Date.now() / 1000)) => ({
  'paystack-signature': `t=${t},v1=whk_fixture:${crypto.createHmac('sha512', webhookSecret).update(`${t}.`).update(raw).digest('hex')}`,
});

test('credit prices are server-owned, whole purchases have no expiry, and unsafe amounts are rejected', () => {
  assert.deepEqual(rules.BUNDLES.map((x) => [x.credits, x.priceKobo]), [[10, 500000], [30, 1500000], [60, 3000000], [120, 6000000]]);
  assert.equal(rules.quote(3).priceKobo, 150000);
  assert.equal(rules.UNITS_PER_CREDIT, 60000);
  for (const value of [0, -1, 1.5, '30', null, NaN, Infinity, Number.MAX_SAFE_INTEGER]) assert.throws(() => rules.quote(value));
});

test('Paystack authenticates raw bodies, timestamp tolerance, and prevents signature downgrade', () => {
  const raw = Buffer.from('{ "event": "charge.success", "data": {} }');
  assert.equal(verifyWebhook(raw, signed(raw), { secretKey, webhookSecret }), true);
  assert.equal(verifyWebhook(Buffer.concat([raw, Buffer.from('\n')]), signed(raw), { secretKey, webhookSecret }), false);
  assert.equal(verifyWebhook(raw, signed(raw, Math.floor(Date.now() / 1000) - 301), { secretKey, webhookSecret }), false);
  const legacy = { 'x-paystack-signature': crypto.createHmac('sha512', secretKey).update(raw).digest('hex') };
  assert.equal(verifyWebhook(raw, legacy, { secretKey }), true);
  assert.equal(verifyWebhook(raw, legacy, { secretKey, webhookSecret }), false);
  assert.equal(verifyWebhook(raw, { ...legacy, 'paystack-signature': 'bad' }, { secretKey, webhookSecret }), false);
  assert.equal(verifyWebhook(raw, {}, { secretKey }), false);
});

let gateway, s, alice, bob, db;
const payments = new Map();
let nextId = crypto.randomInt(1_000_000_000, 1_000_000_000_000);
let verifyFailures = 0;
let initializeFailures = 0;
let calls = 0;
async function jsonBody(req) { const chunks = []; for await (const chunk of req) chunks.push(chunk); return JSON.parse(Buffer.concat(chunks).toString() || '{}'); }

test.before(async () => {
  if (skip) return;
  db = require('../db');
  gateway = http.createServer(async (req, res) => {
    calls++;
    assert.equal(req.headers.authorization, `Bearer ${secretKey}`);
    const reply = (status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (req.url === '/transaction/initialize') {
      const body = await jsonBody(req);
      payments.set(body.reference, { id: nextId++, reference: body.reference, requested_amount: Number(body.amount), amount: Number(body.amount) + 10000, fees: 10000, currency: 'NGN', status: 'pending', domain: 'test', metadata: body.metadata, customer: { email: body.email } });
      if (initializeFailures-- > 0) return reply(503, { status: false });
      return reply(200, { status: true, data: { reference: body.reference, authorization_url: `https://checkout.paystack.com/${body.reference}`, access_code: 'fixture' } });
    }
    if (req.url.startsWith('/transaction/verify/')) {
      if (verifyFailures-- > 0) return reply(503, { status: false });
      return reply(200, { status: true, data: payments.get(decodeURIComponent(req.url.split('/').pop())) });
    }
    reply(404, {});
  });
  await new Promise((r) => gateway.listen(0, '127.0.0.1', r));
  s = await boot({ PAYSTACK_SECRET_KEY: secretKey, PAYSTACK_WEBHOOK_SECRET: webhookSecret, PAYSTACK_PASS_FEES_CONFIRMED: 'true', PAYSTACK_API_URL: `http://127.0.0.1:${gateway.address().port}` });
  alice = client(s.base); bob = client(s.base);
  assert.equal((await alice.post('/api/signup', signupPayload())).status, 201);
  assert.equal((await bob.post('/api/signup', signupPayload())).status, 201);
});
test.after(async () => { if (s) await s.stop(); if (gateway) await new Promise((r) => gateway.close(r)); if (db) await db.close(); });
const checkout = (credits) => alice.post('/api/wallet/checkout', { credits });
const verify = (ref, who = alice) => who.post(`/api/wallet/payments/${ref}/verify`);
async function webhook(ref, headers) {
  const raw = Buffer.from(JSON.stringify({ event: 'charge.success', data: { reference: ref, amount: 1 } }));
  return fetch(s.base + '/payments/paystack/webhook', { method: 'POST', headers: { 'content-type': 'application/json', ...(headers || signed(raw)) }, body: raw });
}

test('wallet requires sign-in, starts empty, quotes bundles and custom credits without trusting a supplied amount', { skip }, async () => {
  assert.equal((await client(s.base).get('/api/wallet')).status, 401);
  const wallet = await alice.get('/api/wallet');
  assert.equal(wallet.body.balanceCredits, 0);
  assert.equal(wallet.body.purchasesEnabled, true);
  const quote = await alice.post('/api/wallet/quote', { credits: 30, amount: 1 });
  assert.equal(quote.body.priceKobo, 1500000);
  assert.equal((await alice.post('/api/wallet/quote', { credits: 1.5 })).status, 400);
  const r = await alice.post('/api/wallet/checkout', { credits: 3, amount: 1 });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(payments.get(r.body.reference).requested_amount, 150000);
  assert.match(r.body.authorizationUrl, /^https:\/\/checkout\.paystack\.com\//);
  assert.equal((await alice.get('/api/wallet')).body.balanceCredits, 0);
});

test('pending and unsuccessful payments create no credits; another account cannot verify a purchase', { skip }, async () => {
  const r = await checkout(10); const ref = r.body.reference;
  const before = calls;
  assert.equal((await verify(ref, bob)).status, 404);
  assert.equal(calls, before);
  assert.equal((await verify(ref)).body.status, 'pending');
  payments.get(ref).status = 'failed';
  assert.equal((await verify(ref)).body.status, 'failed');
  assert.equal((await alice.get('/api/wallet')).body.balanceCredits, 0);
  assert.equal((await webhook(ref, { 'x-paystack-signature': 'forged' })).status, 401);
});

test('verified payment posts exactly once across concurrent callbacks and signed webhook retries', { skip }, async () => {
  const r = await checkout(30); const ref = r.body.reference;
  payments.get(ref).status = 'success';
  const results = await Promise.all([verify(ref), verify(ref), webhook(ref), webhook(ref)]);
  assert.ok(results.every((r) => r.status === 200));
  assert.equal((await alice.get('/api/wallet')).body.balanceCredits, 30);
  assert.equal((await bob.get('/api/wallet')).body.balanceCredits, 0);
  const history = (await alice.get('/api/wallet/transactions')).body.entries;
  assert.equal(history.filter((x) => x.reference === ref).length, 1);
  assert.equal(history[0].credits, 30);
  assert.equal(history[0].balanceAfter, 30);
  assert.equal((await webhook(ref)).status, 200);
  assert.equal((await alice.get('/api/wallet')).body.balanceCredits, 30);
  // The database itself must hold exactly one purchase entry for this payment.
  const rows = (await db.q('SELECT COUNT(*) AS n FROM credit_ledger l JOIN credit_payments p ON p.id=l.payment_id WHERE p.reference=$1', [ref])).rows;
  assert.equal(Number(rows[0].n), 1);
});

test('amount, net funding, currency, customer, metadata and mode mismatches never mint credits', { skip }, async () => {
  for (const change of [ { requested_amount: 1 }, { amount: 1500000 }, { currency: 'USD' }, { customer: { email: 'wrong@ex.test' } }, { metadata: {} }, { domain: 'live' } ]) {
    const r = await checkout(30); const ref = r.body.reference;
    Object.assign(payments.get(ref), { status: 'success' }, change);
    assert.equal((await verify(ref)).status, 409, JSON.stringify(change));
  }
  assert.equal((await alice.get('/api/wallet')).body.balanceCredits, 30);
});

test('transient errors remain recoverable, unknown notifications are harmless, and payment history is private', { skip }, async () => {
  const r = await checkout(10); const ref = r.body.reference;
  payments.get(ref).status = 'success'; verifyFailures = 1;
  assert.equal((await webhook(ref)).status, 502);
  assert.equal((await alice.get('/api/wallet')).body.balanceCredits, 30);
  assert.equal((await webhook(ref)).status, 200);
  assert.equal((await alice.get('/api/wallet')).body.balanceCredits, 40);
  assert.equal((await webhook('unknown-reference')).status, 200);
  assert.equal((await bob.get('/api/wallet/payments')).body.payments.length, 0);
  const entry = (await alice.get('/api/wallet/payments')).body.payments.find((p) => p.reference === ref);
  assert.equal(entry.status, 'paid');
  const page = await alice.get('/wallet'); assert.equal(page.status, 200);
});

test('interrupted initialization retains a reference that a later verified notification can settle', { skip }, async () => {
  const buyer = client(s.base);
  await buyer.post('/api/signup', signupPayload());
  initializeFailures = 1;
  const r = await buyer.post('/api/wallet/checkout', { credits: 10 });
  assert.equal(r.status, 502);
  const ref = [...payments.keys()].pop();
  payments.get(ref).status = 'success';
  assert.equal((await webhook(ref)).status, 200);
  assert.equal((await buyer.get('/api/wallet')).body.balanceCredits, 10);
});

test('the same provider transaction cannot credit two purchase references', { skip }, async () => {
  const buyer = client(s.base); await buyer.post('/api/signup', signupPayload());
  const first = await buyer.post('/api/wallet/checkout', { credits: 10 });
  payments.get(first.body.reference).status = 'success';
  assert.equal((await verify(first.body.reference, buyer)).status, 200);
  const second = await buyer.post('/api/wallet/checkout', { credits: 10 });
  const duplicate = payments.get(second.body.reference);
  duplicate.status = 'success'; duplicate.id = payments.get(first.body.reference).id;
  assert.equal((await verify(second.body.reference, buyer)).status, 409);
  assert.equal((await buyer.get('/api/wallet')).body.balanceCredits, 10);
  assert.equal((await buyer.get('/api/wallet/transactions')).body.entries.length, 1);
});

test('deleting an account cannot silently discard purchased credits or an unfinished checkout', { skip }, async () => {
  const walletData = require('../src/features/wallet/data');
  const deletion = require('../src/features/auth/deletion');
  const buyer = client(s.base); const identity = signupPayload();
  await buyer.post('/api/signup', identity);
  const id = (await buyer.get('/api/session')).body.user.id;
  const r = await buyer.post('/api/wallet/checkout', { credits: 10 });
  await assert.rejects(deletion.deleteAccount(id), (e) => e.status === 409);
  payments.get(r.body.reference).status = 'success';
  await verify(r.body.reference, buyer);
  await assert.rejects(deletion.deleteAccount(id), (e) => e.status === 409);
  assert.equal(await walletData.balance(id), 10);
  await db.q('UPDATE users SET is_seed=true WHERE id=$1', [id]);
  try {
    await assert.rejects(require('../src/features/seed/seed').remove(), (e) => e.status === 409);
    assert.equal(await walletData.balance(id), 10);
  } finally { await db.q('UPDATE users SET is_seed=false WHERE id=$1', [id]); }
});


test('a production process cannot accept sandbox purchases', () => {
  const result = spawnSync(process.execPath, ['-e', "process.stdout.write(String(require('./src/features/wallet/paystack').enabled()))"], {
    cwd: require('node:path').join(__dirname, '..'), encoding: 'utf8',
    env: { ...process.env, NODE_ENV: 'production', PUBLIC_URL: 'https://example.test', PAYSTACK_SECRET_KEY: 'sk_test_fixture', PAYSTACK_PASS_FEES_CONFIRMED: 'true', PAYSTACK_API_URL: 'https://api.paystack.co' },
  });
  assert.equal(result.status, 0);
  assert.equal(result.stdout, 'false');
});

test('without gateway credentials wallets remain readable and purchases stay disabled', { skip }, async () => {
  const disabled = await boot({ PAYSTACK_SECRET_KEY: '', PAYSTACK_WEBHOOK_SECRET: '', PAYSTACK_PASS_FEES_CONFIRMED: 'false' });
  try {
    const buyer = client(disabled.base);
    assert.equal((await buyer.post('/api/signup', signupPayload())).status, 201);
    const summary = (await buyer.get('/api/wallet')).body;
    assert.equal(summary.balanceCredits, 0);
    assert.equal(summary.purchasesEnabled, false);
    assert.equal((await buyer.post('/api/wallet/checkout', { credits: 10 })).status, 503);
    assert.equal((await buyer.get('/api/wallet/payments')).body.payments.length, 0);
  } finally { await disabled.stop(); }
});


test('older unfinished purchases remain reachable through private cursor pagination', { skip }, async () => {
  const buyer = client(s.base); await buyer.post('/api/signup', signupPayload());
  const user = (await buyer.get('/api/session')).body.user;
  const data = require('../src/features/wallet/data');
  let oldest;
  for (let i = 0; i < 51; i++) {
    const row = await data.createPayment(user, rules.quote(1), 'test');
    if (!oldest) oldest = row.reference;
  }
  const first = (await buyer.get('/api/wallet/payments')).body;
  assert.equal(first.payments.length, 50);
  assert.ok(first.nextBefore);
  const last = (await buyer.get('/api/wallet/payments?before=' + first.nextBefore)).body;
  assert.equal(last.payments.length, 1);
  assert.equal(last.payments[0].reference, oldest);
  assert.equal(last.nextBefore, null);
  assert.equal((await buyer.get('/api/wallet/payments?before=bad')).status, 400);
  assert.equal((await bob.get('/api/wallet/payments?before=' + first.nextBefore)).body.payments.length, 0);
});
