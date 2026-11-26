'use strict';
process.env.PROCESSING_FEE_PERCENT = '0'; // these suites pin the original price maths; the fee is covered in test/settings-wallet.test.js
// Plans, limits, AI pool, plan gating, subscription checkout, renewals, grace and admin plan tools.
const secretKey = 'sk_test_billing_fixture';
Object.assign(process.env, { PAYSTACK_SECRET_KEY: secretKey, PAYSTACK_PASS_FEES_CONFIRMED: 'true', PUBLIC_URL: 'http://127.0.0.1:9', NODE_ENV: 'test' });
delete process.env.PAYSTACK_WEBHOOK_SECRET;
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const { boot, client, signupPayload } = require('./helpers/server');
const skip = !process.env.DATABASE_URL && process.env.DB_DRIVER !== 'sqlite' ? 'set DATABASE_URL or DB_DRIVER=sqlite' : false;
const plans = require('../src/lib/plans');
const codes = require('../src/lib/codes');
const DAY = 86400000;

// ---------------------------------------------------------------- unit
test('plan defaults match the approved table and server ceilings cap them', () => {
  const s = plans.envDefaults();
  assert.deepEqual(plans.limitsFor(s, 'free'), { venues: 1, audience: 100, meeting: 25, speakerSeats: 2, includedCredits: 0, uploadBytes: 250 * 1048576, uploadMB: 250 });
  const p = plans.limitsFor(s, 'premium');
  assert.equal(p.venues, 3); assert.equal(p.audience, 300); assert.equal(p.meeting, 50); assert.equal(p.speakerSeats, 4); assert.equal(p.includedCredits, 2000);
  const b = plans.limitsFor(s, 'business');
  assert.equal(b.venues, 10); assert.equal(b.audience, 500); assert.equal(b.includedCredits, 5000);
  const o = plans.limitsFor(s, 'organisation');
  assert.equal(o.venues, 20); assert.equal(o.audience, 1000); assert.equal(o.speakerSeats, 10); assert.equal(o.includedCredits, 12000);
  assert.equal(plans.priceFor(s, 'premium', 'month'), 1500000); assert.equal(plans.priceFor(s, 'premium', 'year'), 15000000);
  assert.equal(plans.priceFor(s, 'pro', 'month'), 1500000);
  assert.equal(plans.priceFor(s, 'business', 'month'), 3500000); assert.equal(plans.priceFor(s, 'business', 'year'), 35000000);
  assert.equal(plans.priceFor(s, 'organisation', 'month'), 7500000); assert.equal(plans.priceFor(s, 'organisation', 'year'), 75000000);
  assert.equal(plans.priceFor(s, 'free', 'month'), null);
  // overrides win, unknown or invalid keys are ignored; meeting size never exceeds MAX_PARTICIPANTS (50)
  const ov = plans.limitsFor(s, 'free', JSON.stringify({ venues: 4, meeting: 500, bogus: 1, includedCredits: 50 }));
  assert.equal(ov.venues, 4); assert.equal(ov.meeting, 50); assert.equal(ov.includedCredits, 50);
  assert.equal(plans.limitsFor(s, 'nonsense').venues, 1);
});

test('settings validation remaps Premium to Pro and accepts Business', () => {
  const s = plans.envDefaults();
  const m = plans.mergeSettings(s, { plans: { premium: { venues: 5 }, business: { venues: 12 } }, graceDays: 7 });
  assert.equal(m.plans.pro.venues, 5); assert.equal(m.plans.business.venues, 12); assert.equal(m.graceDays, 7);
  assert.equal(s.plans.pro.venues, 3, 'merge does not mutate');
  for (const bad of [{ plans: { gold: {} } }, { plans: { free: { venues: -1 } } }, { plans: { free: { colour: 1 } } }, { plans: { pro: { priceMonthKobo: 0 } } }, { graceDays: 1.5 }]) {
    assert.throws(() => plans.mergeSettings(s, bad), (e) => e.status === 400, JSON.stringify(bad));
  }
  assert.deepEqual(plans.diff(s, m), { plans: { pro: { venues: 5 }, business: { venues: 12 } }, graceDays: 7 });
});

