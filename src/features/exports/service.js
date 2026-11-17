/**
 * Exports and analytics. Hosts on a plan with "exports" download attendance and transcripts as
 * CSV or Excel; "analytics" unlocks the host dashboard data (daily audience, top sessions,
 * promotion and ticket stats). Venue meetings are also open to the venue's org admins.
 */
const { one, many } = require('../../core/db');
const plans = require('../../lib/plans');
const { csv, xlsx } = require('../../lib/xlsx');
const fail = (status, message) => Object.assign(new Error(message), { status, expose: true });

/** The meeting, if this user may export it (host, or owner/org admin of the venue it ran in). */
async function meetingFor(userId, historyId) {
  const m = await one('SELECT * FROM meeting_history WHERE id=$1', [historyId]);
  if (!m) throw fail(404, 'Session not found');
  if (m.host_user_id === userId) return { meeting: m, payer: userId };
  const v = await require('../venues/data').getVenueByCode(m.code).catch(() => null);
  if (v && await require('../orgs/service').canManageVenue(userId, v)) return { meeting: m, payer: v.ownerUserId };
  throw fail(404, 'Session not found');
}
/** Pure: group join/leave log rows into one line per person. */
function attendanceRows(logs, hostUserId, now = Date.now()) {
  const groups = new Map();
  for (const r of logs) {
    const key = r.user_id ? `u:${r.user_id}` : `n:${r.display_name}`;
    if (!groups.has(key)) groups.set(key, { name: r.display_name, userId: r.user_id || null, username: r.username || null, email: r.email || null, joins: [], secs: 0, lastLeft: null });
    const g = groups.get(key);
    const a = new Date(r.joined_at).getTime(); const b = r.left_at ? new Date(r.left_at).getTime() : now;
    g.joins.push(a); if (b > a) g.secs += (b - a) / 1000;
    if (r.left_at && (!g.lastLeft || b > g.lastLeft)) g.lastLeft = b;
  }
  return [...groups.values()].map((g) => ({
    name: g.name, username: g.username, email: g.email, role: g.userId && g.userId === hostUserId ? 'host' : g.userId ? 'member' : 'guest',
    firstJoin: new Date(Math.min(...g.joins)).toISOString(), lastLeave: g.lastLeft ? new Date(g.lastLeft).toISOString() : null,
    minutes: Math.round(g.secs / 6) / 10, sessions: g.joins.length,
  })).sort((x, y) => (x.role === 'host' ? -1 : y.role === 'host' ? 1 : x.firstJoin.localeCompare(y.firstJoin)));
}
function file(rows, format, base, sheet) {
  const safe = String(base).replace(/[^\w.-]+/g, '-').replace(/-+/g, '-').slice(0, 60) || 'export';
  if (format === 'xlsx') return { raw: xlsx(rows, sheet), type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', headers: { 'Content-Disposition': `attachment; filename="${safe}.xlsx"`, 'Cache-Control': 'no-store' } };
  return { raw: csv(rows), type: 'text/csv; charset=utf-8', headers: { 'Content-Disposition': `attachment; filename="${safe}.csv"`, 'Cache-Control': 'no-store' } };
}
async function attendanceExport(userId, historyId, format) {
  const { meeting, payer } = await meetingFor(userId, historyId);
  await plans.requireFeature(payer, 'exports', 'Exports');
  const logs = await many(`SELECT l.*, u.username, u.email FROM meeting_participants_log l LEFT JOIN users u ON u.id=l.user_id WHERE l.meeting_history_id=$1 ORDER BY l.joined_at LIMIT 50000`, [historyId]);
  const showEmail = meeting.host_user_id === userId;
  const rows = [['Name', 'Username', ...(showEmail ? ['Email'] : []), 'Role', 'First joined (UTC)', 'Last left (UTC)', 'Minutes', 'Sessions']];
  for (const a of attendanceRows(logs, meeting.host_user_id)) rows.push([a.name, a.username || '', ...(showEmail ? [a.email || ''] : []), a.role, a.firstJoin, a.lastLeave || '', a.minutes, a.sessions]);
  return file(rows, format, `attendance-${meeting.name}-${historyId}`, 'Attendance');
}
async function transcriptExport(userId, historyId, format) {
  const { meeting, payer } = await meetingFor(userId, historyId);
  await plans.requireFeature(payer, 'exports', 'Exports');
  const segs = await many('SELECT spoken_at, speaker_name, text, lang, source FROM transcript_segments WHERE meeting_history_id=$1 ORDER BY spoken_at, id LIMIT 100000', [historyId]);
  const rows = [['Time (UTC)', 'Speaker', 'Text', 'Language', 'Source']];
  for (const s of segs) rows.push([new Date(s.spoken_at).toISOString(), s.speaker_name, s.text, s.lang || '', s.source]);
  return file(rows, format, `transcript-${meeting.name}-${historyId}`, 'Transcript');
}
// ---------------------------------------------------------------- date ranges
const DAY = 86400000;
const PRESETS = [7, 30, 90];
const ymd = (ms) => new Date(ms).toISOString().slice(0, 10);
const utcDay = (ms) => { const d = new Date(ms); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()); };
/**
 * Pure: the reporting window from query params, validated. Whole UTC days, `to` inclusive.
 *   ?days=7|30|90 (any 1..365 still works for old links), or ?from=YYYY-MM-DD&to=YYYY-MM-DD (at most 366 days, not in the future).
 * Returns { from: Date, until: Date (exclusive), days, fromDay, toDay, preset }. Throws 400 on bad input.
 */
