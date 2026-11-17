/**
 * Branding and verified badge.
 *   PUT  /api/branding/venues/:slug  { logoUrl, coverUrl, accent, accent2, about }   owner or org admin, Premium+
 *   GET  /api/admin/verified                     verified hosts
 *   POST /api/admin/verified/:userId { verified, note }   grant / revoke (admin)
 */
const svc = require('./service');

module.exports = function routes(route, { requireUser, httpError, data, int }) {
  route('PUT', '/api/branding/venues/([A-Za-z0-9]{3,16}(?:-venue)?)', async (ctx, [slug]) => {
    const u = await requireUser(ctx.req, ctx.res);
    const v = await data.getVenueBySlug(slug.toLowerCase());
    const out = await svc.saveBranding(u, v, await ctx.body(16 * 1024));
    return { slug: out.slug, brand: out.brand };
  });
  const admin = async (ctx) => { const u = await requireUser(ctx.req, ctx.res); if (!u.isAdmin) throw httpError(403, 'Admins only'); return u; };
  route('GET', '/api/admin/verified', async (ctx) => { await admin(ctx); return { users: await svc.listVerified() }; });
  route('POST', '/api/admin/verified/(\\d+)', async (ctx, [id]) => {
    const u = await admin(ctx);
    const b = await ctx.body();
    return svc.setVerified(u.id, int(id), b.verified !== false, b.note);
  });
};
