'use strict';
process.env.PROCESSING_FEE_PERCENT = '0'; // these suites pin the original price maths; the fee is covered in test/settings-wallet.test.js
// Phase 2 and 3: feature gating, fee math, org permissions, recurring series, reminder idempotency,
// exports, branding, verified badge, tickets, donations, promotions, payouts and refunds.
const secretKey = 'sk_test_phase3_fixture';
Object.assign(process.env, { PAYSTACK_SECRET_KEY: secretKey, PAYSTACK_PASS_FEES_CONFIRMED: 'true', PUBLIC_URL: 'http://127.0.0.1:9', NODE_ENV: 'test', REMINDER_WORKER: 'false', REPLAY_WORKER: 'false' });
delete process.env.PAYSTACK_WEBHOOK_SECRET;
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const { boot, client, signupPayload } = require('./helpers/server');
const skip = !process.env.DATABASE_URL && process.env.DB_DRIVER !== 'sqlite' ? 'set DATABASE_URL or DB_DRIVER=sqlite' : false;
const plans = require('../src/lib/plans');
const orgs = require('../src/features/orgs/service');
const { occurrences } = require('../src/features/recurring/series');
const { dueLead } = require('../src/features/recurring/reminders');
const { csv, xlsx } = require('../src/lib/xlsx');
const { cleanBranding } = require('../src/features/branding/service');

// ---------------------------------------------------------------- unit
test('plan features: defaults, env fallback and admin overrides through the plans module', () => {
  const s = plans.envDefaults();
  const free = plans.featuresFor(s, 'free'), prem = plans.featuresFor(s, 'premium'), org = plans.featuresFor(s, 'organisation');
  for (const k of ['branding', 'recurring', 'reminders', 'exports', 'analytics', 'badge', 'ticketing', 'replays']) assert.equal(free[k], false, 'free ' + k);
  assert.equal(free.selfPromo, true);
  for (const k of ['branding', 'recurring', 'reminders', 'exports', 'analytics', 'badge']) assert.equal(prem[k], true, 'premium ' + k);
  assert.equal(prem.ticketing, false); assert.equal(prem.orgMembers, 0);
  assert.equal(org.ticketing, true); assert.equal(org.replays, true); assert.ok(org.orgMembers > 0);
  const m = plans.mergeSettings(s, { features: { premium: { ticketing: 1, orgMembers: 3 } }, platform: { feeBps: 750 } });
  assert.equal(plans.featuresFor(m, 'premium').ticketing, true); assert.equal(plans.featuresFor(m, 'premium').orgMembers, 3); assert.equal(plans.platform(m).feeBps, 750);
  for (const bad of [{ features: { gold: {} } }, { features: { free: { flying: 1 } } }, { platform: { feeBps: -1 } }, { platform: { feeBps: 999999 } }, { platform: { nope: 1 } }]) {
    assert.throws(() => plans.mergeSettings(s, bad), (e) => e.status === 400, JSON.stringify(bad));
  }
  process.env.PLATFORM_FEE_BPS = '300'; process.env.PLAN_PREMIUM_TICKETING = '1';
  try { const e = plans.envDefaults(); assert.equal(plans.platform(e).feeBps, 300); assert.equal(plans.featuresFor(e, 'premium').ticketing, true); }
  finally { delete process.env.PLATFORM_FEE_BPS; delete process.env.PLAN_PREMIUM_TICKETING; }
  assert.equal(plans.platform(s).feeBps, 500, 'default fee 5%');
});

test('fee math: split rounds half up to the kobo and never loses money', () => {
  assert.deepEqual(plans.feeSplit(10000, 500), { gross: 10000, fee: 500, net: 9500 });
  assert.deepEqual(plans.feeSplit(5000, 500), { gross: 5000, fee: 250, net: 4750 });
  assert.deepEqual(plans.feeSplit(10010, 500), { gross: 10010, fee: 501, net: 9509 });
  assert.deepEqual(plans.feeSplit(10, 500), { gross: 10, fee: 1, net: 9 });
  assert.deepEqual(plans.feeSplit(12345, 0), { gross: 12345, fee: 0, net: 12345 });
  for (let i = 0; i < 500; i++) { const g = crypto.randomInt(0, 1e9), b = crypto.randomInt(0, 3000); const r = plans.feeSplit(g, b); assert.equal(r.fee + r.net, g); assert.ok(r.fee >= 0 && r.net >= 0); }
});

