/**
 * Host end of a live or orphaned meeting, participant keep-alive, and admin
 * open-meetings list plus the 2-minute end warning.
 */
const endControl = require('../../rooms/end-control');

module.exports = function routes(route, kit) {
  const { requireUser, httpError, getAuthUser, roomParticipant, int } = kit;

  async function requireAdmin(ctx) {
    const u = await requireUser(ctx.req, ctx.res);
    if (!u.isAdmin) throw httpError(403, 'Admins only. Add your email to ADMIN_EMAILS and confirm it.');
    return u;
  }

  route('POST', '/api/meeting/([A-Za-z0-9-]+)/end', async (ctx, [code]) => {
    const u = await requireUser(ctx.req, ctx.res);
    return endControl.endByHost(code, u);
  });

  route('POST', '/api/sessions/(\\d+)/end', async (ctx, [id]) => {
    const u = await requireUser(ctx.req, ctx.res);
    return endControl.endByHost(null, u, { historyId: int(id) });
  });

  route('POST', '/api/meeting/([A-Za-z0-9-]+)/keep', async (ctx, [code]) => {
    const u = await getAuthUser(ctx.req, ctx.res);
    const rp = roomParticipant(ctx.req, code);
    if (!u && !rp) throw httpError(401, 'Join the meeting to keep it live');
    return endControl.keepAlive(code, { user: u, participant: rp && rp.participant, meeting: rp && rp.meeting });
  });

  route('GET', '/api/admin/meetings', async (ctx) => {
    await requireAdmin(ctx);
    return { meetings: await endControl.listOpen() };
  });

  route('POST', '/api/admin/meetings/([A-Za-z0-9-]+)/end-in', async (ctx, [code]) => {
    const admin = await requireAdmin(ctx);
    const body = await ctx.body().catch(() => ({})) || {};
    return endControl.scheduleEndIn(code, { admin, ms: body.ms });
  });

  route('POST', '/api/admin/meetings/([A-Za-z0-9-]+)/cancel-end', async (ctx, [code]) => {
    await requireAdmin(ctx);
    return endControl.cancelEnd(code);
  });
};
