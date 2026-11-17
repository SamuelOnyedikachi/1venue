'use strict';
// Delete account: password -> emailed 6-digit code -> final confirm. Rate/attempt limits, Google/
// Apple-only accounts (no password), what is deleted vs anonymised, storage cleanup, emails.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { boot, client, signupPayload } = require('./helpers/server');

const skip = !process.env.DATABASE_URL && process.env.DB_DRIVER !== 'sqlite' ? 'set DATABASE_URL' : false;

/** The code from the "[mail] ... code=123456" console line (SMTP unset in tests). */
async function codeFor(s, email, after) {
  const t0 = Date.now();
  while (Date.now() - t0 < 5000) {
    const line = s.output().slice(after).split('\n').reverse().find((l) => l.startsWith('[mail]') && l.includes(`to=${email} `) && / code=\d{6}/.test(l));
    if (line) return / code=(\d{6})/.exec(line)[1];
    await new Promise((r) => setTimeout(r, 50));
  }
  return null;
}

test('delete account: password, email code, limits, data removed or anonymised, files gone', { skip }, async () => {
  const storeDir = fs.mkdtempSync(path.join(os.tmpdir(), '1v-del-'));
  const s = await boot({ STORAGE_DRIVER: 'local', STORAGE_DIR: storeDir });
  const db = require('../db');
  try {
    const p = signupPayload({ password: 'delete me please 1' });
    const c = client(s.base);
    assert.equal((await c.post('/api/signup', p)).status, 201);
    const me = (await c.get('/api/session')).body.user;
    const other = client(s.base);
    await other.post('/api/signup', signupPayload());
    const otherId = (await other.get('/api/session')).body.user.id;

    // some data across features
    await db.q("INSERT INTO posts (user_id, body) VALUES ($1, 'hello')", [me.id]);
    const hist = (await db.q("INSERT INTO meeting_history (code, name, host_user_id, host_display_name) VALUES ('del-room', 'Room', $1, 'Del Host') RETURNING id", [otherId])).rows[0].id;
    await db.q("INSERT INTO chat_messages (meeting_history_id, sender_user_id, sender_name, body) VALUES ($1, $2, 'Del User', 'shared msg')", [hist, me.id]);
    const qid = (await db.q("INSERT INTO questions (code, author_key, author_name, body) VALUES ('del-room', $1, 'Del User', 'a question?') RETURNING id", [`u:${me.id}`])).rows[0].id;
    await db.q("INSERT INTO meeting_participants_log (meeting_history_id, user_id, display_name) VALUES ($1, $2, 'Del User')", [hist, me.id]);
    const th = (await db.q('INSERT INTO dm_threads (user_a_id, user_b_id) VALUES ($1, $2) RETURNING id', [me.id, otherId])).rows[0].id;
    await db.q("INSERT INTO dm_messages (thread_id, sender_user_id, sender_name, body) VALUES ($1, $2, 'Del User', 'hi')", [th, me.id]);
    fs.mkdirSync(path.join(storeDir, '2026/11'), { recursive: true });
    fs.writeFileSync(path.join(storeDir, '2026/11/abc-me.png'), 'x');
    await db.q("INSERT INTO files (id, driver, object_key, filename, mime, size_bytes, owner_user_id) VALUES ('fdeltest0000000001', 'local', '2026/11/abc-me.png', 'me.png', 'image/png', 1, $1)", [me.id]);

    // not signed in -> 401
    assert.equal((await client(s.base).post('/api/auth/delete/start', { password: p.password })).status, 401);
    // wrong password
    const wrong = await c.post('/api/auth/delete/start', { password: 'nope nope nope' });
    assert.equal(wrong.status, 400); assert.match(wrong.body.error, /password/i);

    // right password -> code by email, masked address back
    let mark = s.mark();
    const st = await c.post('/api/auth/delete/start', { password: p.password });
    assert.equal(st.status, 200); assert.equal(st.body.expiresInMin, 10);
    assert.ok(!st.body.email.includes(p.email.split('@')[0].slice(1)), 'email is masked');
    const code1 = await codeFor(s, p.email, mark);
    assert.match(code1, /^\d{6}$/);
    const row = (await db.q('SELECT code_hash FROM account_deletion_codes WHERE user_id = $1', [me.id])).rows[0];
    assert.notEqual(row.code_hash, code1, 'only a hash is stored');
    // a second code within a minute is refused
    assert.equal((await c.post('/api/auth/delete/start', { password: p.password })).status, 429);

    // 5 wrong codes lock it, even the right one then fails
    const bad = code1 === '000000' ? '111111' : '000000';
    for (let i = 0; i < 4; i++) assert.equal((await c.post('/api/auth/delete/verify', { code: bad })).status, 400);
    assert.equal((await c.post('/api/auth/delete/verify', { code: bad })).status, 429);
    assert.equal((await c.post('/api/auth/delete/verify', { code: code1 })).status, 429);

    // new code (pretend a minute passed), verify, then a grant is required to delete
    await db.q(`UPDATE account_deletion_codes SET created_at = ${db.USE_PG ? "NOW() - interval '2 minutes'" : "strftime('%Y-%m-%dT%H:%M:%fZ','now','-2 minutes')"} WHERE user_id = $1`, [me.id]);
    mark = s.mark();
    assert.equal((await c.post('/api/auth/delete/start', { password: p.password })).status, 200);
    const code2 = await codeFor(s, p.email, mark);
    assert.equal((await c.post('/api/auth/delete/confirm', { grant: 'forged' })).status, 400);
    const v = await c.post('/api/auth/delete/verify', { code: code2 });
    assert.equal(v.status, 200); assert.ok(v.body.grant);
    assert.equal((await c.post('/api/auth/delete/verify', { code: code2 })).status, 400, 'a code works once');
    // another user's session cannot use this grant
    assert.equal((await other.post('/api/auth/delete/confirm', { grant: v.body.grant })).status, 403);

    mark = s.mark();
    const del = await c.post('/api/auth/delete/confirm', { grant: v.body.grant });
    assert.equal(del.status, 200); assert.equal(del.body.deleted, true);
    assert.ok(await s.mailLink(p.email, /account was deleted/, { after: mark }) !== null, 'goodbye email sent');
    assert.equal((await c.get('/api/me')).status, 401, 'signed out');
    assert.equal((await client(s.base).post('/api/login', { login: p.email, password: p.password })).status, 401);

    const one = async (sql, args) => (await db.q(sql, args)).rows[0];
    assert.equal(await one('SELECT 1 FROM users WHERE id = $1', [me.id]), undefined);
    assert.equal((await one('SELECT COUNT(*)::int n FROM posts WHERE user_id = $1', [me.id])).n, 0);
    assert.equal((await one('SELECT COUNT(*)::int n FROM auth_sessions WHERE user_id = $1', [me.id])).n, 0);
    assert.equal((await one('SELECT COUNT(*)::int n FROM dm_threads WHERE id = $1', [th])).n, 1, 'DM thread kept for the other person');
    assert.deepEqual(await one('SELECT sender_user_id, sender_name FROM dm_messages WHERE thread_id = $1', [th]), { sender_user_id: null, sender_name: 'Deleted user' }, 'their DM side anonymised');
    assert.equal(await one("SELECT 1 FROM files WHERE id = 'fdeltest0000000001'"), undefined);
    assert.equal(fs.existsSync(path.join(storeDir, '2026/11/abc-me.png')), false, 'file removed from storage');
    const msg = await one("SELECT sender_user_id, sender_name FROM chat_messages WHERE body = 'shared msg' AND meeting_history_id = $1", [hist]);
    assert.deepEqual(msg, { sender_user_id: null, sender_name: 'Deleted user' }, 'shared chat kept, anonymised');
    const qn = await one('SELECT author_key, author_name FROM questions WHERE id = $1', [qid]);
    assert.equal(qn.author_name, 'Deleted user'); assert.notEqual(qn.author_key, `u:${me.id}`);
    assert.equal((await one('SELECT display_name FROM meeting_participants_log WHERE meeting_history_id = $1', [hist])).display_name, 'Deleted user');
    assert.equal((await other.get('/api/me')).status, 200, 'other people are untouched');
  } finally { await s.stop(); await db.close().catch(() => {}); fs.rmSync(storeDir, { recursive: true, force: true }); }
});

test('delete account without a password (Google/Apple-only): straight to the email code', { skip }, async () => {
  const s = await boot();
  const db = require('../db');
  try {
    const p = signupPayload();
    const c = client(s.base);
    await c.post('/api/signup', p);
    await db.q('UPDATE users SET password_hash = NULL WHERE email = $1', [p.email]);
    const mark = s.mark();
    const st = await c.post('/api/auth/delete/start', {});
    assert.equal(st.status, 200); assert.equal(st.body.passwordChecked, false);
    const code = await codeFor(s, p.email, mark);
    const v = await c.post('/api/auth/delete/verify', { code });
    assert.equal(v.status, 200);
    assert.equal((await c.post('/api/auth/delete/confirm', { grant: v.body.grant })).status, 200);
    assert.equal((await db.q('SELECT 1 FROM users WHERE email = $1', [p.email])).rows.length, 0);
  } finally { await s.stop(); await db.close().catch(() => {}); }
});
