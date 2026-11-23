/**
 * Messages power features, on top of service.js (plan: "Messages that feel like Cooby").
 *   pins             many pinned messages per chat, shared by every member (WhatsApp-style bar)
 *   new chat         by username or email (allow-list, blocks and rate limits still apply)
 *   search           across every chat I am in, with from / has / chat filters
 *   contact panel    profile, shared meetings, files shared in the chat, private notes, reply stats
 *   scheduled        send later; a small worker posts due messages through the normal send path
 *   quick replies    saved snippets per user
 *   forward          a message into another chat or a live meeting's chat
 *   AI               analyse a shared file, table data for charts, voice-note transcription (cached),
 *                    and a summary of a long chat. AI points are spent like everywhere else (takeAi).
 */
const { cleanText, cleanList } = require('../../lib/safe-text');
const crypto = require('node:crypto');
const config = require('../../config');
const log = require('../../lib/log');
const { q, one, many } = require('../../core/db');
const { rateLimit } = require('../../lib/http');
const { normalizeAttachment } = require('../../lib/attachment');
const access = require('./access');
const socket = require('./socket');

const { fail } = access;
const svc = () => require('./service');
const num = (v) => (v == null ? null : Number(v));
const json = (v) => { if (v == null || v === '') return null; if (typeof v === 'object') return v; try { return JSON.parse(v); } catch (_) { return null; } };
const urlKey = (kind, url) => crypto.createHash('sha1').update(`${kind}|${url}`).digest('hex');
const MAX_PINS = 50;

async function writable(user, convId) {
  const c = await svc().convRow(user.id, convId);
  const st = await svc().sendState(c, user.id);
  if (!st.canSend) throw fail(403, st.reason || 'You can’t change this chat');
  return c;
}
async function messageIn(c, mid, me) {
  const s = svc().src(c);
  const row = await one(`SELECT * FROM ${s.table} WHERE id=$1 AND ${s.col}=$2${s.extra}`, [Number(mid), s.key]);
  if (!row || row.deleted_at) throw fail(404, 'Message not found');
  return svc().msgOut(row, c, me);
}

// ---------------------------------------------------------------- pins
async function listPins(c, me) {
  const rows = await many('SELECT message_id, pinned_by, created_at FROM message_pins WHERE conversation_id=$1 ORDER BY created_at DESC, message_id DESC LIMIT $2', [c.id, MAX_PINS]);
  if (!rows.length) return [];
  const s = svc().src(c);
  const msgs = await many(`SELECT * FROM ${s.table} WHERE ${s.col}=$1${s.extra} AND id = ANY($2::int[]) AND deleted_at IS NULL`, [s.key, rows.map((r) => Number(r.message_id))]);
  const by = new Map(msgs.map((r) => { const m = svc().msgOut(r, c, me); return [m.id, m]; }));
  return rows.filter((r) => by.has(Number(r.message_id))).map((r) => {
    const m = by.get(Number(r.message_id));
    return { id: m.id, fromName: m.fromName, text: m.text.slice(0, 200), attachmentKind: m.attachment ? m.attachment.kind : null, pinnedBy: num(r.pinned_by), pinnedAt: r.created_at };
  });
}
async function broadcastPins(c) {
  for (const uid of await svc().memberIds(c.id)) socket.sendToUser(uid, { type: 'pins', conversationId: c.id, pins: await listPins(c, uid) });
}
async function pin(user, convId, mid) {
  const c = await writable(user, convId);
  if (svc().isMeetingScoped(c)) throw fail(400, 'Meeting chats can’t have pins');
  await messageIn(c, mid, user.id);
  const n = Number((await one('SELECT COUNT(*) AS n FROM message_pins WHERE conversation_id=$1', [c.id])).n) || 0;
  if (n >= MAX_PINS) throw fail(400, `You can pin up to ${MAX_PINS} messages. Unpin one first.`);
  await q('INSERT INTO message_pins (conversation_id, message_id, pinned_by) VALUES ($1,$2,$3) ON CONFLICT (conversation_id, message_id) DO NOTHING', [c.id, Number(mid), user.id]);
  await broadcastPins(c);
  return { pins: await listPins(c, user.id) };
}
async function unpin(user, convId, mid) {
  const c = await writable(user, convId);
  await q('DELETE FROM message_pins WHERE conversation_id=$1 AND message_id=$2', [c.id, Number(mid)]);
  await broadcastPins(c);
  return { pins: await listPins(c, user.id) };
}

