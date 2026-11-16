/**
 * Exports (Premium+): ?format=csv (default) or xlsx
 *   GET /api/exports/attendance/:historyId     GET /api/exports/transcript/:historyId     GET /api/exports/sessions
 * Analytics (Premium+):
 *   GET /api/host/analytics?days=30
 */
const svc = require('./service');
module.exports = function routes(route, { requireUser, int }) {
  const fmt = (ctx) => (ctx.url.searchParams.get('format') === 'xlsx' ? 'xlsx' : 'csv');
  route('GET', '/api/exports/attendance/(\\d+)', async (ctx, [id]) => svc.attendanceExport((await requireUser(ctx.req, ctx.res)).id, int(id), fmt(ctx)));
  route('GET', '/api/exports/transcript/(\\d+)', async (ctx, [id]) => svc.transcriptExport((await requireUser(ctx.req, ctx.res)).id, int(id), fmt(ctx)));
  route('GET', '/api/exports/sessions', async (ctx) => svc.sessionsExport((await requireUser(ctx.req, ctx.res)).id, fmt(ctx)));
  route('GET', '/api/host/analytics', async (ctx) => svc.analytics((await requireUser(ctx.req, ctx.res)).id, ctx.url.searchParams.get('days')));
};