test('effective plan: active, grace, cancelled, expired and complimentary', () => {
  const now = Date.parse('2026-06-15T12:00:00Z');
  const sub = (x) => ({ plan: 'premium', status: 'active', current_period_end: '2026-06-20T00:00:00Z', grace_until: null, cancel_at_period_end: false, ...x });
  assert.equal(plans.effectivePlan(null, now), 'free');
  assert.equal(plans.effectivePlan(sub(), now), 'pro');
  assert.equal(plans.effectivePlan(sub({ current_period_end: '2026-06-10T00:00:00Z' }), now), 'free');
  assert.equal(plans.effectivePlan(sub({ status: 'past_due', current_period_end: '2026-06-12T00:00:00Z', grace_until: '2026-06-17T00:00:00Z' }), now), 'pro');
  assert.equal(plans.effectivePlan(sub({ status: 'past_due', current_period_end: '2026-06-08T00:00:00Z', grace_until: '2026-06-13T00:00:00Z' }), now), 'free');
  assert.equal(plans.effectivePlan(sub({ status: 'cancelled', current_period_end: '2026-06-12T00:00:00Z', grace_until: '2026-06-17T00:00:00Z' }), now), 'free', 'cancelled gets no grace');
  assert.equal(plans.effectivePlan(sub({ status: 'expired' }), now), 'free');
  assert.equal(plans.effectivePlan(sub({ status: 'comp', plan: 'organisation', current_period_end: null }), now), 'organisation');
  assert.equal(plans.effectivePlan(sub({ status: 'comp', current_period_end: '2026-06-01T00:00:00Z' }), now), 'free');
});

test('billing periods add calendar months and years without overflow', () => {
  assert.equal(plans.addInterval('2026-01-31T10:00:00Z', 'month').toISOString(), '2026-02-28T10:00:00.000Z');
  assert.equal(plans.addInterval('2028-01-31T10:00:00Z', 'month').toISOString(), '2028-02-29T10:00:00.000Z');
  assert.equal(plans.addInterval('2026-03-15T00:00:00Z', 'year').toISOString(), '2027-03-15T00:00:00.000Z');
});

test('venue link rights for every plan and short-link add-on', () => {
  const ok = (input, rights, slug) => assert.equal(codes.customSlug(input, rights).slug, slug);
  const no = (input, rights, re) => assert.throws(() => codes.customSlug(input, rights), re);
  const r = (plan, tier) => plans.slugRights(plan, tier);
  ok('faith', r('free'), 'faith-venue'); no('abcd', r('free'), /5 letters/);
  ok('faith', r('free', 'slug3'), 'faith-venue'); // add-ons need a paid plan: Free still gets -venue
  for (const p of ['premium', 'organisation']) {
    ok('faith', r(p), 'faith'); no('abcd', r(p), /4-character/); no('abc', r(p), /3-character/); no('ab', r(p), /at least 3/);
    ok('abcd', r(p, 'slug4'), 'abcd'); no('abc', r(p, 'slug4'), /3-character/); no('ab', r(p, 'slug4'), /at least 3/);
    ok('abcd', r(p, 'slug3'), 'abcd'); ok('abc', r(p, 'slug3'), 'abc'); no('ab', r(p, 'slug3'), /at least 3/);
    assert.equal(r(p, 'slug2').tier, 'none', 'no 2-character tier');
    assert.equal(codes.customSlug('faith', r(p), { suffix: true }).slug, 'faith-venue');
  }
  no('admin', r('premium'), /reserved/); no('billing', r('premium'), /reserved/);
  // legacy plan names still resolve
  ok('abc', 'slug3', 'abc'); ok('faith', 'premium', 'faith'); ok('faith', 'free', 'faith-venue');
});