test('org permissions: owner > admin > moderator, admins manage moderators only', () => {
  assert.equal(orgs.can('moderator', 'venue.open'), true);
  assert.equal(orgs.can('moderator', 'members.invite'), false);
  assert.equal(orgs.can('admin', 'members.invite'), true);
  assert.equal(orgs.can('admin', 'org.delete'), false);
  assert.equal(orgs.can('owner', 'org.delete'), true);
  assert.equal(orgs.can(null, 'org.view'), false);
  assert.equal(orgs.canManageRole('admin', 'moderator'), true);
  assert.equal(orgs.canManageRole('admin', 'admin'), false);
  assert.equal(orgs.canManageRole('owner', 'admin'), true);
  assert.equal(orgs.canManageRole('owner', 'owner'), false);
  assert.equal(orgs.canManageRole('moderator', 'moderator'), false);
});

test('recurring occurrences: weekly, biweekly, monthly clamping, count and until', () => {
  const w = occurrences({ firstStart: '2026-01-05T18:00:00Z', pattern: 'weekly', count: 3 });
  assert.deepEqual(w.map((d) => d.toISOString().slice(0, 10)), ['2026-01-05', '2026-01-12', '2026-01-19']);
  const b = occurrences({ firstStart: '2026-01-05T18:00:00Z', pattern: 'biweekly', until: '2026-02-03T00:00:00Z' });
  assert.deepEqual(b.map((d) => d.toISOString().slice(0, 10)), ['2026-01-05', '2026-01-19', '2026-02-02']);
  const m = occurrences({ firstStart: '2026-01-31T10:00:00Z', pattern: 'monthly', count: 4 });
  assert.deepEqual(m.map((d) => d.toISOString().slice(0, 10)), ['2026-01-31', '2026-02-28', '2026-03-31', '2026-04-30']);
  assert.equal(occurrences({ firstStart: '2026-01-01T00:00:00Z', pattern: 'weekly', count: 500, max: 52 }).length, 52);
  assert.throws(() => occurrences({ firstStart: '2026-01-01', pattern: 'daily', count: 2 }), (e) => e.status === 400);
  assert.throws(() => occurrences({ firstStart: '2026-01-01', pattern: 'weekly' }), (e) => e.status === 400);
});

test('reminder leads: picks the nearest open lead, nothing after start', () => {
  const now = Date.parse('2026-03-01T12:00:00Z'), min = 60000, leads = [1440, 60];
  assert.equal(dueLead(now + 2000 * min, now, leads), null);
  assert.equal(dueLead(now + 1000 * min, now, leads), 1440);
  assert.equal(dueLead(now + 59 * min, now, leads), 60, 'late server sends only the 1h reminder');
  assert.equal(dueLead(now - min, now, leads), null);
});

test('exports: CSV guards formulas and XLSX is a valid zip with the sheet', () => {
  const c = csv([['Name', 'Note'], ['=HYPERLINK("x")', 'a,b'], ['Ada', null]]);
  assert.ok(c.startsWith('\uFEFF'));
  assert.match(c, /"'=HYPERLINK\(""x""\)","a,b"/);
  const buf = xlsx([['Name', 'Minutes'], ['Ada <&>', 42]], 'Attendance');
  assert.equal(buf.readUInt32LE(0), 0x04034b50);
  const names = []; let off = 0;
  while (buf.readUInt32LE(off) === 0x04034b50) {
    const comp = buf.readUInt32LE(off + 18), nl = buf.readUInt16LE(off + 26), xl = buf.readUInt16LE(off + 28), method = buf.readUInt16LE(off + 8);
    const name = buf.slice(off + 30, off + 30 + nl).toString(); const data = buf.slice(off + 30 + nl + xl, off + 30 + nl + xl + comp);
    names.push(name);
    if (name === 'xl/worksheets/sheet1.xml') { const xml = (method === 8 ? zlib.inflateRawSync(data) : data).toString(); assert.match(xml, /Ada &lt;&amp;&gt;/); assert.match(xml, /<v>42<\/v>/); }
    off += 30 + nl + xl + comp;
  }
  for (const n of ['[Content_Types].xml', 'xl/workbook.xml', 'xl/worksheets/sheet1.xml']) assert.ok(names.includes(n), n);
});

