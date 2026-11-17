/**
 * Exports (Premium+): ?format=csv (default) or xlsx
 *   GET /api/exports/attendance/:historyId     GET /api/exports/transcript/:historyId     GET /api/exports/chat/:historyId
 * Range exports, all my sessions in ?days=7|30|90 or ?from=YYYY-MM-DD&to=YYYY-MM-DD (validated server-side):
 *   GET /api/exports/sessions   /api/exports/attendance   /api/exports/registrations   /api/exports/chat   /api/exports/transcripts
 *   GET /api/host/exports?days|from&to   row counts and the newest timestamp per export, plus the sessions in the range
 * Analytics (Premium+):
 *   GET /api/host/analytics?days=30 | ?from&to
 */
const svc = require('./service');
module.exports = function routes(route, { requireUser, int }) {
  const fmt = (ctx) => (ctx.url.searchParams.get('format') === 'xlsx' ? 'xlsx' : 'csv');
  const range = (ctx) => svc.parseRange(ctx.url.searchParams);
  const uid = async (ctx) => (await requireUser(ctx.req, ctx.res)).id;
  route('GET', '/api/exports/attendance/(\\d+)', async (ctx, [id]) => svc.attendanceExport(await uid(ctx), int(id), fmt(ctx)));
  route('GET', '/api/exports/transcript/(\\d+)', async (ctx, [id]) => svc.transcriptExport(await uid(ctx), int(id), fmt(ctx)));
  route('GET', '/api/exports/chat/(\\d+)', async (ctx, [id]) => svc.chatExport(await uid(ctx), int(id), fmt(ctx)));
  route('GET', '/api/exports/sessions', async (ctx) => { const u = await uid(ctx); return svc.sessionsExport(u, fmt(ctx), range(ctx)); });
  route('GET', '/api/exports/attendance', async (ctx) => { const u = await uid(ctx); return svc.attendanceRangeExport(u, fmt(ctx), range(ctx)); });
  route('GET', '/api/exports/registrations', async (ctx) => { const u = await uid(ctx); return svc.registrationsExport(u, fmt(ctx), range(ctx)); });
  route('GET', '/api/exports/chat', async (ctx) => { const u = await uid(ctx); return svc.chatRangeExport(u, fmt(ctx), range(ctx)); });
  route('GET', '/api/exports/transcripts', async (ctx) => { const u = await uid(ctx); return svc.transcriptsRangeExport(u, fmt(ctx), range(ctx)); });
  route('GET', '/api/host/exports', async (ctx) => { const u = await uid(ctx); return svc.exportSummary(u, range(ctx)); });
  route('GET', '/api/host/analytics', async (ctx) => { const u = await uid(ctx); return svc.analytics(u, ctx.url.searchParams); });
};
