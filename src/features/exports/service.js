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
async function sessionsExport(userId, format) {
  await plans.requireFeature(userId, 'exports', 'Exports');
  const rows = [['Session', 'Code', 'Started (UTC)', 'Ended (UTC)', 'People', 'Peak']];
  for (const s of await sessionStats(userId, 3650, 2000)) rows.push([s.name, s.code, s.startedAt, s.endedAt || '', s.people, s.peak]);
  return file(rows, format, 'sessions', 'Sessions');
}
async function sessionStats(userId, days, limit = 50) {
  const since = new Date(Date.now() - days * 86400000);
  const rows = await many(`SELECT h.id, h.name, h.code, h.created_at, h.ended_at, h.max_participants,
      (SELECT COUNT(DISTINCT COALESCE(CAST(l.user_id AS TEXT), l.display_name)) FROM meeting_participants_log l WHERE l.meeting_history_id=h.id) AS people
    FROM meeting_history h WHERE h.host_user_id=$1 AND h.created_at >= $2 ORDER BY h.created_at DESC LIMIT $3`, [userId, since, limit]);
  return rows.map((r) => ({ id: r.id, name: r.name, code: r.code, startedAt: new Date(r.created_at).toISOString(), endedAt: r.ended_at ? new Date(r.ended_at).toISOString() : null, people: Number(r.people), peak: Number(r.max_participants) }));
}
/** Pure: bucket timestamps into the last `days` UTC days. */
function daily(times, days, now = Date.now()) {
  const out = [];
  const start = Date.UTC(new Date(now).getUTCFullYear(), new Date(now).getUTCMonth(), new Date(now).getUTCDate()) - (days - 1) * 86400000;
  for (let i = 0; i < days; i++) out.push({ day: new Date(start + i * 86400000).toISOString().slice(0, 10), n: 0 });
  for (const t of times) { const i = Math.floor((new Date(t).getTime() - start) / 86400000); if (i >= 0 && i < days) out[i].n++; }
  return out;
}
async function analytics(userId, days = 30) {
  await plans.requireFeature(userId, 'analytics', 'Analytics');
  days = Math.min(365, Math.max(7, parseInt(days, 10) || 30));
  const since = new Date(Date.now() - days * 86400000);
  const joins = await many('SELECT l.joined_at FROM meeting_participants_log l JOIN meeting_history h ON h.id=l.meeting_history_id WHERE h.host_user_id=$1 AND l.joined_at >= $2 LIMIT 100000', [userId, since]);
  const sessions = await sessionStats(userId, days, 200);
  const events = await many(`SELECT e.id, e.slug, e.title, e.status, e.starts_at, e.peak_viewers, e.total_joins, (SELECT COUNT(*) FROM event_rsvps r WHERE r.event_id=e.id) AS rsvps
    FROM events e WHERE e.host_user_id=$1 AND COALESCE(e.starts_at, e.created_at) >= $2 ORDER BY COALESCE(e.starts_at, e.created_at) DESC LIMIT 50`, [userId, since]);
  const promos = await many('SELECT id, event_id, views, clicks, active, review_status, starts_at, ends_at FROM promotions WHERE owner_user_id=$1 ORDER BY id DESC LIMIT 50', [userId]).catch(() => []);
  const money = await one(`SELECT COALESCE(SUM(CASE WHEN kind IN ('sale','donation') THEN gross_kobo ELSE 0 END),0) AS gross, COALESCE(SUM(CASE WHEN kind IN ('sale','donation') THEN fee_kobo ELSE 0 END),0) AS fees, COALESCE(SUM(net_kobo),0) AS balance FROM host_ledger WHERE host_user_id=$1`, [userId]).catch(() => null);
  const tickets = await one("SELECT COUNT(*) AS n FROM tickets t JOIN events e ON e.id=t.event_id WHERE e.host_user_id=$1 AND t.status='valid'", [userId]).catch(() => null);
  return {
    days, audienceByDay: daily(joins.map((j) => j.joined_at), days),
    totals: { sessions: sessions.length, joins: joins.length, people: sessions.reduce((a, s) => a + s.people, 0), peak: sessions.reduce((a, s) => Math.max(a, s.peak), 0), tickets: Number(tickets ? tickets.n : 0),
      grossKobo: Number(money ? money.gross : 0), feesKobo: Number(money ? money.fees : 0), balanceKobo: Number(money ? money.balance : 0) },
    sessions: sessions.slice(0, 20),
    events: events.map((e) => ({ id: Number(e.id), slug: e.slug, title: e.title, status: e.status, startsAt: e.starts_at, peak: Number(e.peak_viewers || 0), joins: Number(e.total_joins || 0), rsvps: Number(e.rsvps) })),
    promotions: promos.map((p) => ({ id: Number(p.id), eventId: p.event_id ? Number(p.event_id) : null, views: Number(p.views), clicks: Number(p.clicks), ctr: p.views ? Math.round((p.clicks / p.views) * 1000) / 10 : 0, active: !!p.active, review: p.review_status, startsAt: p.starts_at, endsAt: p.ends_at })),
  };
}
module.exports = { attendanceRows, daily, attendanceExport, transcriptExport, sessionsExport, analytics, meetingFor };