test('branding input: hex colours and safe image links only', () => {
  assert.deepEqual(cleanBranding({ accent: '#AABBCC', about: '  Hi  ' }), { brand_accent: '#aabbcc', brand_about: 'Hi' });
  assert.equal(cleanBranding({ logoUrl: '/files/abc/logo.png' }).brand_logo_url, '/files/abc/logo.png');
  for (const bad of [{ accent: 'red' }, { logoUrl: 'javascript:alert(1)' }, { coverUrl: 'http://evil.test/x.png' }]) assert.throws(() => cleanBranding(bad), (e) => e.status === 400);
});

// ---------------------------------------------------------------- integration (real server + mock Paystack)
let gateway, s, db, alice, bob, carol, admin, ids = {};
const txs = new Map();
let nextId = crypto.randomInt(1e9, 1e12);
async function jsonBody(req) { const c = []; for await (const x of req) c.push(x); return JSON.parse(Buffer.concat(c).toString() || '{}'); }
const pay = (ref) => Object.assign(txs.get(ref), { status: 'success', paid_at: new Date().toISOString() });
const refOf = (url) => url.split('/').pop();

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
    if (req.url.startsWith('/transaction/verify/')) return reply(200, { status: true, data: txs.get(decodeURIComponent(req.url.split('/').pop())) });
    reply(404, {});
  });
  await new Promise((r) => gateway.listen(0, '127.0.0.1', r));
  process.env.PAYSTACK_API_URL = `http://127.0.0.1:${gateway.address().port}`;
  const adminBody = signupPayload();
  s = await boot({ PAYSTACK_API_URL: process.env.PAYSTACK_API_URL, ADMIN_EMAILS: adminBody.email, BILLING_WORKER: 'false', REMINDER_WORKER: 'false', REPLAY_WORKER: 'false' });
  alice = client(s.base); bob = client(s.base); carol = client(s.base); admin = client(s.base);
  for (const [c, k] of [[alice, 'alice'], [bob, 'bob'], [carol, 'carol']]) {
    const body = signupPayload();
    assert.equal((await c.post('/api/signup', body)).status, 201);
    const me = (await c.get('/api/session')).body.user; ids[k] = me.id; ids[k + 'Email'] = body.email;
  }
  await admin.post('/api/signup', adminBody);
  await admin.post('/api/auth/verify-email', { token: new URL(await s.mailLink(adminBody.email, /Confirm your email/)).searchParams.get('token') });
});
test.after(async () => { if (s) await s.stop(); if (gateway) await new Promise((r) => gateway.close(r)); if (db) await db.close(); });

const put = async (c, p, body) => { const res = await fetch(s.base + p, { method: 'PUT', headers: { 'content-type': 'application/json', cookie: c.jar.header() }, body: JSON.stringify(body) }); let json = null; try { json = await res.json(); } catch {} return { status: res.status, body: json }; };
const grant = (id, plan) => admin.post(`/api/admin/billing/users/${id}`, { plan, reason: 'phase 3 test' });
const newEvent = async (c, extra = {}) => {
  const r = await c.post('/api/events', { title: 'Phase test ' + crypto.randomBytes(3).toString('hex'), category: 'seminar', visibility: 'public', startsAt: new Date(Date.now() + 2 * 864e5).toISOString(), ...extra });
  assert.ok(r.status === 200 || r.status === 201, JSON.stringify(r.body));
  return r.body;
};

