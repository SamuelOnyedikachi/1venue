'use strict';
// out46: one credit wallet, venue meetings are billed, publisher/viewer room rates.
const test = require('node:test');
const assert = require('node:assert/strict');
const rates = require('../src/features/wallet/rates');
const { boot, client, signupPayload } = require('./helpers/server');
const db = require('../db');
const skip = process.env.DB_DRIVER !== 'sqlite' && !process.env.DATABASE_URL;

test('room rate: base covers host + 1; extra publishers and viewers add on', () => {
  const u = rates.UNITS_PER_CREDIT;
  // 1-to-1: 2 people, both publishers. extras = 0. 1.5 credits/min.
  assert.deepEqual(rates.roomComposition(2, 0), { publishers: 2, viewers: 0, pubExtra: 0, viewExtra: 0 });
  assert.equal(rates.creditsPerMinute(2, 0), 1.5);
  assert.equal(rates.unitsForElapsed(60 * 60 * 1000, 2, 0), Math.floor(1.5 * 60 * u)); // 90 credits / hour

  // 22 cameras: 20 extra publishers. 1.5 + 20*0.3 = 7.5 credits/min.
  assert.equal(rates.creditsPerMinute(22, 0), 7.5);
  const marathon = rates.unitsForElapsed(150 * 60 * 1000, 22, 0); // 2.5 hours
  assert.equal(marathon / u, 7.5 * 150); // 1,125 credits ≈ ₦11,250 over the whole meeting (before free minutes)

  // Stage: 1 speaker + 20 viewers. included leftover 1 covers one viewer, 19 extra viewers.
  // 1.5 + 19*0.1 = 3.4 credits/min.
  assert.deepEqual(rates.roomComposition(1, 20), { publishers: 1, viewers: 20, pubExtra: 0, viewExtra: 19 });
  assert.ok(Math.abs(rates.creditsPerMinute(1, 20) - 3.4) < 1e-9);
  assert.equal(rates.unitsForElapsed(150 * 60 * 1000, 1, 20), Math.floor((150 * 60 * 1000 * rates.creditsPerMinute(1, 20) * u) / 60000));

  // Per-second billing: 1 second at the room rate is a fraction of a credit.
  const oneSec = rates.unitsForElapsed(1000, 2, 0);
  assert.equal(oneSec, Math.floor((1000 * 1.5 * u) / 60000));
  assert.ok(oneSec > 0);
  assert.equal(rates.unitsForElapsed(0, 22, 0), 0);

  // Paid entry always uses the room rate only.
  assert.equal(rates.paidEntryUnitsForElapsed(60 * 1000, 22, 0), Math.floor(1.5 * u));
  const split = rates.splitHostShare(10000);
  assert.equal(split.host, 8000);
  assert.equal(split.platform, 2000);
});

test('public plans list Pro, Business and Organisation, without per-feature credit costs', () => {
  const plans = require('../src/lib/plans');
  const s = plans.envDefaults();
  assert.deepEqual(plans.PLAN_IDS, ['free', 'pro', 'business', 'organisation']);
  assert.equal(plans.canonicalPlan('premium'), 'pro');
  assert.equal(s.plans.pro.includedCredits, 2000);
  assert.equal(s.plans.business.includedCredits, 5000);
  assert.equal(s.plans.organisation.includedCredits, 12000);
  assert.equal(s.plans.pro.priceMonthKobo, 1500000);
  assert.equal(s.plans.business.priceMonthKobo, 3500000);
  assert.equal(s.plans.organisation.priceMonthKobo, 7500000);
  const limits = plans.limitsFor(s, 'pro');
  assert.equal(limits.includedCredits, 2000);
  assert.equal(limits.aiDaily, undefined);
});

let s, host;
test('opening a venue starts a billing session, like any other free-entry meeting', { skip }, async () => {
  s = await boot();
  host = client(s.base);
  const signup = await host.post('/api/signup', signupPayload());
  assert.ok([200, 201].includes(signup.status), JSON.stringify(signup.body));
  const venue = await host.post('/api/venues', { name: 'Metered venue' });
  assert.equal(venue.status, 200, JSON.stringify(venue.body));
  const opened = await host.post('/api/create', { name: 'Venue gathering', venue: venue.body.slug });
  assert.equal(opened.status, 200, JSON.stringify(opened.body));
  const wallet = (await host.get('/api/wallet')).body;
  assert.equal(wallet.balanceCredits, 100, 'welcome credits');
  assert.ok(wallet.billing, 'venue meetings start a billing session');
  assert.equal(wallet.billing.code, opened.body.code);
  const id = (await host.get('/api/session')).body.user.id;
  const row = (await db.q('SELECT * FROM credit_billing_sessions WHERE user_id=$1', [id])).rows[0];
  assert.ok(row);
  assert.ok(Number(row.free_until_ms) > Date.now());
  assert.equal((await host.get('/api/plans')).body.plans.some((p) => p.aiWeights), false);
  const plans = (await host.get('/api/plans')).body.plans;
  assert.deepEqual(plans.map((p) => p.id), ['free', 'pro', 'business', 'organisation']);
  for (const p of plans) assert.equal(p.aiWeights, undefined);
  await s.stop();
  s = null;
});

test.after(async () => { if (s) await s.stop(); await db.close().catch(() => {}); });
