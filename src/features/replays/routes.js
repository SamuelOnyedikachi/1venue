/**
 * Replays.
 *   GET    /api/replays/mine                      my replays, storage used, whether egress is set up
 *   POST   /api/replays/egress  { code, title }   start cloud recording of a live room (host / venue manager)
 *   POST   /api/replays/:id/stop                   stop it (egress finishes the upload; the worker marks it ready)
 *   POST   /api/replays/upload?eventId|historyId&title&visibility   raw video body (fallback when egress is off)
 *   POST   /api/replays/link { url, eventId|historyId, title, visibility }
 *   GET    /api/replays/:id                        replay page data (access-checked)
 *   PATCH  /api/replays/:id { title, visibility }  DELETE /api/replays/:id
 *   GET    /api/events/:id/replays                 public replays for an event
 * Media: GET /replays/:id/media (src/features/replays/http.js)
 */
const svc = require('./service');
module.exports = function routes(route, { requireUser, getAuthUser, httpError, rateLimit, int }) {
  route('GET', '/api/replays/mine', async (ctx) => svc.mine((await requireUser(ctx.req, ctx.res)).id));
  route('POST', '/api/replays/egress', async (ctx) => {
    const u = await requireUser(ctx.req, ctx.res);
    if (!rateLimit('replay-egress:' + u.id, 6)) throw httpError(429, 'Please wait a moment');
    const b = await ctx.body();
    return { $status: 201, $body: await svc.startEgress(u, b.code, b) };
  });
  route('POST', '/api/replays/(\\d+)/stop', async (ctx, [id]) => svc.stopEgress(await requireUser(ctx.req, ctx.res), int(id)));
  route('POST', '/api/replays/upload', async (ctx) => {
    const u = await requireUser(ctx.req, ctx.res);
    if (!rateLimit('replay-upload:' + u.id, 4)) throw httpError(429, 'Please wait before uploading again');
    return { $status: 201, $body: await svc.upload(u, ctx.req, ctx.url.searchParams) };
  });
  route('POST', '/api/replays/link', async (ctx) => { const u = await requireUser(ctx.req, ctx.res); return { $status: 201, $body: await svc.addLink(u, await ctx.body()) }; });
  route('GET', '/api/replays/(\\d+)', async (ctx, [id]) => svc.getPublic(int(id), await getAuthUser(ctx.req, ctx.res)));
  route('PATCH', '/api/replays/(\\d+)', async (ctx, [id]) => svc.update(await requireUser(ctx.req, ctx.res), int(id), await ctx.body()));
  route('DELETE', '/api/replays/(\\d+)', async (ctx, [id]) => svc.remove(await requireUser(ctx.req, ctx.res), int(id)));
  route('GET', '/api/events/(\\d+)/replays', async (ctx, [id]) => ({ replays: await svc.forEvent(int(id), await getAuthUser(ctx.req, ctx.res)) }));
};