// ---------------------------------------------------------------- new chat by username or email
const GENERIC = 'We couldn’t start a chat with that person';
async function openByHandle(user, handle) {
  if (!rateLimit('msg-lookup:' + user.id, Number(process.env.MESSAGES_LOOKUPS_PER_MIN) || 20)) throw fail(429, 'Too many lookups. Wait a minute and try again.');
  const h = String(handle || '').trim().replace(/^@/, '').slice(0, 200);
  if (h.length < 2) throw fail(400, 'Type a username or an email address');
  const isEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(h);
  const u = isEmail
    ? await one('SELECT id FROM users WHERE LOWER(email)=LOWER($1) LIMIT 1', [h])
    : await one('SELECT id FROM users WHERE LOWER(username)=LOWER($1) LIMIT 1', [h]);
  // Emails are private: "not on 1venue" and "not allowed" look the same, so nobody can probe addresses.
  if (!u) throw fail(404, isEmail ? GENERIC : 'No one on 1venue has that username');
  if (Number(u.id) === Number(user.id)) throw fail(400, 'That’s you');
  const r = await access.canStartDm(user.id, Number(u.id));
  if (!r.ok) throw fail(isEmail ? 404 : r.status || 403, isEmail ? GENERIC : r.reason);
  return svc().openDm(user, Number(u.id));
}

// ---------------------------------------------------------------- search
const likeEsc = (s) => String(s).replace(/[\\%_]/g, (m) => '\\' + m);
async function search(me, { q: text = '', conversationId = null, from = '', has = '', limit = 40 } = {}) {
  const term = String(text || '').trim().slice(0, 100);
  if (term.length < 2 && !has) throw fail(400, 'Type at least 2 characters');
  const convs = await many(`SELECT c.*, m.cleared_before FROM conversation_members m JOIN conversations c ON c.id=m.conversation_id WHERE m.user_id=$1 AND m.left_at IS NULL${conversationId ? ' AND c.id=$2' : ''}`, conversationId ? [me, Number(conversationId)] : [me]);
  const blocked = await access.blockedByMe(me);
  const out = [];
  const tokens = [...new Set((term.toLowerCase().match(/[\p{L}\p{N}]+/gu) || []))].slice(0, 8);
  const textClause = (p, join) => {
    if (!tokens.length) return '';
    const parts = tokens.map((tok) => {
      p.push(`%${likeEsc(tok)}%`);
      const i = p.length;
      return `(LOWER(COALESCE(body,'')) LIKE $${i} ESCAPE '\\' OR LOWER(COALESCE(sender_name,'')) LIKE $${i} ESCAPE '\\')`;
    });
    return ` AND (${parts.join(` ${join} `)})`;
  };
  for (const c of convs.slice(0, 300)) {
    c.id = Number(c.id);
    const s = svc().src(c);
    const filters = (join) => {
      const p = [s.key, Number(c.cleared_before) || 0];
      let w = `${s.col}=$1${s.extra} AND id > $2 AND deleted_at IS NULL AND (kind IS NULL OR kind NOT IN ('system','call'))`;
      w += textClause(p, join);
      if (from === 'me') { p.push(me); w += ` AND sender_user_id=$${p.length}`; } else if (from === 'them') { p.push(me); w += ` AND (sender_user_id IS NULL OR sender_user_id<>$${p.length})`; }
      if (has === 'link') w += " AND body LIKE '%http%'";
      else if (['file', 'image', 'voice'].includes(has)) { p.push(`%"kind":"${has}"%`); w += ` AND attachments LIKE $${p.length}`; }
      return { p, w };
    };
    let { p, w } = filters('AND');
    let rows = await many(`SELECT * FROM ${s.table} WHERE ${w} ORDER BY id DESC LIMIT 20`, p);
    if (!rows.length && tokens.length > 1) {
      ({ p, w } = filters('OR'));
      rows = await many(`SELECT * FROM ${s.table} WHERE ${w} ORDER BY id DESC LIMIT 20`, p);
    }
    if (!rows.length) continue;
    let title = c.title;
    if (c.type === 'dm') {
      const t = await one('SELECT user_a_id, user_b_id FROM dm_threads WHERE id=$1', [c.dm_thread_id]);
      const peer = t ? (Number(t.user_a_id) === Number(me) ? t.user_b_id : t.user_a_id) : null;
      if (peer && blocked.has(Number(peer))) continue;
      const pu = peer ? await one('SELECT username, display_name FROM users WHERE id=$1', [peer]) : null;
      title = pu ? pu.display_name || pu.username : svc().ANON;
    }
    for (const r of rows) out.push({ conversationId: c.id, title: title || 'Group', type: c.type, message: svc().msgOut(r, c, me) });
  }
  out.sort((a, b) => new Date(b.message.createdAt) - new Date(a.message.createdAt));
  return { results: out.slice(0, Math.min(100, Number(limit) || 40)) };
}

