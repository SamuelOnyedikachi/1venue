/**
 * Calls (plan section 5): an ephemeral LiveKit room ("call-<uuid>"), never a 1venue meeting.
 * No wallet credits. Ringing goes over the user socket (and Web Push when configured); an
 * unanswered call ends as "Missed" after CALL_RING_TIMEOUT_MS and no LiveKit room is left running.
 *
 * Plan gating (editable in /admin): callParticipants (2 = 1:1 only) and callVideo (1:1 video).
 * Group video is offered as "Open as meeting" instead.
 */
const crypto = require('crypto');
const { q, one, many } = require('../../core/db');
const config = require('../../config');
const { createLiveKitToken, isLiveKitConfigured } = require('../../livekit/tokens');
const service = require('./service');
const access = require('./access');
const socket = require('./socket');
const push = require('./push');

const { fail } = access;
let TrackSource = null;
try { TrackSource = require('livekit-server-sdk').TrackSource; } catch (_) {}
const ringMs = () => Math.max(5000, Number(process.env.CALL_RING_TIMEOUT_MS) || 40000);
const maxMinutes = () => Math.max(5, Number(process.env.CALL_MAX_MINUTES) || 240);
const timers = new Map();
const nameOf = (u) => (u && (u.displayName || u.display_name || u.username)) || 'Someone';

async function token(user, call) {
  const sources = TrackSource ? [TrackSource.MICROPHONE, ...(call.kind === 'video' ? [TrackSource.CAMERA] : [])] : undefined;
  return createLiveKitToken(`u:${user.id}`, nameOf(user), call.livekit_room, { ttl: '2h', canPublishData: false, canPublishSources: sources });
}
function callOut(c, extra = {}) {
  return { id: c.id, conversationId: Number(c.conversation_id), kind: c.kind, state: c.state, startedBy: c.started_by == null ? null : Number(c.started_by), startedAt: c.started_at, answeredAt: c.answered_at || null, ...extra };
}
async function getCall(id) { return one('SELECT * FROM calls WHERE id=$1', [String(id || '')]); }
async function participant(callId, userId) { return one('SELECT * FROM call_participants WHERE call_id=$1 AND user_id=$2', [callId, userId]); }
async function notifyMembers(convId, payload, exceptId = null) {
  for (const uid of await service.memberIds(convId)) if (uid !== Number(exceptId)) socket.sendToUser(uid, payload);
}
async function busy(userId, exceptCallId = '') {
  return !!(await one(`SELECT 1 AS x FROM call_participants p JOIN calls c ON c.id=p.call_id
    WHERE p.user_id=$1 AND c.state <> 'ended' AND p.state = 'joined' AND c.id <> $2 LIMIT 1`, [userId, exceptCallId]));
}
/** Concurrent participant cap for a call in conversation c, from the caller's plan. */
async function capFor(c, starterId) {
  if (c.type === 'dm') return 2;
  return Math.max(2, Number((await service.ent(starterId)).features.callParticipants) || 2);
}

