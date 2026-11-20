/**
 * Messages: one inbox over the existing chat stores (plan sections 2-3). Nothing is copied:
 *   dm       -> dm_messages (thread_id)                     signed-in pairs only
 *   meeting  -> chat_messages (meeting_history_id, no group) public chat of a meeting you attended
 *   group    -> chat_messages (group_id)                     an in-meeting sub-group you were in
 *            -> chat_messages (conversation_id)              a standing group or an organisation team group
 * `conversations` is only an index (title, last preview) and `conversation_members` holds per-user
 * state (read pointer, mute, archive, pin, clear). Sends from a live room and from /messages write
 * the same row through the same functions, so there is never a second copy of history.
 */
const { q, one, many } = require('../../core/db');
const db = require('../../../db');
const plans = require('../../lib/plans');
const store = require('../../rooms/store');
const { normCode } = require('../../lib/codes');
const { rateLimit } = require('../../lib/http');
const { normalizeAttachment } = require('../../lib/attachment');
const access = require('./access');
const { isVerified } = require('../../lib/auth');
const socket = require('./socket');
const push = require('./push');

const { fail } = access;
const ANON = 'Deleted user';
const MAX_TEXT = 2000;
const EDIT_WINDOW_MS = 15 * 60 * 1000;
const num = (v) => (v == null ? null : Number(v));
const json = (v) => { if (v == null || v === '') return null; if (typeof v === 'object') return v; try { return JSON.parse(v); } catch (_) { return null; } };
const nameOf = (u) => (u && (u.displayName || u.display_name || u.username)) || 'Someone';

// ---------------------------------------------------------------- plans
const entCache = new Map();
async function ent(userId) {
  const hit = entCache.get(userId);
  if (hit && Date.now() - hit.at < 30000) return hit.v;
  const v = await plans.entitlements(userId);
  entCache.set(userId, { v, at: Date.now() });
  if (entCache.size > 5000) entCache.clear();
  return v;
}
/** Messages older than this are hidden for the viewer (null = keep forever). */
function retentionCutoff(e, now = Date.now()) { const d = Number(e.features.historyDays) || 0; return d > 0 ? new Date(now - d * 86400000) : null; }

// ---------------------------------------------------------------- sources
function src(c) {
  if (c.type === 'dm') return { kind: 'dm', table: 'dm_messages', col: 'thread_id', key: c.dm_thread_id, extra: '' };
  if (c.type === 'meeting') return { kind: 'chat', table: 'chat_messages', col: 'meeting_history_id', key: c.meeting_history_id, extra: ' AND group_id IS NULL AND conversation_id IS NULL' };
  if (c.group_id) return { kind: 'chat', table: 'chat_messages', col: 'group_id', key: c.group_id, extra: '' };
  return { kind: 'chat', table: 'chat_messages', col: 'conversation_id', key: c.id, extra: '' };
}
const usesRetention = (c) => c.type === 'dm' || (c.type === 'group' && !c.group_id);
const isStanding = (c) => c.type === 'group' && !c.group_id && !c.org_id;
const isMeetingScoped = (c) => c.type === 'meeting' || !!c.group_id;
function subtype(c) { return c.type === 'group' ? (c.org_id ? 'org' : c.group_id ? 'meeting-group' : 'standing') : null; }

function parseLegacy(body) {
  const s = String(body || ''); const i = s.indexOf('\n__attach__');
  if (i < 0) return { text: s, attachment: null };
  return { text: s.slice(0, i), attachment: json(s.slice(i + 11)) };
}
function slim(a) {
  if (!a || typeof a !== 'object') return null;
  if (a.kind === 'passage') return a;
  if (a.kind === 'board') return { kind: 'board', name: a.name || 'Whiteboard.mwb', mime: 'application/x-mwb', size: Number(a.size) || 0, url: a.url || null, preview: a.preview || null, pages: Number(a.pages) || 1 };
  return { kind: a.kind || 'file', name: a.name || 'file', mime: a.mime || '', size: Number(a.size) || 0, url: a.url || null, dataUrl: a.url ? null : (a.dataUrl || null) };
}
function msgOut(row, c, me = null) {
  let text = row.body || ''; let attachment = null;
  if (c.type === 'dm' && !row.attachments) ({ text, attachment } = parseLegacy(text));
  else attachment = json(row.attachments);
  const deleted = !!row.deleted_at;
  return {
    id: Number(row.id), conversationId: Number(c.id), fromUserId: num(row.sender_user_id), fromName: row.sender_name || ANON,
    text: deleted ? '' : text, attachment: deleted ? null : slim(attachment), kind: row.kind || 'text', payload: deleted ? null : json(row.payload),
    createdAt: row.created_at, editedAt: row.edited_at || null, deleted, mine: me != null && num(row.sender_user_id) === Number(me), meetingCode: row.meeting_code || null,
    replyToId: num(row.reply_to_id) || null,
  };
}
function preview({ text, attachment, kind, payload }) {
  if (kind === 'card' && payload) return ({ meeting: 'Meeting: ', schedule: 'Scheduled: ', venue: 'Venue: ', speaker_invite: 'Speaker invite: ', event_live: 'Live now: ', event: 'Event: ', confirm: '' }[payload.type] || '') + (payload.title || payload.type || '');
  if (text) return String(text).slice(0, 140);
  if (attachment) return attachment.kind === 'voice' ? 'Voice note' : attachment.kind === 'image' ? 'Photo' : attachment.kind === 'passage' ? attachment.reference : attachment.kind === 'board' ? `Whiteboard: ${String(attachment.name || 'board').replace(/\.mwb$/i, '')}` : `File: ${attachment.name || 'file'}`;
  return '';
}

// ---------------------------------------------------------------- conversation rows
const CONV_SELECT = `SELECT c.*, m.role, m.last_read_message_id, m.muted, m.archived, m.pinned, m.cleared_before, m.left_at,
    m.starred, m.follow_up, m.closed, m.snoozed_until, m.labels,
    t.user_a_id, t.user_b_id, mh.code AS mh_code, mh.ended_at AS mh_ended_at, g.meeting_code AS g_code
  FROM conversation_members m JOIN conversations c ON c.id=m.conversation_id
  LEFT JOIN dm_threads t ON t.id=c.dm_thread_id
  LEFT JOIN meeting_history mh ON mh.id=c.meeting_history_id
  LEFT JOIN chat_groups g ON g.id=c.group_id`;
