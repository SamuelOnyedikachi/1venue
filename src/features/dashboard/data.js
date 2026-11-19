const { USE_PG } = require('../../../db');
/**
 * dashboard queries (PostgreSQL, parameterised). Split out of src/venue/data.js;
 * src/venue/data.js still re-exports everything for older call sites.
 */
const { one, many } = require('../../core/db');

// ---------------------------------------------------------------- dashboard
async function dashboard(userId) {
  if (!USE_PG) {
    const stats = await one(`SELECT
      (SELECT COUNT(*) FROM meeting_history WHERE host_user_id=$1) AS hosted,
      (SELECT COUNT(DISTINCT meeting_history_id) FROM meeting_participants_log WHERE user_id=$1) AS attended,
      (SELECT COALESCE(SUM((julianday(COALESCE(left_at, strftime('%Y-%m-%dT%H:%M:%fZ','now'))) - julianday(joined_at))*86400),0) FROM meeting_participants_log WHERE user_id=$1 AND joined_at > datetime('now','-30 days')) AS seconds30,
      (SELECT COUNT(*) FROM follows WHERE followee_id=$1) AS followers,
      (SELECT COUNT(*) FROM follows WHERE follower_id=$1) AS following,
      ((SELECT COALESCE(SUM(total_joins),0) FROM events WHERE host_user_id=$1) + (SELECT COUNT(*) FROM meeting_participants_log l JOIN meeting_history h ON h.id=l.meeting_history_id WHERE h.host_user_id=$1)) AS audience,
      MAX((SELECT COALESCE(MAX(peak_viewers),0) FROM events WHERE host_user_id=$1),(SELECT COALESCE(MAX(max_participants),0) FROM meeting_history WHERE host_user_id=$1)) AS peak,
      (SELECT COUNT(*) FROM transcript_segments t JOIN meeting_history h ON h.id=t.meeting_history_id WHERE h.host_user_id=$1) AS transcript_lines`, [userId]);
    const activity = await many(`WITH RECURSIVE days(day,n) AS (SELECT date('now','-13 days'),0 UNION ALL SELECT date(day,'+1 day'),n+1 FROM days WHERE n<13)
      SELECT day,(SELECT COUNT(*) FROM meeting_participants_log l WHERE l.user_id=$1 AND date(l.joined_at)=day) AS n FROM days ORDER BY day`, [userId]);
    return { stats, activity };
  }
  // Audience/peak include venue + instant meetings (meeting_history), not only scheduled events.
  // Transcripts count segments from any meeting the user hosted.
  const stats = await one(`SELECT
      (SELECT COUNT(*) FROM meeting_history WHERE host_user_id=$1)::int AS hosted,
      (SELECT COUNT(DISTINCT meeting_history_id) FROM meeting_participants_log WHERE user_id=$1)::int AS attended,
      (SELECT COALESCE(SUM(EXTRACT(EPOCH FROM (COALESCE(left_at, NOW()) - joined_at))),0) FROM meeting_participants_log WHERE user_id=$1 AND joined_at > NOW() - INTERVAL '30 days')::bigint AS seconds30,
      (SELECT COUNT(*) FROM follows WHERE followee_id=$1)::int AS followers,
      (SELECT COUNT(*) FROM follows WHERE follower_id=$1)::int AS following,
      (
        (SELECT COALESCE(SUM(total_joins),0) FROM events WHERE host_user_id=$1)
        + (SELECT COALESCE(SUM(
             (SELECT COUNT(*) FROM meeting_participants_log mpl WHERE mpl.meeting_history_id = mh.id)
           ), 0) FROM meeting_history mh WHERE mh.host_user_id=$1)
      )::int AS audience,
      GREATEST(
        (SELECT COALESCE(MAX(peak_viewers),0) FROM events WHERE host_user_id=$1),
        (SELECT COALESCE(MAX(max_participants),0) FROM meeting_history WHERE host_user_id=$1)
      )::int AS peak,
      (SELECT COUNT(*) FROM transcript_segments t
         JOIN meeting_history h ON h.id=t.meeting_history_id
        WHERE h.host_user_id=$1)::int AS transcript_lines`, [userId]);
  const activity = await many(`SELECT to_char(d, 'YYYY-MM-DD') AS day,
      (SELECT COUNT(*) FROM meeting_participants_log l WHERE l.user_id=$1 AND l.joined_at::date = d::date)::int AS n
    FROM generate_series(CURRENT_DATE - INTERVAL '13 days', CURRENT_DATE, INTERVAL '1 day') d ORDER BY d`, [userId]);
  return { stats, activity };
}