// ---------------------------------------------------------------- integration (real server + mock Paystack)
let gateway, s, db, service, alice, bob, admin, aliceId, bobId;
const txs = new Map();
let nextId = crypto.randomInt(1e9, 1e12);
let decline = false;
let tamper = null;
async function jsonBody(req) { const c = []; for await (const x of req) c.push(x); return JSON.parse(Buffer.concat(c).toString() || '{}'); }
const auth = (code = 'AUTH_' + crypto.randomBytes(6).toString('hex')) => ({ authorization_code: code, reusable: true, last4: '4081', exp_month: '12', exp_year: '2030', card_type: 'visa', bank: 'Bannk', channel: 'card' });
const pay = (ref) => { const t = txs.get(ref); Object.assign(t, { status: 'success', authorization: auth() }); if (tamper) { tamper(t); tamper = null; } };

test.before(async () => {
  if (skip) return;
  db = require('../db');
  gateway = http.createServer(async (req, res) => {
    const reply = (st, b) => { res.writeHead(st, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(b)); };
    if (req.headers.authorization !== `Bearer ${secretKey}`) return reply(401, { status: false });
    if (req.url === '/transaction/initialize') {
      const b = await jsonBody(req);
      txs.set(b.reference, { id: nextId++, reference: b.reference, requested_amount: b.amount, amount: b.amount + 5000, fees: 5000, currency: 'NGN', status: 'pending', domain: 'test', metadata: b.metadata, customer: { email: b.email } });
      return reply(200, { status: true, data: { reference: b.reference, authorization_url: `https://checkout.paystack.com/${b.reference}`, access_code: 'x' } });
    }
    if (req.url === '/transaction/charge_authorization') {
      const b = await jsonBody(req);
      assert.match(b.authorization_code, /^AUTH_/);
      if (decline) return reply(400, { status: false, message: 'Insufficient Funds' });
      const t = { id: nextId++, reference: b.reference, requested_amount: b.amount, amount: b.amount, fees: 0, currency: 'NGN', status: 'success', domain: 'test', metadata: b.metadata, customer: { email: b.email }, authorization: auth(b.authorization_code) };
      txs.set(b.reference, t);
      return reply(200, { status: true, data: t });
    }
    if (req.url.startsWith('/transaction/verify/')) return reply(200, { status: true, data: txs.get(decodeURIComponent(req.url.split('/').pop())) });
    reply(404, {});
  });
  await new Promise((r) => gateway.listen(0, '127.0.0.1', r));
  process.env.PAYSTACK_API_URL = `http://127.0.0.1:${gateway.address().port}`;
  service = require('../src/features/billing/service');
  const adminBody = signupPayload();
  s = await boot({ PAYSTACK_API_URL: process.env.PAYSTACK_API_URL, ADMIN_EMAILS: adminBody.email, BILLING_WORKER: 'false' });
  alice = client(s.base); bob = client(s.base); admin = client(s.base);
  assert.equal((await alice.post('/api/signup', signupPayload())).status, 201);
  assert.equal((await bob.post('/api/signup', signupPayload())).status, 201);
  await admin.post('/api/signup', adminBody);
  await admin.post('/api/auth/verify-email', { token: new URL(await s.mailLink(adminBody.email, /Confirm your email/)).searchParams.get('token') });
  aliceId = (await alice.get('/api/session')).body.user.id;
  bobId = (await bob.get('/api/session')).body.user.id;
});
test.after(async () => { if (s) await s.stop(); if (gateway) await new Promise((r) => gateway.close(r)); if (db) await db.close(); });

const sub = (id) => db.q('SELECT * FROM subscriptions WHERE user_id=$1', [id]).then((r) => r.rows[0]);