test('free plan is gated: branding, series, exports, analytics and tickets need an upgrade', { skip, timeout: 60000 }, async () => {
  const me = await alice.get('/api/billing');
  assert.equal(me.body.features.branding, false);
  const v = await alice.post('/api/venues', { name: 'Alice hall' });
  assert.ok(v.status === 200 || v.status === 201, JSON.stringify(v.body)); ids.venue = v.body.slug;
  const br = await put(alice, `/api/branding/venues/${ids.venue}`, { accent: '#112233' });
  assert.equal(br.status, 403); assert.equal(br.body.upgrade, true);
  assert.equal((await alice.post('/api/series', { kind: 'event', title: 'Weekly', firstStart: new Date(Date.now() + 864e5).toISOString(), pattern: 'weekly', count: 3 })).status, 403);
  assert.equal((await alice.get('/api/exports/sessions')).status, 403);
  assert.equal((await alice.get('/api/host/analytics')).status, 403);
  const ev = await newEvent(alice);
  assert.equal((await put(alice, `/api/events/${ev.id}/tickets/tiers`, { tiers: [{ name: 'GA', priceKobo: 0 }] })).status, 403);
  assert.equal(ev.speakerSeats <= 2, true, 'speaker seats clamped to the free plan');
  assert.equal((await alice.get('/api/venues/' + ids.venue)).body.brand, null, 'free venues render plain');
});

test('branding and verified badge after upgrade; badge needs Premium+ and boosts Discover', { skip, timeout: 60000 }, async () => {
  assert.equal((await grant(ids.alice, 'organisation')).status, 200);
  ids.venue = (await alice.get('/api/venues')).body.venues[0].slug; // paid plans drop the -venue style link
  const br = await put(alice, `/api/branding/venues/${ids.venue}`, { accent: '#112233', about: 'Sunday services', logoUrl: '/files/abc/logo.png' });
  assert.equal(br.status, 200, JSON.stringify(br.body));
  const v = (await bob.get('/api/venues/' + ids.venue)).body;
  assert.equal(v.brand.accent, '#112233'); assert.equal(v.brand.about, 'Sunday services');
  assert.ok((await put(bob, `/api/branding/venues/${ids.venue}`, { accent: '#000000' })).status >= 403, 'only managers brand');
  assert.equal((await alice.post(`/api/admin/verified/${ids.alice}`, { verified: true })).status, 403, 'admin only');
  assert.ok((await admin.post(`/api/admin/verified/${ids.bob}`, { verified: true })).status >= 400, 'free users are not eligible');
  assert.equal((await admin.post(`/api/admin/verified/${ids.alice}`, { verified: true, note: 'church' })).status, 200);
  const ev = await newEvent(alice);
  assert.equal((await bob.get('/api/events/' + ev.slug)).body.host.verified, true);
  const d = (await bob.get('/api/discover?status=upcoming&limit=50')).body.events;
  const firstUnverified = d.findIndex((e) => !e.host.verified), lastVerified = d.map((e) => !!e.host.verified).lastIndexOf(true);
  assert.ok(firstUnverified === -1 || lastVerified < firstUnverified || d.some((e) => e.live), 'verified hosts rank first among upcoming');
  assert.equal((await admin.post(`/api/admin/verified/${ids.alice}`, { verified: false })).status, 200);
  assert.notEqual((await bob.get('/api/events/' + ev.slug)).body.host.verified, true);
});

