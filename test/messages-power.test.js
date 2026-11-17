'use strict';
// Messages power features: WhatsApp-style read receipts (read only after the reader has replied),
// quoted replies, pins, new chat by username / email (privacy + blocks), scheduled messages, inbox tabs
// and labels, search, contact panel + private notes, quick replies, forwarding, voice-note
// transcription caching (charged once), material Q&A, and documents shared in meetings.
Object.assign(process.env, { NODE_ENV: 'test', REMINDER_WORKER: 'false', REPLAY_WORKER: 'false', MESSAGES_RETENTION_WORKER: 'false', CALL_SWEEP: 'false' });
const test = require('node:test');
const assert = require('node:assert/strict');
const { boot, client, signupPayload } = require('./helpers/server');
const { zip } = require('../src/lib/xlsx');
const { buildDoc, textPages } = require('../src/features/content/doc');
const { sanitizeContent } = require('../src/features/content/ws');
const skip = !process.env.DATABASE_URL && process.env.DB_DRIVER !== 'sqlite' ? 'set DATABASE_URL or DB_DRIVER=sqlite' : false;
const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const docx = (paras) => zip([{ name: '[Content_Types].xml', data: '<Types/>' }, { name: 'word/document.xml', data: `<w:document><w:body>${paras.map((p) => `<w:p><w:r><w:t xml:space="preserve">${p}</w:t></w:r></w:p>`).join('')}</w:body></w:document>` }]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('doc builder: text pages and 50-row table pages; content sanitize accepts "doc"', () => {
  const pages = textPages(Array.from({ length: 30 }, (_, i) => `Paragraph ${i} `.repeat(20)).join('\n\n'));
  assert.ok(pages.length > 1 && pages.every((p) => p.length <= 2200));
  const t = buildDoc({ rows: [['Name', 'Qty'], ...Array.from({ length: 120 }, (_, i) => [`n${i}`, String(i)])] }, 'Stock');
  assert.equal(t.kind, 'table'); assert.equal(t.pageCount, 3); assert.deepEqual(t.header, ['Name', 'Qty']); assert.equal(t.rows.length, 120);
  const d = buildDoc({ text: 'Hello\n\nWorld' }, 'Plan');
  assert.equal(d.kind, 'text'); assert.equal(d.pageCount, 1);
  const c = sanitizeContent({ contentType: 'doc', url: '/files/abc123/doc.json', docKind: 'table', pageCount: 999, title: 'Stock' });
  assert.equal(c.type, 'doc'); assert.equal(c.docKind, 'table'); assert.equal(c.pageCount, 200);
  assert.equal(sanitizeContent({ contentType: 'doc', url: 'https://evil.test/x.json' }), null);
});

test('messages power features end to end', { skip, timeout: 180000 }, async (t) => {
  const s = await boot({ MESSAGES_SCHEDULER_MS: '300', VAPID_PUBLIC_KEY: '', VAPID_PRIVATE_KEY: '', MESSAGES_LOOKUPS_PER_MIN: '200' });
  t.after(() => s.stop());
  const db = require('../db');
  const user = async () => { const c = client(s.base); const p = signupPayload(); assert.equal((await c.post('/api/signup', p)).status, 201); c.me = (await c.get('/api/session')).body.user; c.email = p.email; return c; };
  const [A, B, C] = [await user(), await user(), await user()];
  const send = async (c, id, body) => { const r = await c.post(`/api/messages/conversations/${id}/messages`, body); assert.equal(r.status, 201, JSON.stringify(r.body)); return r.body.message; };
  let conv;

  await t.test('new chat by username or email; emails never reveal who is on 1venue; blocks respected', async () => {
    const r = await A.post('/api/messages/new', { handle: '@' + B.me.username });
    assert.equal(r.status, 200, JSON.stringify(r.body)); conv = r.body.conversation; assert.equal(conv.peer.id, B.me.id);
    const byMail = await C.post('/api/messages/new', { handle: A.email.toUpperCase() });
    assert.equal(byMail.status, 200); assert.equal(byMail.body.conversation.peer.id, A.me.id);
    const ghost = await A.post('/api/messages/new', { handle: 'nobody-here@ex.test' });
    assert.equal(ghost.status, 404);
    assert.equal((await A.post('/api/messages/new', { handle: 'no_such_user_zz' })).status, 404);
    assert.equal((await A.post('/api/messages/new', { handle: A.me.username })).status, 400, 'not yourself');
    await B.post('/api/messages/blocks', { userId: C.me.id });
    const blocked = await C.post('/api/messages/new', { handle: B.email });
    assert.equal(blocked.status, 404); assert.equal(blocked.body.error, ghost.body.error, 'a block looks exactly like "no such email"');
    assert.notEqual((await C.post('/api/messages/new', { handle: B.me.username })).status, 200);
    await B.del(`/api/messages/blocks/${C.me.id}`);
    await B.put('/api/messages/settings', { dmPolicy: 'nobody' });
    assert.notEqual((await C.post('/api/messages/new', { handle: B.me.username })).status, 200, 'privacy setting respected');
    await B.put('/api/messages/settings', { dmPolicy: 'everyone' });
  });

  await t.test('read receipts: "read" only after the reader has replied in that chat', async () => {
    const m1 = await send(A, conv.id, { text: 'hi B' });
    await B.post(`/api/messages/conversations/${conv.id}/read`, { messageId: m1.id });
    let view = (await A.get(`/api/messages/conversations/${conv.id}`)).body.conversation;
    assert.equal(view.peerReplied, false); assert.equal(Number(view.peerReadId) || 0, 0, 'B read it but has never replied: A sees only delivered');
    const m2 = await send(B, conv.id, { text: 'hey A' });
    await B.post(`/api/messages/conversations/${conv.id}/read`, { messageId: m2.id });
    view = (await A.get(`/api/messages/conversations/${conv.id}`)).body.conversation;
    assert.equal(view.peerReplied, true); assert.ok(Number(view.peerReadId) >= m1.id, 'after replying, reads are visible');
  });

  let quoted;
  await t.test('quoted replies: stored, returned with a quote, cross-chat ids dropped', async () => {
    const list = (await A.get(`/api/messages/conversations/${conv.id}/messages`)).body.messages;
    const target = list.find((m) => m.text === 'hi B');
    quoted = await send(B, conv.id, { text: 'replying', replyToId: target.id });
    assert.equal(quoted.replyToId, target.id);
    const other = (await C.post('/api/messages/new', { handle: A.me.username })).body.conversation;
    const stray = await send(C, other.id, { text: 'sneaky', replyToId: target.id });
    assert.equal(stray.replyToId || null, null, 'cannot quote a message from another chat');
    const again = (await A.get(`/api/messages/conversations/${conv.id}/messages`)).body.messages.find((m) => m.id === quoted.id);
    assert.equal(again.replyToId, target.id); assert.ok(again.replyTo && /hi B/.test(again.replyTo.text), 'quote preview attached');
  });

  await t.test('pins: many per chat, listed newest first, unpin, outsiders refused', async () => {
    const list = (await A.get(`/api/messages/conversations/${conv.id}/messages`)).body.messages;
    for (const m of list.slice(0, 3)) assert.equal((await A.post(`/api/messages/conversations/${conv.id}/messages/${m.id}/pin`)).status, 200);
    let pins = (await B.get(`/api/messages/conversations/${conv.id}`)).body.conversation.pins;
    assert.equal(pins.length, 3, 'both sides see the pins');
    const r = await B.del(`/api/messages/conversations/${conv.id}/messages/${list[0].id}/pin`);
    assert.equal(r.status, 200); assert.equal(r.body.pins.length, 2);
    assert.notEqual((await C.post(`/api/messages/conversations/${conv.id}/messages/${list[1].id}/pin`)).status, 200);
    pins = (await A.get(`/api/messages/conversations/${conv.id}`)).body.conversation.pins;
    assert.equal(pins.length, 2);
  });

  await t.test('scheduled messages: validated, cancellable, sent by the worker', async () => {
    assert.equal((await A.post(`/api/messages/conversations/${conv.id}/scheduled`, { text: 'too soon', sendAt: new Date(Date.now() + 5000).toISOString() })).status, 400);
    const a = await A.post(`/api/messages/conversations/${conv.id}/scheduled`, { text: 'good morning (scheduled)', sendAt: new Date(Date.now() + 3600000).toISOString() });
    assert.equal(a.status, 201, JSON.stringify(a.body));
    const b = await A.post(`/api/messages/conversations/${conv.id}/scheduled`, { text: 'never sent', sendAt: new Date(Date.now() + 7200000).toISOString() });
    assert.equal((await A.get(`/api/messages/conversations/${conv.id}/scheduled`)).body.scheduled.length, 2);
    assert.equal((await B.del(`/api/messages/scheduled/${b.body.scheduled.id}`)).status, 404, 'only the author can cancel');
    assert.equal((await A.del(`/api/messages/scheduled/${b.body.scheduled.id}`)).status, 200);
    await db.q('UPDATE scheduled_messages SET send_at=$1 WHERE id=$2', [new Date(Date.now() - 1000), a.body.scheduled.id]); // make it due
    let got = null;
    for (let i = 0; i < 40 && !got; i++) { await sleep(150); got = (await B.get(`/api/messages/conversations/${conv.id}/messages`)).body.messages.find((m) => m.text === 'good morning (scheduled)'); }
    assert.ok(got, 'the worker delivered it'); assert.equal(got.senderUserId || got.from?.id || A.me.id, A.me.id);
    const row = (await db.q('SELECT status FROM scheduled_messages WHERE id=$1', [a.body.scheduled.id])).rows[0];
    assert.equal(row.status, 'sent');
    assert.equal((await A.get(`/api/messages/conversations/${conv.id}/scheduled`)).body.scheduled.length, 0);
    const all = (await B.get(`/api/messages/conversations/${conv.id}/messages`)).body.messages.filter((m) => m.text === 'never sent');
    assert.equal(all.length, 0);
  });

  await t.test('inbox tabs, labels, snooze and search', async () => {
    const ids = async (c, f) => (await c.get(`/api/messages/conversations?filter=${encodeURIComponent(f)}`)).body.conversations.map((x) => x.id);
    assert.equal((await A.patch(`/api/messages/conversations/${conv.id}`, { starred: true, labels: [{ name: 'VIP', color: '#e11d48' }] })).status, 200);
    assert.ok((await ids(A, 'starred')).includes(conv.id));
    assert.ok((await ids(A, 'label:VIP')).includes(conv.id));
    assert.ok(!(await ids(B, 'starred')).includes(conv.id), 'stars are per person');
    await A.patch(`/api/messages/conversations/${conv.id}`, { snoozedUntil: new Date(Date.now() + 86400000).toISOString() });
    assert.ok(!(await ids(A, 'inbox')).includes(conv.id)); assert.ok((await ids(A, 'snoozed')).includes(conv.id));
    await A.patch(`/api/messages/conversations/${conv.id}`, { snoozedUntil: null, closed: true });
    assert.ok((await ids(A, 'closed')).includes(conv.id)); assert.ok(!(await ids(A, 'inbox')).includes(conv.id));
    await send(B, conv.id, { text: 'new message reopens it' });
    assert.ok((await ids(A, 'inbox')).includes(conv.id), 'a new message reopens a closed chat');
    await A.patch(`/api/messages/conversations/${conv.id}`, { followUp: true });
    assert.ok((await ids(A, 'followup')).includes(conv.id));
    const hits = (await A.get('/api/messages/search?q=morning')).body.results;
    assert.ok(hits.some((h) => /good morning/.test(h.message.text)));
    assert.equal((await C.get('/api/messages/search?q=morning')).body.results.length, 0, 'search only covers your chats');
    assert.ok((await A.get('/api/messages/search?q=hey&from=them')).body.results.every((h) => !h.message.mine));
  });

  await t.test('contact panel, private notes, quick replies, forwarding', async () => {
    const note = await A.put(`/api/messages/conversations/${conv.id}/note`, { body: 'Met at the conference' });
    assert.equal(note.status, 200);
    const card = (await A.get(`/api/messages/conversations/${conv.id}/contact`)).body;
    assert.equal(card.user.id, B.me.id); assert.equal(card.note.body, 'Met at the conference');
    assert.ok(card.stats && card.stats.total >= 3);
    assert.equal((await B.get(`/api/messages/conversations/${conv.id}/contact`)).body.note.body || '', '', 'notes are private');
    assert.equal((await A.post('/api/messages/quick-replies', { shortcut: 'thx', body: 'Thank you so much!' })).status, 201);
    assert.equal((await A.get('/api/messages/quick-replies')).body.replies[0].shortcut, 'thx');
    const other = (await A.post('/api/messages/new', { handle: C.me.username })).body.conversation;
    const fw = await A.post(`/api/messages/conversations/${conv.id}/messages/${quoted.id}/forward`, { conversationId: other.id });
    assert.equal(fw.status, 201, JSON.stringify(fw.body));
    const inC = (await C.get(`/api/messages/conversations/${other.id}/messages`)).body.messages.find((m) => m.text === 'replying');
    assert.ok(inC, 'forwarded copy delivered'); assert.equal(inC.payload && inC.payload.forwarded, true);
  });

  await t.test('voice-note transcription is cached by file and charged once', async () => {
    const up = await fetch(`${s.base}/api/files`, { method: 'POST', headers: { cookie: B.jar.header(), 'content-type': 'audio/webm', 'x-file-name': 'voice.webm' }, body: Buffer.alloc(2048, 7) });
    const f = await up.json(); assert.equal(up.status, 200, JSON.stringify(f));
    const vm = await send(B, conv.id, { attachment: { kind: 'voice', url: f.url, mime: 'audio/webm', name: 'voice.webm', size: 2048 } });
    const before = (await A.get('/api/ai/usage').catch(() => ({}))).body;
    const t1 = await A.post(`/api/messages/conversations/${conv.id}/messages/${vm.id}/transcribe`);
    assert.equal(t1.status, 200, JSON.stringify(t1.body)); assert.equal(t1.body.cached, false); assert.ok(t1.body.cost >= 1); assert.match(t1.body.text, /Preview transcript/);
    const t2 = await B.post(`/api/messages/conversations/${conv.id}/messages/${vm.id}/transcribe`);
    assert.equal(t2.body.cached, true); assert.equal(t2.body.cost, 0); assert.equal(t2.body.text, t1.body.text);
    const n = (await db.q('SELECT COUNT(*) AS n FROM audio_transcripts WHERE created_by IN ($1,$2)', [A.me.id, B.me.id])).rows[0].n * 1; assert.equal(n, 1);
    const txt = await send(A, conv.id, { text: 'not audio' });
    assert.equal((await A.post(`/api/messages/conversations/${conv.id}/messages/${txt.id}/transcribe`)).status, 400);
    assert.notEqual((await C.post(`/api/messages/conversations/${conv.id}/messages/${vm.id}/transcribe`)).status, 200, 'outsiders cannot');
    void before;
  });

  await t.test('material Q&A: owner asks, answers stored, others refused', async () => {
    const up = await fetch(`${s.base}/api/files?purpose=content`, { method: 'POST', headers: { cookie: A.jar.header(), 'content-type': DOCX, 'x-file-name': 'plan.docx' }, body: docx(['The retreat is on 12 March in Ibadan.', 'Budget is 400,000 naira.']) });
    const f = await up.json();
    const m = (await A.post('/api/materials', { title: 'Retreat plan', kind: 'doc', payload: { sourceUrl: f.url, sourceName: 'plan.docx', sourceMime: DOCX } })).body;
    const r = await A.post(`/api/materials/${m.id}/questions`, { question: 'Where is the retreat?' });
    assert.equal(r.status, 201, JSON.stringify(r.body)); assert.ok(r.body.question.answer.length > 0);
    assert.equal((await A.get(`/api/materials/${m.id}/questions`)).body.questions.length, 1);
    assert.notEqual((await B.post(`/api/materials/${m.id}/questions`, { question: 'Where?' })).status, 201);
    assert.equal((await A.post(`/api/materials/${m.id}/questions`, { question: '?' })).status, 400);
  });

  await t.test('documents shared in a meeting: converted once, served as JSON', async () => {
    const csv = 'Item,Qty\nPens,4\nBooks,10\n';
    const up = await fetch(`${s.base}/api/files?purpose=content`, { method: 'POST', headers: { cookie: A.jar.header(), 'content-type': 'text/csv', 'x-file-name': 'stock.csv' }, body: Buffer.from(csv) });
    const f = await up.json();
    const r = await A.post('/api/convert/doc', { url: f.url, name: 'stock.csv', mime: 'text/csv' });
    assert.equal(r.status, 200, JSON.stringify(r.body)); assert.equal(r.body.contentType, 'doc'); assert.equal(r.body.docKind, 'table'); assert.equal(r.body.pageCount, 1);
    const doc = (await A.get('/api/convert/doc?url=' + encodeURIComponent(r.body.url))).body;
    assert.deepEqual(doc.header, ['Item', 'Qty']); assert.equal(doc.rows.length, 2);
    assert.equal((await client(s.base).post('/api/convert/doc', { url: f.url })).status, 401);
  });
});