async function start(user, convId, kind = 'audio') {
  kind = kind === 'video' ? 'video' : 'audio';
  const c = await service.convRow(user.id, convId);
  if (c.type === 'meeting' || c.group_id) throw fail(400, 'This chat belongs to a meeting. Join the meeting instead.');
  const st = await service.sendState(c, user.id);
  if (!st.canSend) throw fail(403, st.reason || 'You can’t call here');
  const e = await service.ent(user.id);
  if (c.type !== 'dm') {
    if ((Number(e.features.callParticipants) || 2) <= 2) throw fail(403, 'Group calls are included in Premium and Organisation. Upgrade to call a group.', { upgrade: true });
    if (kind === 'video') throw fail(403, 'For group video, open the chat as a meeting.');
  } else if (kind === 'video' && !e.features.callVideo) throw fail(403, 'Video calls are included in Premium and Organisation. Upgrade, or open the chat as a meeting.', { upgrade: true });
  if (!isLiveKitConfigured()) throw fail(503, 'Calls need LiveKit to be configured on the server');
  if (await busy(user.id)) throw fail(409, 'You are already in a call');
  const open = await one("SELECT * FROM calls WHERE conversation_id=$1 AND state <> 'ended' ORDER BY started_at DESC LIMIT 1", [c.id]);
  if (open) throw fail(409, 'There is already a call in this chat', { callId: open.id });
  const members = (await service.memberIds(c.id)).filter((x) => x !== Number(user.id));
  if (c.type === 'dm' && members[0] && await busy(members[0])) throw fail(409, 'They are on another call. Try again later.');
  const id = crypto.randomUUID();
  const call = await one(`INSERT INTO calls (id, conversation_id, kind, livekit_room, started_by, state) VALUES ($1,$2,$3,$4,$5,'ringing') RETURNING *`, [id, c.id, kind, `call-${id}`, user.id]);
  await q("INSERT INTO call_participants (call_id, user_id, state, joined_at) VALUES ($1,$2,'joined',NOW())", [id, user.id]);
  for (const uid of members) await q("INSERT INTO call_participants (call_id, user_id, state) VALUES ($1,$2,'invited') ON CONFLICT DO NOTHING", [id, uid]);
  const from = { id: Number(user.id), name: nameOf(user), avatarUrl: user.avatarUrl || user.avatar_url || null };
  const title = c.type === 'dm' ? from.name : `${from.name} · ${c.title || 'Group'}`;
  for (const uid of members) {
    socket.sendToUser(uid, { type: 'call-ring', call: callOut(call, { from, title: c.type === 'dm' ? from.name : c.title || 'Group call', group: c.type !== 'dm' }) });
    // Always (not only when offline): a background tab can't show anything itself, and the service worker
    // skips it when a 1venue tab is in view. Same tag as the in-page notification, so never two.
    push.notify(uid, { kind: 'call', title: `Incoming ${kind} call`, body: `${title} is calling you on 1venue`, url: `/messages/${c.id}?call=${id}`, tag: `call-${id}`, callId: id, conversationId: c.id, icon: from.avatarUrl || undefined }).catch(() => {});
  }
  socket.sendToUser(user.id, { type: 'call-started', call: callOut(call) });
  timers.set(id, setTimeout(() => { ringTimeout(id).catch((err) => console.warn('[calls] ring timeout', err.message)); }, ringMs()).unref());
  return { call: callOut(call), token: await token(user, call), url: config.LIVEKIT_URL };
}
async function ringTimeout(id) {
  const call = await getCall(id);
  if (!call || call.state === 'ended') return;
  const joined = Number((await one("SELECT COUNT(*) AS n FROM call_participants WHERE call_id=$1 AND state='joined'", [id])).n);
  if (call.state === 'ringing' || joined < 2) await end(call, 'missed');
}
async function accept(user, callId) {
  const call = await getCall(callId);
  if (!call || call.state === 'ended') throw fail(404, 'This call has ended');
  await service.convRow(user.id, call.conversation_id); // still a member
  const p = await participant(call.id, user.id);
  if (!p) throw fail(403, 'You were not invited to this call');
  if (await busy(user.id, call.id)) throw fail(409, 'You are already in another call');
  if (p.state !== 'joined') {
    const c = await one('SELECT * FROM conversations WHERE id=$1', [call.conversation_id]);
    const cap = await capFor(c, call.started_by || user.id);
    const joined = Number((await one("SELECT COUNT(*) AS n FROM call_participants WHERE call_id=$1 AND state='joined'", [call.id])).n);
    if (joined >= cap) throw fail(403, `This call is full (${cap} people). Open it as a meeting for more.`);
  }
  await q("UPDATE call_participants SET state='joined', joined_at=COALESCE(joined_at, NOW()), left_at=NULL WHERE call_id=$1 AND user_id=$2", [call.id, user.id]);
  if (call.state === 'ringing') await q("UPDATE calls SET state='active', answered_at=NOW() WHERE id=$1", [call.id]);
  const fresh = await getCall(call.id);
  await notifyMembers(fresh.conversation_id, { type: 'call-accepted', call: callOut(fresh), userId: Number(user.id), name: nameOf(user) });
  return { call: callOut(fresh), token: await token(user, fresh), url: config.LIVEKIT_URL };
}
async function decline(user, callId) {
  const call = await getCall(callId);
  if (!call || call.state === 'ended') return { ok: true };
  const p = await participant(call.id, user.id);
  if (!p) throw fail(403, 'You were not invited to this call');
  await q("UPDATE call_participants SET state='declined', left_at=NOW() WHERE call_id=$1 AND user_id=$2 AND state='invited'", [call.id, user.id]);
  const c = await one('SELECT type FROM conversations WHERE id=$1', [call.conversation_id]);
  if (c && c.type === 'dm' && call.state === 'ringing') await end(call, 'declined');
  else socket.sendToUser(user.id, { type: 'call-declined', callId: call.id });
  return { ok: true };
}
async function leave(user, callId) {
  const call = await getCall(callId);
  if (!call || call.state === 'ended') return { ok: true };
  await q("UPDATE call_participants SET state='left', left_at=NOW() WHERE call_id=$1 AND user_id=$2 AND state='joined'", [call.id, user.id]);
  const c = await one('SELECT type FROM conversations WHERE id=$1', [call.conversation_id]);
  const joined = Number((await one("SELECT COUNT(*) AS n FROM call_participants WHERE call_id=$1 AND state='joined'", [call.id])).n);
  if (call.state === 'ringing' && Number(call.started_by) === Number(user.id)) await end(call, 'cancelled');
  else if ((c && c.type === 'dm') || joined === 0) await end(call, call.state === 'ringing' ? 'missed' : 'completed');
  else await notifyMembers(call.conversation_id, { type: 'call-left', callId: call.id, userId: Number(user.id) });
  return { ok: true };
}
async function joinedOrThrow(user, call) {
  if (!call || call.state === 'ended') throw fail(404, 'This call has ended');
  const p = await participant(call.id, user.id);
  if (!p || p.state !== 'joined') throw fail(403, 'Join the call first');
}
/** Escalate a 1:1 call to video (same room, new grants). Group video goes to a meeting. */
async function upgradeVideo(user, callId) {
  const call = await getCall(callId);
  await joinedOrThrow(user, call);
  const c = await one('SELECT type FROM conversations WHERE id=$1', [call.conversation_id]);
  if (!c || c.type !== 'dm') throw fail(403, 'For group video, open the chat as a meeting.');
  const e = await service.ent(user.id);
  if (!e.features.callVideo) throw fail(403, 'Video calls are included in Premium and Organisation. Upgrade, or open the chat as a meeting.', { upgrade: true });
  await q("UPDATE calls SET kind='video' WHERE id=$1", [call.id]);
  const fresh = await getCall(call.id);
  await notifyMembers(fresh.conversation_id, { type: 'call-upgraded', call: callOut(fresh) }, user.id);
  return { call: callOut(fresh), token: await token(user, fresh), url: config.LIVEKIT_URL };
}
async function refreshToken(user, callId) {
  const call = await getCall(callId);
  await joinedOrThrow(user, call);
  return { call: callOut(call), token: await token(user, call), url: config.LIVEKIT_URL };
}
async function current(user) {
  const rows = await many(`SELECT c.*, p.state AS my_state FROM call_participants p JOIN calls c ON c.id=p.call_id
    WHERE p.user_id=$1 AND c.state <> 'ended' AND p.state IN ('invited','joined') ORDER BY c.started_at DESC LIMIT 5`, [user.id]);
  return { calls: rows.map((r) => callOut(r, { myState: r.my_state })) };
}