async function convRow(me, id) {
  const c = await one(`${CONV_SELECT} WHERE m.user_id=$1 AND c.id=$2 AND m.left_at IS NULL`, [me, id]);
  if (!c) throw fail(404, 'Conversation not found');
  c.id = Number(c.id);
  return c;
}
const peerOf = (c, me) => (Number(c.user_a_id) === Number(me) ? num(c.user_b_id) : num(c.user_a_id));
function liveRoom(c) {
  if (c.type === 'meeting') {
    const m = c.mh_code ? store.getMeeting(normCode(c.mh_code)) : null;
    return m && Number(m.historyId) === Number(c.meeting_history_id) ? m : null;
  }
  if (c.group_id) {
    const m = c.g_code ? store.getMeeting(normCode(c.g_code)) : null;
    return m && m.chatGroups && m.chatGroups[c.group_id] ? m : null;
  }
  return null;
}
async function memberIds(convId) {
  return (await many('SELECT user_id FROM conversation_members WHERE conversation_id=$1 AND left_at IS NULL', [convId])).map((r) => Number(r.user_id));
}
/** { canSend, readOnly, reason } for me in c. */
async function sendState(c, me, peerUser) {
  if (c.type === 'dm') {
    const peer = peerOf(c, me);
    const u = peerUser !== undefined ? peerUser : (peer ? await one('SELECT id FROM users WHERE id=$1', [peer]) : null);
    if (!u) return { canSend: false, readOnly: true, reason: 'This account was deleted' };
    if (await access.isBlocked(me, peer)) return { canSend: false, readOnly: false, reason: 'You can no longer message this person' };
    return { canSend: true, readOnly: false };
  }
  if (isMeetingScoped(c)) {
    return liveRoom(c) ? { canSend: true, readOnly: false, live: true } : { canSend: false, readOnly: true, reason: 'This meeting has ended. Its chat is kept as history.' };
  }
  return { canSend: true, readOnly: false };
}
async function unreadCount(c, me, cutoff) {
  const s = src(c);
  const floor = Math.max(Number(c.last_read_message_id) || 0, Number(c.cleared_before) || 0);
  const p = [s.key, floor, me]; let extra = s.extra;
  if (cutoff && usesRetention(c)) { p.push(cutoff); extra += ' AND created_at >= $4'; }
  const r = await one(`SELECT COUNT(*) AS n FROM ${s.table} WHERE ${s.col}=$1${extra} AND id > $2 AND deleted_at IS NULL AND (sender_user_id IS NULL OR sender_user_id <> $3)`, p);
  return Number(r && r.n) || 0;
}
async function decorate(rows, me, { unread = true } = {}) {
  if (!rows.length) return [];
  const e = await ent(me); const cutoff = retentionCutoff(e);
  const dmPeers = [...new Set(rows.filter((r) => r.type === 'dm').map((r) => peerOf(r, me)).filter(Boolean))];
  const peers = new Map((dmPeers.length ? await many('SELECT id, username, display_name, avatar_url, email, email_verified_at, verified_active, is_system FROM users WHERE id = ANY($1::int[])', [dmPeers]) : []).map((u) => [Number(u.id), u]));
  const blocked = await access.blockedByMe(me);
  const groupIds = rows.filter((r) => r.type !== 'dm').map((r) => Number(r.id));
  const counts = new Map((groupIds.length ? await many('SELECT conversation_id, COUNT(*) AS n FROM conversation_members WHERE conversation_id = ANY($1::int[]) AND left_at IS NULL GROUP BY conversation_id', [groupIds]) : []).map((r) => [Number(r.conversation_id), Number(r.n)]));
  const out = [];
  for (const c of rows) {
    c.id = Number(c.id);
    const peerId = c.type === 'dm' ? peerOf(c, me) : null;
    if (peerId && blocked.has(peerId)) continue; // blocking hides the thread for the blocker
    const pu = peerId ? peers.get(peerId) || null : null;
    const st = await sendState(c, me, c.type === 'dm' ? pu : undefined);
    const live = !!liveRoom(c);
    out.push({
      id: c.id, type: c.type, subtype: subtype(c),
      title: c.type === 'dm' ? (pu ? pu.display_name || pu.username : ANON) : c.title || 'Group',
      peer: c.type === 'dm' ? (pu ? { id: Number(pu.id), username: pu.username, name: pu.display_name || pu.username, avatarUrl: pu.avatar_url || null, verified: isVerified(pu), system: !!(pu.is_system || pu.isSystem) } : { id: null, name: ANON, deleted: true }) : null,
      avatarUrl: pu ? pu.avatar_url || null : null,
      lastMessageAt: c.last_message_at || c.created_at, lastPreview: c.last_preview || '',
      unread: unread ? await unreadCount(c, me, cutoff) : 0,
      muted: !!c.muted, archived: !!c.archived, pinned: !!c.pinned, role: c.role,
      starred: !!c.starred, followUp: !!c.follow_up, closed: !!c.closed, labels: labelsOf(c.labels),
      snoozedUntil: c.snoozed_until && new Date(c.snoozed_until).getTime() > Date.now() ? new Date(c.snoozed_until).toISOString() : null,
      memberCount: c.type === 'dm' ? 2 : counts.get(c.id) || 0,
      live, meetingCode: c.type === 'meeting' ? c.mh_code : c.group_id ? c.g_code : null,
      canSend: st.canSend, readOnly: st.readOnly, reason: st.reason || null,
      editable: c.type === 'dm' || isStanding(c) || !!c.org_id,
    });
  }
  return out;
}

