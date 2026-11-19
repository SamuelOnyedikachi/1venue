/**
 * Graceful-restart support for live rooms.
 *
 * Live room state lives in this process (src/rooms/store.js). On SIGTERM, and
 * every SNAPSHOT_INTERVAL_MS, every live meeting is written to `meeting_snapshots`.
 * The next process restores rooms proactively on boot from those snapshots and
 * from still-open meeting_history / billing rows, so a meeting that shows as
 * Live is joinable even when Coolify started the new container before the old
 * one could snapshot. Billing never charges the downtime gap: accounted_ms is
 * advanced to now on restore without a debit.
 *
 * Snapshots older than RESTART.restoreMaxMs are ended (unless the room is
 * already live in this process).
 */
const db = require('../../db');
const config = require('../config');
const { normCode } = require('../lib/codes');
const store = require('./store');

// JSON with Map/Set support; timers and functions are dropped.
function replacer(key, v) {
  if (v instanceof Map) return { __map: [...v.entries()] };
  if (v instanceof Set) return { __set: [...v.values()] };
  if (typeof v === 'function') return undefined;
  if (v && typeof v === 'object' && v.constructor && /^(Timeout|Immediate)$/.test(v.constructor.name)) return undefined;
  return v;
}
function reviver(key, v) {
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    if (Array.isArray(v.__map) && Object.keys(v).length === 1) return new Map(v.__map);
    if (Array.isArray(v.__set) && Object.keys(v).length === 1) return new Set(v.__set);
  }
  return v;
}
const serialize = (meeting) => JSON.stringify(meeting, replacer);
const deserialize = (json) => JSON.parse(typeof json === 'string' ? json : JSON.stringify(json), reviver);

async function snapshotOne(meeting) {
  if (!meeting?.code) return;
  await db.q(
    `INSERT INTO meeting_snapshots (code, history_id, state) VALUES ($1, $2, $3::jsonb)
     ON CONFLICT (code) DO UPDATE SET history_id = EXCLUDED.history_id, state = EXCLUDED.state, created_at = NOW()`,
    [meeting.code, meeting.historyId || null, serialize(meeting)]
  );
}

/** Write every live meeting. Called on SIGTERM and on the periodic snapshot timer. */
async function snapshotAll() {
  let n = 0;
  for (const [code, meeting] of store.allMeetings()) {
    try { await snapshotOne(meeting); n++; }
    catch (e) { console.warn('[snapshot] save', code, e.message); }
  }
  return n;
}

async function adoptBilling(meeting) {
  if (!meeting.billingId) return true;
  const billingData = require('../features/wallet/billing-data');
  const ownerId = require('../features/wallet/billing').ownerId;
  if (!await billingData.claim(meeting.billingId, ownerId)) return false;
  await billingData.skipDowntime(meeting.billingId, { ownerId });
  const session = await billingData.get(meeting.billingId);
  if (!session || session.state !== 'active') return false;
  return true;
}

function finishRestored(meeting, from) {
  if (!(meeting.participants instanceof Map)) meeting.participants = new Map();
  if (meeting.content) { meeting.content.slideshow = false; delete meeting.content.slideshowTimer; }
  meeting.lastActivity = Date.now();
  meeting.restoredAt = Date.now();
  meeting.restoredFrom = from;
  return meeting;
}

async function place(code, meeting, from) {
  finishRestored(meeting, from);
  if (!(await adoptBilling(meeting))) return null;
  store.setMeeting(code, meeting);
  try { await snapshotOne(meeting); } catch (e) { console.warn('[snapshot] resave', code, e.message); }
  console.log(`[snapshot] restored ${code} from ${from} (${meeting.participants.size} participants)`);
  return meeting;
}

const inflight = new Map();
/** Return the live meeting for `code`, restoring it from a snapshot or open DB row if needed. */
function getOrRestoreMeeting(code) {
  const c = normCode(code);
  const live = store.getMeeting(c);
  if (live) return Promise.resolve(live);
  if (!c) return Promise.resolve(null);
  if (!inflight.has(c)) {
    inflight.set(c, restore(c).catch((e) => { console.warn('[snapshot] restore', c, e.message); return null; }).finally(() => inflight.delete(c)));
  }
  return inflight.get(c);
}

async function restore(code) {
  const r = await db.q(
    `SELECT s.state, s.created_at, h.ended_at FROM meeting_snapshots s
       LEFT JOIN meeting_history h ON h.id = s.history_id WHERE s.code = $1`,
    [code]
  );
  const row = r.rows[0];
  if (row && !row.ended_at && Date.now() - new Date(row.created_at).getTime() <= config.RESTART.restoreMaxMs) {
    if (store.getMeeting(code)) return store.getMeeting(code);
    const meeting = deserialize(row.state);
    return place(code, meeting, 'snapshot');
  }
  return restoreFromHistory(code);
}

