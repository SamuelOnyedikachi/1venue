'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { boot, client, signupPayload } = require('./helpers/server');
const plans = require('../src/lib/plans');

const skipDb = !process.env.DATABASE_URL && process.env.DB_DRIVER !== 'sqlite' ? 'set DATABASE_URL or DB_DRIVER=sqlite' : false;

test('PLATFORM_PROMO_MAX_DAYS defaults to 90 and is env-configurable', () => {
  const s = plans.envDefaults();
  assert.equal(s.platform.promoMaxDays, 90);
  assert.equal(plans.promoQuote(s, { days: 90, placements: ['books'] }).days, 90);
  assert.throws(() => plans.promoQuote(s, { days: 91, placements: ['books'] }), (e) => e.status === 400);
  process.env.PLATFORM_PROMO_MAX_DAYS = '45';
  try {
    const e = plans.envDefaults();
    assert.equal(e.platform.promoMaxDays, 45);
    assert.equal(plans.promoQuote(e, { days: 45, placements: ['feed'] }).days, 45);
    assert.throws(() => plans.promoQuote(e, { days: 46, placements: ['feed'] }), (err) => err.status === 400);
  } finally { delete process.env.PLATFORM_PROMO_MAX_DAYS; }
});

test('dashboard analytics: 7/30/90/custom ranges, hosted and joined series', { skip: skipDb, timeout: 60000 }, async () => {
  const s = await boot();
  try {
    const u = client(s.base);
    const signed = await u.post('/api/signup', signupPayload({ displayName: 'Dash Host' }));
    assert.ok(signed.status === 200 || signed.status === 201, JSON.stringify(signed.body));
    const me = (await u.get('/api/session')).body.user;
    assert.ok(me && me.id);

    const ev = await u.post('/api/events', {
      title: 'Analytics practice night',
      category: 'seminar',
      visibility: 'public',
      startsAt: new Date().toISOString(),
    });
    assert.ok(ev.status === 200 || ev.status === 201, JSON.stringify(ev.body));

    const crypto = require('node:crypto');
    const db = require('../db');
    const now = Date.now();
    const recent = new Date(now - 2 * 864e5).toISOString();
    const mid = new Date(now - 10 * 864e5).toISOString();
    const old = new Date(now - 40 * 864e5).toISOString();
    const mk = async (name, at, peak) => (await db.q(
      'INSERT INTO meeting_history (code, name, host_user_id, max_participants, created_at, ended_at) VALUES ($1,$2,$3,$4,$5,$5) RETURNING id',
      ['da-' + crypto.randomBytes(3).toString('hex'), name, me.id, peak, at],
    )).rows[0].id;
    const hNew = await mk('Recent session', recent, 8);
    const hMid = await mk('Mid session', mid, 3);
    const hOld = await mk('Old session', old, 2);
    const join = (hid, at) => db.q(
      'INSERT INTO meeting_participants_log (meeting_history_id, user_id, display_name, joined_at, left_at) VALUES ($1,$2,$3,$4,$4)',
      [hid, me.id, 'Dash Host', at],
    );
    await join(hNew, recent); await join(hMid, mid); await join(hOld, old);

    const a7 = await u.get('/api/dashboard/analytics?days=7');
    assert.equal(a7.status, 200, JSON.stringify(a7.body));
    assert.equal(a7.body.range.days, 7);
    assert.equal(a7.body.totals.hosted, 1, JSON.stringify(a7.body.totals));
    assert.equal(a7.body.joinedByDay.length, 7);
    assert.equal(a7.body.hostedByDay.length, 7);

    const a30 = await u.get('/api/dashboard/analytics?days=30');
    assert.equal(a30.status, 200);
    assert.equal(a30.body.range.days, 30);
    assert.ok(a30.body.totals.hosted >= 2, JSON.stringify(a30.body.totals));

    const a90 = await u.get('/api/dashboard/analytics?days=90');
    assert.equal(a90.status, 200);
    assert.equal(a90.body.range.days, 90);
    assert.equal(a90.body.totals.hosted, 3, JSON.stringify(a90.body.totals));

    const from = new Date(now - 12 * 864e5).toISOString().slice(0, 10);
    const to = new Date(now - 1 * 864e5).toISOString().slice(0, 10);
    const custom = await u.get(`/api/dashboard/analytics?from=${from}&to=${to}`);
    assert.equal(custom.status, 200, JSON.stringify(custom.body));
    assert.ok(custom.body.range.days >= 11 && custom.body.range.days <= 13, custom.body.range);
    assert.ok(custom.body.totals.hosted >= 2);

    assert.equal((await u.get('/api/dashboard/analytics?days=0')).status, 400);
    assert.equal((await u.get('/api/dashboard/analytics?days=999')).status, 400);

    const guest = client(s.base);
    assert.equal((await guest.get('/api/dashboard/analytics?days=7')).status, 401);
  } finally { await s.stop(); }
});