test('Free plan gating: one venue, -venue links, and AI billed from the credit wallet', { skip, timeout: 60000 }, async () => {
  const me = await alice.get('/api/billing');
  assert.equal(me.body.plan, 'free'); assert.equal(me.body.limits.venues, 1); assert.equal(me.body.limits.audience, 100);
  assert.equal(me.body.limits.aiDaily, undefined);
  const v1 = await alice.post('/api/venues', { name: 'Main hall', customSlug: 'alice' + crypto.randomBytes(3).toString('hex') });
  assert.equal(v1.status, 200, JSON.stringify(v1.body)); assert.match(v1.body.slug, /-venue$/);
  const v2 = await alice.post('/api/venues', { name: 'Second' });
  assert.equal(v2.status, 403); assert.match(v2.body.error, /Upgrade/);
  const ask = await alice.post('/api/ai/ask', { question: 'hi' });
  assert.equal(ask.status, 200, JSON.stringify(ask.body));
  assert.equal(ask.body.aiLeft, undefined);
  const t = await plans.takeAi({ kind: 'summary', ownerId: bobId });
  assert.equal(t.ok, true); assert.equal(t.cost, 1);
  await db.q('UPDATE credit_wallets SET balance_units=0, plan_balance_units=0 WHERE user_id=$1', [aliceId]);
  const over = await alice.post('/api/ai/translate', { text: 'hello', lang: 'French' });
  assert.equal(over.status, 402); assert.match(over.body.error, /credits/i);
});

test('unsigned AI is denied; a per-IP cap remains as an abuse guard', { skip }, async () => {
  const unsigned = await plans.takeAi({ kind: 'ask', ownerId: null, guestIp: '10.0.0.1' });
  assert.equal(unsigned.ok, false); assert.equal(unsigned.needSignIn, true);
  const host = (await db.q("INSERT INTO users (email, username, display_name, password_hash) VALUES ($1,$2,'Host','x') RETURNING id", [`host${Date.now()}@ex.test`, 'h' + Date.now().toString(36)])).rows[0].id;
  const rates = require('../src/features/wallet/rates');
  await db.q('INSERT INTO credit_wallets(user_id, balance_units) VALUES ($1,$2)', [host, 100 * rates.UNITS_PER_CREDIT]);
  const a = await plans.takeAi({ kind: 'catchup', ownerId: host });
  assert.equal(a.ok, true); assert.equal(a.cost, 1);
  await a.refund();
  plans.clearCache();
  const saved = process.env.AI_GUEST_PER_IP_DAILY; process.env.AI_GUEST_PER_IP_DAILY = '2';
  try {
    plans.clearCache();
    assert.equal((await plans.takeAi({ kind: 'ask', ownerId: host, guestIp: '10.0.0.2' })).ok, true);
    assert.equal((await plans.takeAi({ kind: 'ask', ownerId: host, guestIp: '10.0.0.2' })).ok, true);
    const capped = await plans.takeAi({ kind: 'ask', ownerId: host, guestIp: '10.0.0.2' });
    assert.equal(capped.ok, false); assert.equal(capped.guestCap, true);
    assert.equal((await plans.takeAi({ kind: 'ask', ownerId: host, guestIp: '10.0.0.3' })).ok, true, 'another address is not blocked');
  } finally { if (saved == null) delete process.env.AI_GUEST_PER_IP_DAILY; else process.env.AI_GUEST_PER_IP_DAILY = saved; plans.clearCache(); }
});