test('recurring series and reminders: tick twice sends each reminder once', { skip, timeout: 60000 }, async () => {
  const first = new Date(Date.now() + 50 * 60000).toISOString();
  const sr = await alice.post('/api/series', { kind: 'event', title: 'Weekly prayer', firstStart: first, durationMin: 60, pattern: 'weekly', count: 3, visibility: 'public' });
  assert.equal(sr.status, 201, JSON.stringify(sr.body));
  const evs = (await db.q('SELECT id, starts_at FROM events WHERE series_id=$1 ORDER BY starts_at', [sr.body.series.id])).rows;
  assert.equal(evs.length, 3);
  assert.equal((await bob.post(`/api/events/${evs[0].id}/rsvp`)).status, 200);
  const reminders = require('../src/features/recurring/reminders');
  const a = await reminders.tick(new Date());
  const b = await reminders.tick(new Date());
  const rows = (await db.q("SELECT * FROM reminder_sends WHERE target_type='event' AND target_id=$1", [evs[0].id])).rows;
  assert.equal(rows.length, 2, 'host and RSVP, one row each');
  assert.ok(rows.every((r) => Number(r.lead_min) === 60));
  assert.ok(a.sent + a.failed >= 2); assert.equal(b.sent, 0, 'second tick (or a restart) sends nothing new');
  const list = (await alice.get('/api/series')).body.series;
  assert.ok(list.some((x) => x.id === sr.body.series.id));
  assert.equal((await bob.del('/api/series/' + sr.body.series.id)).status, 404, 'not yours');
  assert.equal((await alice.del('/api/series/' + sr.body.series.id)).status, 200);
});

test('exports: host gets CSV and XLSX attendance; others are refused', { skip, timeout: 60000 }, async () => {
  const h = (await db.q("INSERT INTO meeting_history (code, name, host_user_id, max_participants) VALUES ('exp-001', 'Export test', $1, 2) RETURNING id", [ids.alice])).rows[0].id;
  await db.q("INSERT INTO meeting_participants_log (meeting_history_id, user_id, display_name, joined_at, left_at) VALUES ($1, $2, 'Bob', '2026-01-01T10:00:00.000Z', '2026-01-01T10:30:00.000Z')", [h, ids.bob]);
  const r = await fetch(`${s.base}/api/exports/attendance/${h}`, { headers: { cookie: alice.jar.header() } });
  assert.equal(r.status, 200); assert.match(r.headers.get('content-type'), /text\/csv/);
  const text = await r.text(); assert.match(text, /Bob/); assert.match(text, /30/);
  const x = await fetch(`${s.base}/api/exports/attendance/${h}?format=xlsx`, { headers: { cookie: alice.jar.header() } });
  assert.equal(x.status, 200); assert.equal(Buffer.from(await x.arrayBuffer()).readUInt32LE(0), 0x04034b50);
  assert.ok((await bob.get(`/api/exports/attendance/${h}`)).status >= 403);
  const an = await alice.get('/api/host/analytics?days=30');
  assert.equal(an.status, 200); assert.equal(an.body.audienceByDay.length, 30);
});