// ---------------------------------------------------------------- projections (no copies)
const lastSync = new Map();
/** Index meeting chats, in-meeting groups and organisation team groups for this user. Idempotent. */
async function syncProjections(me, { force = false } = {}) {
  const t = lastSync.get(me);
  if (!force && t && Date.now() - t < 15000) return;
  lastSync.set(me, Date.now());
  if (lastSync.size > 10000) lastSync.clear();
  // Public chat of meetings I hosted or attended (signed in). Guests never get inbox threads.
  const meetings = await many(`SELECT mh.id, mh.name, mh.created_at FROM meeting_history mh
    WHERE mh.id IN (SELECT meeting_history_id FROM meeting_participants_log WHERE user_id=$1 UNION SELECT id FROM meeting_history WHERE host_user_id=$1)
      AND EXISTS (SELECT 1 FROM chat_messages cm WHERE cm.meeting_history_id=mh.id AND cm.group_id IS NULL AND cm.conversation_id IS NULL)
    ORDER BY mh.id DESC LIMIT 50`, [me]);
  for (const m of meetings) {
    const last = await one(`SELECT created_at, body, attachments FROM chat_messages WHERE meeting_history_id=$1 AND group_id IS NULL AND conversation_id IS NULL ORDER BY id DESC LIMIT 1`, [m.id]);
    await q(`INSERT INTO conversations (type, meeting_history_id, title, last_message_at, last_preview, created_at) VALUES ('meeting',$1,$2,$3,$4,$5)
      ON CONFLICT (meeting_history_id) DO NOTHING`, [m.id, m.name || 'Meeting', last ? last.created_at : m.created_at, last ? preview({ text: last.body, attachment: json(last.attachments) }) : '', m.created_at]);
    const c = await one('SELECT id FROM conversations WHERE meeting_history_id=$1', [m.id]);
    if (c) await q('INSERT INTO conversation_members (conversation_id, user_id) VALUES ($1,$2) ON CONFLICT (conversation_id, user_id) DO NOTHING', [c.id, me]);
  }
  // In-meeting sub-groups I was a signed-in member of.
  const groups = await many(`SELECT g.id, g.title, g.created_at FROM chat_groups g WHERE g.id IN (SELECT group_id FROM chat_group_members WHERE user_id=$1)
    AND EXISTS (SELECT 1 FROM chat_messages cm WHERE cm.group_id=g.id) ORDER BY g.created_at DESC LIMIT 50`, [me]);
  for (const g of groups) {
    const last = await one('SELECT created_at, body, attachments FROM chat_messages WHERE group_id=$1 ORDER BY id DESC LIMIT 1', [g.id]);
    await q(`INSERT INTO conversations (type, group_id, title, last_message_at, last_preview, created_at) VALUES ('group',$1,$2,$3,$4,$5)
      ON CONFLICT (group_id) DO NOTHING`, [g.id, g.title || 'Group', last ? last.created_at : g.created_at, last ? preview({ text: last.body, attachment: json(last.attachments) }) : '', g.created_at]);
    const c = await one('SELECT id FROM conversations WHERE group_id=$1', [g.id]);
    if (c) await q('INSERT INTO conversation_members (conversation_id, user_id) VALUES ($1,$2) ON CONFLICT (conversation_id, user_id) DO NOTHING', [c.id, me]);
  }
  // Organisation team groups: created automatically, membership follows org membership.
  const orgs = await many('SELECT o.id, o.name, m.role FROM org_members m JOIN organisations o ON o.id=m.org_id WHERE m.user_id=$1', [me]).catch(() => []);
  for (const o of orgs) {
    await q(`INSERT INTO conversations (type, org_id, title, last_message_at) VALUES ('group',$1,$2,NOW()) ON CONFLICT (org_id) DO NOTHING`, [o.id, `${o.name} team`]);
    const c = await one('SELECT id FROM conversations WHERE org_id=$1', [o.id]);
    if (c) await q(`INSERT INTO conversation_members (conversation_id, user_id, role) VALUES ($1,$2,$3)
      ON CONFLICT (conversation_id, user_id) DO UPDATE SET left_at=NULL, role=EXCLUDED.role`, [c.id, me, ['owner', 'admin'].includes(o.role) ? 'admin' : 'member']);
  }
  await q(`UPDATE conversation_members SET left_at=NOW() WHERE user_id=$1 AND left_at IS NULL AND conversation_id IN
    (SELECT id FROM conversations WHERE org_id IS NOT NULL AND org_id NOT IN (SELECT org_id FROM org_members WHERE user_id=$1))`, [me]).catch(() => {});
}

