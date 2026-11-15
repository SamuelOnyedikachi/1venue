/**
 * Promoted events / posts.
 *   GET    /api/promotions?placement=discover        up to 3 live promotions (public)
 *   POST   /api/promotions/seen  { ids }             count views (cards actually scrolled into view)
 *   POST   /api/promotions/(id)/click                count a click
 *   GET    /api/admin/promotions                     admin list with stats
 *   GET    /api/admin/promotions/candidates?type&q   admin picker
 *   POST   /api/admin/promotions                     { type, targetId, placements, startsAt, endsAt, weight }
 *   PATCH  /api/admin/promotions/(id)                { active, placements, startsAt, endsAt, weight }
 *   DELETE /api/admin/promotions/(id)
 */
const promos = require('./data');

module.exports = function routes(route, kit) {
  const { getAuthUser, requireUser, httpError, rateLimit, clientIp, int } = kit;
  const admin = async (ctx) => {
    const u = await requireUser(ctx.req, ctx.res);
    if (!u.isAdmin) throw httpError(403, 'Admins only. Add your email to ADMIN_EMAILS and confirm it.');
    return u;
  };

  route('GET', '/api/promotions', async (ctx) => {
    const placement = String(ctx.url.searchParams.get('placement') || '').toLowerCase();
    if (!promos.PLACEMENTS.includes(placement)) throw httpError(400, 'Unknown placement');
    const u = await getAuthUser(ctx.req, ctx.res);
    return { items: await promos.live(placement, { limit: Math.min(3, int(ctx.url.searchParams.get('limit'), 3)), viewerId: u && u.id }) };
  });
  route('POST', '/api/promotions/seen', async (ctx) => {
    if (!rateLimit(`promo-seen:${clientIp(ctx.req)}`, 30)) return { ok: true, counted: 0 };
    const b = await ctx.body(8 * 1024);
    return { ok: true, counted: await promos.countViews(Array.isArray(b.ids) ? b.ids : []) };
  });
  route('POST', '/api/promotions/(\\d+)/click', async (ctx, [id]) => {
    if (!rateLimit(`promo-click:${clientIp(ctx.req)}`, 20)) return { ok: true };
    return { ok: await promos.countClick(Number(id)) };
  });

  route('GET', '/api/admin/promotions', async (ctx) => { await admin(ctx); return { promotions: await promos.list(), placements: promos.PLACEMENTS }; });
  route('GET', '/api/admin/promotions/candidates', async (ctx) => {
    await admin(ctx);
    const s = ctx.url.searchParams;
    return { items: await promos.candidates(s.get('type') === 'post' ? 'post' : 'event', s.get('q')) };
  });
  route('POST', '/api/admin/promotions', async (ctx) => { const u = await admin(ctx); return { $status: 201, $body: await promos.create(u.id, await ctx.body()) }; });
  route('PATCH', '/api/admin/promotions/(\\d+)', async (ctx, [id]) => {
    await admin(ctx);
    const r = await promos.update(Number(id), await ctx.body());
    if (!r) throw httpError(404, 'Promotion not found');
    return r;
  });
  route('DELETE', '/api/admin/promotions/(\\d+)', async (ctx, [id]) => {
    await admin(ctx);
    if (!(await promos.remove(Number(id)))) throw httpError(404, 'Promotion not found');
    return { ok: true };
  });
};
