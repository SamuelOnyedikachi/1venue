'use strict';
// Settings + wallet round: processing fee maths, currency display, billing profile, auto top-up, header/settings UI.
const secretKey = 'sk_test_settings_wallet';
Object.assign(process.env, { PAYSTACK_SECRET_KEY: secretKey, PAYSTACK_PASS_FEES_CONFIRMED: 'true', PUBLIC_URL: 'http://127.0.0.1:9', NODE_ENV: 'test' });
delete process.env.PAYSTACK_WEBHOOK_SECRET; delete process.env.PROCESSING_FEE_PERCENT; delete process.env.FX_RATES; delete process.env.CURRENCY_BASE;
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { boot, client, signupPayload } = require('./helpers/server');
const skip = !process.env.DATABASE_URL && process.env.DB_DRIVER !== 'sqlite' ? 'set DATABASE_URL or DB_DRIVER=sqlite' : false;
const money = require('../src/lib/money');
const src = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
function browserModule(file, bindings, names) {
  const s = src(file).replace(/^import [\s\S]*?;\s*$/mg, '').replace(/^export (?=(?:async )?function|const|let|class)/mg, '');
  return new Function(...Object.keys(bindings), `${s}\nreturn { ${names} };`)(...Object.values(bindings));
}

test('processing fee: default 3%, env override, integer half-up rounding to minor units', () => {
  assert.equal(money.feePercent(), 3);
  assert.deepEqual(money.withFee(150000), { subtotal: 150000, fee: 4500, total: 154500, percent: 3 });
  assert.equal(money.withFee(1500000).total, 1545000, '30 credits = ₦15,000 + ₦450');
  assert.equal(money.withFee(17).fee, 1, '0.51 kobo rounds up');
  assert.equal(money.withFee(16).fee, 0, '0.48 kobo rounds down');
  assert.equal(money.withFee(100, 2.5).fee, 3, 'exact half rounds up');
  assert.equal(money.withFee(0).total, 0);
  assert.throws(() => money.withFee(1.5)); assert.throws(() => money.withFee(-1));
  for (const [v, want] of [['0', 0], ['1.5', 1.5], ['abc', 3], ['50', 3], ['', 3]]) { process.env.PROCESSING_FEE_PERCENT = v; assert.equal(money.feePercent(), want, v); }
  delete process.env.PROCESSING_FEE_PERCENT;
  const rules = require('../src/features/wallet/rules');
  const q = rules.quote(30);
  assert.equal(q.subtotalKobo, 1500000); assert.equal(q.feeKobo, 45000); assert.equal(q.totalKobo, 1545000); assert.equal(q.feePercent, 3);
});

test('currency: placeholders are marked, FX_RATES overrides them, conversion and Intl formatting', async () => {
  money.clearCache();
  let r = await money.rates({ fresh: true });
  assert.equal(r.base, 'NGN'); assert.equal(r.configured, false); assert.ok(r.placeholder.includes('USD'));
  process.env.FX_RATES = JSON.stringify({ USD: 0.001, bogus: 4, GBP: -1 });
  r = await money.rates({ fresh: true });
  assert.equal(r.rates.USD, 0.001); assert.ok(!r.placeholder.includes('USD')); assert.ok(r.placeholder.includes('GBP')); assert.equal(r.rates.GBP, money.PLACEHOLDER_RATES.GBP);
  assert.equal(money.convert(1545000, 'USD', r), 1545, '₦15,450 at 0.001 = $15.45');
  assert.equal(money.format(1545, 'USD'), '$15.45');
  assert.match(money.format(1545000, 'NGN'), /₦15,450\.00/);
  assert.equal(money.isCurrency('kes'), true); assert.equal(money.isCurrency('XYZ'), false);
  delete process.env.FX_RATES; money.clearCache();
});

