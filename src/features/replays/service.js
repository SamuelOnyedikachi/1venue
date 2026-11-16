/**
 * Cloud replays.
 *
 * Primary path: self-hosted LiveKit Egress records the room as one composite MP4 and uploads it
 * straight to the S3-compatible bucket (Cloudflare R2) that 1venue already uses for files. The
 * app never touches the video bytes. Turned on by env:
 *   LIVEKIT_EGRESS_ENABLED=true, LIVEKIT_URL/API_KEY/API_SECRET (LIVEKIT_API_URL for an internal URL),
 *   STORAGE_DRIVER=s3 + S3_* (bucket, endpoint, keys); optional EGRESS_S3_ACCESS_KEY_ID /
 *   EGRESS_S3_SECRET_ACCESS_KEY / EGRESS_S3_ENDPOINT / EGRESS_S3_REGION for separate egress credentials
 *   (same bucket), EGRESS_LAYOUT (default "speaker"), EGRESS_FILE_PREFIX (default "replays").
 * A worker polls egress status every REPLAY_POLL_MS (60 s) and marks replays ready or failed.
 *
 * Fallback: hosts upload a recording (streamed to storage, capped by platform.replayUploadMB) or
 * paste an https link. Plan gate: features.replays; storage cap: features.replayMB per owner.
 */
const { q, one, many } = require('../../core/db');
const plans = require('../../lib/plans');
const config = require('../../config');
const fail = (status, message, extra) => Object.assign(new Error(message), { status, expose: true }, extra || {});

