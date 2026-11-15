/**
 * Materials: pre-loaded decks, attachable to events.
 * JSON API routes (see src/core/router.js for the route() contract).
 */
const log = require('../../lib/log');

module.exports = function routes(route, kit) {
  const { getAuthUser, data, httpError, requireUser } = kit;

  // ------------------------------------------------------------ materials (preload decks)
  route('GET', '/api/materials', async (ctx) => {
    const u = await requireUser(ctx.req, ctx.res);
    return { materials: await data.listMaterials(u.id) };
  });
  route('POST', '/api/materials', async (ctx) => {
    const u = await requireUser(ctx.req, ctx.res);
    const b = await ctx.body();
    const pl = (b && b.payload) || {};
    const f = { user: u.id, kind: b && b.kind, pages: Array.isArray(pl.pages) ? pl.pages.length : undefined, url: pl.url ? String(pl.url).slice(0, 160) : undefined, firstPage: Array.isArray(pl.pages) && pl.pages[0] ? String(pl.pages[0]).slice(0, 160) : undefined };
    log.info('materials', 'create received', f);
    try {
      const m = await data.createMaterial(u.id, b);
      log.info('materials', 'created', { user: u.id, id: m.id, kind: m.kind, pages: m.payload.pages ? m.payload.pages.length : undefined });
      return m;
    } catch (e) {
      log[(e.status || 500) >= 500 ? 'error' : 'warn']('materials', 'create failed', { ...f, status: e.status || 500, error: e.message, reason: e.reason });
      throw e;
    }
  });
  route('GET', '/api/materials/(\\d+)', async (ctx, [id]) => {
    const u = await requireUser(ctx.req, ctx.res);
    const m = await data.getMaterial(Number(id), u.id);
    if (!m) throw httpError(404, 'Material not found');
    return m;
  });
  route('PATCH', '/api/materials/(\\d+)', async (ctx, [id]) => {
    const u = await requireUser(ctx.req, ctx.res);
    const m = await data.updateMaterial(Number(id), u.id, await ctx.body());
    if (!m) throw httpError(404, 'Material not found');
    return m;
  });
  route('DELETE', '/api/materials/(\\d+)', async (ctx, [id]) => {
    const u = await requireUser(ctx.req, ctx.res);
    if (!(await data.deleteMaterial(Number(id), u.id))) throw httpError(404, 'Material not found');
    return { ok: true };
  });
  route('GET', '/api/events/(\\d+)/materials', async (ctx, [id]) => {
    const u = await getAuthUser(ctx.req, ctx.res);
    const ev = await data.getEventById(Number(id), u?.id);
    if (!ev) throw httpError(404, 'Event not found');
    const isHost = !!(u && ev.host && u.id === ev.host.id);
    const isPrivate = ev.visibility === 'private' || ev.visibility === 'unlisted';
    if (isPrivate && !isHost) throw httpError(403, 'Only the host can see materials for a private event');
    return { materials: await data.listEventMaterials(Number(id)) };
  });
  route('PUT', '/api/events/(\\d+)/materials', async (ctx, [id]) => {
    const u = await requireUser(ctx.req, ctx.res);
    const b = await ctx.body();
    try {
      const materials = await data.setEventMaterials(Number(id), u.id, b.materialIds || b.ids || []);
      log.info('materials', 'event attached', { user: u.id, event: Number(id), count: materials.length });
      return { materials };
    } catch (e) {
      log.warn('materials', 'event attach failed', { user: u.id, event: Number(id), status: e.status || 500, error: e.message });
      throw e;
    }
  });
};