test('client money.js mirrors the server fee maths and rounds credits to 2 decimals', () => {
  const fakeIcon = (n, o = {}) => `<svg data-i="${n}" aria-label="${o.label || ''}"></svg>`;
  const m = browserModule('public/js/money.js', { h: () => null, api: async () => ({}), sheet: () => null, toastErr: () => {}, icon: fakeIcon }, 'withFee, fmtCredits, convert, format, fmtMoney, coinHtml, setCurrency');
  for (const sub of [0, 1, 16, 17, 99, 150000, 1500000, 3333333]) for (const p of [0, 2.5, 3, 7.25]) assert.deepEqual(m.withFee(sub, p), money.withFee(sub, p), `${sub} @ ${p}%`);
  assert.equal(m.fmtCredits(32.0499), '32.05'); assert.equal(m.fmtCredits(30), '30'); assert.equal(m.fmtCredits(7.5), '7.50'); assert.equal(m.fmtCredits(0.004), '0'); assert.equal(m.fmtCredits(1234.567), '1,234.57');
  assert.match(m.coinHtml(), /aria-label="credits"/);
  assert.match(m.fmtMoney(150000), /1,500\.00/);
});

test('header shows icon + balance only, no settings gear; settings drops the sync blurb', () => {
  const app = src('public/js/app.js'), credits = src('public/js/credits.js'), settings = src('public/js/pages/settings.js');
  assert.doesNotMatch(app, /class: 'icon-btn', href: '\/settings'/);
  assert.match(app, /label: 'Settings'/, 'Settings stays in the user menu');
  assert.match(credits, /formatCredits=fmtCredits/);
  assert.doesNotMatch(credits, /\+' credits'\s*;?\s*\/\/ icon/);
  assert.doesNotMatch(settings, /synced across devices|Sign in to sync/);
  assert.match(settings, /'theme', 'set-row-stack'/);
  const wallet = src('public/js/pages/wallet.js');
  assert.doesNotMatch(wallet, /processing fee"|Credits added|" credits"/);
  for (const ic of ['checkCircle', 'hourglass', 'xCircle', 'returnArrow']) assert.match(wallet, new RegExp(`"${ic}"`));
  const icons = src('public/js/icons.js');
  for (const ic of ['coin', 'xCircle', 'hourglass', 'returnArrow']) assert.match(icons, new RegExp(`\\b${ic}:`));
  assert.match(src('public/sw.js'), /'\/js\/money\.js'/);
});

// ---------------------------------------------------------------- integration (real server + mock gateway)
let gateway, s, db, autotopup, alice, bob, admin, aliceId;
const txs = new Map();
let nextId = crypto.randomInt(1e9, 1e12);
let decline = false, charges = 0;
async function jsonBody(req) { const c = []; for await (const x of req) c.push(x); return JSON.parse(Buffer.concat(c).toString() || '{}'); }
const auth = (code = 'AUTH_' + crypto.randomBytes(6).toString('hex')) => ({ authorization_code: code, reusable: true, last4: '4081', exp_month: '12', exp_year: '2030', card_type: 'visa ', bank: 'Bannk', channel: 'card' });

test.before(async () => {
  if (skip) return;
  db = require('../db');
  gateway = http.createServer(async (req, res) => {
    const reply = (st, b) => { res.writeHead(st, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(b)); };
    if (req.headers.authorization !== `Bearer ${secretKey}`) return reply(401, { status: false });
    if (req.url === '/transaction/initialize') {
      const b = await jsonBody(req);
      txs.set(b.reference, { id: nextId++, reference: b.reference, requested_amount: b.amount, amount: b.amount, fees: 0, currency: 'NGN', status: 'pending', domain: 'test', metadata: b.metadata, customer: { email: b.email }, channels: b.channels });
      return reply(200, { status: true, data: { reference: b.reference, authorization_url: `https://checkout.paystack.com/${b.reference}`, access_code: 'x' } });
    }
    if (req.url === '/transaction/charge_authorization') {
      const b = await jsonBody(req); charges++;
      await new Promise((r) => setTimeout(r, 30));
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
  autotopup = require('../src/features/wallet/autotopup');
  const adminBody = signupPayload();
  s = await boot({ PAYSTACK_API_URL: process.env.PAYSTACK_API_URL, ADMIN_EMAILS: adminBody.email, BILLING_WORKER: 'false', AUTO_TOPUP: 'false' });
  alice = client(s.base); bob = client(s.base); admin = client(s.base);
  assert.equal((await alice.post('/api/signup', signupPayload())).status, 201);
  assert.equal((await bob.post('/api/signup', signupPayload())).status, 201);
  await admin.post('/api/signup', adminBody);
  await admin.post('/api/auth/verify-email', { token: new URL(await s.mailLink(adminBody.email, /Confirm your email/)).searchParams.get('token') });
  aliceId = (await alice.get('/api/session')).body.user.id;
});
test.after(async () => { if (s) await s.stop(); if (gateway) await new Promise((r) => gateway.close(r)); if (db) await db.close(); });

async function newUser() {
  const c = client(s.base); assert.equal((await c.post('/api/signup', signupPayload())).status, 201);
  return { c, id: (await c.get('/api/session')).body.user.id };
}
const withCard = (id, extra = {}) => db.q(`INSERT INTO auto_topups (user_id, enabled, threshold_credits, pack_credits, monthly_cap_credits, authorization_code, card_last4, card_brand, failures, updated_at)
  VALUES ($1,1,$2,$3,$4,$5,'4081','visa',0,NOW())`, [id, extra.threshold || 20, extra.pack || 60, extra.cap || 240, 'AUTH_' + crypto.randomBytes(5).toString('hex')]);
const balance = async (id) => Number((await db.q('SELECT balance_units FROM credit_wallets WHERE user_id=$1', [id])).rows[0]?.balance_units || 0) / 60000;
const topups = (id) => db.q("SELECT * FROM credit_payments WHERE user_id=$1 AND source='auto_topup' ORDER BY id", [id]).then((r) => r.rows);

test('every checkout charges subtotal + 3% and records the split', { skip, timeout: 60000 }, async () => {
  const w = await alice.get('/api/wallet');
  assert.equal(w.body.feePercent, 3);
  const q = await alice.post('/api/wallet/quote', { credits: 30 });
  assert.equal(q.body.totalKobo, 1545000); assert.doesNotMatch(q.body.feeNotice, /\+ processing fee/i);
  const co = await alice.post('/api/wallet/checkout', { credits: 30 });
  assert.equal(co.status, 201, JSON.stringify(co.body));
  assert.equal(txs.get(co.body.reference).requested_amount, 1545000, 'gateway asked for the total');
  const row = (await db.q('SELECT * FROM credit_payments WHERE reference=$1', [co.body.reference])).rows[0];
  assert.equal(Number(row.price_kobo), 1545000); assert.equal(Number(row.subtotal_kobo), 1500000); assert.equal(Number(row.processing_fee_kobo), 45000); assert.equal(Number(row.fee_percent), 3);
  txs.get(co.body.reference).status = 'success';
  const v = await alice.post(`/api/wallet/payments/${co.body.reference}/verify`);
  assert.equal(v.body.status, 'paid'); assert.equal(v.body.feeKobo, 45000);
  assert.equal(await balance(aliceId), 30, 'the fee buys no extra credits');

  const plans = (await alice.get('/api/plans')).body;
  const premium = plans.plans.find((p) => p.id === 'premium');
  const bc = await alice.post('/api/billing/checkout', { plan: 'premium', interval: 'month' });
  assert.equal(bc.status, 201, JSON.stringify(bc.body));
  const want = money.withFee(premium.priceMonthKobo);
  assert.equal(txs.get(bc.body.reference).requested_amount, want.total);
  const bp = (await db.q('SELECT * FROM billing_payments WHERE reference=$1', [bc.body.reference])).rows[0];
  assert.equal(Number(bp.price_kobo), want.total); assert.equal(Number(bp.processing_fee_kobo), want.fee);
  const detail = await admin.get(`/api/admin/billing/users/${aliceId}`);
  assert.equal(detail.status, 200);
  assert.equal(detail.body.payments[0].feeKobo, want.fee, 'admin sees the fee on plan payments');
  assert.ok(detail.body.creditPayments.some((p) => p.feeKobo === 45000 && p.subtotalKobo === 1500000), 'and on credit purchases');
});

test('billing profile: address + currency, validated; prices are recorded in the shown currency', { skip }, async () => {
  assert.equal((await client(s.base).get('/api/me/billing-profile')).status, 401);
  assert.equal((await bob.get('/api/me/billing-profile')).body.currency, 'NGN');
  assert.equal((await bob.put('/api/me/billing-profile', { currency: 'XYZ' })).status, 400);
  assert.equal((await bob.put('/api/me/billing-profile', { country: 'Nigeria' })).status, 400);
  const r = await bob.put('/api/me/billing-profile', { country: 'gb', line1: '1 High St <b>', line2: '', city: 'London', state: 'Greater London', postalCode: 'SW1A 1AA', currency: 'usd' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual({ ...r.body }, { country: 'GB', line1: '1 High St  b', line2: null, city: 'London', state: 'Greater London', postalCode: 'SW1A 1AA', currency: 'USD' });
  const m = (await bob.get('/api/money')).body;
  assert.equal(m.currency, 'USD'); assert.equal(m.chargeCurrency, 'NGN'); assert.equal(m.feePercent, 3); assert.ok(m.placeholderRates.includes('USD'));
  assert.equal((await client(s.base).get('/api/money')).body.currency, 'NGN');
  const co = await bob.post('/api/wallet/checkout', { credits: 10 });
  const row = (await db.q('SELECT * FROM credit_payments WHERE reference=$1', [co.body.reference])).rows[0];
  assert.equal(row.currency, 'NGN'); assert.equal(row.display_currency, 'USD');
  assert.equal(Number(row.display_total_minor), Math.round((515000 / 100) * money.PLACEHOLDER_RATES.USD * 100));
  assert.equal((await bob.get('/api/admin/fx')).status, 403);
  const fx = await admin.put('/api/admin/fx', { rates: { USD: 0.0007 } });
  assert.equal(fx.status, 200); assert.equal(fx.body.rates.USD, 0.0007); assert.ok(!fx.body.placeholder.includes('USD')); assert.equal(fx.body.feePercent, 3);
  assert.equal((await admin.del('/api/admin/fx')).body.rates.USD, money.PLACEHOLDER_RATES.USD);
});

test('auto top-up: card saved through hosted checkout, then one charge of pack + fee', { skip, timeout: 60000 }, async () => {
  const { c, id } = await newUser();
  let a = (await c.get('/api/wallet/auto-topup')).body;
  assert.equal(a.subscriber, false); assert.equal(a.card, null); assert.equal(a.enabled, false);
  assert.equal((await c.put('/api/wallet/auto-topup', { enabled: true })).status, 409, 'needs a card first');
  assert.equal((await c.put('/api/wallet/auto-topup', { packCredits: 60, monthlyCapCredits: 30 })).status, 400, 'cap below one pack');
  assert.equal((await c.put('/api/wallet/auto-topup', { thresholdCredits: 15, packCredits: 30, monthlyCapCredits: 90 })).status, 200);
  const setup = await c.post('/api/wallet/auto-topup/card');
  assert.equal(setup.status, 201, JSON.stringify(setup.body));
  const t = txs.get(setup.body.reference);
  assert.deepEqual(t.channels, ['card']); assert.equal(t.requested_amount, 1545000);
  Object.assign(t, { status: 'success', authorization: auth() });
  assert.equal((await c.post(`/api/wallet/payments/${setup.body.reference}/verify`)).body.status, 'paid');
  a = (await c.get('/api/wallet/auto-topup')).body;
  assert.equal(a.enabled, true); assert.deepEqual(a.card, { last4: '4081', brand: 'visa', exp: '12/30' });
  const stored = (await db.q('SELECT * FROM auto_topups WHERE user_id=$1', [id])).rows[0];
  assert.match(stored.authorization_code, /^AUTH_/); assert.equal(Object.keys(stored).some((k) => /pan|cvv|card_number/i.test(k)), false);
  assert.equal(await balance(id), 30);
  assert.equal(await autotopup.run(id), 'not_needed', 'balance 30 ≥ threshold 15');
  await db.q('UPDATE credit_wallets SET balance_units=$2 WHERE user_id=$1', [id, 5 * 60000]);
  const before = charges;
  const results = await Promise.all([autotopup.run(id), autotopup.run(id), autotopup.run(id)]);
  assert.deepEqual(results.filter((x) => x === 'paid'), ['paid'], results.join());
  assert.equal(charges - before, 1, 'concurrent runs charge once');
  assert.equal(await balance(id), 35);
  const rows = await topups(id);
  assert.equal(rows.length, 1); assert.equal(Number(rows[0].price_kobo), 1545000); assert.equal(Number(rows[0].processing_fee_kobo), 45000); assert.equal(rows[0].status, 'paid');
  assert.equal((await c.get('/api/wallet/auto-topup')).body.lastStatus, 'paid');
  // cap: 90 a month, 30 used → one more fits, the third does not
  await db.q('UPDATE credit_wallets SET balance_units=0 WHERE user_id=$1', [id]);
  assert.equal(await autotopup.run(id), 'paid');
  await db.q('UPDATE credit_wallets SET balance_units=0 WHERE user_id=$1', [id]);
  assert.equal(await autotopup.run(id), 'paid');
  await db.q('UPDATE credit_wallets SET balance_units=0 WHERE user_id=$1', [id]);
  assert.equal(await autotopup.run(id), 'cap_reached');
  assert.equal((await topups(id)).length, 3);
  assert.equal((await c.get('/api/wallet/auto-topup')).body.usedThisMonthCredits, 90);
  assert.equal((await c.del('/api/wallet/auto-topup/card')).body.card, null);
  assert.equal(await autotopup.run(id), 'busy_or_off');
});

test('auto top-up: failures back off, then turn it off after 3; subscribers are skipped; debit hook triggers it', { skip, timeout: 60000 }, async () => {
  const { c, id } = await newUser();
  await withCard(id);
  decline = true;
  const t0 = Date.now();
  assert.equal(await autotopup.run(id, { now: t0 }), 'failed');
  assert.equal(await autotopup.run(id, { now: t0 + 1000 }), 'retry_later');
  assert.equal(await autotopup.run(id, { now: t0 + 2 * 3600000 }), 'failed');
  assert.equal(await autotopup.run(id, { now: t0 + 4 * 3600000 }), 'disabled');
  decline = false;
  const a = (await c.get('/api/wallet/auto-topup')).body;
  assert.equal(a.enabled, false); assert.equal(a.lastStatus, 'failed'); assert.equal(a.failures, 3);
  assert.ok((await topups(id)).every((p) => p.status === 'failed'));
  assert.equal(await balance(id), 0);
  assert.equal((await c.put('/api/wallet/auto-topup', { enabled: true })).body.failures, 0, 're-enabling resets the counter');

  const sub = await newUser();
  await withCard(sub.id);
  assert.equal((await admin.post(`/api/admin/billing/users/${sub.id}`, { plan: 'premium', reason: 'test' })).status, 200);
  assert.equal(await autotopup.run(sub.id), 'subscriber');
  assert.equal((await sub.c.get('/api/wallet/auto-topup')).body.subscriber, true);
  assert.equal((await sub.c.put('/api/wallet/auto-topup', { enabled: false })).status, 409);

  const hook = await newUser();
  await withCard(hook.id, { pack: 10, cap: 100 });
  const old = process.env.AUTO_TOPUP; delete process.env.AUTO_TOPUP;
  autotopup.maybeAfterDebit(hook.id, 0); autotopup.maybeAfterDebit(hook.id, 0);
  for (let i = 0; i < 100 && (await balance(hook.id)) === 0; i++) await new Promise((r) => setTimeout(r, 50));
  if (old != null) process.env.AUTO_TOPUP = old;
  assert.equal(await balance(hook.id), 10);
  assert.equal((await topups(hook.id)).length, 1);
});

test('short links: 4-character ₦10,000 and 3-character ₦25,000; old saved price keys map across by price', () => {
  const plans = require('../src/lib/plans');
  assert.deepEqual(plans.DEFAULTS.slugAddons, { slug4: 1000000, slug3: 2500000 });
  assert.deepEqual(plans.SLUG_TIERS, ['none', 'slug4', 'slug3']);
  assert.deepEqual(plans.legacySlugPrices({ slug3: 1200000, slug2: 3000000 }), { slug4: 1200000, slug3: 3000000 });
  const base = plans.envDefaults();
  assert.deepEqual(plans.mergeSettings(base, { slugAddons: { slug3: 1100000, slug2: 2600000 } }).slugAddons, { slug4: 1100000, slug3: 2600000 }, 'an old admin page patch');
  assert.deepEqual(plans.mergeSettings(base, { slugAddons: { slug4: 900000 } }).slugAddons, { slug4: 900000, slug3: 2500000 });
  assert.throws(() => plans.mergeSettings(base, { slugAddons: { slug5: 1 } }), /Unknown add-on/);
  process.env.SLUG3_PRICE_KOBO = '1300000'; process.env.LINK3_PRICE_KOBO = '2700000';
  assert.deepEqual(plans.envDefaults().slugAddons, { slug4: 1300000, slug3: 2700000 }, 'old env name still sets the ₦10k tier');
  delete process.env.SLUG3_PRICE_KOBO; delete process.env.LINK3_PRICE_KOBO;
  const codes = require('../src/lib/codes');
  assert.ok(!codes.SLUG_ROUTE_RE.test('ab')); assert.ok(codes.SLUG_ROUTE_RE.test('abc'));
  assert.match(src('public/js/pages/upgrade.js'), /tile\(4, 'abcd', addons\.slug4\), tile\(3, 'abc', addons\.slug3\)/);
  assert.match(src('public/js/pages/upgrade.js'), /released \$\{releaseDays\} days after it lapses/);
});

test('saved admin prices from before the change keep their money on the right tier', { skip }, async () => {
  const plans = require('../src/lib/plans');
  await db.q("INSERT INTO app_settings (key, value, updated_at) VALUES ('plans', $1, NOW()) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value", [JSON.stringify({ slugAddons: { slug3: 1100000, slug2: 2600000 } })]);
  plans.clearCache();
  assert.deepEqual((await plans.getSettings({ fresh: true })).slugAddons, { slug4: 1100000, slug3: 2600000 });
  await plans.saveSettings({ graceDays: 6 }, null);
  const stored = JSON.parse((await db.q("SELECT value FROM app_settings WHERE key='plans'")).rows[0].value);
  assert.equal(stored.slugAddonsV, 2);
  assert.deepEqual((await plans.getSettings({ fresh: true })).slugAddons, { slug4: 1100000, slug3: 2600000 }, 'not remapped twice');
  await plans.resetSettings(null);
});

test('short-link release: notices at 14 and 3 days, released once at 60, renewing keeps it', { skip, timeout: 60000 }, async () => {
  const sl = require('../src/features/billing/shortlinks');
  assert.equal(sl.releaseDays(), 60);
  const DAY = 86400000;
  const short = () => 'q' + crypto.randomBytes(4).toString('hex').replace(/[^a-z]/g, 'x').slice(0, 2);
  async function parkedVenue() {
    const { c, id } = await newUser();
    assert.equal((await admin.post(`/api/admin/billing/users/${id}`, { plan: 'premium', reason: 'test' })).status, 200);
    const v = (await c.post('/api/venues', { name: 'Short hall' })).body;
    await admin.post(`/api/admin/billing/venues/${v.id}`, { slugTier: 'slug3', reason: 'test' });
    let slug, r;
    for (let i = 0; i < 10; i++) { slug = short(); r = await c.patch(`/api/venues/${v.slug}`, { customSlug: slug }); if (r.status === 200) break; }
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal((await admin.post(`/api/admin/billing/users/${id}`, { plan: 'free', reason: 'lapsed' })).status, 200);
    const row = (await db.q('SELECT * FROM venues WHERE id=$1', [v.id])).rows[0];
    assert.equal(row.reserved_slug, slug); assert.ok(row.link_parked_at, 'parked with a timestamp');
    return { c, id, venueId: v.id, slug, parkedAt: new Date(row.link_parked_at).getTime() };
  }
  const a = await parkedVenue();
  const at = (days) => new Date(a.parkedAt + days * DAY + 1000);
  const notice = async () => Number((await db.q('SELECT link_notice_days FROM venues WHERE id=$1', [a.venueId])).rows[0].link_notice_days || 0);
  await sl.sweep(at(10)); assert.equal(await notice(), 0, 'nothing yet');
  await Promise.all([sl.sweep(at(46.5)), sl.sweep(at(46.5))]); assert.equal(await notice(), 14);
  await sl.sweep(at(50)); assert.equal(await notice(), 14, 'no repeat');
  await sl.sweep(at(57.5)); assert.equal(await notice(), 3);
  { const cr = await client(s.base).get('/api/venues/claimable/' + a.slug); assert.equal(cr.body.claimable, false, 'still held ' + cr.status + JSON.stringify(cr.body)); }
  const runs = await Promise.all([sl.sweep(at(60)), sl.sweep(at(60)), sl.sweep(at(61))]);
  assert.equal(runs.reduce((n, r) => n + r.released, 0), 1, 'released exactly once across workers');
  const row = (await db.q('SELECT * FROM venues WHERE id=$1', [a.venueId])).rows[0];
  assert.equal(row.reserved_slug, null); assert.equal(row.slug_addon, 'none'); assert.match(row.slug, /-venue$/);
  const audit = (await db.q("SELECT * FROM plan_audit WHERE user_id=$1 AND action='short_link_released'", [a.id])).rows;
  assert.equal(audit.length, 1); assert.equal(JSON.parse(audit[0].detail).slug, a.slug);
  assert.equal((await client(s.base).get('/api/venues/' + a.slug)).status, 404, 'old short URL is gone');
  assert.equal((await client(s.base).get('/api/venues/claimable/' + a.slug)).body.claimable, true, 'and claimable');
  // someone else on a paid plan can now take it
  const b = await newUser();
  await admin.post(`/api/admin/billing/users/${b.id}`, { plan: 'premium', reason: 'test' });
  const bv = (await b.c.post('/api/venues', { name: 'New owner' })).body;
  await admin.post(`/api/admin/billing/venues/${bv.id}`, { slugTier: 'slug3', reason: 'test' });
  assert.equal((await b.c.patch(`/api/venues/${bv.slug}`, { customSlug: a.slug })).status, 200);

  const k = await parkedVenue();
  await admin.post(`/api/admin/billing/users/${k.id}`, { plan: 'premium', reason: 'renewed' });
  const kept = await sl.sweep(new Date(k.parkedAt + 61 * DAY));
  assert.equal(kept.released, 0);
  const kr = (await db.q('SELECT * FROM venues WHERE id=$1', [k.venueId])).rows[0];
  assert.equal(kr.slug, k.slug, 'renewing within the window restores the link'); assert.equal(kr.reserved_slug, null); assert.equal(kr.link_parked_at, null);
  assert.equal((await client(s.base).get('/api/venues/claimable/ab')).body.claimable, false, 'no 2-character links');
});