function parseRange(params = {}, now = Date.now()) {
  const get = (k) => (typeof params.get === 'function' ? params.get(k) : params[k]);
  const today = utcDay(now);
  const from = get('from'), to = get('to');
  if (from != null || to != null) {
    const parse = (v, label) => {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(String(v || ''))) throw fail(400, `${label} must be a date like 2026-01-31`);
      const ms = Date.parse(v + 'T00:00:00Z');
      if (!Number.isFinite(ms) || ymd(ms) !== v) throw fail(400, `${label} is not a real date`);
      return ms;
    };
    const a = parse(from, 'The start date'), b = parse(to == null || to === '' ? ymd(today) : to, 'The end date');
    if (a > b) throw fail(400, 'The start date must be on or before the end date');
    if (b > today) throw fail(400, 'The end date cannot be in the future');
    const days = Math.round((b - a) / DAY) + 1;
    if (days > 366) throw fail(400, 'Choose a range of at most 366 days');
    return { from: new Date(a), until: new Date(b + DAY), days, fromDay: ymd(a), toDay: ymd(b), preset: null };
  }
  const raw = get('days');
  const n = raw == null || raw === '' ? 30 : Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 365) throw fail(400, 'days must be a whole number from 1 to 365');
  const a = today - (n - 1) * DAY;
  return { from: new Date(a), until: new Date(today + DAY), days: n, fromDay: ymd(a), toDay: ymd(today), preset: PRESETS.includes(n) ? n : null };
}
const rangeOut = (r) => ({ from: r.fromDay, to: r.toDay, days: r.days, preset: r.preset });
const hostedIn = 'SELECT id FROM meeting_history WHERE host_user_id=$1 AND created_at >= $2 AND created_at < $3';