async function listConversations(me, { filter = 'all', archived = false, type = '' } = {}) {
  await syncProjections(me);
  const rows = await many(`${CONV_SELECT} WHERE m.user_id=$1 AND m.left_at IS NULL ORDER BY m.pinned DESC, COALESCE(c.last_message_at, c.created_at) DESC, c.id DESC LIMIT 200`, [me]);
  let list = await decorate(rows, me);
  list = list.filter((c) => (archived ? c.archived : !c.archived));
  // Cooby-style tabs. "all" / "inbox" hide closed chats and chats snoozed until later.
  if (filter === 'all' || filter === 'inbox') list = list.filter((c) => !c.closed && !c.snoozedUntil);
  else if (filter === 'starred') list = list.filter((c) => c.starred);
  else if (filter === 'unread') list = list.filter((c) => c.unread > 0);
  else if (filter === 'followup') list = list.filter((c) => c.followUp);
  else if (filter === 'snoozed') list = list.filter((c) => c.snoozedUntil);
  else if (filter === 'closed') list = list.filter((c) => c.closed);
  else if (filter.startsWith('label:')) { const want = filter.slice(6).toLowerCase(); list = list.filter((c) => c.labels.some((l) => l.name.toLowerCase() === want)); }
  const kind = ['dm', 'groups', 'meetings'].includes(type) ? type : ['dm', 'groups', 'meetings'].includes(filter) ? filter : '';
  if (kind === 'dm') list = list.filter((c) => c.type === 'dm');
  else if (kind === 'groups') list = list.filter((c) => c.type === 'group');
  else if (kind === 'meetings') list = list.filter((c) => c.type === 'meeting' || c.subtype === 'meeting-group');
  return list;
}
async function unreadSummary(me) {
  const rows = await many(`${CONV_SELECT} WHERE m.user_id=$1 AND m.left_at IS NULL`, [me]);
  const list = await decorate(rows, me);
  const byId = {}; let total = 0;
  for (const c of list) { if (c.unread) byId[c.id] = c.unread; if (!c.muted && !c.archived) total += c.unread; }
  return { total, conversations: byId };
}
async function getConversation(me, id) {
  const c = await convRow(me, id);
  const [out] = await decorate([c], me);
  if (!out) throw fail(404, 'Conversation not found');
  if (c.type === 'dm' && out.peer && out.peer.id) {
    const [mine, theirs] = await Promise.all([access.prefs(me), access.prefs(out.peer.id)]);
    out.presence = mine.hidePresence || theirs.hidePresence ? null : { online: socket.isOnline(out.peer.id), lastSeenAt: await socket.lastSeen(out.peer.id) };
    const pr = await one('SELECT last_read_message_id FROM conversation_members WHERE conversation_id=$1 AND user_id=$2', [c.id, out.peer.id]);
    // WhatsApp-style rule: "read" shows only once the other person has replied in this chat at least
    // once. Until then the sender only sees "delivered", so a cold message never leaks read state.
    out.peerReplied = await hasSent(c, out.peer.id);
    out.peerReadId = out.peerReplied && pr ? Number(pr.last_read_message_id) : 0;
  } else if (c.type !== 'dm') {
    out.members = (await many(`SELECT u.id, u.username, u.display_name, u.avatar_url, u.email, u.email_verified_at, u.verified_active, u.is_system, m.role FROM conversation_members m JOIN users u ON u.id=m.user_id
      WHERE m.conversation_id=$1 AND m.left_at IS NULL ORDER BY m.role, m.joined_at LIMIT 200`, [c.id])).map((u) => ({ id: Number(u.id), username: u.username, name: u.display_name || u.username, avatarUrl: u.avatar_url || null, role: u.role, verified: isVerified(u) }));
  }
  out.pins = await require('./power').listPins(c, me).catch(() => []);
  return out;
}
/** Has this user written a real (non-system) message in the conversation? */
async function hasSent(c, userId) {
  if (!userId) return false;
  const s = src(c);
  return !!(await one(`SELECT 1 AS x FROM ${s.table} WHERE ${s.col}=$1${s.extra} AND sender_user_id=$2 AND (kind IS NULL OR kind NOT IN ('system','call')) LIMIT 1`, [s.key, userId]));
}
function labelsOf(v) {
  const a = json(v);
  return Array.isArray(a) ? a.filter((l) => l && l.name).slice(0, 8).map((l) => ({ name: String(l.name).slice(0, 24), color: /^#[0-9a-f]{6}$/i.test(l.color) ? l.color : '#7c5cff' })) : [];
}

// ---------------------------------------------------------------- DMs
async function ensureDmConversation(thread, createdBy = null) {
  await q(`INSERT INTO conversations (type, dm_thread_id, created_by, last_message_at) VALUES ('dm',$1,$2,$3) ON CONFLICT (dm_thread_id) DO NOTHING`,
    [thread.id, createdBy, thread.last_message_at || null]);
  const c = await one('SELECT * FROM conversations WHERE dm_thread_id=$1', [thread.id]);
  for (const uid of [thread.user_a_id, thread.user_b_id]) {
    if (!uid) continue;
    await q(`INSERT INTO conversation_members (conversation_id, user_id) SELECT $1::int, id FROM users WHERE id=$2
      ON CONFLICT (conversation_id, user_id) DO NOTHING`, [c.id, uid]);
  }
  return c;
}
function newChatCap(e) {
  const free = Number(process.env.MESSAGES_NEW_DM_PER_HOUR_FREE) || 5;
  const paid = Number(process.env.MESSAGES_NEW_DM_PER_HOUR_PAID) || 30;
  return e.plan === 'free' && !e.orgPlan ? free : paid;
}
/** Open (or start) a DM with another signed-in user, applying the allow-list. */
async function openDm(user, peerId) {
  peerId = Number(peerId);
  const r = await access.assertCanStartDm(user.id, peerId);
  let thread = r.existing;
  if (!thread) {
    const e = await ent(user.id);
    const since = new Date(Date.now() - 3600000);
    const n = Number((await one("SELECT COUNT(*) AS n FROM conversations WHERE type='dm' AND created_by=$1 AND created_at > $2", [user.id, since])).n) || 0;
    if (n >= newChatCap(e)) throw fail(429, 'You have started a lot of new chats in the last hour. Please try again later.');
    thread = await db.findOrCreateDmThread(user.id, peerId);
  }
  const c = await ensureDmConversation(thread, r.existing ? null : user.id);
  await q('UPDATE conversation_members SET archived=FALSE WHERE conversation_id=$1 AND user_id=$2', [c.id, user.id]);
  return getConversation(user.id, Number(c.id));
}

// ---------------------------------------------------------------- sending
async function insertMessage(c, { senderUserId, senderName, text, attachment = null, kind = 'text', payload = null, meetingCode = null, participantId = null, replyToId = null }) {
  const att = attachment ? JSON.stringify(attachment) : null; const pl = payload ? JSON.stringify(payload) : null;
  let row;
  if (c.type === 'dm') {
    row = await one(`INSERT INTO dm_messages (thread_id, sender_user_id, sender_participant_id, sender_name, body, meeting_code, attachments, kind, payload, reply_to_id)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`, [c.dm_thread_id, senderUserId || null, participantId, senderName || 'User', text || '', meetingCode, att, kind, pl, replyToId || null]);
    await q('UPDATE dm_threads SET last_message_at=NOW() WHERE id=$1', [c.dm_thread_id]);
  } else if (!isMeetingScoped(c)) {
    row = await one(`INSERT INTO chat_messages (conversation_id, sender_id, sender_name, sender_user_id, body, attachments, kind, payload, reply_to_id)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`, [c.id, senderUserId ? `user:${senderUserId}` : null, senderName || 'User', senderUserId || null, text || null, att, kind, pl, replyToId || null]);
  } else throw fail(400, 'Meeting chats are written through the room');
  await q('UPDATE conversations SET last_message_at=NOW(), last_preview=$2 WHERE id=$1', [c.id, preview({ text, attachment, kind, payload })]);
  return row;
}
/** Fan a saved row out to every member's sockets and push it to members who are away. */
async function deliver(c, row, { senderId = null, notify = true } = {}) {
  const message = msgOut(row, c);
  if (message.replyToId) await attachReplies([message], c);
  if (senderId && row.kind !== 'system') await q('UPDATE conversation_members SET closed=FALSE WHERE conversation_id=$1 AND user_id <> $2 AND closed', [c.id, senderId]).catch(() => {});
  const ids = await memberIds(c.id);
  const muted = new Set((await many('SELECT user_id FROM conversation_members WHERE conversation_id=$1 AND muted', [c.id])).map((r) => Number(r.user_id)));
  for (const uid of ids) socket.sendToUser(uid, { type: 'message', conversationId: Number(c.id), message, muted: muted.has(uid) });
  if (!notify || !push.enabled()) return message;
  const title = c.type === 'dm' ? message.fromName : `${message.fromName} · ${c.title || 'Group'}`;
  for (const uid of ids) {
    if (uid === Number(senderId) || muted.has(uid) || socket.hasVisible(uid)) continue;
    push.notify(uid, { kind: 'message', title, body: preview(message) || 'New message', url: `/messages/${c.id}`, tag: `conv-${c.id}` }).catch(() => {});
  }
  return message;
}
function cleanInput(body = {}) {
  const text = String(body.text || '').trim().slice(0, MAX_TEXT);
  const attachment = normalizeAttachment(body.attachment);
  if (!text && !attachment) throw fail(400, 'Type a message or attach something');
  return { text, attachment };
}
async function sendMessage(user, convId, body) {
  if (!rateLimit('msg-send:' + user.id, Number(process.env.MESSAGES_SEND_PER_MIN) || 30)) throw fail(429, 'You are sending messages too quickly');
  const c = await convRow(user.id, convId);
  const st = await sendState(c, user.id);
  if (!st.canSend) throw fail(403, st.reason || 'You can’t send messages here');
  const { text, attachment } = cleanInput(body);
  if (isMeetingScoped(c)) return sendToLiveRoom(user, c, text, attachment);
  const replyToId = await validReply(c, body.replyToId);
  const row = await insertMessage(c, { senderUserId: user.id, senderName: nameOf(user), text, attachment, replyToId });
  const out = await deliver(c, row, { senderId: user.id });
  setImmediate(() => { require('./notify').onUserMessage(user, c, out).catch((e) => console.warn('[notify] reply', e.message)); });
  return { ...out, mine: true };
}
/** A reply target must be a message in the same conversation; anything else is silently dropped. */
async function validReply(c, id) {
  id = Number(id) || 0;
  if (!id) return null;
  const s = src(c);
  const r = await one(`SELECT id FROM ${s.table} WHERE id=$1 AND ${s.col}=$2${s.extra}`, [id, s.key]);
  return r ? id : null;
}
/** Quoted bubble data for replies: { id, fromName, text, kind, attachmentKind, deleted }. */
async function attachReplies(messages, c) {
  const ids = [...new Set(messages.map((m) => m.replyToId).filter(Boolean))];
  if (!ids.length) return;
  const s = src(c);
  const rows = await many(`SELECT * FROM ${s.table} WHERE ${s.col}=$1 AND id = ANY($2::int[])`, [s.key, ids]);
  const by = new Map(rows.map((r) => { const m = msgOut(r, c); return [m.id, { id: m.id, fromName: m.fromName, fromUserId: m.fromUserId, text: m.text.slice(0, 160), attachmentKind: m.attachment ? m.attachment.kind : null, deleted: m.deleted }]; }));
  for (const m of messages) if (m.replyToId) m.replyTo = by.get(m.replyToId) || { id: m.replyToId, missing: true };
}
/** Live meeting chat from /messages: same in-memory history, room broadcast and chat_messages row as the room. */
async function sendToLiveRoom(user, c, text, attachment) {
  const meeting = liveRoom(c);
  if (!meeting) throw fail(403, 'This meeting has ended. Its chat is kept as history.');
  const code = normCode(c.type === 'meeting' ? c.mh_code : c.g_code);
  const name = nameOf(user); const pid = `user:${user.id}`;
  if (c.type === 'meeting') {
    const chatMsg = { type: 'chat', id: Date.now() + '-' + Math.random().toString(36).slice(2, 7), participantId: pid, name, text, mentions: [], attachment, at: Date.now() };
    if (!Array.isArray(meeting.chatHistory)) meeting.chatHistory = [];
    meeting.chatHistory.push(chatMsg);
    store.broadcast(code, chatMsg);
  } else {
    const g = meeting.chatGroups[c.group_id];
    const entry = { id: 'gc_' + Date.now() + '_' + Math.random().toString(36).slice(2, 9), groupId: c.group_id, fromId: pid, fromName: name, fromUserId: user.id, text, attachment, at: Date.now() };
    if (!Array.isArray(g.messages)) g.messages = [];
    g.messages.push(entry);
    for (const mid of g.members || []) store.sendToParticipant(mid, { type: 'group-chat', message: entry });
  }
  const row = await persistRoomChat(meeting, code, { senderId: pid, senderName: name, senderUserId: user.id, text, attachment, groupId: c.group_id || null });
  const out = await onRoomChat(row);
  return { ...(out || msgOut(row, c)), mine: true };
}
/** The one persist path for room chat rows (used by the room plugins and by /messages). */
async function persistRoomChat(meeting, code, { senderId, senderName, senderUserId, text, attachment, groupId = null }) {
  let artifactId = meeting.artifactId || null;
  if (!artifactId && meeting.historyId) {
    try { const art = await db.ensureArtifactForHistory(meeting.historyId, code); if (art) { meeting.artifactId = art.id; artifactId = art.id; } } catch (_) {}
  }
  const att = attachment ? { kind: attachment.kind, name: attachment.name, mime: attachment.mime, size: attachment.size, dataUrl: attachment.dataUrl || null, url: attachment.url || null } : null;
  return db.saveChatMessage({ meetingHistoryId: meeting.historyId || null, artifactId, sessionId: code, senderId, senderName, senderUserId: senderUserId || null, body: text || null, attachments: att, groupId });
}
/** A room chat row was saved: refresh its inbox entry and fan it out to inbox subscribers. */
async function onRoomChat(row) {
  if (!row) return null;
  const c = row.group_id ? await one('SELECT * FROM conversations WHERE group_id=$1', [row.group_id])
    : row.meeting_history_id ? await one('SELECT * FROM conversations WHERE meeting_history_id=$1', [row.meeting_history_id]) : null;
  if (!c) return null;
  c.id = Number(c.id);
  const att = json(row.attachments);
  await q('UPDATE conversations SET last_message_at=NOW(), last_preview=$2 WHERE id=$1', [c.id, preview({ text: row.body, attachment: att })]);
  if (row.sender_user_id) await q('INSERT INTO conversation_members (conversation_id, user_id) SELECT $1::int, id FROM users WHERE id=$2 ON CONFLICT (conversation_id, user_id) DO NOTHING', [c.id, row.sender_user_id]).catch(() => {});
  return deliver(c, row, { senderId: row.sender_user_id, notify: false });
}
/** An in-room private message between two signed-in people: same dm_threads row as the inbox. */
async function saveRoomDm({ fromUserId, toUserId, participantId, senderName, text, attachment, meetingCode }) {
  if (await access.isBlocked(fromUserId, toUserId)) return null;
  const thread = await db.findOrCreateDmThread(fromUserId, toUserId);
  const c = await ensureDmConversation(thread, null);
  const row = await insertMessage({ ...c, id: Number(c.id), type: 'dm', dm_thread_id: thread.id }, { senderUserId: fromUserId, senderName, text, attachment, meetingCode, participantId });
  await deliver({ ...c, id: Number(c.id) }, row, { senderId: fromUserId });
  return row;
}
/** System or card message from a user (calls, meeting cards). */
async function postSystem(c, { senderUserId = null, senderName = '1venue', text = '', kind = 'system', payload = null, notify = false }) {
  const row = await insertMessage(c, { senderUserId, senderName, text, kind, payload });
  return deliver(c, row, { senderId: senderUserId, notify });
}

// ---------------------------------------------------------------- history, read, edit, react
async function listMessages(me, convId, { before = null, limit = 50 } = {}) {
  const c = await convRow(me, convId);
  const e = await ent(me); const cutoff = usesRetention(c) ? retentionCutoff(e) : null;
  const s = src(c);
  const p = [s.key, Number(c.cleared_before) || 0]; let extra = s.extra;
  if (before) { p.push(Number(before)); extra += ` AND id < $${p.length}`; }
  if (cutoff) { p.push(cutoff); extra += ` AND created_at >= $${p.length}`; }
  p.push(Math.min(100, Math.max(1, Number(limit) || 50)));
  const rows = (await many(`SELECT * FROM ${s.table} WHERE ${s.col}=$1${extra} AND id > $2 ORDER BY id DESC LIMIT $${p.length}`, p)).reverse();
  const messages = rows.map((r) => msgOut(r, c, me));
  await attachReactions(messages, s.kind, me);
  await attachReplies(messages, c);
  const hasMore = rows.length === p[p.length - 1];
  // Tell the client about hidden history only when something older really exists.
  const hidden = cutoff && !hasMore ? await one(`SELECT id FROM ${s.table} WHERE ${s.col}=$1${s.extra} AND id > $2 AND created_at < $3 LIMIT 1`, [s.key, Number(c.cleared_before) || 0, cutoff]) : null;
  return { messages, hasMore, hiddenBefore: hidden ? cutoff : null };
}
async function attachReactions(messages, source, me) {
  if (!messages.length) return;
  const rows = await many('SELECT message_id, emoji, user_id FROM message_reactions WHERE message_source=$1 AND message_id = ANY($2::int[]) ORDER BY created_at', [source, messages.map((m) => m.id)]);
  const by = new Map();
  for (const r of rows) {
    const k = Number(r.message_id); if (!by.has(k)) by.set(k, new Map());
    const m = by.get(k); const x = m.get(r.emoji) || { emoji: r.emoji, count: 0, mine: false };
    x.count++; if (Number(r.user_id) === Number(me)) x.mine = true; m.set(r.emoji, x);
  }
  for (const msg of messages) msg.reactions = [...(by.get(msg.id) || new Map()).values()];
}
async function maxId(c) {
  const s = src(c);
  const r = await one(`SELECT MAX(id) AS m FROM ${s.table} WHERE ${s.col}=$1${s.extra}`, [s.key]);
  return Number(r && r.m) || 0;
}
async function markRead(me, convId, messageId) {
  const c = await convRow(me, convId);
  const top = await maxId(c);
  const target = messageId ? Math.min(Number(messageId) || 0, top) : top;
  const r = await q('UPDATE conversation_members SET last_read_message_id=$3, last_read_at=NOW() WHERE conversation_id=$1 AND user_id=$2 AND last_read_message_id < $3', [c.id, me, target]);
  if (r.rowCount) {
    // Others only learn I read their messages once I have replied in this chat (see getConversation).
    const replied = await hasSent(c, me);
    for (const uid of await memberIds(c.id)) {
      if (uid === Number(me)) socket.sendToUser(uid, { type: 'unread' });
      else if (replied) socket.sendToUser(uid, { type: 'read', conversationId: c.id, userId: Number(me), messageId: target });
    }
  }
  return { ok: true, lastReadId: target };
}
async function ownMessage(c, me, mid) {
  if (isMeetingScoped(c)) throw fail(403, 'Meeting chat can’t be edited or deleted here');
  const s = src(c);
  const row = await one(`SELECT * FROM ${s.table} WHERE id=$1 AND ${s.col}=$2`, [mid, s.key]);
  if (!row || row.deleted_at) throw fail(404, 'Message not found');
  if (num(row.sender_user_id) !== Number(me) || (row.kind && row.kind !== 'text')) throw fail(403, 'You can only change your own messages');
  return { row, s };
}
async function editMessage(me, convId, mid, body = {}) {
  const c = await convRow(me, convId);
  const { row, s } = await ownMessage(c, me, mid);
  if (Date.now() - new Date(row.created_at).getTime() > EDIT_WINDOW_MS) throw fail(403, 'Messages can be edited for 15 minutes');
  const text = String(body.text || '').trim().slice(0, MAX_TEXT);
  if (!text) throw fail(400, 'Type the new message');
  let newBody = text;
  if (c.type === 'dm' && !row.attachments) { const i = String(row.body || '').indexOf('\n__attach__'); if (i >= 0) newBody = text + String(row.body).slice(i); }
  const upd = await one(`UPDATE ${s.table} SET body=$2, edited_at=NOW() WHERE id=$1 RETURNING *`, [row.id, newBody]);
  const message = msgOut(upd, c);
  for (const uid of await memberIds(c.id)) socket.sendToUser(uid, { type: 'message-edited', conversationId: c.id, message });
  return { ...message, mine: true };
}
async function deleteMessage(me, convId, mid) {
  const c = await convRow(me, convId);
  const { row, s } = await ownMessage(c, me, mid);
  await q(`UPDATE ${s.table} SET body='', attachments=NULL, deleted_at=NOW() WHERE id=$1`, [row.id]);
  for (const uid of await memberIds(c.id)) socket.sendToUser(uid, { type: 'message-deleted', conversationId: c.id, messageId: Number(row.id) });
  return { ok: true };
}
async function toggleReaction(me, convId, mid, emoji) {
  const c = await convRow(me, convId);
  const st = await sendState(c, me);
  if (st.readOnly || !st.canSend) throw fail(403, st.reason || 'You can’t react here');
  const e = String(emoji || '').trim();
  if (!e || [...e].length > 8 || /[A-Za-z<>]/.test(e)) throw fail(400, 'Pick an emoji');
  const s = src(c);
  if (!(await one(`SELECT id FROM ${s.table} WHERE id=$1 AND ${s.col}=$2${s.extra} AND deleted_at IS NULL`, [mid, s.key]))) throw fail(404, 'Message not found');
  const del = await q('DELETE FROM message_reactions WHERE message_source=$1 AND message_id=$2 AND user_id=$3 AND emoji=$4', [s.kind, mid, me, e]);
  if (!del.rowCount) await q('INSERT INTO message_reactions (message_source, message_id, user_id, emoji) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING', [s.kind, mid, me, e]);
  const msg = [{ id: Number(mid) }];
  for (const uid of await memberIds(c.id)) {
    await attachReactions(msg, s.kind, uid);
    socket.sendToUser(uid, { type: 'reaction', conversationId: c.id, messageId: Number(mid), reactions: msg[0].reactions });
  }
  await attachReactions(msg, s.kind, me);
  return { reactions: msg[0].reactions };
}
async function updateMember(me, convId, b = {}) {
  const c = await convRow(me, convId);
  const sets = []; const p = [c.id, me];
  for (const k of ['muted', 'archived', 'pinned', 'starred', 'closed']) if (b[k] !== undefined) { p.push(!!b[k]); sets.push(`${k}=$${p.length}`); }
  if (b.followUp !== undefined) { p.push(!!b.followUp); sets.push(`follow_up=$${p.length}`); }
  if (b.snoozedUntil !== undefined) {
    const t = b.snoozedUntil ? new Date(b.snoozedUntil) : null;
    if (t && (Number.isNaN(t.getTime()) || t.getTime() < Date.now() - 60000)) throw fail(400, 'Pick a time in the future');
    if (t && t.getTime() > Date.now() + 366 * 86400000) throw fail(400, 'Snooze for up to a year');
    p.push(t); sets.push(`snoozed_until=$${p.length}`);
  }
  if (b.labels !== undefined) {
    const list = labelsOf(Array.isArray(b.labels) ? b.labels : []);
    p.push(list.length ? JSON.stringify(list) : null); sets.push(`labels=$${p.length}`);
  }
  if (sets.length) await q(`UPDATE conversation_members SET ${sets.join(', ')} WHERE conversation_id=$1 AND user_id=$2`, p);
  socket.sendToUser(me, { type: 'conversation-updated', conversationId: c.id });
  return getConversation(me, c.id);
}
async function clearHistory(me, convId) {
  const c = await convRow(me, convId);
  const top = await maxId(c);
  await q('UPDATE conversation_members SET cleared_before=$3, last_read_message_id=GREATEST(last_read_message_id, $3) WHERE conversation_id=$1 AND user_id=$2', [c.id, me, top]);
  return { ok: true };
}
async function relayTyping(me, convId) {
  const c = await convRow(me, convId).catch(() => null);
  if (!c) return;
  const u = await one('SELECT username, display_name FROM users WHERE id=$1', [me]);
  for (const uid of await memberIds(c.id)) if (uid !== Number(me)) socket.sendToUser(uid, { type: 'typing', conversationId: c.id, userId: Number(me), name: nameOf(u) });
}

// ---------------------------------------------------------------- groups
async function groupCap(userId) { return Math.max(2, Number((await ent(userId)).features.groupMembers) || 2); }
async function createGroup(user, b = {}) {
  const title = String(b.title || '').trim().slice(0, 80);
  if (title.length < 1) throw fail(400, 'Give the group a name');
  const ids = [...new Set((Array.isArray(b.memberIds) ? b.memberIds : []).map(Number).filter((x) => x && x !== Number(user.id)))];
  if (!ids.length) throw fail(400, 'Add at least one person');
  const cap = await groupCap(user.id);
  if (ids.length + 1 > cap) throw fail(403, `Groups on your plan can have up to ${cap} members. Upgrade for bigger groups.`, { upgrade: true });
  for (const id of ids) if (!(await access.canAddToGroup(user.id, id))) {
    const u = await one('SELECT username, display_name FROM users WHERE id=$1', [id]);
    throw fail(403, `You can’t add ${u ? nameOf(u) : 'that person'} to a group`);
  }
  const c = await one("INSERT INTO conversations (type, title, created_by, last_message_at) VALUES ('group',$1,$2,NOW()) RETURNING *", [title, user.id]);
  c.id = Number(c.id);
  await q("INSERT INTO conversation_members (conversation_id, user_id, role) VALUES ($1,$2,'admin')", [c.id, user.id]);
  for (const id of ids) await q("INSERT INTO conversation_members (conversation_id, user_id, role) VALUES ($1,$2,'member') ON CONFLICT DO NOTHING", [c.id, id]);
  await postSystem(c, { senderUserId: user.id, senderName: nameOf(user), text: `${nameOf(user)} created the group “${title}”` });
  return getConversation(user.id, c.id);
}
async function adminConv(me, convId) {
  const c = await convRow(me, convId);
  if (c.org_id) throw fail(400, 'Organisation team groups follow the organisation’s members');
  if (!isStanding(c)) throw fail(400, 'Only group chats can be changed');
  return c;
}
async function addMember(user, convId, userId) {
  const c = await adminConv(user.id, convId);
  if (c.role !== 'admin') throw fail(403, 'Only group admins can add people');
  const cap = await groupCap(c.created_by || user.id);
  const count = (await memberIds(c.id)).length;
  if (count + 1 > cap) throw fail(403, `This group is full (${cap} members on the creator’s plan)`, { upgrade: true });
  if (!(await access.canAddToGroup(user.id, userId))) throw fail(403, 'You can’t add that person');
  const u = await one('SELECT id, username, display_name FROM users WHERE id=$1', [userId]);
  await q(`INSERT INTO conversation_members (conversation_id, user_id) VALUES ($1,$2)
    ON CONFLICT (conversation_id, user_id) DO UPDATE SET left_at=NULL, joined_at=NOW()`, [c.id, userId]);
  await postSystem(c, { senderUserId: user.id, senderName: nameOf(user), text: `${nameOf(user)} added ${nameOf(u)}` });
  return getConversation(user.id, c.id);
}
async function removeMember(user, convId, userId) {
  const c = await convRow(user.id, convId);
  userId = Number(userId);
  const self = userId === Number(user.id);
  if (c.type === 'meeting' || c.group_id) {
    if (!self) throw fail(403, 'You can only remove yourself');
    await q('UPDATE conversation_members SET left_at=NOW() WHERE conversation_id=$1 AND user_id=$2', [c.id, userId]);
    return { ok: true };
  }
  if (c.type === 'dm') throw fail(400, 'Archive or clear a chat instead');
  if (c.org_id) throw fail(400, 'Leave the organisation to leave its team group');
  if (!self && c.role !== 'admin') throw fail(403, 'Only group admins can remove people');
  const u = await one('SELECT id, username, display_name FROM users WHERE id=$1', [userId]);
  const r = await q('UPDATE conversation_members SET left_at=NOW() WHERE conversation_id=$1 AND user_id=$2 AND left_at IS NULL', [c.id, userId]);
  if (!r.rowCount) throw fail(404, 'Not a member');
  if (!(await one("SELECT 1 AS x FROM conversation_members WHERE conversation_id=$1 AND left_at IS NULL AND role='admin'", [c.id]))) {
    await q(`UPDATE conversation_members SET role='admin' WHERE conversation_id=$1 AND user_id=(SELECT user_id FROM conversation_members WHERE conversation_id=$1 AND left_at IS NULL ORDER BY joined_at LIMIT 1)`, [c.id]);
  }
  await postSystem(c, { senderUserId: user.id, senderName: nameOf(user), text: self ? `${nameOf(user)} left` : `${nameOf(user)} removed ${nameOf(u)}` });
  return { ok: true };
}
async function renameGroup(user, convId, title) {
  const c = await adminConv(user.id, convId);
  if (c.role !== 'admin') throw fail(403, 'Only group admins can rename the group');
  const t = String(title || '').trim().slice(0, 80);
  if (!t) throw fail(400, 'Give the group a name');
  await q('UPDATE conversations SET title=$2 WHERE id=$1', [c.id, t]);
  await postSystem({ ...c, title: t }, { senderUserId: user.id, senderName: nameOf(user), text: `${nameOf(user)} renamed the group to “${t}”` });
  return getConversation(user.id, c.id);
}

// ---------------------------------------------------------------- reports
async function report(user, b = {}) {
  if (!rateLimit('msg-report:' + user.id, 10)) throw fail(429, 'Please wait a moment');
  const c = await convRow(user.id, Number(b.conversationId));
  const s = src(c);
  const row = await one(`SELECT * FROM ${s.table} WHERE id=$1 AND ${s.col}=$2${s.extra}`, [Number(b.messageId), s.key]);
  if (!row) throw fail(404, 'Message not found');
  const m = msgOut(row, c);
  const reason = String(b.reason || '').trim().slice(0, 500) || 'No reason given';
  const r = await one(`INSERT INTO message_reports (reporter_id, reported_user_id, conversation_id, message_source, message_id, reason, snapshot_text, snapshot_attachment)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`, [user.id, m.fromUserId, c.id, s.kind, m.id, reason, m.text.slice(0, 2000), m.attachment && m.attachment.url ? m.attachment.url : null]);
  return { ok: true, id: Number(r.id) };
}
async function listReports(status = 'open') {
  const rows = await many(`SELECT r.*, ru.username AS reporter, tu.username AS reported, tu.display_name AS reported_name FROM message_reports r
    LEFT JOIN users ru ON ru.id=r.reporter_id LEFT JOIN users tu ON tu.id=r.reported_user_id
    WHERE ($1::text = 'all' OR r.status = $1::text) ORDER BY r.id DESC LIMIT 100`, [status]);
  return rows.map((r) => ({ id: Number(r.id), status: r.status, reason: r.reason, text: r.snapshot_text, attachmentUrl: r.snapshot_attachment, reporter: r.reporter, reportedUserId: num(r.reported_user_id), reported: r.reported, reportedName: r.reported_name, createdAt: r.created_at, note: r.admin_note, reviewedAt: r.reviewed_at }));
}
async function reviewReport(adminId, id, b = {}) {
  const status = ['dismissed', 'actioned', 'open'].includes(b.status) ? b.status : null;
  if (!status) throw fail(400, 'Choose dismissed, actioned or open');
  const r = await q('UPDATE message_reports SET status=$2, admin_note=$3, reviewed_by=$4, reviewed_at=NOW() WHERE id=$1', [id, status, String(b.note || '').slice(0, 500) || null, adminId]);
  if (!r.rowCount) throw fail(404, 'Report not found');
  return { ok: true };
}

module.exports = {
  ANON, src, msgOut, hasSent, attachReplies, validReply, labelsOf, cleanInput, nameOf, preview, retentionCutoff, ent, convRow, sendState, memberIds,
  syncProjections, listConversations, unreadSummary, getConversation, openDm, ensureDmConversation,
  insertMessage, deliver, sendMessage, persistRoomChat, onRoomChat, saveRoomDm, postSystem,
  listMessages, markRead, editMessage, deleteMessage, toggleReaction, updateMember, clearHistory, relayTyping,
  createGroup, addMember, removeMember, renameGroup, report, listReports, reviewReport, isMeetingScoped,
};
