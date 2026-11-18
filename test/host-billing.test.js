'use strict';
process.env.PROCESSING_FEE_PERCENT = '1.5';
// Host tools + billing round: analytics/export date ranges, per-placement promotion pricing (server-side),
// extend/pause, rich promotion cards, separate payout bank fields (+ best-effort parse of old text),
// billing history, receipts and removing the saved card.
const secretKey = 'sk_test_host_billing';
Object.assign(process.env, { PAYSTACK_SECRET_KEY: secretKey, PAYSTACK_PASS_FEES_CONFIRMED: 'true', PUBLIC_URL: 'http://127.0.0.1:9', NODE_ENV: 'test', REMINDER_WORKER: 'false', REPLAY_WORKER: 'false' });
delete process.env.PAYSTACK_WEBHOOK_SECRET;
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const { boot, client, signupPayload } = require('./helpers/server');
const skip = !process.env.DATABASE_URL && process.env.DB_DRIVER !== 'sqlite' ? 'set DATABASE_URL or DB_DRIVER=sqlite' : false;
const plans = require('../src/lib/plans');
const { parseRange, bucket } = require('../src/features/exports/service');
const banks = require('../src/lib/banks');

// ---------------------------------------------------------------- unit
test('range params: presets, custom from/to, and validation', () => {
  const now = Date.parse('2026-11-17T12:00:00Z');
  const r7 = parseRange({ days: '7' }, now);
  assert.equal(r7.fromDay, '2026-11-11'); assert.equal(r7.toDay, '2026-11-17'); assert.equal(r7.days, 7); assert.equal(r7.preset, 7);
  assert.equal(parseRange({}, now).days, 30, 'default 30 days');
  assert.equal(parseRange(new URLSearchParams('days=90'), now).fromDay, '2026-08-20');
  const c = parseRange({ from: '2026-10-01', to: '2026-10-31' }, now);
  assert.equal(c.days, 31); assert.equal(c.preset, null); assert.equal(c.until.toISOString(), '2026-11-01T00:00:00.000Z');
  assert.equal(parseRange({ from: '2026-11-10' }, now).toDay, '2026-11-17', 'missing to = today');
  for (const bad of [{ days: '0' }, { days: '400' }, { days: 'abc' }, { from: '2026-13-01', to: '2026-12-01' }, { from: '2026-02-30', to: '2026-03-01' }, { from: '2026-11-10', to: '2026-11-01' },
    { from: '2026-11-01', to: '2026-11-30' }, { from: '2024-01-01', to: '2026-11-01' }, { from: '1/1/2026', to: '2026-02-01' }]) {
    assert.throws(() => parseRange(bad, now), (e) => e.status === 400, JSON.stringify(bad));
  }
  const b = bucket(['2026-11-11T05:00:00Z', '2026-11-11T09:00:00Z', '2026-11-17T23:59:00Z', '2026-11-18T00:00:00Z'], 7, r7.from.getTime());
  assert.deepEqual(b.map((d) => d.n), [2, 0, 0, 0, 0, 0, 1]);
});

