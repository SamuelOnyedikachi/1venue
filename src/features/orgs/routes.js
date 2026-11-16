/**
 * Organisations.
 *   GET    /api/orgs                         my organisations (with my role)
 *   POST   /api/orgs           { name }      create (Organisation plan)
 *   GET    /api/orgs/:id                     members, invites, venues, library, my permissions
 *   PATCH  /api/orgs/:id       { name }      rename (owner)       DELETE /api/orgs/:id (owner)
 *   POST   /api/orgs/:id/invites { email, role }   DELETE /api/orgs/:id/invites/:inviteId
 *   POST   /api/orgs/invites/accept { token }
 *   PATCH  /api/orgs/:id/members/:userId { role }   DELETE /api/orgs/:id/members/:userId
 *   POST   /api/orgs/:id/venues { name, customSlug }   PUT/DELETE /api/orgs/:id/venues/:venueId (attach/detach own venue)
 *   PUT/DELETE /api/orgs/:id/materials/:materialId   share / unshare a material in the library
 */
const orgs = require('./service');

module.exports = function routes(route, { requireUser, httpError, rateLimit, int }) {
  route('GET', '/api/orgs', async (ctx) => ({ orgs: await orgs.mine((await requireUser(ctx.req, ctx.res)).id) }));
  route('POST', '/api/orgs', async (ctx) => { const u = await requireUser(ctx.req, ctx.res); return { $status: 201, $body: await orgs.create(u, (await ctx.body()).name) }; });
  route('POST', '/api/orgs/invites/accept', async (ctx) => {
    const u = await requireUser(ctx.req, ctx.res);
    if (!rateLimit('org-accept:' + u.id, 20)) throw httpError(429, 'Please wait a moment');
    return orgs.accept(u, String((await ctx.body()).token || ''));
  });
  route('GET', '/api/orgs/(\\d+)', async (ctx, [id]) => orgs.detail(int(id), (await requireUser(ctx.req, ctx.res)).id));
  route('PATCH', '/api/orgs/(\\d+)', async (ctx, [id]) => { const u = await requireUser(ctx.req, ctx.res); return orgs.rename(int(id), u.id, (await ctx.body()).name); });
  route('DELETE', '/api/orgs/(\\d+)', async (ctx, [id]) => orgs.remove(int(id), (await requireUser(ctx.req, ctx.res)).id));
  route('POST', '/api/orgs/(\\d+)/invites', async (ctx, [id]) => {
    const u = await requireUser(ctx.req, ctx.res);
    if (!rateLimit('org-invite:' + u.id, 20)) throw httpError(429, 'Please wait before sending more invites');
    return { $status: 201, $body: await orgs.invite(int(id), u, await ctx.body()) };
  });
  route('DELETE', '/api/orgs/(\\d+)/invites/(\\d+)', async (ctx, [id, inv]) => orgs.revokeInvite(int(id), (await requireUser(ctx.req, ctx.res)).id, int(inv)));
  route('PATCH', '/api/orgs/(\\d+)/members/(\\d+)', async (ctx, [id, uid]) => { const u = await requireUser(ctx.req, ctx.res); return orgs.setRole(int(id), u.id, int(uid), (await ctx.body()).role); });
  route('DELETE', '/api/orgs/(\\d+)/members/(\\d+)', async (ctx, [id, uid]) => orgs.removeMember(int(id), (await requireUser(ctx.req, ctx.res)).id, int(uid)));
  route('POST', '/api/orgs/(\\d+)/venues', async (ctx, [id]) => { const u = await requireUser(ctx.req, ctx.res); return { $status: 201, $body: await orgs.createVenue(int(id), u, await ctx.body()) }; });
  route('PUT', '/api/orgs/(\\d+)/venues/(\\d+)', async (ctx, [id, vid]) => orgs.attachVenue(int(id), (await requireUser(ctx.req, ctx.res)).id, int(vid), true));
  route('DELETE', '/api/orgs/(\\d+)/venues/(\\d+)', async (ctx, [id, vid]) => orgs.attachVenue(int(id), (await requireUser(ctx.req, ctx.res)).id, int(vid), false));
  route('PUT', '/api/orgs/(\\d+)/materials/(\\d+)', async (ctx, [id, mid]) => orgs.shareMaterial(int(id), (await requireUser(ctx.req, ctx.res)).id, int(mid), true));
  route('DELETE', '/api/orgs/(\\d+)/materials/(\\d+)', async (ctx, [id, mid]) => orgs.shareMaterial(int(id), (await requireUser(ctx.req, ctx.res)).id, int(mid), false));
};