test('tickets: free tier cap, paid checkout with 5% fee ledger, ticket gate, refund and payout', { skip, timeout: 90000 }, async () => {
  const ev = await newEvent(alice);
  const t = await put(alice, `/api/events/${ev.id}/tickets/tiers`, { tiers: [{ name: 'Free', priceKobo: 0, quantity: 1 }, { name: 'VIP', priceKobo: 10000, quantity: 5 }] });
  assert.equal(t.status, 200, JSON.stringify(t.body));
  const [free, vip] = t.body.tiers;
  assert.equal((await put(alice, `/api/events/${ev.id}/tickets/tiers`, { tiers: [{ name: 'Bad', priceKobo: 100 }] })).status, 400, 'paid tiers are at least ₦50');
  assert.equal((await put(bob, `/api/events/${ev.id}/tickets/tiers`, { tiers: [] })).status >= 403, true);
  const svc = require('../src/features/commerce/service');
  assert.equal((await svc.canJoinEvent(ev.id, { id: ids.bob })).ok, false, 'ticket required');
  assert.equal((await svc.canJoinEvent(ev.id, { id: ids.alice })).ok, true, 'host skips');
  const g = await bob.post(`/api/events/${ev.id}/tickets`, { tierId: free.id });
  assert.equal(g.status, 201); assert.equal(g.body.free, true);
  assert.equal((await svc.canJoinEvent(ev.id, { id: ids.bob })).ok, true);
  assert.ok((await carol.post(`/api/events/${ev.id}/tickets`, { tierId: free.id })).status >= 400, 'free tier sold out');
  const buy = await carol.post(`/api/events/${ev.id}/tickets`, { tierId: vip.id, quantity: 2 });
  assert.equal(buy.status, 201, JSON.stringify(buy.body));
  const ref = refOf(buy.body.authorizationUrl);
  assert.equal(txs.get(ref).requested_amount, 20000);
  pay(ref);
  const v = await carol.post(`/api/commerce/payments/${ref}/verify`, {});
  assert.equal(v.body.status, 'paid'); assert.equal(v.body.feeKobo, 1000);
  assert.equal((await carol.post(`/api/commerce/payments/${ref}/verify`, {})).body.status, 'paid', 'verify is idempotent');
  const tix = (await carol.get(`/api/events/${ev.id}/tickets`)).body;
  assert.equal(tix.mine.length, 2);
  assert.equal(tix.tiers.find((x) => x.id === vip.id).sold, 2);
  let e = (await alice.get('/api/earnings')).body;
  assert.equal(e.balanceKobo, 19000); assert.equal(e.feesKobo, 1000);
  assert.equal(e.ledger.filter((l) => l.kind === 'sale').length, 1, 'one ledger row per payment');
  // donation
  const d = await bob.post(`/api/events/${ev.id}/donate`, { amountKobo: 50000 });
  assert.equal(d.status, 201); pay(refOf(d.body.authorizationUrl));
  await bob.post(`/api/commerce/payments/${refOf(d.body.authorizationUrl)}/verify`, {});
  e = (await alice.get('/api/earnings')).body;
  assert.equal(e.balanceKobo, 19000 + 47500);
  // refund the ticket purchase
  assert.equal((await alice.post(`/api/admin/commerce/payments/${ref}/refund`, {})).status, 403);
  assert.equal((await admin.post(`/api/admin/commerce/payments/${ref}/refund`, { note: 'event moved' })).status, 200);
  assert.ok((await admin.post(`/api/admin/commerce/payments/${ref}/refund`, {})).status >= 400, 'only once');
  e = (await alice.get('/api/earnings')).body;
  assert.equal(e.balanceKobo, 47500);
  assert.equal((await carol.get(`/api/events/${ev.id}/tickets`)).body.mine.filter((x) => x.status === 'valid').length, 0);
  // payouts: below minimum refused, then request, one open at a time, admin marks paid
  assert.equal((await alice.post('/api/earnings/payouts', { amountKobo: 100, bankDetails: 'GTB 0123456789 Alice' })).status, 400);
  assert.ok((await alice.post('/api/earnings/payouts', { amountKobo: 999999999, bankDetails: 'GTB' })).status >= 400, 'over balance');
});