async function sessionsExport(userId, format, range = parseRange({})) {
  await plans.requireFeature(userId, 'exports', 'Exports');
  const rows = [['Session', 'Code', 'Started (UTC)', 'Ended (UTC)', 'People', 'Peak']];
  for (const s of await sessionStats(userId, range, 5000)) rows.push([s.name, s.code, s.startedAt, s.endedAt || '', s.people, s.peak]);
  return file(rows, format, `sessions-${range.fromDay}-to-${range.toDay}`, 'Sessions');
}
/** Everyone who joined any of my sessions in the range, one line per person per session. */
async function attendanceRangeExport(userId, format, range) {
  await plans.requireFeature(userId, 'exports', 'Exports');
  const sessions = await many(`SELECT id, name, host_user_id FROM meeting_history WHERE host_user_id=$1 AND created_at >= $2 AND created_at < $3 ORDER BY created_at LIMIT 2000`, [userId, range.from, range.until]);
  const rows = [['Session', 'Name', 'Username', 'Email', 'Role', 'First joined (UTC)', 'Last left (UTC)', 'Minutes', 'Sessions']];
  for (const m of sessions) {
    const logs = await many('SELECT l.*, u.username, u.email FROM meeting_participants_log l LEFT JOIN users u ON u.id=l.user_id WHERE l.meeting_history_id=$1 ORDER BY l.joined_at LIMIT 50000', [m.id]);
    for (const a of attendanceRows(logs, m.host_user_id)) rows.push([m.name, a.name, a.username || '', a.email || '', a.role, a.firstJoin, a.lastLeave || '', a.minutes, a.sessions]);
  }
  return file(rows, format, `attendance-${range.fromDay}-to-${range.toDay}`, 'Attendance');
}
async function transcriptsRangeExport(userId, format, range) {
  await plans.requireFeature(userId, 'exports', 'Exports');
  const segs = await many(`SELECT t.spoken_at, t.speaker_name, t.text, t.lang, t.source, h.name AS session FROM transcript_segments t JOIN meeting_history h ON h.id=t.meeting_history_id
    WHERE t.meeting_history_id IN (${hostedIn}) ORDER BY t.spoken_at, t.id LIMIT 200000`, [userId, range.from, range.until]);
  const rows = [['Session', 'Time (UTC)', 'Speaker', 'Text', 'Language', 'Source']];
  for (const s of segs) rows.push([s.session, new Date(s.spoken_at).toISOString(), s.speaker_name, s.text, s.lang || '', s.source]);
  return file(rows, format, `transcripts-${range.fromDay}-to-${range.toDay}`, 'Transcripts');
}
async function chatRangeExport(userId, format, range) {
  await plans.requireFeature(userId, 'exports', 'Exports');
  const msgs = await many(`SELECT c.created_at, c.sender_name, c.body, h.name AS session FROM chat_messages c JOIN meeting_history h ON h.id=c.meeting_history_id
    WHERE c.meeting_history_id IN (${hostedIn}) AND c.group_id IS NULL ORDER BY c.created_at, c.id LIMIT 200000`, [userId, range.from, range.until]);
  const rows = [['Session', 'Time (UTC)', 'From', 'Message']];
  for (const m of msgs) rows.push([m.session, new Date(m.created_at).toISOString(), m.sender_name || '', m.body || '']);
  return file(rows, format, `chat-${range.fromDay}-to-${range.toDay}`, 'Chat');
}
async function chatExport(userId, historyId, format) {
  const { meeting, payer } = await meetingFor(userId, historyId);
  await plans.requireFeature(payer, 'exports', 'Exports');
  const msgs = await many('SELECT created_at, sender_name, body FROM chat_messages WHERE meeting_history_id=$1 AND group_id IS NULL ORDER BY created_at, id LIMIT 100000', [historyId]);
  const rows = [['Time (UTC)', 'From', 'Message']];
  for (const m of msgs) rows.push([new Date(m.created_at).toISOString(), m.sender_name || '', m.body || '']);
  return file(rows, format, `chat-${meeting.name}-${historyId}`, 'Chat');
}
/** RSVPs for my events created or starting in the range (emails: the host owns the event). */
async function registrationsExport(userId, format, range) {
  await plans.requireFeature(userId, 'exports', 'Exports');
  const regs = await many(`SELECT e.title, e.starts_at, r.created_at, u.display_name, u.username, u.email FROM event_rsvps r JOIN events e ON e.id=r.event_id JOIN users u ON u.id=r.user_id
    WHERE e.host_user_id=$1 AND r.created_at >= $2 AND r.created_at < $3 ORDER BY r.created_at LIMIT 200000`, [userId, range.from, range.until]);
  const rows = [['Event', 'Event starts (UTC)', 'Registered (UTC)', 'Name', 'Username', 'Email']];
  for (const r of regs) rows.push([r.title, r.starts_at ? new Date(r.starts_at).toISOString() : '', new Date(r.created_at).toISOString(), r.display_name || '', r.username || '', r.email || '']);
  return file(rows, format, `registrations-${range.fromDay}-to-${range.toDay}`, 'Registrations');
}
const lastAt = (v) => (v ? new Date(v).toISOString() : null);
/** What each export would contain for the range: row counts and the newest timestamp. */
async function exportSummary(userId, range) {
  await plans.requireFeature(userId, 'exports', 'Exports');
  const args = [userId, range.from, range.until];
  const [sess, att, tr, chat, reg] = await Promise.all([
    one('SELECT COUNT(*) AS n, MAX(created_at) AS last FROM meeting_history WHERE host_user_id=$1 AND created_at >= $2 AND created_at < $3', args),
    one(`SELECT COUNT(*) AS n, MAX(joined_at) AS last FROM meeting_participants_log WHERE meeting_history_id IN (${hostedIn})`, args),
    one(`SELECT COUNT(*) AS n, MAX(spoken_at) AS last FROM transcript_segments WHERE meeting_history_id IN (${hostedIn})`, args),
    one(`SELECT COUNT(*) AS n, MAX(created_at) AS last FROM chat_messages WHERE meeting_history_id IN (${hostedIn}) AND group_id IS NULL`, args),
    one('SELECT COUNT(*) AS n, MAX(r.created_at) AS last FROM event_rsvps r JOIN events e ON e.id=r.event_id WHERE e.host_user_id=$1 AND r.created_at >= $2 AND r.created_at < $3', args),
  ]);
  const row = (id, r) => ({ id, rows: Number(r ? r.n : 0), lastAt: lastAt(r && r.last) });
  return { range: rangeOut(range), exports: [row('sessions', sess), row('attendance', att), row('registrations', reg), row('chat', chat), row('transcripts', tr)],
    sessions: (await sessionStats(userId, range, 50)).map((s) => ({ ...s })) };
}
async function sessionStats(userId, range, limit = 50) {
  const rows = await many(`SELECT h.id, h.name, h.code, h.created_at, h.ended_at, h.max_participants,
      (SELECT COUNT(DISTINCT COALESCE(CAST(l.user_id AS TEXT), l.display_name)) FROM meeting_participants_log l WHERE l.meeting_history_id=h.id) AS people,
      (SELECT COUNT(*) FROM transcript_segments t WHERE t.meeting_history_id=h.id) AS segments,
      (SELECT COUNT(*) FROM chat_messages c WHERE c.meeting_history_id=h.id AND c.group_id IS NULL) AS chats
    FROM meeting_history h WHERE h.host_user_id=$1 AND h.created_at >= $2 AND h.created_at < $3 ORDER BY h.created_at DESC LIMIT $4`, [userId, range.from, range.until, limit]);
  return rows.map((r) => ({ id: Number(r.id), name: r.name, code: r.code, startedAt: new Date(r.created_at).toISOString(), endedAt: r.ended_at ? new Date(r.ended_at).toISOString() : null, people: Number(r.people), peak: Number(r.max_participants), transcriptLines: Number(r.segments), chatMessages: Number(r.chats) }));
}
/** Pure: bucket timestamps into whole UTC days from `startMs` for `days` days. */
function bucket(times, days, startMs, pick = () => 1, reduce = (a, b) => a + b) {
  const out = [];
  for (let i = 0; i < days; i++) out.push({ day: ymd(startMs + i * DAY), n: 0 });
  for (const t of times) {
    const at = typeof t === 'object' && t && !(t instanceof Date) ? t.at : t;
    const i = Math.floor((new Date(at).getTime() - startMs) / DAY);
    if (i >= 0 && i < days) out[i].n = reduce(out[i].n, pick(t));
  }
  return out;
}
/** Pure: bucket timestamps into the last `days` UTC days. */
function daily(times, days, now = Date.now()) { return bucket(times, days, utcDay(now) - (days - 1) * DAY); }
async function analytics(userId, params = {}) {
  await plans.requireFeature(userId, 'analytics', 'Analytics');
  const range = typeof params === 'object' && params ? parseRange(params) : parseRange({ days: params });
  const args = [userId, range.from, range.until];
  const start = range.from.getTime();
  const joins = await many('SELECT l.joined_at FROM meeting_participants_log l JOIN meeting_history h ON h.id=l.meeting_history_id WHERE h.host_user_id=$1 AND l.joined_at >= $2 AND l.joined_at < $3 LIMIT 200000', args);
  const regs = await many('SELECT r.created_at FROM event_rsvps r JOIN events e ON e.id=r.event_id WHERE e.host_user_id=$1 AND r.created_at >= $2 AND r.created_at < $3 LIMIT 200000', args);
  const sessions = await sessionStats(userId, range, 500);
  const events = await many(`SELECT e.id, e.slug, e.title, e.status, e.starts_at, e.peak_viewers, e.total_joins, (SELECT COUNT(*) FROM event_rsvps r WHERE r.event_id=e.id) AS rsvps, (SELECT COUNT(*) FROM meeting_participants_log l JOIN meeting_history m ON m.id=l.meeting_history_id WHERE m.event_id=e.id) AS log_joins, (SELECT MAX(m.max_participants) FROM meeting_history m WHERE m.event_id=e.id) AS log_peak
    FROM events e WHERE e.host_user_id=$1 AND COALESCE(e.starts_at, e.created_at) >= $2 AND COALESCE(e.starts_at, e.created_at) < $3 ORDER BY COALESCE(e.starts_at, e.created_at) DESC LIMIT 50`, args);
  const promos = await many('SELECT id, event_id, views, clicks, active, review_status, starts_at, ends_at FROM promotions WHERE owner_user_id=$1 ORDER BY id DESC LIMIT 50', [userId]).catch(() => []);
  const money = await one(`SELECT COALESCE(SUM(CASE WHEN kind IN ('sale','donation') THEN gross_kobo ELSE 0 END),0) AS gross, COALESCE(SUM(CASE WHEN kind IN ('sale','donation') THEN fee_kobo ELSE 0 END),0) AS fees, COALESCE(SUM(net_kobo),0) AS balance FROM host_ledger WHERE host_user_id=$1`, [userId]).catch(() => null);
  const inRange = await one(`SELECT COALESCE(SUM(CASE WHEN kind IN ('sale','donation') THEN gross_kobo ELSE 0 END),0) AS gross FROM host_ledger WHERE host_user_id=$1 AND created_at >= $2 AND created_at < $3`, args).catch(() => null);
  const tickets = await one("SELECT COUNT(*) AS n FROM tickets t JOIN events e ON e.id=t.event_id WHERE e.host_user_id=$1 AND t.status='valid'", [userId]).catch(() => null);
  const count = (sql) => one(sql, args).then((r) => Number(r ? r.n : 0)).catch(() => 0);
  const [chat, questions, pollVotes, transcriptLines] = await Promise.all([
    count(`SELECT COUNT(*) AS n FROM chat_messages WHERE meeting_history_id IN (${hostedIn})`),
    count(`SELECT COUNT(*) AS n FROM questions WHERE meeting_history_id IN (${hostedIn})`),
    count(`SELECT COUNT(*) AS n FROM poll_votes v JOIN polls p ON p.id=v.poll_id WHERE p.meeting_history_id IN (${hostedIn})`),
    count(`SELECT COUNT(*) AS n FROM transcript_segments WHERE meeting_history_id IN (${hostedIn})`),
  ]);
  const peakByDay = bucket(sessions.map((x) => ({ at: x.startedAt, v: x.peak })), range.days, start, (x) => x.v, Math.max);
  return {
    days: range.days, range: rangeOut(range),
    audienceByDay: bucket(joins.map((j) => j.joined_at), range.days, start).map((d) => ({ day: d.day, joins: d.n })),
    registrationsByDay: bucket(regs.map((r) => r.created_at), range.days, start).map((d) => ({ day: d.day, registrations: d.n })),
    peakByDay: peakByDay.map((d) => ({ day: d.day, peak: d.n })),
    engagement: { chat, questions, pollVotes, transcriptLines },
    totals: { sessions: sessions.length, joins: joins.length, registrations: regs.length, people: sessions.reduce((a, x) => a + x.people, 0), peak: sessions.reduce((a, x) => Math.max(a, x.peak), 0), tickets: Number(tickets ? tickets.n : 0),
      grossKobo: Number(money ? money.gross : 0), grossInRangeKobo: Number(inRange ? inRange.gross : 0), feesKobo: Number(money ? money.fees : 0), balanceKobo: Number(money ? money.balance : 0) },
    sessions: sessions.slice(0, 20),
    events: events.map((e) => ({ id: Number(e.id), slug: e.slug, title: e.title, status: e.status, startsAt: e.starts_at, peak: Math.max(Number(e.peak_viewers || 0), Number(e.log_peak || 0)), joins: Math.max(Number(e.total_joins || 0), Number(e.log_joins || 0)), rsvps: Number(e.rsvps) })),
    promotions: promos.map((p) => ({ id: Number(p.id), eventId: p.event_id ? Number(p.event_id) : null, views: Number(p.views), clicks: Number(p.clicks), ctr: p.views ? Math.round((p.clicks / p.views) * 1000) / 10 : 0, active: !!p.active, review: p.review_status, startsAt: p.starts_at, endsAt: p.ends_at })),
  };
}
module.exports = { attendanceRows, daily, bucket, parseRange, attendanceExport, transcriptExport, chatExport, sessionsExport, attendanceRangeExport, transcriptsRangeExport, chatRangeExport, registrationsExport, exportSummary, analytics, meetingFor };