function egressConfig() {
  const S = config.STORAGE;
  const s3 = S.s3 || {};
  if (process.env.LIVEKIT_EGRESS_ENABLED !== 'true') return null;
  if (!config.LIVEKIT_URL || !config.LIVEKIT_API_KEY || !config.LIVEKIT_API_SECRET) return null;
  if (S.driver !== 's3' || !s3.bucket) return null;
  const accessKey = process.env.EGRESS_S3_ACCESS_KEY_ID || s3.accessKeyId;
  const secret = process.env.EGRESS_S3_SECRET_ACCESS_KEY || s3.secretAccessKey;
  if (!accessKey || !secret) return null;
  const apiUrl = (process.env.LIVEKIT_API_URL || config.LIVEKIT_URL).replace(/^ws(s?):\/\//, 'http$1://');
  return { apiUrl, bucket: s3.bucket, accessKey, secret, endpoint: process.env.EGRESS_S3_ENDPOINT || s3.endpoint || '', region: process.env.EGRESS_S3_REGION || s3.region || 'auto',
    forcePathStyle: s3.forcePathStyle !== false, layout: process.env.EGRESS_LAYOUT || 'speaker', prefix: (process.env.EGRESS_FILE_PREFIX || 'replays').replace(/^\/+|\/+$/g, '') };
}
let clientOverride = null;
function egressClient(cfg) {
  if (clientOverride) return clientOverride;
  const { EgressClient } = require('livekit-server-sdk');
  return new EgressClient(cfg.apiUrl, config.LIVEKIT_API_KEY, config.LIVEKIT_API_SECRET);
}

const replayOut = (r, { owner = false } = {}) => r && ({ id: Number(r.id), title: r.title, source: r.source, status: r.status, visibility: r.visibility, eventId: r.event_id ? Number(r.event_id) : null,
  historyId: r.meeting_history_id || null, durationSec: r.duration_sec || null, sizeBytes: r.size_bytes ? Number(r.size_bytes) : null, createdAt: r.created_at, endedAt: r.ended_at,
  mediaUrl: r.status === 'ready' ? (r.source === 'url' ? r.url : `/replays/${r.id}/media`) : null, external: r.source === 'url', error: owner ? r.error || null : undefined, roomCode: owner ? r.room_code : undefined });

async function usedBytes(ownerId) { return Number((await one("SELECT COALESCE(SUM(size_bytes),0) AS n FROM replays WHERE owner_user_id=$1 AND status<>'failed'", [ownerId])).n); }
async function assertQuota(ownerId, extra = 0) {
  const ent = await plans.requireFeature(ownerId, 'replays', 'Cloud replays');
  const cap = ent.features.replayMB * 1048576;
  if (cap && (await usedBytes(ownerId)) + extra > cap) throw fail(413, `Replay storage is full (${ent.features.replayMB} MB on your plan). Delete old replays first.`);
  return ent;
}

// ---------------------------------------------------------------- egress
async function canControlRoom(userId, meeting) {
  if (!meeting) return false;
  if (meeting.hostUserId === userId || (meeting.limits && meeting.limits.ownerUserId === userId)) return true;
  const v = meeting.venue ? await require('../venues/data').getVenueByCode(meeting.code).catch(() => null) : null;
  return !!(v && await require('../orgs/service').canManageVenue(userId, v));
}
async function startEgress(user, code, { title } = {}) {
  const cfg = egressConfig();
  if (!cfg) throw fail(503, 'Cloud recording is not set up on this server. Upload a recording instead.');
  const store = require('../../rooms/store');
  const meeting = store.getMeeting(String(code || '').toLowerCase()) || store.getMeeting(String(code || ''));
  if (!meeting || !(await canControlRoom(user.id, meeting))) throw fail(404, 'Live room not found');
  const owner = (meeting.limits && meeting.limits.ownerUserId) || meeting.hostUserId || user.id;
  await assertQuota(owner);
  if (await one("SELECT 1 FROM replays WHERE room_code=$1 AND status='recording'", [meeting.code])) throw fail(409, 'This room is already being recorded');
  const { EncodedFileOutput, S3Upload, EncodedFileType } = require('livekit-server-sdk');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const filepath = `${cfg.prefix}/${meeting.code}/${stamp}.mp4`;
  const output = new EncodedFileOutput({ fileType: EncodedFileType.MP4, filepath,
    output: { case: 's3', value: new S3Upload({ accessKey: cfg.accessKey, secret: cfg.secret, region: cfg.region, endpoint: cfg.endpoint, bucket: cfg.bucket, forcePathStyle: cfg.forcePathStyle }) } });
  let info;
  try { info = await egressClient(cfg).startRoomCompositeEgress(meeting.code, output, { layout: cfg.layout }); }
  catch (e) { console.error('[replays] egress start', e.message); throw fail(502, 'The recording service did not start. Check that LiveKit Egress is running.'); }
  const r = await one(`INSERT INTO replays (owner_user_id, event_id, meeting_history_id, room_code, title, source, egress_id, status, driver, object_key, mime, visibility)
    VALUES ($1,$2,$3,$4,$5,'egress',$6,'recording','s3',$7,'video/mp4',$8) RETURNING *`,
  [owner, meeting.eventId || null, meeting.historyId || null, meeting.code, String(title || meeting.name || 'Replay').slice(0, 120), info.egressId, filepath, 'public']);
  return replayOut(r, { owner: true });
}
async function stopEgress(user, id) {
  const r = await one('SELECT * FROM replays WHERE id=$1', [id]);
  if (!r || r.source !== 'egress') throw fail(404, 'Recording not found');
  const store = require('../../rooms/store');
  if (r.owner_user_id !== user.id && !(await canControlRoom(user.id, store.getMeeting(r.room_code)))) throw fail(404, 'Recording not found');
  if (r.status !== 'recording') return replayOut(r, { owner: true });
  const cfg = egressConfig();
  try { if (cfg) await egressClient(cfg).stopEgress(r.egress_id); } catch (e) { console.warn('[replays] egress stop', e.message); }
  await q("UPDATE replays SET status='processing' WHERE id=$1 AND status='recording'", [id]);
  return replayOut(await one('SELECT * FROM replays WHERE id=$1', [id]), { owner: true });
}
/** Poll LiveKit for egress results. EgressStatus: 3 complete, 4 failed, 5 aborted, 6 limit reached. */
async function poll() {
  const cfg = egressConfig();
  if (!cfg) return { checked: 0 };
  const rows = await many("SELECT * FROM replays WHERE source='egress' AND status IN ('recording','processing') ORDER BY id LIMIT 50");
  let checked = 0;
  for (const r of rows) {
    let info;
    try { [info] = await egressClient(cfg).listEgress({ egressId: r.egress_id }); } catch (e) { console.warn('[replays] poll', e.message); continue; }
    checked++;
    if (!info) continue;
    const st = Number(info.status);
    if (st === 3 || st === 6) {
      const f = (info.fileResults && info.fileResults[0]) || info.file || {};
      const size = f.size != null ? Number(f.size) : null;
      const dur = f.duration != null ? Math.round(Number(f.duration) / 1e9) : null;
      await q("UPDATE replays SET status='ready', size_bytes=$2, duration_sec=$3, ended_at=NOW() WHERE id=$1", [r.id, size, dur]);
    } else if (st === 4 || st === 5) {
      await q("UPDATE replays SET status='failed', error=$2, ended_at=NOW() WHERE id=$1", [r.id, String(info.error || 'egress failed').slice(0, 200)]);
    } else if (st === 2 && r.status === 'recording') {
      await q("UPDATE replays SET status='processing' WHERE id=$1", [r.id]);
    }
  }
  return { checked };
}
let timer = null;
function startWorker() {
  if (timer || process.env.REPLAY_WORKER === 'false' || !egressConfig()) return null;
  timer = setInterval(() => { poll().catch((e) => console.error('[replays] poll', e.message)); }, Math.max(15000, Number(process.env.REPLAY_POLL_MS) || 60000));
  timer.unref();
  return timer;
}

// ---------------------------------------------------------------- manual upload / link
async function target(userId, { eventId, historyId }) {
  if (eventId) {
    const ev = await one('SELECT id, title, host_user_id, meeting_history_id FROM events WHERE id=$1', [eventId]);
    if (!ev || ev.host_user_id !== userId) throw fail(404, 'Event not found or not yours');
    return { eventId: ev.id, historyId: ev.meeting_history_id || null, title: ev.title };
  }
  if (historyId) {
    const { meeting } = await require('../exports/service').meetingFor(userId, historyId);
    return { eventId: meeting.event_id || null, historyId: meeting.id, title: meeting.name };
  }
  return { eventId: null, historyId: null, title: 'Replay' };
}
const VIS = ['public', 'unlisted', 'private'];
async function upload(user, req, query) {
  const size = Number(req.headers['content-length']) || 0;
  const mime = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  if (!/^(video|audio)\//.test(mime)) throw fail(415, 'Upload a video or audio file (MP4, WebM, M4A, MP3)');
  const t = await target(user.id, { eventId: parseInt(query.get('eventId'), 10) || null, historyId: parseInt(query.get('historyId'), 10) || null });
  await assertQuota(user.id, size);
  const maxBytes = plans.platform(await plans.getSettings()).replayUploadMB * 1048576;
  let filename = 'replay';
  try { filename = decodeURIComponent(String(req.headers['x-file-name'] || 'replay')); } catch (_) {}
  const saved = await require('../../venue/storage').saveStream(req, { filename, mime, size, maxBytes });
  const r = await one(`INSERT INTO replays (owner_user_id, event_id, meeting_history_id, title, source, status, driver, object_key, mime, size_bytes, visibility)
    VALUES ($1,$2,$3,$4,'upload','ready',$5,$6,$7,$8,$9) RETURNING *`,
  [user.id, t.eventId, t.historyId, String(query.get('title') || t.title).slice(0, 120), saved.driver, saved.objectKey, mime, saved.size, VIS.includes(query.get('visibility')) ? query.get('visibility') : 'public']);
  return replayOut(r, { owner: true });
}
async function addLink(user, b = {}) {
  await assertQuota(user.id);
  let url;
  try { url = new URL(String(b.url || '')); } catch (_) { throw fail(400, 'Paste a full https link'); }
  if (url.protocol !== 'https:' || url.username || url.password) throw fail(400, 'Paste a full https link');
  const t = await target(user.id, { eventId: parseInt(b.eventId, 10) || null, historyId: parseInt(b.historyId, 10) || null });
  const r = await one(`INSERT INTO replays (owner_user_id, event_id, meeting_history_id, title, source, status, url, visibility) VALUES ($1,$2,$3,$4,'url','ready',$5,$6) RETURNING *`,
    [user.id, t.eventId, t.historyId, String(b.title || t.title).slice(0, 120), url.href, VIS.includes(b.visibility) ? b.visibility : 'public']);
  return replayOut(r, { owner: true });
}
async function update(user, id, b = {}) {
  const r = await one('SELECT * FROM replays WHERE id=$1 AND owner_user_id=$2', [id, user.id]);
  if (!r) throw fail(404, 'Replay not found');
  const title = b.title != null ? String(b.title).trim().slice(0, 120) || r.title : r.title;
  const vis = VIS.includes(b.visibility) ? b.visibility : r.visibility;
  return replayOut(await one('UPDATE replays SET title=$2, visibility=$3 WHERE id=$1 RETURNING *', [id, title, vis]), { owner: true });
}
async function remove(user, id) {
  const r = await one('SELECT * FROM replays WHERE id=$1 AND owner_user_id=$2', [id, user.id]);
  if (!r) throw fail(404, 'Replay not found');
  if (r.status === 'recording') throw fail(409, 'Stop the recording first');
  if (r.object_key) await require('../../venue/storage').remove({ driver: r.driver, object_key: r.object_key });
  await q('DELETE FROM replays WHERE id=$1', [id]);
  return { ok: true };
}
async function mine(userId) {
  return { replays: (await many('SELECT * FROM replays WHERE owner_user_id=$1 ORDER BY id DESC LIMIT 100', [userId])).map((r) => replayOut(r, { owner: true })),
    usedBytes: await usedBytes(userId), egress: !!egressConfig() };
}
/** Viewer access: owner always; otherwise the owner's plan must still include replays, private is owner-only, ticketed events need a ticket. */
async function access(replay, viewer) {
  if (!replay) return { ok: false, status: 404 };
  if (viewer && viewer.id === replay.owner_user_id) return { ok: true };
  if (replay.status !== 'ready' || replay.visibility === 'private') return { ok: false, status: 404 };
  const ent = await plans.entitlements(replay.owner_user_id);
  if (!ent.features.replays) return { ok: false, status: 404 };
  if (replay.event_id) {
    const gate = await require('../commerce/service').canJoinEvent(replay.event_id, viewer);
    if (!gate.ok) return { ok: false, status: 403, reason: 'This replay is for ticket holders.' };
    const ev = await one('SELECT visibility, host_user_id FROM events WHERE id=$1', [replay.event_id]);
    if (ev && ev.visibility === 'private') return { ok: false, status: 404 };
  }
  return { ok: true };
}
async function getPublic(id, viewer) {
  const r = await one('SELECT r.*, e.slug AS event_slug, e.title AS event_title, u.display_name, u.username FROM replays r LEFT JOIN events e ON e.id=r.event_id LEFT JOIN users u ON u.id=r.owner_user_id WHERE r.id=$1', [id]);
  const a = await access(r, viewer);
  if (!a.ok) throw fail(a.status, a.reason || 'Replay not found');
  return { ...replayOut(r, { owner: !!(viewer && viewer.id === r.owner_user_id) }), event: r.event_slug ? { slug: r.event_slug, title: r.event_title } : null, host: { name: r.display_name || r.username, username: r.username } };
}
async function forEvent(eventId, viewer) {
  const rows = await many("SELECT * FROM replays WHERE event_id=$1 AND status='ready' ORDER BY id DESC LIMIT 20", [eventId]);
  const out = [];
  for (const r of rows) if ((await access(r, viewer)).ok && (r.visibility === 'public' || (viewer && viewer.id === r.owner_user_id))) out.push(replayOut(r));
  return out;
}

module.exports = { egressConfig, startEgress, stopEgress, poll, startWorker, upload, addLink, update, remove, mine, access, getPublic, forEvent, replayOut, _setEgressClient: (c) => { clientOverride = c; } };