test('payout lifecycle and promotions with admin approval', { skip, timeout: 90000 }, async () => {
  const setPlat = await fetch(s.base + '/api/admin/billing/settings', { method: 'PUT', headers: { 'content-type': 'application/json', cookie: admin.jar.header() }, body: JSON.stringify({ platform: { payoutMinKobo: 10000 } }) });
  assert.equal(setPlat.status, 200, await setPlat.text());
  await new Promise((r) => setTimeout(r, 50));
  const p = await alice.post('/api/earnings/payouts', { amountKobo: 20000, bankDetails: 'GTB 0123456789 Alice' });
  assert.equal(p.status, 201, JSON.stringify(p.body));
  assert.ok((await alice.post('/api/earnings/payouts', { amountKobo: 10000, bankDetails: 'GTB' })).status >= 400, 'one open request');
  assert.equal((await alice.get('/api/earnings')).body.balanceKobo, 27500);
  assert.equal((await admin.post(`/api/admin/payouts/${p.body.id}`, { action: 'rejected', note: 'wrong account' })).status, 200);
  assert.equal((await alice.get('/api/earnings')).body.balanceKobo, 47500, 'rejection restores balance');
  const p2 = await alice.post('/api/earnings/payouts', { amountKobo: 20000, bankDetails: 'GTB 0123456789 Alice' });
  assert.equal((await admin.post(`/api/admin/payouts/${p2.body.id}`, { action: 'paid', reference: 'TRF-1' })).status, 200);
  assert.equal((await alice.get('/api/earnings')).body.balanceKobo, 27500);

  // promotions: paid, pending review, approved by admin
  const ev = await newEvent(alice);
  const q = await alice.get('/api/promote/quote?days=3');
  assert.equal(q.body.priceKobo, 345000, 'all placements include the ₦150/day profile slot');
  const st = await alice.post('/api/promote', { eventId: ev.id, days: 3 });
  assert.equal(st.status, 201, JSON.stringify(st.body));
  const ref = refOf(st.body.authorizationUrl); pay(ref);
  assert.equal((await alice.post(`/api/commerce/payments/${ref}/verify`, {})).body.status, 'paid');
  let mine = (await alice.get('/api/promote/mine')).body.promotions;
  const promo = mine.find((x) => x.eventId === ev.id);
  assert.equal(promo.review, 'pending'); assert.equal(promo.active, false);
  assert.equal((await bob.post('/api/promote', { eventId: ev.id, days: 3 })).status >= 403, true, 'only your own events');
  assert.equal((await admin.post(`/api/admin/promotions/${promo.id}/review`, { decision: 'approve' })).status, 200);
  mine = (await alice.get('/api/promote/mine')).body.promotions;
  const ok = mine.find((x) => x.id === promo.id);
  assert.equal(ok.review, 'approved'); assert.equal(ok.active, true);
  assert.ok(new Date(ok.endsAt) - new Date(ok.startsAt) >= 3 * 864e5 - 60000);
});

test('organisations: invite by email, roles and permissions, member cap, shared venues', { skip, timeout: 90000 }, async () => {
  assert.equal((await bob.post('/api/orgs', { name: 'Bob Org' })).status, 403, 'free plan has no orgs');
  const o = await alice.post('/api/orgs', { name: 'Grace Church' });
  assert.equal(o.status, 201, JSON.stringify(o.body));
  const orgId = o.body.id;
  assert.ok((await alice.post('/api/orgs', { name: 'Second' })).status >= 400, 'one org per owner');
  const mark = s.mark();
  assert.equal((await alice.post(`/api/orgs/${orgId}/invites`, { email: ids.bobEmail, role: 'admin' })).status, 201);
  const link = await s.mailLink(ids.bobEmail, /Join Grace Church/, { after: mark });
  assert.ok(link, 'invite email sent');
  const token = new URL(link).searchParams.get('invite');
  assert.equal((await carol.post('/api/orgs/invites/accept', { token })).status, 403, 'invite is bound to the email');
  assert.equal((await bob.post('/api/orgs/invites/accept', { token })).status, 200);
  assert.ok((await bob.post('/api/orgs/invites/accept', { token })).status >= 400, 'single use');
  // bob (admin) invites carol as moderator, but cannot invite admins
  assert.equal((await bob.post(`/api/orgs/${orgId}/invites`, { email: ids.carolEmail, role: 'admin' })).status, 403);
  const m2 = s.mark();
  assert.equal((await bob.post(`/api/orgs/${orgId}/invites`, { email: ids.carolEmail, role: 'moderator' })).status, 201);
  const t2 = new URL(await s.mailLink(ids.carolEmail, /Join Grace Church/, { after: m2 })).searchParams.get('invite');
  assert.equal((await carol.post('/api/orgs/invites/accept', { token: t2 })).status, 200);
  const d = (await carol.get(`/api/orgs/${orgId}`)).body;
  assert.equal(d.role, 'moderator'); assert.equal(d.members.length, 3);
  assert.equal(d.members.some((m) => m.email), false, 'moderators do not see emails');
  assert.equal((await carol.post(`/api/orgs/${orgId}/invites`, { email: 'x@example.com', role: 'moderator' })).status, 403);
  assert.equal((await bob.patch(`/api/orgs/${orgId}/members/${ids.carol}`, { role: 'admin' })).status, 403, 'admins cannot make admins');
  assert.equal((await alice.patch(`/api/orgs/${orgId}/members/${ids.carol}`, { role: 'admin' })).status, 200);
  assert.equal((await carol.del(`/api/orgs/${orgId}/members/${ids.alice}`)).status, 403, 'nobody removes the owner');
  // org venues: an admin creates one, members manage it, plan features come from the org
  const v = await bob.post(`/api/orgs/${orgId}/venues`, { name: 'Youth hall' });
  assert.equal(v.status, 201, JSON.stringify(v.body));
  const cv = await carol.get('/api/venues/' + v.body.slug);
  assert.equal(cv.body.canManage, true, JSON.stringify({ created: v.body, got: cv.body }));
  const bf = (await bob.get('/api/billing')).body;
  assert.equal(bf.orgPlan, 'organisation'); assert.equal(bf.features.exports, true, 'members inherit org features');
  // member cap counts pending invites
  await fetch(s.base + '/api/admin/billing/settings', { method: 'PUT', headers: { 'content-type': 'application/json', cookie: admin.jar.header() }, body: JSON.stringify({ features: { organisation: { orgMembers: 3 } } }) });
  await new Promise((r) => setTimeout(r, 50));
  const cap = await alice.post(`/api/orgs/${orgId}/invites`, { email: 'four@example.com', role: 'moderator' });
  assert.equal(cap.status, 403); assert.equal(cap.body.upgrade, true);
  assert.equal((await carol.del(`/api/orgs/${orgId}/members/${ids.carol}`)).status, 200, 'members can leave');
});