async function restoreFromHistory(code, historyId) {
  code = normCode(code);
  if (store.getMeeting(code)) return store.getMeeting(code);
  const h = historyId
    ? (await db.q('SELECT * FROM meeting_history WHERE id=$1 AND ended_at IS NULL', [historyId])).rows[0]
    : (await db.q('SELECT * FROM meeting_history WHERE code=$1 AND ended_at IS NULL ORDER BY created_at DESC LIMIT 1', [code])).rows[0];
  if (!h) return null;
  const billing = (await db.q("SELECT * FROM credit_billing_sessions WHERE history_id=$1 AND state<>'closed'", [h.id])).rows[0];
  const paid = (await db.q("SELECT * FROM paid_meeting_sessions WHERE history_id=$1 AND state='active'", [h.id])).rows[0];
  const logs = (await db.q('SELECT * FROM meeting_participants_log WHERE meeting_history_id=$1 ORDER BY id', [h.id])).rows;
  const { createParticipant, createMeetingSettings, generateInviteToken } = store;
  const participants = new Map();
  for (const p of logs) {
    if (!p.participant_id) continue;
    const isHost = h.host_user_id != null && p.user_id != null && Number(p.user_id) === Number(h.host_user_id);
    participants.set(p.participant_id, createParticipant({
      id: p.participant_id,
      name: p.display_name,
      role: isHost ? 'host' : 'participant',
      userId: p.user_id || null,
      status: p.left_at ? 'LEFT' : 'ACTIVE',
    }));
  }
  let host = [...participants.values()].find((p) => p.role === 'host')
    || [...participants.values()].find((p) => p.status === 'ACTIVE');
  if (!host) {
    const hid = 'host-restored-' + h.id;
    host = createParticipant({
      id: hid,
      name: h.host_display_name || 'Host',
      role: 'host',
      userId: h.host_user_id || null,
      status: 'ACTIVE',
    });
    participants.set(hid, host);
  } else {
    host.role = 'host';
    host.isHost = true;
    host.status = 'ACTIVE';
  }
  const now = Date.now();
  const meeting = {
    code,
    paidEntry: paid ? {
      enabled: true,
      entryCredits: Number(paid.entry_units),
      durationMin: Number(paid.duration_min),
      startedMs: Number(paid.started_ms),
      advertisedEndMs: Number(paid.advertised_end_ms),
      runtimeEndMs: Number(paid.runtime_end_ms),
    } : null,
    billingId: billing ? billing.id : null,
    mediaRoom: billing ? billing.media_room : null,
    name: h.name,
    hostId: host.id,
    hostUserId: h.host_user_id || null,
    historyId: h.id,
    createdAt: h.created_at ? new Date(h.created_at).getTime() : now,
    lastActivity: now,
    participants,
    content: null,
    chatHistory: [],
    scheduledId: null,
    venue: null,
    settings: createMeetingSettings(),
    inviteToken: generateInviteToken(),
    inviteAccess: 'anyone',
    requireInviteKey: false,
    blocked: { participantIds: new Set(), userIds: new Set(), names: new Set() },
  };
  return place(code, meeting, 'history');
}

/** On boot, put every still-open meeting back into memory before billing starts. */
async function restoreAll() {
  let n = 0;
  const snaps = await db.q(
    `SELECT s.code FROM meeting_snapshots s
       LEFT JOIN meeting_history h ON h.id = s.history_id
      WHERE h.ended_at IS NULL OR s.history_id IS NULL`
  ).catch(() => ({ rows: [] }));
  for (const row of snaps.rows) {
    if (store.getMeeting(normCode(row.code))) { n++; continue; }
    if (await restore(normCode(row.code))) n++;
  }
  const open = await db.q('SELECT id, code FROM meeting_history WHERE ended_at IS NULL').catch(() => ({ rows: [] }));
  for (const row of open.rows) {
    const code = normCode(row.code);
    if (store.getMeeting(code)) continue;
    if (await restoreFromHistory(code, row.id)) n++;
  }
  console.log(`[snapshot] boot restored ${n} live room(s)`);
  return n;
}

/** A brand-new meeting reuses a code that still has a snapshot: close the old session first. */
async function discardSnapshot(code) {
  const r = await db.q('DELETE FROM meeting_snapshots WHERE code = $1 RETURNING history_id', [normCode(code)]).catch(() => ({ rows: [] }));
  for (const row of r.rows) if (row.history_id) await db.endMeetingHistory(row.history_id).catch(() => {});
}

/** End meetings whose snapshot was never picked up (nobody came back in time). */
async function expireSnapshots() {
  const r = await db.q(
    `SELECT code, history_id, state, created_at FROM meeting_snapshots
      WHERE created_at < ${db.USE_PG ? "NOW() - ($1::text || ' milliseconds')::interval" : "strftime('%Y-%m-%dT%H:%M:%fZ','now',(-$1/1000.0) || ' seconds')"}`,
    [String(config.RESTART.restoreMaxMs)]
  ).catch(() => ({ rows: [] }));
  for (const row of r.rows) {
    if (store.getMeeting(row.code)) {
      try { await snapshotOne(store.getMeeting(row.code)); } catch (e) { console.warn('[snapshot] refresh', row.code, e.message); }
      continue;
    }
    await db.q('DELETE FROM meeting_snapshots WHERE code=$1', [row.code]).catch(() => {});
    const m = deserialize(row.state);
    if (!(m.participants instanceof Map)) m.participants = new Map();
    if (m.content) delete m.content.slideshowTimer;
    store.setMeeting(row.code, m);
    if (m.billingId) {
      const billingData = require('../features/wallet/billing-data');
      await billingData.skipDowntime(m.billingId);
      await billingData.settle(m.billingId, { now: Number((await billingData.get(m.billingId))?.accounted_ms || Date.now()), endReason: 'restart-expired' });
    }
    await require('./lifecycle').endMeeting(row.code, 'restart-expired').catch(() => store.deleteMeeting(row.code));
    console.log(`[snapshot] expired ${row.code}`);
  }
}

module.exports = { snapshotAll, snapshotOne, restoreAll, getOrRestoreMeeting, discardSnapshot, expireSnapshots, serialize, deserialize };