test('promotion pricing: placement rates x days with duration discounts, admin-configurable', () => {
  const s = plans.envDefaults();
  assert.equal(plans.promoQuote(s, { days: 3 }).priceKobo, 300000, 'all placements = the old ₦1,000/day');
  const q = plans.promoQuote(s, { days: 7, placements: 'feed' });
  assert.equal(q.grossKobo, 7 * 30000); assert.equal(q.discountPercent, 10); assert.equal(q.priceKobo, 189000);
  assert.equal(plans.promoQuote(s, { days: 14, placements: ['feed', 'discover'] }).discountPercent, 15);
  assert.equal(plans.promoQuote(s, { days: 30, placements: ['books'] }).discountPercent, 25);
  assert.equal(plans.promoQuote(s, { days: 6, placements: ['books'] }).discountPercent, 0);
  assert.deepEqual(plans.promoQuote(s, { days: 2, placements: ['books', 'discover', 'books'] }).placements.map((l) => l.id), ['discover', 'books'], 'deduped, fixed order');
  assert.equal(plans.promoQuote(s, { days: 90, placements: ['books'] }).days, 90);
  for (const bad of [{ days: 0 }, { days: 91 }, { days: 1.5 }, { days: 3, placements: ['homepage'] }]) assert.throws(() => plans.promoQuote(s, bad), (e) => e.status === 400, JSON.stringify(bad));
  const m = plans.mergeSettings(s, { promoPricing: { feed: 50000, books: 0, tier1Days: 5, tier1Pct: 20 } });
  assert.equal(plans.promoQuote(m, { days: 5, placements: ['feed'] }).priceKobo, 200000);
  assert.throws(() => plans.promoQuote(m, { days: 5, placements: ['books'] }), (e) => e.status === 400, 'a zero rate is switched off');
  assert.throws(() => plans.mergeSettings(s, { promoPricing: { tier1Pct: 95 } }), (e) => e.status === 400);
  assert.throws(() => plans.mergeSettings(s, { promoPricing: { hero: 1 } }), (e) => e.status === 400);
  assert.throws(() => plans.mergeSettings(s, { promoPricing: { discover: 0, feed: 0, venues: 0, books: 0 } }), (e) => e.status === 400);
  process.env.PROMO_RATE_FEED_KOBO = '45000'; process.env.PROMO_TIER2_PERCENT = '20'; process.env.PLATFORM_PROMO_MAX_DAYS = '14';
  try { const e = plans.envDefaults(); assert.equal(plans.promoPricing(e).feed, 45000); assert.equal(plans.promoQuote(e, { days: 14, placements: ['feed'] }).discountPercent, 20); assert.equal(e.platform.promoMaxDays, 14); assert.throws(() => plans.promoQuote(e, { days: 15, placements: ['feed'] }), (err) => err.status === 400); }
  finally { delete process.env.PROMO_RATE_FEED_KOBO; delete process.env.PROMO_TIER2_PERCENT; delete process.env.PLATFORM_PROMO_MAX_DAYS; }
  assert.deepEqual(plans.scaledRates(200000), { feed: 60000, venues: 40000, books: 30000, discover: 70000 });
});

test('bank details: separate fields validate; old one-box text is split best-effort', () => {
  assert.deepEqual(banks.cleanBankFields({ bankName: 'Zenith Bank', accountNumber: '01234 56789', accountName: ' Ada  Obi ' }), { bankName: 'Zenith Bank', accountNumber: '0123456789', accountName: 'Ada Obi', bankDetails: 'Zenith Bank · 0123456789 · Ada Obi' });
  for (const bad of [{ bankName: '', accountNumber: '0123456789', accountName: 'Ada' }, { bankName: 'Zenith', accountNumber: '012345678', accountName: 'Ada' }, { bankName: 'Zenith', accountNumber: '01234567890', accountName: 'Ada' }, { bankName: 'Zenith', accountNumber: 'abcdefghij', accountName: 'Ada' }, { bankName: 'Zenith', accountNumber: '0123456789', accountName: '1' }]) {
    assert.throws(() => banks.cleanBankFields(bad), (e) => e.status === 400, JSON.stringify(bad));
  }
  assert.deepEqual(banks.parseBankText('GTB 0123456789 Alice'), { bankName: 'Guaranty Trust Bank (GTBank)', accountNumber: '0123456789', accountName: 'Alice', complete: true });
  assert.equal(banks.parseBankText('Bank: Access, Acc No: 0011223344, Name: Tunde Bakare').accountName, 'Tunde Bakare');
  assert.equal(banks.parseBankText('Lagos Coop Bank 1234567890 Mary').bankName, 'Lagos Coop Bank');
  assert.equal(banks.parseBankText('call me').complete, false);
  assert.ok(banks.NAMES.includes('OPay') && banks.NAMES.length > 30);
});

// ---------------------------------------------------------------- integration
let gw, s, db, host, other, admin, ids = {};
const txs = new Map();
let nextId = crypto.randomInt(1e9, 1e12);
async function jsonBody(req) { const c = []; for await (const x of req) c.push(x); return JSON.parse(Buffer.concat(c).toString() || '{}'); }
const pay = (ref) => Object.assign(txs.get(ref), { status: 'success', paid_at: new Date().toISOString(), amount: txs.get(ref).requested_amount });
const refOf = (url) => url.split('/').pop();

