'use strict';
// Admin → Current promotions: search, filters, paging and the streamed CSV export of every matching row.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { boot, client, signupPayload } = require('./helpers/server');
const skip = !process.env.DATABASE_URL && process.env.DB_DRIVER !== 'sqlite' ? 'set DATABASE_URL or DB_DRIVER=sqlite' : false;
const tokenOf = (link) => new URL(link).searchParams.get('token');
const parseCsv = (text) => {
  const rows = []; let row = [], cell = '', q = false;
  const t = text.replace(/^\uFEFF/, '');
  for (let i = 0; i < t.length; i++) {
    const ch = t[i];
    if (q) { if (ch === '"' && t[i + 1] === '"') { cell += '"'; i++; } else if (ch === '"') q = false; else cell += ch; }
    else if (ch === '"') q = true;
    else if (ch === ',') { row.push(cell); cell = ''; }
    else if (ch === '\n') { row.push(cell.replace(/\r$/, '')); rows.push(row); row = []; cell = ''; }
    else cell += ch;
  }
  return rows;
};

test('admin promotions: search + filters + paging; CSV export streams every matching row, admins only', { skip, timeout: 120000 }, async () => {
  const adminBody = signupPayload();
  const s = await boot({ ADMIN_EMAILS: adminBody.email });
  try {
    const a = client(s.base);
    await a.post('/api/signup', adminBody);
    await a.post('/api/auth/verify-email', { token: tokenOf(await s.mailLink(adminBody.email, /Confirm your email/)) });
    const u = client(s.base); await u.post('/api/signup', signupPayload());
    const tag = 'zq' + crypto.randomBytes(4).toString('hex');
    const made = [];
    for (let i = 0; i < 8; i++) {
      const ev = (await a.post('/api/events', { title: `${tag} event ${i}`, category: 'seminar', visibility: 'public', startsAt: new Date(Date.now() + 864e5).toISOString() })).body;
      const r = await a.post('/api/admin/promotions', { type: 'event', targetId: ev.id, placements: ['discover', 'feed'], startsAt: i === 7 ? new Date(Date.now() + 10 * 864e5).toISOString() : undefined });
      assert.equal(r.status, 201, JSON.stringify(r.body)); made.push(r.body);
    }
    const post = (await a.post('/api/posts', { body: `${tag} =SUM(A1) "quoted", post` })).body;
    assert.equal((await a.post('/api/admin/promotions', { type: 'post', targetId: post.id, placements: ['feed'] })).status, 201);
    assert.equal((await a.patch(`/api/admin/promotions/${made[1].id}`, { active: false })).status, 200);

    // list: 5 per page with a total
    const p1 = await a.get(`/api/admin/promotions?q=${tag}&limit=5&offset=0`);
    assert.equal(p1.status, 200); assert.equal(p1.body.total, 9); assert.equal(p1.body.promotions.length, 5);
    const p2 = await a.get(`/api/admin/promotions?q=${tag}&limit=5&offset=5`);
    assert.equal(p2.body.promotions.length, 4);
    assert.equal(new Set([...p1.body.promotions, ...p2.body.promotions].map((p) => p.id)).size, 9, 'pages do not overlap');
    assert.equal((await a.get(`/api/admin/promotions?q=${tag}&type=post`)).body.total, 1);
    assert.equal((await a.get(`/api/admin/promotions?q=${tag}&status=paused`)).body.total, 1);
    assert.equal((await a.get(`/api/admin/promotions?q=${tag}&status=scheduled`)).body.total, 1);
    assert.equal((await a.get(`/api/admin/promotions?q=${tag}&status=live`)).body.total, 7);
    assert.equal((await a.get(`/api/admin/promotions?q=${tag}%20event%203`)).body.total, 1, 'title search');
    const later = new Date(Date.now() + 5 * 864e5).toISOString().slice(0, 10);
    assert.equal((await a.get(`/api/admin/promotions?q=${tag}&from=${later}`)).body.total, 1, 'start-date filter');
    assert.equal((await a.get(`/api/admin/promotions?q=${tag}&status=bogus&from=nope`)).body.total, 9, 'bad filters are ignored');
    assert.ok(Array.isArray((await a.get('/api/admin/promotions')).body.promotions), 'the unfiltered list still works');

    // export: auth
    const url = (qs) => `${s.base}/api/admin/promotions/export.csv?${qs}`;
    assert.equal((await fetch(url(`q=${tag}`))).status, 401);
    assert.equal((await fetch(url(`q=${tag}`), { headers: { cookie: u.jar.header() } })).status, 403);
    // export: every matching row, not just a page
    const res = await fetch(url(`q=${tag}`), { headers: { cookie: a.jar.header() } });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/csv/);
    assert.match(res.headers.get('content-disposition'), /attachment; filename="promotions-\d{4}-\d{2}-\d{2}\.csv"/);
    const rows = parseCsv(await res.text());
    assert.deepEqual(rows[0].slice(0, 5), ['id', 'type', 'title', 'host_or_author', 'status']);
    assert.equal(rows.length - 1, 9);
    const postRow = rows.find((r) => r[1] === 'post');
    assert.equal(postRow[2], `${tag} =SUM(A1) "quoted", post`, 'quotes and commas survive');
    assert.equal(postRow[6], 'feed');
    assert.ok(rows.slice(1).some((r) => r[4] === 'paused') && rows.slice(1).some((r) => r[4] === 'scheduled'));
    // export: filters apply
    const live = parseCsv(await (await fetch(url(`q=${tag}&status=live&type=event`), { headers: { cookie: a.jar.header() } })).text());
    assert.equal(live.length - 1, 6, '8 events minus paused and scheduled'); assert.ok(live.slice(1).every((r) => r[1] === 'event' && r[4] === 'live'));
    const none = parseCsv(await (await fetch(url(`q=${tag}-nothing`), { headers: { cookie: a.jar.header() } })).text());
    assert.equal(none.length, 1, 'header only');
  } finally { await s.stop(); }
});