// ---------------------------------------------------------------- contact panel
async function dmPeer(me, convId) {
  const c = await svc().convRow(me, convId);
  if (c.type !== 'dm') throw fail(400, 'Contact details are for direct chats');
  const peer = Number(c.user_a_id) === Number(me) ? num(c.user_b_id) : num(c.user_a_id);
  if (!peer) throw fail(404, 'This account was deleted');
  return { c, peer };
}
/** Average gap between a message and the other person's next reply, in seconds (gaps over 3 days ignored). */
function replyStats(rows, me) {
  const gaps = { mine: [], theirs: [] };
  for (let i = 1; i < rows.length; i++) {
    const a = rows[i - 1], b = rows[i];
    if (!a.sender_user_id || !b.sender_user_id || Number(a.sender_user_id) === Number(b.sender_user_id)) continue;
    const d = (new Date(b.created_at) - new Date(a.created_at)) / 1000;
    if (d < 0 || d > 3 * 86400) continue;
    (Number(b.sender_user_id) === Number(me) ? gaps.mine : gaps.theirs).push(d);
  }
  const avg = (x) => (x.length ? Math.round(x.reduce((s, v) => s + v, 0) / x.length) : null);
  return { myAvgReplySec: avg(gaps.mine), theirAvgReplySec: avg(gaps.theirs) };
}
async function contact(me, convId) {
  const { c, peer } = await dmPeer(me, convId);
  const u = await one('SELECT id, username, display_name, avatar_url, bio, created_at FROM users WHERE id=$1', [peer]);
  if (!u) throw fail(404, 'This account was deleted');
  const meetings = await many(`SELECT mh.id, mh.name, mh.code, mh.created_at FROM meeting_history mh
    WHERE mh.id IN (SELECT meeting_history_id FROM meeting_participants_log WHERE user_id=$1 UNION SELECT id FROM meeting_history WHERE host_user_id=$1)
      AND mh.id IN (SELECT meeting_history_id FROM meeting_participants_log WHERE user_id=$2 UNION SELECT id FROM meeting_history WHERE host_user_id=$2)
    ORDER BY mh.id DESC LIMIT 10`, [me, peer]).catch(() => []);
  const rows = await many('SELECT id, sender_user_id, created_at, attachments, body, kind, deleted_at FROM dm_messages WHERE thread_id=$1 ORDER BY id DESC LIMIT 1000', [c.dm_thread_id]);
  rows.reverse();
  const real = rows.filter((r) => !r.deleted_at && (!r.kind || !['system', 'call'].includes(r.kind)));
  const files = [];
  for (let i = real.length - 1; i >= 0 && files.length < 20; i--) {
    const a = json(real[i].attachments);
    if (a && a.url && a.kind !== 'passage') files.push({ messageId: Number(real[i].id), kind: a.kind || 'file', name: a.name || 'file', url: a.url, mime: a.mime || '', at: real[i].created_at });
  }
  const mats = await many(`SELECT m.id, m.title, m.kind FROM materials m WHERE m.owner_user_id=$1 AND EXISTS (
      SELECT 1 FROM event_materials em JOIN events e ON e.id=em.event_id WHERE em.material_id=m.id AND e.visibility='public') ORDER BY m.id DESC LIMIT 6`, [peer]).catch(() => []);
  const note = await one('SELECT body, updated_at FROM contact_notes WHERE owner_id=$1 AND subject_user_id=$2', [me, peer]);
  const total = Number((await one('SELECT COUNT(*) AS n FROM dm_messages WHERE thread_id=$1 AND deleted_at IS NULL', [c.dm_thread_id])).n) || 0;
  const mine = Number((await one('SELECT COUNT(*) AS n FROM dm_messages WHERE thread_id=$1 AND deleted_at IS NULL AND sender_user_id=$2', [c.dm_thread_id, me])).n) || 0;
  return {
    user: { id: Number(u.id), username: u.username, name: u.display_name || u.username, avatarUrl: u.avatar_url || null, bio: u.bio || '', joinedAt: u.created_at },
    sharedMeetings: meetings.map((m) => ({ id: Number(m.id), name: m.name || 'Meeting', code: m.code, at: m.created_at })),
    files, materials: mats.map((m) => ({ id: Number(m.id), title: m.title, kind: m.kind })),
    note: note ? { body: note.body, updatedAt: note.updated_at } : { body: '', updatedAt: null },
    stats: { total, mine, theirs: total - mine, firstAt: real[0] ? real[0].created_at : null, lastAt: real.length ? real[real.length - 1].created_at : null, ...replyStats(real, me) },
  };
}
async function saveNote(me, convId, body) {
  const { peer } = await dmPeer(me, convId);
  const text = String(body || '').slice(0, 4000);
  await q(`INSERT INTO contact_notes (owner_id, subject_user_id, body, updated_at) VALUES ($1,$2,$3,NOW())
    ON CONFLICT (owner_id, subject_user_id) DO UPDATE SET body=EXCLUDED.body, updated_at=NOW()`, [me, peer, text]);
  return { note: { body: text, updatedAt: new Date().toISOString() } };
}