const fmtDur = (s) => (s >= 3600 ? `${Math.floor(s / 3600)} h ${Math.round((s % 3600) / 60)} min` : s >= 60 ? `${Math.round(s / 60)} min` : `${s} s`);
/** End a call once: mark it, tear down the LiveKit room, post "Audio call, 4 min" / "Missed call". */
async function end(call, reason = 'completed') {
  const r = await q("UPDATE calls SET state='ended', end_reason=$2, ended_at=NOW() WHERE id=$1 AND state <> 'ended'", [call.id, reason]);
  clearTimeout(timers.get(call.id)); timers.delete(call.id);
  if (!r.rowCount) return false; // someone else ended it
  const unanswered = await many("SELECT user_id FROM call_participants WHERE call_id=$1 AND state='invited'", [call.id]).then((x) => x.map((y) => Number(y.user_id))).catch(() => []);
  await q("UPDATE call_participants SET state=CASE WHEN state='joined' THEN 'left' ELSE state END, left_at=COALESCE(left_at, NOW()) WHERE call_id=$1", [call.id]);
  try {
    const client = require('../../livekit/cleanup').roomClient();
    if (client) await client.deleteRoom(call.livekit_room).catch(() => {});
  } catch (_) {}
  const fresh = await getCall(call.id);
  const answered = !!fresh.answered_at && reason !== 'missed';
  const secs = answered ? Math.max(1, Math.round((new Date(fresh.ended_at) - new Date(fresh.answered_at)) / 1000)) : 0;
  const label = fresh.kind === 'video' ? 'Video call' : 'Audio call';
  const text = answered ? `${label}, ${fmtDur(secs)}` : reason === 'declined' ? `${label} declined` : reason === 'cancelled' ? `${label} cancelled` : `Missed ${label.toLowerCase()}`;
  const c = await one('SELECT * FROM conversations WHERE id=$1', [fresh.conversation_id]);
  if (c) {
    c.id = Number(c.id);
    const starter = fresh.started_by ? await one('SELECT id, username, display_name FROM users WHERE id=$1', [fresh.started_by]) : null;
    await service.postSystem(c, { senderUserId: starter ? Number(starter.id) : null, senderName: starter ? nameOf(starter) : '1venue', text, kind: 'call', payload: { callId: fresh.id, kind: fresh.kind, durationSec: secs, missed: !answered, reason }, notify: !answered && reason === 'missed' }).catch((e) => console.warn('[calls] log', e.message));
    await notifyMembers(c.id, { type: 'call-ended', callId: fresh.id, reason, conversationId: c.id });
    // Take the "Incoming call" notification down on phones / closed tabs (it is requireInteraction).
    if (!answered && push.enabled()) {
      const who = starter ? nameOf(starter) : 'Someone';
      for (const uid of unanswered) push.notify(uid, { kind: 'call-end', title: reason === 'declined' ? 'Call declined' : `Missed ${label.toLowerCase()}`, body: `From ${who}`, url: `/messages/${c.id}`, tag: `call-${fresh.id}`, replaceTag: `conv-${c.id}`, callId: fresh.id }).catch(() => {});
    }
  }
  return true;
}