// Personal dashboard analytics (every signed-in account). Reuses the host-tools date range
// (?days=7|30|90 or ?from&to) and the same day-bucket helper.
async function analytics(userId, params = {}) {
  const { parseRange, bucket, rangeOut } = require('../exports/service');
  const range = typeof params === 'object' && params ? parseRange(params) : parseRange({ days: params });
  const args = [userId, range.from, range.until];
  const start = range.from.getTime();
  const hostedRows = await many('SELECT created_at, max_participants FROM meeting_history WHERE host_user_id=$1 AND created_at >= $2 AND created_at < $3', args);
  const joinedRows = await many('SELECT joined_at, meeting_history_id FROM meeting_participants_log WHERE user_id=$1 AND joined_at >= $2 AND joined_at < $3 LIMIT 200000', args);
  const rsvpRows = await many('SELECT r.created_at FROM event_rsvps r JOIN events e ON e.id=r.event_id WHERE e.host_user_id=$1 AND r.created_at >= $2 AND r.created_at < $3 LIMIT 200000', args);
  const audienceRows = await many('SELECT l.joined_at FROM meeting_participants_log l JOIN meeting_history h ON h.id=l.meeting_history_id WHERE h.host_user_id=$1 AND l.joined_at >= $2 AND l.joined_at < $3 LIMIT 200000', args);
  let seconds = 0, transcriptLines = 0, eventPeak = 0;
  if (!USE_PG) {
    const sec = await one(`SELECT COALESCE(SUM((julianday(COALESCE(left_at, strftime('%Y-%m-%dT%H:%M:%fZ','now'))) - julianday(joined_at))*86400),0) AS seconds
      FROM meeting_participants_log WHERE user_id=$1 AND joined_at >= $2 AND joined_at < $3`, args);
    seconds = Number(sec && sec.seconds) || 0;
    const tx = await one(`SELECT COUNT(*) AS n FROM transcript_segments t JOIN meeting_history h ON h.id=t.meeting_history_id
      WHERE h.host_user_id=$1 AND h.created_at >= $2 AND h.created_at < $3`, args);
    transcriptLines = Number(tx && tx.n) || 0;
    const pk = await one(`SELECT COALESCE(MAX(peak_viewers),0) AS peak FROM events
      WHERE host_user_id=$1 AND COALESCE(starts_at, created_at) >= $2 AND COALESCE(starts_at, created_at) < $3`, args);
    eventPeak = Number(pk && pk.peak) || 0;
  } else {
    const sec = await one(`SELECT COALESCE(SUM(EXTRACT(EPOCH FROM (COALESCE(left_at, NOW()) - joined_at))),0)::bigint AS seconds
      FROM meeting_participants_log WHERE user_id=$1 AND joined_at >= $2 AND joined_at < $3`, args);
    seconds = Number(sec && sec.seconds) || 0;
    const tx = await one(`SELECT COUNT(*)::int AS n FROM transcript_segments t JOIN meeting_history h ON h.id=t.meeting_history_id
      WHERE h.host_user_id=$1 AND h.created_at >= $2 AND h.created_at < $3`, args);
    transcriptLines = Number(tx && tx.n) || 0;
    const pk = await one(`SELECT COALESCE(MAX(peak_viewers),0)::int AS peak FROM events
      WHERE host_user_id=$1 AND COALESCE(starts_at, created_at) >= $2 AND COALESCE(starts_at, created_at) < $3`, args);
    eventPeak = Number(pk && pk.peak) || 0;
  }
  const hostedPeak = hostedRows.reduce((m, r) => Math.max(m, Number(r.max_participants) || 0), 0);
  const attended = new Set(joinedRows.map((r) => String(r.meeting_history_id))).size;
  return {
    range: rangeOut(range),
    totals: {
      hosted: hostedRows.length,
      attended,
      joins: joinedRows.length,
      seconds: Math.round(seconds),
      audience: audienceRows.length,
      peak: Math.max(hostedPeak, eventPeak),
      rsvps: rsvpRows.length,
      transcriptLines,
    },
    hostedByDay: bucket(hostedRows.map((r) => r.created_at), range.days, start).map((d) => ({ day: d.day, hosted: d.n })),
    joinedByDay: bucket(joinedRows.map((r) => r.joined_at), range.days, start).map((d) => ({ day: d.day, joined: d.n })),
    rsvpsByDay: bucket(rsvpRows.map((r) => r.created_at), range.days, start).map((d) => ({ day: d.day, rsvps: d.n })),
    audienceByDay: bucket(audienceRows.map((r) => r.joined_at), range.days, start).map((d) => ({ day: d.day, joins: d.n })),
  };
}

module.exports = { dashboard, analytics };
