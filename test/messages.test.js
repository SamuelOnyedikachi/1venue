'use strict';
// Messages (M1-M5): DM allow-list, blocking, deletion keeping history, meeting-thread projection and
// read-only state, unread counts, plan gating, call token issuance, retention and the push-disabled path.
Object.assign(process.env, { NODE_ENV: 'test', REMINDER_WORKER: 'false', REPLAY_WORKER: 'false', MESSAGES_RETENTION_WORKER: 'false', CALL_SWEEP: 'false' });
delete process.env.VAPID_PUBLIC_KEY; delete process.env.VAPID_PRIVATE_KEY;
const test = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');
const WebSocket = require('ws');
const { boot, client, signupPayload } = require('./helpers/server');
const plans = require('../src/lib/plans');
const skip = !process.env.DATABASE_URL && process.env.DB_DRIVER !== 'sqlite' ? 'set DATABASE_URL or DB_DRIVER=sqlite' : false;

test('plan keys for messaging: defaults, env fallback and admin validation', () => {
  const s = plans.envDefaults();
  const f = plans.featuresFor(s, 'free'), p = plans.featuresFor(s, 'premium'), o = plans.featuresFor(s, 'organisation');
  assert.deepEqual([f.callVideo, f.groupMembers, f.callParticipants, f.historyDays], [false, 8, 2, 365]);
  assert.deepEqual([p.callVideo, p.groupMembers, p.callParticipants, p.historyDays], [true, 32, 8, 0]);
  assert.deepEqual([o.groupMembers, o.callParticipants, o.historyDays], [64, 16, 0]);
  const m = plans.mergeSettings(s, { features: { free: { callParticipants: 4, historyDays: 30 } } });
  assert.equal(plans.featuresFor(m, 'free').callParticipants, 4);
  assert.throws(() => plans.mergeSettings(s, { features: { free: { callVideo: 2 } } }), (e) => e.status === 400);
});