test('replays: manual upload fallback, range streaming, visibility and plan gating', { skip, timeout: 60000 }, async () => {
  const body = crypto.randomBytes(4096);
  const up = await fetch(`${s.base}/api/replays/upload?title=Sunday&visibility=public`, { method: 'POST', headers: { cookie: alice.jar.header(), 'content-type': 'video/mp4', 'x-file-name': 'sunday.mp4' }, body });
  const r = await up.json();
  assert.equal(up.status, 201, JSON.stringify(r));
  assert.equal((await fetch(`${s.base}/api/replays/upload`, { method: 'POST', headers: { cookie: carol.jar.header(), 'content-type': 'video/mp4' }, body })).status, 403, 'free plan (carol left the org) has no replays');
  assert.equal((await fetch(`${s.base}/api/replays/upload`, { method: 'POST', headers: { cookie: alice.jar.header(), 'content-type': 'text/html' }, body })).status, 415);
  const pub = await carol.get('/api/replays/' + r.id);
  assert.equal(pub.status, 200); assert.equal(pub.body.mediaUrl, `/replays/${r.id}/media`);
  const part = await fetch(`${s.base}/replays/${r.id}/media`, { headers: { range: 'bytes=0-99' } });
  assert.equal(part.status, 206); assert.equal(Buffer.from(await part.arrayBuffer()).length, 100);
  const full = await fetch(`${s.base}/replays/${r.id}/media`);
  assert.ok(Buffer.from(await full.arrayBuffer()).equals(body));
  assert.equal((await alice.patch('/api/replays/' + r.id, { visibility: 'private' })).status, 200);
  assert.equal((await carol.get('/api/replays/' + r.id)).status, 404);
  assert.equal((await fetch(`${s.base}/replays/${r.id}/media`)).status, 404);
  assert.equal((await alice.get('/api/replays/' + r.id)).status, 200, 'owner always sees it');
  assert.equal((await alice.post('/api/replays/link', { url: 'http://insecure.test/v.mp4' })).status, 400);
  assert.equal((await alice.post('/api/replays/link', { url: 'https://youtu.be/abcdefgh' })).status, 201);
  assert.equal((await alice.post('/api/replays/egress', { code: 'nope00' })).status >= 400, true, 'egress needs LiveKit config');
  assert.equal((await bob.del('/api/replays/' + r.id)).status >= 403, true);
  assert.equal((await alice.del('/api/replays/' + r.id)).status, 200);
});