// ---------------------------------------------------------------- scheduled messages
const schedOut = (r) => ({ id: Number(r.id), conversationId: Number(r.conversation_id), text: r.body || '', attachment: json(r.attachments), replyToId: num(r.reply_to_id), sendAt: new Date(r.send_at).toISOString(), status: r.status, error: r.error || null, sentMessageId: num(r.sent_message_id) });
async function schedule(user, convId, b = {}) {
  const c = await writable(user, convId);
  if (svc().isMeetingScoped(c)) throw fail(400, 'Meeting chats can’t have scheduled messages');
  const { text, attachment } = svc().cleanInput(b);
  const at = new Date(b.sendAt);
  if (Number.isNaN(at.getTime())) throw fail(400, 'Pick when to send it');
  if (at.getTime() < Date.now() + 30000) throw fail(400, 'Pick a time at least a minute from now');
  if (at.getTime() > Date.now() + 366 * 86400000) throw fail(400, 'Schedule up to a year ahead');
  const n = Number((await one("SELECT COUNT(*) AS n FROM scheduled_messages WHERE user_id=$1 AND status='pending'", [user.id])).n) || 0;
  if (n >= 100) throw fail(400, 'You have 100 scheduled messages waiting. Cancel some first.');
  const replyToId = await svc().validReply(c, b.replyToId);
  const r = await one(`INSERT INTO scheduled_messages (conversation_id, user_id, body, attachments, reply_to_id, send_at) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [c.id, user.id, text, attachment ? JSON.stringify(attachment) : null, replyToId, at]);
  return { scheduled: schedOut(r) };
}
async function listScheduled(user, convId) {
  const c = await svc().convRow(user.id, convId);
  return { scheduled: (await many("SELECT * FROM scheduled_messages WHERE user_id=$1 AND conversation_id=$2 AND status='pending' ORDER BY send_at", [user.id, c.id])).map(schedOut) };
}
async function cancelScheduled(user, id) {
  const r = await q("UPDATE scheduled_messages SET status='cancelled' WHERE id=$1 AND user_id=$2 AND status='pending'", [Number(id), user.id]);
  if (!r.rowCount) throw fail(404, 'Scheduled message not found');
  return { ok: true };
}
/** Send everything that is due. Each row is claimed first so two processes never send it twice. */
async function runDue(now = new Date()) {
  const due = await many("SELECT * FROM scheduled_messages WHERE status='pending' AND send_at <= $1 ORDER BY send_at LIMIT 50", [now]);
  let sent = 0;
  for (const r of due) {
    const claim = await q("UPDATE scheduled_messages SET status='sent' WHERE id=$1 AND status='pending'", [r.id]);
    if (!claim.rowCount) continue;
    try {
      const user = await one('SELECT id, username, display_name FROM users WHERE id=$1', [r.user_id]);
      if (!user) throw fail(410, 'Account deleted');
      const c = await svc().convRow(user.id, Number(r.conversation_id));
      const st = await svc().sendState(c, user.id);
      if (!st.canSend) throw fail(403, st.reason || 'You can’t send messages here any more');
      const row = await svc().insertMessage(c, { senderUserId: user.id, senderName: svc().nameOf(user), text: r.body || '', attachment: json(r.attachments), replyToId: num(r.reply_to_id), payload: { scheduled: true } });
      await svc().deliver(c, row, { senderId: user.id });
      await q('UPDATE scheduled_messages SET sent_message_id=$2 WHERE id=$1', [r.id, row.id]);
      socket.sendToUser(user.id, { type: 'scheduled-sent', conversationId: c.id, id: Number(r.id) });
      sent++;
    } catch (e) {
      await q("UPDATE scheduled_messages SET status='failed', error=$2 WHERE id=$1", [r.id, String(e.message || 'failed').slice(0, 200)]).catch(() => {});
      log.warn('messages', 'scheduled send failed', { id: Number(r.id), error: e.message });
    }
  }
  return { sent };
}
let timer = null;
function startWorker() {
  if (timer || process.env.MESSAGES_SCHEDULER === 'false') return null;
  const every = Math.max(200, config.MESSAGES.schedulerMs);
  timer = setInterval(() => { runDue().catch((e) => log.warn('messages', 'scheduler', { error: e.message })); }, every);
  timer.unref();
  return timer;
}

// ---------------------------------------------------------------- quick replies
async function listQuick(me) {
  return { replies: (await many('SELECT id, shortcut, body FROM quick_replies WHERE user_id=$1 ORDER BY shortcut', [me])).map((r) => ({ id: Number(r.id), shortcut: r.shortcut, body: r.body })) };
}
async function addQuick(me, b = {}) {
  const shortcut = String(b.shortcut || '').trim().replace(/^\//, '').replace(/\s+/g, '-').slice(0, 24);
  const body = String(b.body || '').trim().slice(0, 1000);
  if (!shortcut || !body) throw fail(400, 'Give it a shortcut and the text');
  const n = Number((await one('SELECT COUNT(*) AS n FROM quick_replies WHERE user_id=$1', [me])).n) || 0;
  if (n >= 50) throw fail(400, 'You can save up to 50 quick replies');
  await q('INSERT INTO quick_replies (user_id, shortcut, body) VALUES ($1,$2,$3)', [me, shortcut, body]);
  return listQuick(me);
}
async function delQuick(me, id) { await q('DELETE FROM quick_replies WHERE id=$1 AND user_id=$2', [Number(id), me]); return listQuick(me); }

// ---------------------------------------------------------------- forward
async function forward(user, convId, mid, targetId) {
  if (!rateLimit('msg-fwd:' + user.id, 20)) throw fail(429, 'You are forwarding too quickly');
  const c = await svc().convRow(user.id, convId);
  const m = await messageIn(c, mid, user.id);
  if (m.kind !== 'text') throw fail(400, 'Only messages can be forwarded');
  const attachment = m.attachment ? normalizeAttachment(m.attachment) : null;
  const t = await svc().convRow(user.id, Number(targetId));
  if (svc().isMeetingScoped(t)) return { message: await svc().sendMessage(user, t.id, { text: m.text ? `↪ ${m.text}` : '', attachment }), conversationId: t.id };
  const st = await svc().sendState(t, user.id);
  if (!st.canSend) throw fail(403, st.reason || 'You can’t send messages there');
  if (!m.text && !attachment) throw fail(400, 'Nothing to forward');
  const row = await svc().insertMessage(t, { senderUserId: user.id, senderName: svc().nameOf(user), text: m.text, attachment, payload: { forwarded: true } });
  const out = await svc().deliver(t, row, { senderId: user.id });
  return { message: { ...out, mine: true }, conversationId: t.id };
}

// ---------------------------------------------------------------- AI
const llmOn = () => !config.AI.mock && !!config.STT.replicate.token;
async function llm(prompt, { system, maxTokens = 700, tag = 'messages-ai' } = {}) {
  const { run, llmInput, llmText, resolveLlm } = require('../../lib/replicate');
  const model = resolveLlm(config.MATERIALS.model);
  const out = await run({ token: config.STT.replicate.token, apiBase: config.STT.replicate.apiBase, model, tag, timeoutMs: config.MATERIALS.timeoutMs, wait: 15,
    input: llmInput({ prompt, system: system || 'You are a concise assistant inside a messaging app.', maxTokens: maxTokens, temperature: 0.3 }) });
  return llmText(out.output);
}
async function spend(userId, kind) {
  const t = await require('../../lib/plans').takeAi({ kind, ownerId: userId });
  if (!t.ok) throw fail(429, `Not enough AI points left today (${t.left} of ${t.limit}). Upgrade your plan for more.`, { upgrade: true });
  return t;
}
async function fileOf(user, convId, mid) {
  const c = await svc().convRow(user.id, convId);
  const m = await messageIn(c, mid, user.id);
  const a = m.attachment;
  if (!a || !a.url) throw fail(400, 'This message has no stored file');
  return { c, m, a };
}
const tableCache = new Map();
async function extractedFile(a) {
  const key = urlKey('x', a.url);
  if (tableCache.has(key)) return tableCache.get(key);
  const { readStored } = require('../materials/analysis');
  const { extract } = require('../materials/extract');
  const { buf, row } = await readStored(a.url);
  const x = await extract({ buf, name: a.name || row.filename, mime: a.mime || row.mime });
  tableCache.set(key, x); if (tableCache.size > 20) tableCache.delete(tableCache.keys().next().value);
  return x;
}
/** Old cached rows may hold raw model output: clean them on the way out too. */
const cleanAnalysis = (r = {}) => ({ ...r, summary: cleanText(r.summary, { max: 2000 }), keyPoints: cleanList(r.keyPoints, { max: 300, limit: 8 }), dataCommentary: cleanText(r.dataCommentary, { max: 2000 }) || undefined });
async function analyseFile(user, convId, mid, { force = false } = {}) {
  const { a } = await fileOf(user, convId, mid);
  const key = urlKey('analysis', a.url);
  if (!force) { const hit = await one('SELECT result, model, created_at FROM message_file_analyses WHERE url_key=$1', [key]); if (hit) return { analysis: { ...cleanAnalysis(json(hit.result)), model: hit.model, createdAt: hit.created_at, cached: true } }; }
  if (!rateLimit('msg-analyse:' + user.id, 6)) throw fail(429, 'Please wait a minute before analysing again');
  const x = await extractedFile(a);
  if (!String(x.text || '').trim()) throw fail(422, 'No readable text was found in this file');
  const t = await spend(user.id, 'analysis');
  const analysis = require('../materials/analysis');
  let r;
  try { r = await analysis.callModel({ title: a.name || 'file' }, x); } catch (e) { await t.refund(); throw e; }
  const result = { summary: cleanText(r.result.summary, { max: 2000 }), keyPoints: cleanList(r.result.keyPoints, { max: 300, limit: 8 }), dataCommentary: cleanText(r.result.dataCommentary, { max: 2000 }) || undefined, type: x.type, chartable: !!x.rows, mock: r.mock, cost: t.cost };
  await q(`INSERT INTO message_file_analyses (url_key, result, model, created_by) VALUES ($1,$2,$3,$4)
    ON CONFLICT (url_key) DO UPDATE SET result=EXCLUDED.result, model=EXCLUDED.model, created_at=NOW()`, [key, JSON.stringify(result), r.model, user.id]);
  return { analysis: { ...result, model: r.model, cached: false } };
}
/** Table data for client-side charts (CSV / XLSX). Free: nothing leaves the server. */
async function tableData(user, convId, mid) {
  const { a } = await fileOf(user, convId, mid);
  const x = await extractedFile(a);
  if (!x.rows) throw fail(415, 'Charts need a CSV or Excel file');
  const header = (x.rows[0] || []).slice(0, 20).map((h, i) => h || `Column ${i + 1}`);
  return { name: a.name, header, rows: x.rows.slice(1, 1001).map((r) => r.slice(0, 20)), totalRows: Math.max(0, x.rows.length - 1), columns: x.stats.columns.slice(0, 20).map((c) => ({ name: c.name, type: c.type })) };
}
/** Speech to text for a voice note or audio file. Cached per file, so it is charged once for everyone. */
async function transcribe(user, convId, mid) {
  const { a } = await fileOf(user, convId, mid);
  if (a.kind !== 'voice' && !/^audio\//.test(a.mime || '') && !/^video\/(webm|mp4)/.test(a.mime || '')) throw fail(400, 'Only voice notes and audio files can be transcribed');
  const key = urlKey('stt', a.url);
  const hit = await one('SELECT text, model FROM audio_transcripts WHERE url_key=$1', [key]);
  if (hit) return { text: hit.text, model: hit.model, cached: true, cost: 0 };
  if (!rateLimit('msg-stt:' + user.id, 6)) throw fail(429, 'Please wait a minute before transcribing again');
  const model = config.MESSAGES.sttModel || config.STT.replicate.model;
  const t = await spend(user.id, 'transcribe');
  let text;
  try {
    if (!llmOn()) text = `(Preview transcript) Voice note “${a.name || 'audio'}”. Set REPLICATE_API_TOKEN for real transcription.`;
    else {
      const stt = require('../../venue/stt');
      let audio;
      const base = String(config.PUBLIC_URL || '').replace(/\/$/, '');
      if (/^https:\/\//.test(a.url)) audio = a.url;
      else if (base && /^https:\/\//.test(base)) audio = base + a.url;
      else {
        const { readStored } = require('../materials/analysis');
        const { buf, row } = await readStored(a.url, config.MESSAGES.maxAudioMB * 1048576);
        audio = `data:${a.mime || row.mime || 'audio/webm'};base64,${buf.toString('base64')}`;
      }
      const { run } = require('../../lib/replicate');
      const r = await run({ token: config.STT.replicate.token, apiBase: config.STT.replicate.apiBase, model, input: stt.replicateInput(model, audio, null), timeoutMs: config.MESSAGES.sttTimeoutMs, tag: 'messages-stt', wait: 10 });
      text = stt.clean(stt.replicateText(r.output));
    }
  } catch (e) { await t.refund(); throw e; }
  text = cleanText(text, { max: 20000 }) || '(No speech detected)';
  await q('INSERT INTO audio_transcripts (url_key, text, model, created_by) VALUES ($1,$2,$3,$4) ON CONFLICT (url_key) DO NOTHING', [key, text, llmOn() ? model : 'mock', user.id]);
  return { text, model: llmOn() ? model : 'mock', cached: false, cost: t.cost };
}
const summaries = new Map();
async function summarize(user, convId) {
  const c = await svc().convRow(user.id, convId);
  const { messages } = await svc().listMessages(user.id, c.id, { limit: 100 });
  const real = messages.filter((m) => !m.deleted && m.kind !== 'system' && m.kind !== 'call' && (m.text || m.attachment));
  if (real.length < 3) throw fail(400, 'There isn’t enough here to summarise yet');
  const lastId = real[real.length - 1].id;
  const ck = `${c.id}:${lastId}`;
  if (summaries.has(ck)) return { ...summaries.get(ck), cached: true };
  if (!rateLimit('msg-sum:' + user.id, 6)) throw fail(429, 'Please wait a minute before summarising again');
  const t = await spend(user.id, 'summary');
  const transcript = real.map((m) => `${m.fromName}: ${m.text || `[${m.attachment.kind}: ${m.attachment.name || ''}]`}`).join('\n').slice(-12000);
  let out;
  try {
    if (!llmOn()) {
      const people = [...new Set(real.map((m) => m.fromName))];
      out = { summary: `${real.length} recent messages between ${people.slice(0, 4).join(', ')}.`, keyPoints: real.filter((m) => m.text && m.text.length > 25).slice(-4).map((m) => `${m.fromName}: ${m.text.slice(0, 140)}`), actionItems: real.filter((m) => /\b(will|todo|to do|please|by (mon|tue|wed|thu|fri|tomorrow)|deadline)\b/i.test(m.text || '')).slice(-3).map((m) => m.text.slice(0, 140)), mock: true };
    } else {
      const text = await llm(`Summarise this chat for someone catching up. Reply with JSON only: {"summary":"2-3 sentences","keyPoints":["up to 5"],"actionItems":["who does what, up to 5"]}\n\nChat:\n"""\n${transcript}\n"""`, { maxTokens: 700, tag: 'messages-summary' });
      const p = require('../materials/analysis').parseJson(text);
      out = { summary: cleanText(p.summary, { max: 1500 }) || 'No summary came back. Try again.', keyPoints: cleanList(p.keyPoints, { max: 240, limit: 6 }), actionItems: cleanList(p.actionItems, { max: 240, limit: 6 }), mock: false };
    }
  } catch (e) { await t.refund(); throw e; }
  out.cost = t.cost; out.count = real.length;
  summaries.set(ck, out); if (summaries.size > 200) summaries.delete(summaries.keys().next().value);
  return { ...out, cached: false };
}

module.exports = {
  listPins, pin, unpin, openByHandle, search, contact, saveNote, replyStats,
  schedule, listScheduled, cancelScheduled, runDue, startWorker,
  listQuick, addQuick, delQuick, forward, analyseFile, tableData, transcribe, summarize, urlKey, cleanAnalysis,
};