test('messages end to end', { skip, timeout: 120000 }, async (t) => {
  const LK = { LIVEKIT_URL: 'ws://127.0.0.1:9', LIVEKIT_API_KEY: 'testkey', LIVEKIT_API_SECRET: 'testsecret-testsecret-testsecret-1234' };
  const s = await boot({ ...LK, PLAN_FREE_GROUP_MEMBERS: '3', CALL_RING_TIMEOUT_MS: '5000', VAPID_PUBLIC_KEY: '', VAPID_PRIVATE_KEY: '' });
  t.after(() => s.stop());
  const db = require('../db');
  const one = async (sql, a) => (await db.q(sql, a)).rows[0];
  const user = async () => { const c = client(s.base); const p = signupPayload(); assert.equal((await c.post('/api/signup', p)).status, 201); c.me = (await c.get('/api/session')).body.user; return c; };
  const [A, B, C, D, E] = [await user(), await user(), await user(), await user(), await user()];
  const unread = async (c) => (await c.get('/api/messages/unread')).body.total;

  await t.test('DM allow-list: strangers cannot start a thread, even through /api/dm/with-user', async () => {
    await B.put('/api/messages/settings', { dmPolicy: 'contacts' }); // default is now "everyone"; test the opt-in allow-list
    assert.equal((await A.post('/api/messages/dm', { userId: B.me.id })).status, 403);
    assert.equal((await A.get(`/api/dm/with-user?userId=${B.me.id}`)).status, 403);
    assert.equal((await A.get(`/api/messages/can?userId=${B.me.id}`)).body.ok, false);
    assert.equal((await one('SELECT COUNT(*) AS n FROM dm_threads WHERE (user_a_id=$1 OR user_b_id=$1)', [A.me.id])).n * 1, 0, 'no thread was created');
    await A.post(`/api/users/${B.me.id}/follow`); // one-way is not enough
    assert.equal((await A.post('/api/messages/dm', { userId: B.me.id })).status, 403);
    await B.post(`/api/users/${A.me.id}/follow`);
    assert.equal((await A.get(`/api/messages/can?userId=${B.me.id}`)).body.ok, true);
    assert.equal((await A.get(`/api/dm/with-user?userId=${B.me.id}`)).status, 200, 'mutual follow opens the legacy endpoint too');
  });

  let conv;
  await t.test('send, user-socket fan-out, unread counts and read state', async () => {
    conv = (await A.post('/api/messages/dm', { userId: B.me.id })).body.conversation;
    assert.equal(conv.type, 'dm'); assert.equal(conv.peer.id, B.me.id);
    const ws = new WebSocket(s.base.replace('http', 'ws') + '/ws/me', { headers: { cookie: B.jar.header() } });
    const got = new Promise((resolve, reject) => { ws.on('message', (d) => { const m = JSON.parse(d); if (m.type === 'message') resolve(m); }); ws.on('error', reject); });
    await new Promise((r) => ws.once('open', r));
    const sent = await A.post(`/api/messages/conversations/${conv.id}/messages`, { text: 'hello B' });
    assert.equal(sent.status, 201);
    const evt = await got; ws.close();
    assert.equal(evt.message.text, 'hello B'); assert.equal(evt.conversationId, conv.id);
    await A.post(`/api/messages/conversations/${conv.id}/messages`, { text: 'second' });
    assert.equal(await unread(B), 2); assert.equal(await unread(A), 0);
    const list = (await B.get('/api/messages/conversations')).body.conversations;
    assert.equal(list.find((c) => c.id === conv.id).unread, 2);
    await B.post(`/api/messages/conversations/${conv.id}/read`, {});
    assert.equal(await unread(B), 0, 'read state survives (stored server side)');
    const msgs = (await B.get(`/api/messages/conversations/${conv.id}/messages`)).body.messages;
    assert.deepEqual(msgs.map((m) => m.text), ['hello B', 'second']);
    // reactions and edits (M2)
    const r = await B.post(`/api/messages/conversations/${conv.id}/messages/${msgs[0].id}/reactions`, { emoji: '👍' });
    assert.deepEqual(r.body.reactions, [{ emoji: '👍', count: 1, mine: true }]);
    assert.equal((await B.patch(`/api/messages/conversations/${conv.id}/messages/${msgs[0].id}`, { text: 'nope' })).status, 403, 'only your own');
    const ed = await A.patch(`/api/messages/conversations/${conv.id}/messages/${msgs[0].id}`, { text: 'hello B (edited)' });
    assert.equal(ed.status, 200); assert.ok(ed.body.message.editedAt);
    const unauth = new WebSocket(s.base.replace('http', 'ws') + '/ws/me');
    const code = await new Promise((r) => { unauth.on('unexpected-response', (_q, res) => r(res.statusCode)); unauth.on('open', () => r(200)); unauth.on('error', () => {}); });
    assert.equal(code, 401, 'user socket needs a session');
  });

  await t.test('blocking: hides the thread for the blocker and stops both sides writing', async () => {
    assert.equal((await B.post('/api/messages/blocks', { userId: A.me.id })).status, 200);
    assert.equal((await A.post(`/api/messages/conversations/${conv.id}/messages`, { text: 'are you there' })).status, 403);
    assert.equal((await B.post(`/api/messages/conversations/${conv.id}/messages`, { text: 'x' })).status, 403);
    assert.ok(!(await B.get('/api/messages/conversations')).body.conversations.some((c) => c.id === conv.id));
    const seen = (await A.get(`/api/messages/conversations/${conv.id}`)).body.conversation;
    assert.equal(seen.canSend, false); assert.match(seen.reason, /no longer message/);
    assert.equal((await A.get(`/api/dm/with-user?userId=${B.me.id}`)).status, 403);
    await B.del(`/api/messages/blocks/${A.me.id}`);
    assert.equal((await A.post(`/api/messages/conversations/${conv.id}/messages`, { text: 'back' })).status, 201);
  });

  await t.test('who-can-message-me setting', async () => {
    const set = await fetch(s.base + '/api/messages/settings', { method: 'PUT', headers: { cookie: C.jar.header(), 'content-type': 'application/json' }, body: JSON.stringify({ dmPolicy: 'everyone' }) });
    assert.equal((await set.json()).dmPolicy, 'everyone');
    assert.equal((await D.get(`/api/messages/can?userId=${C.me.id}`)).body.ok, true, 'everyone');
    await fetch(s.base + '/api/messages/settings', { method: 'PUT', headers: { cookie: C.jar.header(), 'content-type': 'application/json' }, body: JSON.stringify({ dmPolicy: 'nobody' }) });
    await D.post(`/api/users/${C.me.id}/follow`); await C.post(`/api/users/${D.me.id}/follow`);
    assert.equal((await D.get(`/api/messages/can?userId=${C.me.id}`)).body.ok, false, 'nobody beats mutual follow');
    await fetch(s.base + '/api/messages/settings', { method: 'PUT', headers: { cookie: C.jar.header(), 'content-type': 'application/json' }, body: JSON.stringify({ dmPolicy: 'contacts' }) });
  });

  await t.test('meeting chats are projected (no copies) and read-only once the room ends; guests get nothing', async () => {
    const hist = (await one("INSERT INTO meeting_history (code, name, host_user_id, host_display_name, ended_at) VALUES ('mtgabc', 'Team sync', $1, 'Host', NOW()) RETURNING id", [D.me.id])).id;
    await db.q("INSERT INTO meeting_participants_log (meeting_history_id, user_id, display_name) VALUES ($1, $2, 'E')", [hist, E.me.id]);
    await db.q("INSERT INTO chat_messages (meeting_history_id, sender_user_id, sender_name, body) VALUES ($1, $2, 'Host', 'welcome all'), ($1, NULL, 'Guest Ada', 'hi from a guest')", [hist, D.me.id]);
    await db.q("INSERT INTO chat_messages (meeting_history_id, sender_user_id, sender_name, body, group_id) VALUES ($1, $2, 'Host', 'side group', 'grp-x')", [hist, D.me.id]);
    await db.q("INSERT INTO dm_threads (user_a_id, guest_key, guest_display_name, peer_is_guest) VALUES ($1, 'guest:p1', 'Guest Ada', TRUE)", [E.me.id]);
    const before = (await one('SELECT COUNT(*) AS n FROM chat_messages')).n * 1;
    const list = (await E.get('/api/messages/conversations')).body.conversations;
    const mt = list.find((c) => c.type === 'meeting');
    assert.ok(mt, 'attendee sees the meeting chat'); assert.equal(mt.title, 'Team sync');
    assert.equal(list.filter((c) => c.type === 'dm').length, 0, 'guest DM threads stay out of the inbox');
    assert.equal(mt.readOnly, true); assert.equal(mt.live, false);
    const msgs = (await E.get(`/api/messages/conversations/${mt.id}/messages`)).body.messages;
    assert.deepEqual(msgs.map((m) => m.text), ['welcome all', 'hi from a guest'], 'public chat only, read from chat_messages');
    assert.equal((await E.post(`/api/messages/conversations/${mt.id}/messages`, { text: 'late reply' })).status, 403);
    assert.equal((await one('SELECT COUNT(*) AS n FROM chat_messages')).n * 1, before, 'nothing copied or written');
    assert.ok((await D.get('/api/messages/conversations')).body.conversations.some((c) => c.id === mt.id), 'host sees it too');
    assert.equal((await one('SELECT COUNT(*) AS n FROM conversations WHERE meeting_history_id=$1', [hist])).n * 1, 1, 'one index row');
    assert.equal(mt.unread, 2);
  });

  await t.test('plan gating: free group size, group calls and video', async () => {
    await A.post(`/api/users/${C.me.id}/follow`); await C.post(`/api/users/${A.me.id}/follow`);
    await A.post(`/api/users/${D.me.id}/follow`); await D.post(`/api/users/${A.me.id}/follow`);
    const big = await A.post('/api/messages/groups', { title: 'Too big', memberIds: [B.me.id, C.me.id, D.me.id] });
    assert.equal(big.status, 403); assert.equal(big.body.upgrade, true);
    const g = await A.post('/api/messages/groups', { title: 'Build team', memberIds: [B.me.id, C.me.id] });
    assert.equal(g.status, 201); assert.equal(g.body.conversation.memberCount, 3);
    const stranger = await A.post(`/api/messages/conversations/${g.body.conversation.id}/members`, { userId: E.me.id });
    assert.equal(stranger.status, 403);
    const gc = await A.post(`/api/messages/conversations/${g.body.conversation.id}/calls`, { kind: 'audio' });
    assert.equal(gc.status, 403); assert.match(gc.body.error, /Group calls/);
    const vid = await A.post(`/api/messages/conversations/${conv.id}/calls`, { kind: 'video' });
    assert.equal(vid.status, 403); assert.match(vid.body.error, /Video calls/);
    // a group member can now reach other members (shared group counts as context)
    assert.equal((await B.get(`/api/messages/can?userId=${C.me.id}`)).body.ok, true);
  });

  await t.test('calls: short-lived LiveKit tokens for an ephemeral call room, no credits, logged in the thread', async () => {
    const st = await A.post(`/api/messages/conversations/${conv.id}/calls`, { kind: 'audio' });
    assert.equal(st.status, 201, JSON.stringify(st.body));
    const tok = jwt.verify(st.body.token, LK.LIVEKIT_API_SECRET);
    assert.match(tok.video.room, /^call-[0-9a-f-]{36}$/); assert.equal(tok.sub, `u:${A.me.id}`);
    assert.ok(tok.exp - (tok.nbf || tok.iat) <= 2 * 3600 + 5, 'TTL is at most 2 hours');
    assert.deepEqual(tok.video.canPublishSources, ['microphone'], 'audio call publishes the microphone only');
    assert.equal((await A.post(`/api/messages/conversations/${conv.id}/calls`, { kind: 'audio' })).status, 409, 'one call at a time');
    const acc = await B.post(`/api/messages/calls/${st.body.call.id}/accept`);
    assert.equal(acc.status, 200); assert.equal(jwt.verify(acc.body.token, LK.LIVEKIT_API_SECRET).video.room, tok.video.room);
    assert.equal((await C.post(`/api/messages/calls/${st.body.call.id}/accept`)).status, 404, 'not a member');
    await B.post(`/api/messages/calls/${st.body.call.id}/leave`);
    const row = await one('SELECT state, end_reason FROM calls WHERE id=$1', [st.body.call.id]);
    assert.deepEqual({ ...row }, { state: 'ended', end_reason: 'completed' });
    const last = (await A.get(`/api/messages/conversations/${conv.id}/messages`)).body.messages.pop();
    assert.equal(last.kind, 'call'); assert.match(last.text, /^Audio call, /);
    assert.equal((await one('SELECT COUNT(*) AS n FROM credit_ledger WHERE user_id=$1', [A.me.id]).catch(() => ({ n: 0 }))).n * 1, 0, 'no wallet movement');
    // unanswered -> missed after the ring timeout
    const st2 = await A.post(`/api/messages/conversations/${conv.id}/calls`, { kind: 'audio' });
    assert.equal(st2.status, 201);
    await new Promise((r) => setTimeout(r, 6500));
    assert.equal((await one('SELECT end_reason FROM calls WHERE id=$1', [st2.body.call.id])).end_reason, 'missed');
    assert.match((await A.get(`/api/messages/conversations/${conv.id}/messages`)).body.messages.pop().text, /^Missed audio call/);
  });

  await t.test('push disabled without VAPID keys: config says off, subscribe stores nothing, sends still work', async () => {
    const cfg = await A.get('/api/messages/push/config');
    assert.deepEqual(cfg.body, { enabled: false, publicKey: null });
    const sub = await A.post('/api/messages/push/subscribe', { endpoint: 'https://push.example/abc', keys: { p256dh: 'x', auth: 'y' } });
    assert.equal(sub.status, 200); assert.equal(sub.body.enabled, false);
    assert.equal((await one('SELECT COUNT(*) AS n FROM push_subscriptions')).n * 1, 0);
    assert.equal((await A.post(`/api/messages/conversations/${conv.id}/messages`, { text: 'still sends' })).status, 201);
  });

  await t.test('report a message', async () => {
    const m = (await B.get(`/api/messages/conversations/${conv.id}/messages`)).body.messages.find((x) => x.text === 'still sends');
    const r = await B.post('/api/messages/reports', { conversationId: conv.id, messageId: m.id, reason: 'spam' });
    assert.equal(r.status, 201);
    const row = await one('SELECT snapshot_text, reported_user_id, status FROM message_reports WHERE id=$1', [r.body.id]);
    assert.equal(row.snapshot_text, 'still sends'); assert.equal(Number(row.reported_user_id), A.me.id); assert.equal(row.status, 'open');
    assert.equal((await B.get('/api/admin/message-reports')).status, 403, 'admins only');
  });

  await t.test('retention: Free hides messages older than 12 months; purge waits for grace and paid members', async () => {
    await D.post(`/api/users/${E.me.id}/follow`); await E.post(`/api/users/${D.me.id}/follow`);
    const de = (await D.post('/api/messages/dm', { userId: E.me.id })).body.conversation;
    const th = (await one('SELECT dm_thread_id FROM conversations WHERE id=$1', [de.id])).dm_thread_id;
    const ago = (d) => new Date(Date.now() - d * 86400000).toISOString();
    for (const [d, body] of [[400, 'very old'], [380, 'old'], [1, 'new']]) await db.q("INSERT INTO dm_messages (thread_id, sender_user_id, sender_name, body, created_at) VALUES ($1,$2,'E',$3,$4)", [th, E.me.id, body, ago(d)]);
    assert.deepEqual((await D.get(`/api/messages/conversations/${de.id}/messages`)).body.messages.map((m) => m.text), ['new']);
    assert.equal((await D.get('/api/messages/unread')).body.conversations[de.id], 1, 'hidden messages are not unread');
    const retention = require('../src/features/messages/retention');
    const r1 = await retention.purge();
    assert.ok(r1.dm >= 1);
    const left = (await db.q('SELECT body FROM dm_messages WHERE thread_id=$1 ORDER BY id', [th])).rows.map((r) => r.body);
    assert.deepEqual(left, ['old', 'new'], '400 days purged, 380 days kept (365 + 30 grace)');
    assert.equal((await retention.purge()).dm, 0, 'idempotent');
    // a paid member keeps the whole thread
    await db.q("INSERT INTO dm_messages (thread_id, sender_user_id, sender_name, body, created_at) VALUES ($1,$2,'E','ancient',$3)", [th, E.me.id, ago(900)]);
    await db.q("INSERT INTO subscriptions (user_id, plan, status, source) VALUES ($1, 'premium', 'comp', 'admin')", [E.me.id]);
    await retention.purge();
    assert.ok((await db.q('SELECT body FROM dm_messages WHERE thread_id=$1', [th])).rows.some((r) => r.body === 'ancient'));
  });

  await t.test('account deletion keeps the other person’s DM history and shows "Deleted user"', async () => {
    const before = (await B.get(`/api/messages/conversations/${conv.id}/messages`)).body.messages.length;
    await require('../src/features/auth/deletion').deleteAccount(A.me.id);
    const c = (await B.get(`/api/messages/conversations/${conv.id}`)).body.conversation;
    assert.equal(c.title, 'Deleted user'); assert.equal(c.readOnly, true); assert.equal(c.canSend, false);
    const msgs = (await B.get(`/api/messages/conversations/${conv.id}/messages`)).body.messages;
    assert.equal(msgs.length, before, 'nothing lost');
    assert.ok(msgs.filter((m) => m.kind === 'text' && !m.mine).every((m) => m.fromName === 'Deleted user' && m.fromUserId === null));
    assert.equal((await B.post(`/api/messages/conversations/${conv.id}/messages`, { text: 'hello?' })).status, 403);
  });
});
