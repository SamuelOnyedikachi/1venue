/**
 * Promoted events / posts.
 *   GET    /api/promotions?placement=discover        up to 3 live promotions (public)
 *   POST   /api/promotions/seen  { ids }             count views (cards actually scrolled into view)
 *   POST   /api/promotions/(id)/click                count a click
 *   GET    /api/admin/promotions?q&status&type&from&to&limit&offset   admin list with stats (+ total)
 *   GET    /api/admin/promotions/export.csv?q&status&type&from&to      every matching row as CSV (streamed)
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
    const limit = Math.min(3, int(ctx.url.searchParams.get('limit'), placement === 'profile' ? 2 : 3));
    const profileUserId = int(ctx.url.searchParams.get('profileUserId'), 0);
    const items = placement === 'profile' && profileUserId
      ? await promos.liveForProfile(profileUserId, { limit, viewerId: u && u.id })
      : await promos.live(placement, { limit, viewerId: u && u.id });
    return { items };
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

  route('GET', '/api/admin/promotions', async (ctx) => {
    await admin(ctx);
    const sp = ctx.url.searchParams;
    if (!['q', 'status', 'type', 'from', 'to', 'limit', 'offset'].some((k) => sp.has(k))) return { promotions: await promos.list(), placements: promos.PLACEMENTS };
    const page = await promos.adminList(promos.adminFilters(sp), { limit: int(sp.get('limit'), 5), offset: int(sp.get('offset'), 0) });
    return { ...page, placements: promos.PLACEMENTS, statuses: promos.STATUSES };
  });
  route('GET', '/api/admin/promotions/export\\.csv', async (ctx) => {
    await admin(ctx);
    const f = promos.adminFilters(ctx.url.searchParams);
    const res = ctx.res;
    const cell = (v) => {
      if (v == null) return '';
      let t = v instanceof Date ? v.toISOString() : String(v);
      if (typeof v === 'string' && /^[=+\-@\t\r]/.test(t)) t = "'" + t; // no spreadsheet formulas
      return /[",\n\r]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
    };
    const line = (cells) => cells.map(cell).join(',') + '\r\n';
    const places = (v) => { if (typeof v === 'string') { try { v = JSON.parse(v); } catch { v = v.replace(/[{}]/g, '').split(','); } } return (Array.isArray(v) ? v : []).join(' '); };
    const iso = (d) => (d ? new Date(d).toISOString() : '');
    res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="promotions-${new Date().toISOString().slice(0, 10)}.csv"`, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    const write = (chunk) => (res.write(chunk) ? null : new Promise((r) => res.once('drain', r)));
    await write('\uFEFF' + line(['id', 'type', 'title', 'host_or_author', 'status', 'review', 'placements', 'starts_at', 'ends_at', 'views', 'clicks', 'ctr_percent', 'weight', 'self_serve', 'created_at']));
    for await (const p of promos.adminRows(f)) {
      if (res.destroyed) break;
      const ctr = p.views ? ((p.clicks / p.views) * 100).toFixed(1) : '';
      const pending = write(line([p.id, p.type, p.target.title || '(deleted)', p.target.host || p.target.author || '', p.state, p.review, places(p.placements), iso(p.startsAt), iso(p.endsAt), p.views, p.clicks, ctr, p.weight, p.selfServe ? 'yes' : 'no', iso(p.createdAt)]));
      if (pending) await pending;
    }
    res.end();
    return { $handled: true };
  });
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
