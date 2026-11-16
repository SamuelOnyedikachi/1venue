/**
 * Recurring series and reminders.
 *   GET    /api/series                  my series with their next occurrence
 *   POST   /api/series                  { kind: event|meeting, title, firstStart, durationMin, pattern: weekly|biweekly|monthly, until?, count?, ...event fields, invitees? }
 *   DELETE /api/series/:id              remove future occurrences
 *   PATCH  /api/schedule/:id/reminders  { reminders: bool, invitees? }   per scheduled meeting
 */
const series = require('./series');

module.exports = function routes(route, { requireUser, httpError, rateLimit, int, db }) {
  route('GET', '/api/series', async (ctx) => ({ series: await series.listSeries((await requireUser(ctx.req, ctx.res)).id) }));
  route('POST', '/api/series', async (ctx) => {
    const u = await requireUser(ctx.req, ctx.res);
    if (!rateLimit('series:' + u.id, 10)) throw httpError(429, 'Please wait a moment');
    return { $status: 201, $body: await series.createSeries(u, await ctx.body(32 * 1024)) };
  });
  route('DELETE', '/api/series/(\\d+)', async (ctx, [id]) => series.cancelSeries((await requireUser(ctx.req, ctx.res)).id, int(id)));
  route('PATCH', '/api/schedule/(\\d+)/reminders', async (ctx, [id]) => {
    const u = await requireUser(ctx.req, ctx.res);
    const b = await ctx.body();
    const inv = b.invitees === undefined ? undefined : JSON.stringify([...new Set((Array.isArray(b.invitees) ? b.invitees : String(b.invitees || '').split(/[,\s]+/)).map((e) => String(e).trim().toLowerCase()).filter((e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)))].slice(0, 100));
    const r = await db.q(`UPDATE scheduled_meetings SET reminders=$3${inv !== undefined ? ', invitees=$4' : ''} WHERE id=$1 AND host_user_id=$2`, inv !== undefined ? [int(id), u.id, b.reminders !== false, inv] : [int(id), u.id, b.reminders !== false]);
    if (!r.rowCount) throw httpError(404, 'Scheduled meeting not found');
    return { ok: true };
  });
};