test('subscription checkout verifies with Paystack, saves the card and lifts limits', { skip, timeout: 60000 }, async () => {
  assert.equal((await alice.post('/api/billing/checkout', { plan: 'free', interval: 'month' })).status, 400);
  assert.equal((await alice.post('/api/billing/checkout', { plan: 'premium', interval: 'week' })).status, 400);
  const co = await alice.post('/api/billing/checkout', { plan: 'premium', interval: 'month' });
  assert.equal(co.status, 201, JSON.stringify(co.body)); assert.match(co.body.authorizationUrl, /^https:\/\/checkout\.paystack\.com\//);
  const t = txs.get(co.body.reference);
  assert.equal(t.requested_amount, 1500000); assert.equal(t.metadata.kind, 'subscription');
  const pending = await alice.post(`/api/billing/payments/${co.body.reference}/verify`);
  assert.equal(pending.body.status, 'pending'); assert.equal((await alice.get('/api/billing')).body.plan, 'free');
  pay(co.body.reference);
  assert.equal((await bob.post(`/api/billing/payments/${co.body.reference}/verify`)).status, 404, 'others cannot verify my payment');
  const ok = await alice.post(`/api/billing/payments/${co.body.reference}/verify`);
  assert.equal(ok.body.status, 'paid', JSON.stringify(ok.body));
  const me = (await alice.get('/api/billing')).body;
  assert.equal(me.plan, 'pro'); assert.equal(me.limits.venues, 3); assert.equal(me.limits.audience, 300);
  assert.equal(me.subscription.card.last4, '4081'); assert.equal(me.subscription.autoRenew, true); assert.equal(me.subscription.interval, 'month');
  assert.equal((await alice.get('/api/session')).body.user.plan, 'pro');
  const v2 = await alice.post('/api/venues', { name: 'Second hall' });
  assert.equal(v2.status, 200, JSON.stringify(v2.body));
  // a clean link is now allowed on venue 1
  const venues = (await alice.get('/api/venues')).body.venues;
  const first = venues[venues.length - 1];
  const clean = 'hall' + crypto.randomBytes(3).toString('hex');
  const p = await alice.patch(`/api/venues/${first.slug}`, { customSlug: clean });
  assert.equal(p.status, 200, JSON.stringify(p.body)); assert.equal(p.body.slug, clean);
  assert.equal((await alice.post('/api/billing/checkout', { plan: 'premium', interval: 'month' })).status, 409, 'already on this plan');
  // short-link add-on checkout is wired with its own price
  assert.equal((await alice.post('/api/billing/slug-addon', { venueSlug: clean, tier: 'slug2' })).status, 400, 'no 2-character tier');
  const addon = await alice.post('/api/billing/slug-addon', { venueSlug: clean, tier: 'slug4' });
  assert.equal(addon.status, 201, JSON.stringify(addon.body)); assert.equal(txs.get(addon.body.reference).requested_amount, 1000000, '4-character = ₦10,000');
  pay(addon.body.reference);
  assert.equal((await alice.post(`/api/billing/payments/${addon.body.reference}/verify`)).body.status, 'paid');
  assert.equal((await alice.get(`/api/venues/${clean}`)).body.slugTier, 'slug4');
  assert.equal((await alice.post('/api/billing/slug-addon', { venueSlug: clean, tier: 'slug4' })).status, 409, 'already has it');
  const up = await alice.post('/api/billing/slug-addon', { venueSlug: clean, tier: 'slug3' });
  assert.equal(up.status, 201); assert.equal(txs.get(up.body.reference).requested_amount, 2500000, '3-character = ₦25,000');
  pay(up.body.reference);
  assert.equal((await alice.post(`/api/billing/payments/${up.body.reference}/verify`)).body.status, 'paid');
  assert.equal((await alice.get(`/api/venues/${clean}`)).body.slugTier, 'slug3', 'upgrade from 4 to 3 characters');
  assert.equal((await alice.get('/api/billing')).body.plan, 'pro', 'add-on does not change the plan');
});

test('a mismatched verification is held for review and grants nothing; Free users cannot buy short links', { skip }, async () => {
  const co = await bob.post('/api/billing/checkout', { plan: 'organisation', interval: 'year' });
  assert.equal(co.status, 201); assert.equal(txs.get(co.body.reference).requested_amount, 75000000);
  tamper = (t) => { t.requested_amount = 100; };
  pay(co.body.reference);
  assert.equal((await bob.post(`/api/billing/payments/${co.body.reference}/verify`)).status, 409);
  assert.equal((await bob.get('/api/billing')).body.plan, 'free');
  assert.equal((await bob.get('/api/billing')).body.payments[0].status, 'review');
  const v = await bob.post('/api/venues', { name: 'Bob venue' });
  assert.equal((await bob.post('/api/billing/slug-addon', { venueSlug: v.body.slug, tier: 'slug3' })).status, 403);
});

test('renewal charges the saved authorization and extends from the old period end', { skip, timeout: 30000 }, async () => {
  const before = await sub(aliceId);
  const oldEnd = new Date(Date.now() - 60000);
  await db.q('UPDATE subscriptions SET current_period_end=$2 WHERE user_id=$1', [aliceId, oldEnd]);
  const out = await service.processDue(new Date());
  assert.deepEqual(out.find((x) => x.userId === aliceId), { userId: aliceId, result: 'renewed' });
  const after = await sub(aliceId);
  assert.equal(after.status, 'active');
  assert.equal(new Date(after.current_period_end).toISOString(), plans.addInterval(oldEnd, 'month').toISOString());
  assert.equal(after.authorization_code, before.authorization_code);
  const r = (await db.q("SELECT * FROM billing_payments WHERE user_id=$1 AND kind='renewal'", [aliceId])).rows;
  assert.equal(r.length, 1); assert.equal(r[0].status, 'paid'); assert.equal(Number(r[0].price_kobo), 1500000);
});

test('a failed renewal keeps the plan for 5 days of grace, then downgrades by archiving extras and parking clean links', { skip, timeout: 30000 }, async () => {
  decline = true;
  try {
    const end = new Date(Date.now() - 60000);
    await db.q('UPDATE subscriptions SET current_period_end=$2, last_attempt_at=NULL WHERE user_id=$1', [aliceId, end]);
    let out = await service.processDue(new Date());
    assert.equal(out.find((x) => x.userId === aliceId).result, 'grace');
    let row = await sub(aliceId);
    assert.equal(row.status, 'past_due');
    assert.equal(new Date(row.grace_until).getTime(), end.getTime() + 5 * DAY);
    assert.equal((await alice.get('/api/billing')).body.plan, 'pro', 'still Pro during grace');
    out = await service.processDue(new Date());
    assert.equal(out.find((x) => x.userId === aliceId).result, 'waiting', 'retries at most daily');
    out = await service.processDue(new Date(end.getTime() + 2 * DAY));
    assert.equal(out.find((x) => x.userId === aliceId).result, 'grace', 'retry inside grace still fails');
    out = await service.processDue(new Date(end.getTime() + 5 * DAY + 60000));
    assert.equal(out.find((x) => x.userId === aliceId).result, 'expired');
    row = await sub(aliceId);
    assert.equal(row.status, 'expired');
    const me = (await alice.get('/api/billing')).body;
    assert.equal(me.plan, 'free'); assert.equal(me.usage.venues, 1);
    const venues = (await alice.get('/api/venues')).body.venues;
    assert.equal(venues.filter((v) => v.archived).length, 1);
    const kept = venues.find((v) => !v.archived);
    assert.match(kept.slug, /-venue$/); assert.ok(kept.reservedSlug, 'clean link reserved');
    const archived = venues.find((v) => v.archived);
    assert.equal((await bob.get(`/api/venues/${archived.slug}`)).status, 404, 'archived venues are hidden');
    assert.equal((await alice.patch(`/api/venues/${archived.slug}`, { name: 'x' })).status, 403, 'archived venues are read-only');
    // nobody else can take the reserved link
    const steal = await admin.post('/api/venues', { name: 'Thief', customSlug: kept.reservedSlug });
    assert.equal(steal.status, 409);
  } finally { decline = false; }
});

test('admin edits plan settings and grants a plan with overrides, restoring archived venues and links', { skip, timeout: 30000 }, async () => {
  assert.equal((await alice.get('/api/admin/billing/settings')).status, 403);
  const put = (body) => fetch(s.base + '/api/admin/billing/settings', { method: 'PUT', headers: { 'content-type': 'application/json', cookie: admin.jar.header() }, body: JSON.stringify(body) });
  assert.equal((await put({ plans: { pro: { venues: -1 } } })).status, 400);
  const ok = await put({ plans: { pro: { priceMonthKobo: 600000 } } });
  assert.equal(ok.status, 200);
  const pub = (await alice.get('/api/plans')).body;
  assert.equal(pub.plans.find((p) => p.id === 'pro').priceMonthKobo, 600000); assert.equal(pub.aiWeights, undefined);
  assert.equal((await admin.del('/api/admin/billing/settings')).status, 200);
  assert.equal((await alice.get('/api/plans')).body.plans.find((p) => p.id === 'pro').priceMonthKobo, 1500000);

  const found = (await admin.get('/api/admin/billing/users?q=' + encodeURIComponent((await alice.get('/api/session')).body.user.email))).body.users;
  assert.equal(found[0].id, aliceId);
  assert.equal((await admin.post(`/api/admin/billing/users/${aliceId}`, { plan: 'organisation' })).status, 400, 'reason required');
  const g = await admin.post(`/api/admin/billing/users/${aliceId}`, { plan: 'organisation', overrides: { venues: 25 }, reason: 'partner church' });
  assert.equal(g.status, 200, JSON.stringify(g.body));
  assert.equal(g.body.plan, 'organisation'); assert.equal(g.body.limits.venues, 25); assert.equal(g.body.limits.audience, 1000); assert.equal(g.body.limits.speakerSeats, 10);
  assert.equal(g.body.subscription.status, 'comp');
  const venues = (await alice.get('/api/venues')).body.venues;
  assert.equal(venues.filter((v) => v.archived).length, 0, 'archived venue restored');
  assert.ok(venues.every((v) => !v.reservedSlug), 'clean link restored');
  assert.ok(g.body.audit.some((a) => a.action === 'admin_plan'));
  const vt = await admin.post(`/api/admin/billing/venues/${venues[0].id}`, { slugTier: 'slug4', reason: 'gift' });
  assert.equal(vt.status, 200); assert.equal(vt.body.slugTier, 'slug4');
  assert.equal((await admin.post(`/api/admin/billing/venues/${venues[0].id}`, { slugTier: 'slug2', reason: 'gift' })).status, 400);
  const back = await admin.post(`/api/admin/billing/users/${aliceId}`, { plan: 'free', overrides: null, reason: 'trial over' });
  assert.equal(back.body.plan, 'free'); assert.deepEqual(back.body.overrides, {});
});

test('cancel and downgrade take effect at period end', { skip, timeout: 30000 }, async () => {
  const co = await bob.post('/api/billing/checkout', { plan: 'organisation', interval: 'month' });
  pay(co.body.reference);
  assert.equal((await bob.post(`/api/billing/payments/${co.body.reference}/verify`)).body.status, 'paid');
  assert.equal((await bob.post('/api/billing/checkout', { plan: 'premium', interval: 'month' })).status, 409, 'downgrades are scheduled, not bought');
  const ch = await bob.post('/api/billing/change', { plan: 'premium', interval: 'year' });
  assert.equal(ch.body.pendingPlan, 'pro'); assert.equal((await bob.get('/api/billing')).body.plan, 'organisation');
  await db.q('UPDATE subscriptions SET current_period_end=$2 WHERE user_id=$1', [bobId, new Date(Date.now() - 1000)]);
  await service.processDue(new Date());
  const row = await sub(bobId);
  assert.equal(row.plan, 'pro'); assert.equal(row.billing_interval, 'year'); assert.equal(row.pending_plan, null);
  const last = (await db.q("SELECT price_kobo FROM billing_payments WHERE user_id=$1 AND kind='renewal' ORDER BY id DESC", [bobId])).rows[0];
  assert.equal(Number(last.price_kobo), 15000000);
  assert.equal((await bob.post('/api/billing/cancel')).body.cancelAtPeriodEnd, true);
  assert.equal((await bob.post('/api/billing/resume')).body.cancelAtPeriodEnd, false);
  await bob.post('/api/billing/cancel');
  await db.q('UPDATE subscriptions SET current_period_end=$2 WHERE user_id=$1', [bobId, new Date(Date.now() - 1000)]);
  assert.equal((await service.processDue(new Date())).find((x) => x.userId === bobId).result, 'expired');
  assert.equal((await bob.get('/api/billing')).body.plan, 'free');
});