test.before(async () => {
  if (skip) return;
  db = require('../db');
  gw = http.createServer(async (req, res) => {
    const reply = (st, b) => { res.writeHead(st, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(b)); };
    if (req.headers.authorization !== `Bearer ${secretKey}`) return reply(401, { status: false });
    if (req.url === '/transaction/initialize') {
      const b = await jsonBody(req);
      txs.set(b.reference, { id: nextId++, reference: b.reference, requested_amount: b.amount, amount: b.amount, fees: 0, currency: 'NGN', status: 'pending', domain: 'test', metadata: b.metadata, customer: { email: b.email } });
      return reply(200, { status: true, data: { reference: b.reference, authorization_url: `https://checkout.paystack.com/${b.reference}`, access_code: 'x' } });
    }
    if (req.url.startsWith('/transaction/verify/')) return reply(200, { status: true, data: txs.get(decodeURIComponent(req.url.split('/').pop())) });
    reply(404, {});
  });
  await new Promise((r) => gw.listen(0, '127.0.0.1', r));
  process.env.PAYSTACK_API_URL = `http://127.0.0.1:${gw.address().port}`;
  const adminBody = signupPayload();
  s = await boot({ PAYSTACK_API_URL: process.env.PAYSTACK_API_URL, ADMIN_EMAILS: adminBody.email, BILLING_WORKER: 'false', REMINDER_WORKER: 'false', REPLAY_WORKER: 'false' });
  host = client(s.base); other = client(s.base); admin = client(s.base);
  for (const [c, k] of [[host, 'host'], [other, 'other']]) {
    const body = signupPayload();
    assert.equal((await c.post('/api/signup', body)).status, 201);
    ids[k] = (await c.get('/api/session')).body.user.id;
  }
  await admin.post('/api/signup', adminBody);
  await admin.post('/api/auth/verify-email', { token: new URL(await s.mailLink(adminBody.email, /Confirm your email/)).searchParams.get('token') });
  assert.equal((await admin.post(`/api/admin/billing/users/${ids.host}`, { plan: 'organisation', reason: 'host tools test' })).status, 200);
});
test.after(async () => { if (s) await s.stop(); if (gw) await new Promise((r) => gw.close(r)); if (db) await db.close(); });
const raw = (c, p) => fetch(s.base + p, { headers: { cookie: c.jar.header() } });
const newEvent = async (c) => {
  const r = await c.post('/api/events', { title: 'Host round ' + crypto.randomBytes(3).toString('hex'), category: 'seminar', visibility: 'public', startsAt: new Date(Date.now() + 2 * 864e5).toISOString() });
  assert.ok(r.status === 200 || r.status === 201, JSON.stringify(r.body)); return r.body;
};