/** Idle sweep: stale ringing calls, active rooms nobody is in, and calls past the hard cap. */
async function sweep(now = Date.now()) {
  const stale = new Date(now - ringMs() * 2);
  for (const c of await many("SELECT * FROM calls WHERE state='ringing' AND started_at < $1", [stale])) await end(c, 'missed');
  const cap = new Date(now - maxMinutes() * 60000);
  for (const c of await many("SELECT * FROM calls WHERE state='active' AND started_at < $1", [cap])) await end(c, 'completed');
  let client = null;
  try { client = require('../../livekit/cleanup').roomClient(); } catch (_) {}
  if (!client) return;
  const idle = new Date(now - 90000);
  for (const c of await many("SELECT * FROM calls WHERE state='active' AND answered_at < $1", [idle])) {
    try { const ps = await client.listParticipants(c.livekit_room); if (!ps || !ps.length) await end(c, 'completed'); } catch (e) { if (e && (e.status === 404 || e.code === 'not_found')) await end(c, 'completed'); }
  }
}
let timer = null;
function startWorker() {
  if (timer || process.env.CALL_SWEEP === 'false') return null;
  timer = setInterval(() => { sweep().catch((e) => console.warn('[calls] sweep', e.message)); }, 60000);
  timer.unref();
  return timer;
}

module.exports = { start, accept, decline, leave, upgradeVideo, refreshToken, current, end, sweep, startWorker, ringTimeout };