test('analytics + exports follow the range; bad ranges are 400; free users are refused', { skip, timeout: 60000 }, async () => {
  const old = new Date(Date.now() - 20 * 864e5).toISOString(), recent = new Date(Date.now() - 2 * 864e5).toISOString();
  const mk = async (name, at, peak) => (await db.q('INSERT INTO meeting_history (code, name, host_user_id, max_participants, created_at) VALUES ($1,$2,$3,$4,$5) RETURNING id', ['hb-' + crypto.randomBytes(3).toString('hex'), name, ids.host, peak, at])).rows[0].id;
  const hOld = await mk('Old session', old, 9), hNew = await mk('Recent session', recent, 4);
  await db.q("INSERT INTO meeting_participants_log (meeting_history_id, user_id, display_name, joined_at, left_at) VALUES ($1, $2, 'Other', $3, $3)", [hOld, ids.other, old]);
  await db.q("INSERT INTO meeting_participants_log (meeting_history_id, display_name, joined_at) VALUES ($1, 'Guest, \"Q\"', $2)", [hNew, recent]);
  await db.q("INSERT INTO chat_messages (meeting_history_id, sender_name, body, created_at) VALUES ($1, 'Guest', '=1+1 Hello', $2)", [hNew, recent]);
  const a7 = await host.get('/api/host/analytics?days=7');
  assert.equal(a7.status, 200, JSON.stringify(a7.body));
  assert.equal(a7.body.audienceByDay.length, 7); assert.equal(a7.body.range.preset, 7);
  assert.equal(a7.body.totals.sessions, 1); assert.equal(a7.body.totals.joins, 1); assert.equal(a7.body.totals.peak, 4);
  assert.equal(a7.body.engagement.chat, 1); assert.equal(a7.body.registrationsByDay.length, 7); assert.equal(a7.body.peakByDay.length, 7);
  const a30 = (await host.get('/api/host/analytics?days=30')).body;
  assert.equal(a30.totals.sessions, 2); assert.equal(a30.totals.peak, 9);
  const day = (ms) => new Date(ms).toISOString().slice(0, 10);
  const custom = (await host.get(`/api/host/analytics?from=${day(Date.now() - 25 * 864e5)}&to=${day(Date.now() - 10 * 864e5)}`)).body;
  assert.equal(custom.totals.sessions, 1); assert.equal(custom.range.days, 16); assert.equal(custom.audienceByDay.length, 16);
  for (const q of ['days=0', 'days=999', 'from=2026-02-30&to=2026-03-02', `from=${day(Date.now())}&to=${day(Date.now() - 864e5)}`, `from=${day(Date.now())}&to=${day(Date.now() + 5 * 864e5)}`]) {
    assert.equal((await host.get('/api/host/analytics?' + q)).status, 400, q);
    assert.equal((await raw(host, '/api/exports/sessions?' + q)).status, 400, 'export ' + q);
  }
  const sum = (await host.get('/api/host/exports?days=7')).body;
  const rowsOf = (id) => sum.exports.find((x) => x.id === id);
  assert.equal(rowsOf('sessions').rows, 1); assert.equal(rowsOf('attendance').rows, 1); assert.equal(rowsOf('chat').rows, 1); assert.ok(rowsOf('chat').lastAt);
  assert.equal(sum.sessions.length, 1); assert.equal(sum.sessions[0].chatMessages, 1);
  const csv7 = await (await raw(host, '/api/exports/sessions?days=7')).text();
  assert.match(csv7, /Recent session/); assert.doesNotMatch(csv7, /Old session/);
  assert.match(await (await raw(host, '/api/exports/sessions?days=30')).text(), /Old session/);
  const att = await raw(host, '/api/exports/attendance?days=7');
  assert.equal(att.status, 200); assert.match(att.headers.get('content-disposition'), /attendance-\d{4}-\d{2}-\d{2}-to-/);
  assert.match(await att.text(), /"Guest, ""Q"""/);
  assert.match(await (await raw(host, '/api/exports/chat?days=7')).text(), /'=1\+1/, 'formula guard');
  assert.match(await (await raw(host, `/api/exports/chat/${hNew}`)).text(), /Hello/);
  const x = await raw(host, '/api/exports/registrations?days=90&format=xlsx');
  assert.equal(x.status, 200); assert.equal(Buffer.from(await x.arrayBuffer()).readUInt32LE(0), 0x04034b50);
  assert.equal((await raw(host, '/api/exports/transcripts?days=7')).status, 200);
  assert.equal((await other.get('/api/host/analytics?days=7')).status, 403);
  assert.equal((await raw(other, '/api/exports/attendance?days=7')).status, 403);
  assert.equal((await raw(other, `/api/exports/chat/${hNew}`)).status, 404);
  assert.equal((await fetch(s.base + '/api/host/exports')).status, 401);
});

test('promote: server prices placements x days, fee and display currency; extend and pause my own', { skip, timeout: 60000 }, async () => {
  const ev = await newEvent(host);
  const q = (await host.get('/api/promote/quote?days=7&placements=feed,discover')).body;
  assert.equal(q.grossKobo, 7 * 65000); assert.equal(q.discountPercent, 10); assert.equal(q.subtotalKobo, 409500);
  assert.equal(q.processingFeeKobo, Math.round(409500 * 0.015)); assert.equal(q.totalKobo, q.subtotalKobo + q.processingFeeKobo); assert.equal(q.displayCurrency, 'NGN');
  assert.equal((await host.get('/api/promote/quote?days=3&placements=hero')).status, 400);
  const st = await host.post('/api/promote', { eventId: ev.id, days: 7, placements: ['feed', 'discover'], priceKobo: 1 });
  assert.equal(st.status, 201, JSON.stringify(st.body));
  assert.equal(st.body.subtotalKobo, 409500, 'client price is ignored');
  const ref = refOf(st.body.authorizationUrl); assert.equal(txs.get(ref).requested_amount, q.totalKobo);
  pay(ref); assert.equal((await host.post(`/api/commerce/payments/${ref}/verify`, {})).body.status, 'paid');
  let p = (await host.get('/api/promote/mine')).body.promotions.find((x) => x.eventId === ev.id);
  assert.deepEqual(p.placements.sort(), ['discover', 'feed']); assert.equal(p.state, 'pending');
  assert.equal((await host.post(`/api/promote/${p.id}/pause`, { paused: true })).status, 409, 'not before review');
  assert.equal((await admin.post(`/api/admin/promotions/${p.id}/review`, { decision: 'approve' })).status, 200);
  p = (await host.get('/api/promote/mine')).body.promotions.find((x) => x.id === p.id);
  assert.equal(p.state, 'live'); assert.equal(p.totalDays, 7); assert.ok(p.daysLeft > 6.9); assert.equal(p.canPause, true);
  assert.equal((await other.post(`/api/promote/${p.id}/pause`, { paused: true })).status, 404, 'not yours');
  const paused = await host.post(`/api/promote/${p.id}/pause`, { paused: true });
  assert.equal(paused.status, 200); assert.equal(paused.body.state, 'paused');
  assert.equal((await host.post(`/api/promote/${p.id}/pause`, { paused: false })).body.state, 'live');
  // extend by 3 days (no discount at 3 days), same placements
  const ex = await host.post('/api/promote', { extendId: p.id, days: 3 });
  assert.equal(ex.status, 201, JSON.stringify(ex.body)); assert.equal(ex.body.subtotalKobo, 3 * 65000);
  assert.equal((await other.post('/api/promote', { extendId: p.id, days: 3 })).status, 404);
  const xr = refOf(ex.body.authorizationUrl); pay(xr); await host.post(`/api/commerce/payments/${xr}/verify`, {});
  const after = (await host.get('/api/promote/mine')).body.promotions.find((x) => x.id === p.id);
  assert.equal(after.totalDays, 10); assert.equal(after.days, 10);
  assert.equal((await host.get('/api/promote/mine')).body.promotions.filter((x) => x.eventId === ev.id).length, 1, 'extend does not create a new promotion');
  // admin pricing saved in the DB drives the quote
  assert.equal((await admin.put('/api/admin/billing/settings', { promoPricing: { feed: 10000, tier1Days: 2, tier1Pct: 50 } })).status, 200);
  assert.equal((await host.get('/api/promote/quote?days=2&placements=feed')).body.subtotalKobo, 10000);
  assert.equal((await host.get('/api/plans')).body.promoPricing.rates.feed, 10000);
  await admin.put('/api/admin/billing/settings', { promoPricing: { feed: 30000, tier1Days: 7, tier1Pct: 10 } });
});

test('payouts: separate bank fields, old text parsed best-effort, admin sees the fields', { skip, timeout: 60000 }, async () => {
  assert.equal((await admin.put('/api/admin/billing/settings', { platform: { payoutMinKobo: 10000 } })).status, 200);
  await db.q("INSERT INTO host_ledger (host_user_id, kind, gross_kobo, fee_kobo, net_kobo) VALUES ($1, 'donation', 100000, 0, 100000)", [ids.host]);
  assert.equal((await host.post('/api/earnings/payouts', { amountKobo: 20000, bankName: 'Zenith Bank', accountNumber: '12345', accountName: 'Host' })).status, 400, '10 digits');
  assert.equal((await host.post('/api/earnings/payouts', { amountKobo: 20000, bankName: '', accountNumber: '0123456789', accountName: 'Host' })).status, 400);
  const r = await host.post('/api/earnings/payouts', { amountKobo: 20000, bankName: 'Zenith Bank', accountNumber: '0123456789', accountName: 'Host Person' });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.deepEqual(r.body.bank, { bankName: 'Zenith Bank', accountNumber: '0123456789', accountName: 'Host Person', source: 'entered' });
  assert.equal(r.body.bankDetails, 'Zenith Bank · 0123456789 · Host Person');
  // an older combined row, written before the split: parsed on read, the original text kept
  const legacy = (await db.q("INSERT INTO payout_requests (host_user_id, amount_kobo, status, bank_details) VALUES ($1, 5000, 'paid', 'UBA 2233445566 Old Name') RETURNING id", [ids.host])).rows[0].id;
  const e = (await host.get('/api/earnings')).body;
  const lp = e.payouts.find((x) => x.id === Number(legacy));
  assert.equal(lp.bank.bankName, 'United Bank for Africa (UBA)'); assert.equal(lp.bank.accountNumber, '2233445566'); assert.equal(lp.bank.source, 'parsed'); assert.equal(lp.bankDetails, 'UBA 2233445566 Old Name');
  assert.ok(e.banks.includes('Zenith Bank')); assert.equal(e.lastBank.accountNumber, '0123456789');
  const list = (await admin.get('/api/admin/payouts?status=requested')).body.payouts;
  assert.equal(list.find((x) => x.id === r.body.id).bank.accountName, 'Host Person');
  assert.equal((await admin.post(`/api/admin/payouts/${r.body.id}`, { action: 'paid', reference: 'TRF-9' })).status, 200);
  const legacyText = await host.post('/api/earnings/payouts', { amountKobo: 10000, bankDetails: 'Kuda 9988776655 Host P' });
  assert.equal(legacyText.status, 201); assert.equal(legacyText.body.bank.bankName, 'Kuda Microfinance Bank');
});

test('billing: history across purchases, receipts for paid ones only, saved card removal', { skip, timeout: 60000 }, async () => {
  const h = (await host.get('/api/billing/history')).body.payments;
  const promo = h.find((x) => x.kind === 'Promotion' && x.status === 'paid' && /^7 days/.test(x.what));
  assert.ok(promo, JSON.stringify(h.slice(0, 3))); assert.match(promo.what, /7 days promoting/); assert.ok(promo.receipt);
  const rc = await raw(host, promo.receipt);
  assert.equal(rc.status, 200); assert.match(rc.headers.get('content-type'), /text\/html/); assert.match(rc.headers.get('content-security-policy'), /default-src 'none'/);
  const html = await rc.text(); assert.match(html, /Receipt/); assert.match(html, /Processing fee \(1\.5%\)/);
  assert.equal((await raw(other, promo.receipt)).status, 404, 'not yours');
  assert.equal((await fetch(s.base + promo.receipt)).status, 401);
  const pending = await host.post('/api/promote', { eventId: (await newEvent(host)).id, days: 1, placements: ['books'] });
  const pr = (await host.get('/api/billing/history')).body.payments.find((x) => x.reference === pending.body.reference);
  assert.equal(pr.status, 'pending'); assert.equal(pr.receipt, null); assert.ok(pr.authorizationUrl);
  assert.equal((await raw(host, `/api/billing/receipts/${pending.body.reference}`)).status, 404);
  assert.equal((await host.del('/api/billing/card')).status, 404, 'no card yet');
  await db.q("UPDATE subscriptions SET authorization_code='AUTH_test1234', card_last4='4081', card_brand='visa' WHERE user_id=$1", [ids.host]);
  assert.equal((await host.get('/api/billing')).body.subscription.card.last4, '4081');
  const rm = await host.del('/api/billing/card');
  assert.equal(rm.status, 200); assert.equal(rm.body.subscription.card, null); assert.equal(rm.body.subscription.autoRenew, false);
});
