/**
 * Materials: pre-loaded decks, attachable to events.
 * JSON API routes (see src/core/router.js for the route() contract).
 */
const log = require('../../lib/log');

module.exports = function routes(route, kit) {
  const { getAuthUser, data, httpError, requireUser, rateLimit, clientIp } = kit;

  // Browser-side failures in the materials / presenting flow (PDF render, PPTX convert, upload, save),
  // so prod logs show what happened in the browser: "[client] materials error {...}". Fire-and-forget.
  const AREAS = new Set(['materials', 'present', 'event-materials', 'upload']);
  const clip = (v, n) => (v == null ? undefined : String(v).replace(/[\u0000-\u001f]/g, ' ').slice(0, n));
  route('POST', '/api/client-log', async (ctx) => {
    const ip = clientIp(ctx.req);
    if (!rateLimit('client-log:' + ip, 30)) return { ok: true };
    let b = {};
    try { b = (await ctx.body(8 * 1024)) || {}; } catch (_) { return { ok: true }; }
    const u = await getAuthUser(ctx.req, ctx.res).catch(() => null);
    const area = AREAS.has(b.area) ? b.area : 'materials';
    log.warn('client', `${area} error`, {
      who: u ? `u:${u.id}` : `ip:${ip}`, step: clip(b.step, 40), message: clip(b.message, 300), status: Number(b.status) || undefined,
      file: clip(b.file, 120), mime: clip(b.mime, 80), size: Number(b.size) || undefined, pages: Number(b.pages) || undefined,
      page: clip(b.page, 60), ua: clip(ctx.req.headers['user-agent'], 120), build: clip(b.build, 40),
    });
    return { ok: true };
  });

  route('GET', '/api/market', async (ctx) => {
    const u = await getAuthUser(ctx.req, ctx.res);
    const s = ctx.url.searchParams;
    return data.listMarket(u && u.id, Object.fromEntries(s.entries()));
  });

  // ------------------------------------------------------------ materials (preload decks)
  route('GET', '/api/materials', async (ctx) => {
    const u = await requireUser(ctx.req, ctx.res);
    const filter = String(ctx.url.searchParams.get('filter') || '');
    if (filter === 'purchased') return { materials: await data.listPurchased(u.id) };
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
  // One material, for its own page (/materials/:id). Owner and organisation members can edit and analyse;
  // anyone may view a marketplace listing or a material attached to a public event.
  const mats = require('./data');
  async function viewable(ctx, id) {
    const u = await getAuthUser(ctx.req, ctx.res).catch(() => null);
    const v = await mats.viewableMaterial(Number(id), u && u.id);
    if (!v) throw httpError(u ? 404 : 401, u ? 'Material not found' : 'Sign in to open this material');
    return { u, ...v };
  }
  route('GET', '/api/materials/(\\d+)', async (ctx, [id]) => {
    const { material, canEdit } = await viewable(ctx, id);
    return { ...material, canEdit };
  });
  route('GET', '/api/materials/(\\d+)/preview', async (ctx, [id]) => {
    const { material } = await viewable(ctx, id);
    if (!['doc', 'sheet', 'pdf', 'pptx'].includes(material.kind) || !material.payload.sourceUrl) throw httpError(404, 'No preview for this material');
    return require('./analysis').preview(material);
  });
  route('GET', '/api/materials/(\\d+)/analysis', async (ctx, [id]) => {
    const { material } = await viewable(ctx, id);
    const a = await mats.getAnalysis(material.id);
    const fresh = a && a.sourceKey === require('./analysis').sourceKey(material);
    return { analysis: fresh ? a : null };
  });
  route('POST', '/api/materials/(\\d+)/analyse', async (ctx, [id]) => {
    const u = await requireUser(ctx.req, ctx.res);
    const m = await data.getMaterial(Number(id), u.id); // analysis spends points: owner / organisation only
    if (!m) throw httpError(404, 'Material not found');
    if (!rateLimit('mat-analyse:' + u.id, 6)) throw httpError(429, 'Please wait a minute before analysing again');
    const b = (await ctx.body().catch(() => ({}))) || {};
    try {
      const analysis = await require('./analysis').analyse(m, { userId: u.id, force: !!b.force, data: mats, takeAi: require('../../lib/plans').takeAi });
      return { analysis };
    } catch (e) {
      log[(e.status || 500) >= 500 ? 'error' : 'warn']('materials', 'analyse failed', { id: m.id, user: u.id, kind: m.kind, status: e.status || 500, error: e.message });
      throw e;
    }
  });
  // Follow-up questions about a file, beyond the first summary. Owner / organisation only (spends points).
  route('GET', '/api/materials/(\\d+)/questions', async (ctx, [id]) => {
    const u = await requireUser(ctx.req, ctx.res);
    const m = await data.getMaterial(Number(id), u.id);
    if (!m) throw httpError(404, 'Material not found');
    return { questions: await require('./analysis').listQueries(m.id) };
  });
  route('POST', '/api/materials/(\\d+)/questions', async (ctx, [id]) => {
    const u = await requireUser(ctx.req, ctx.res);
    const m = await data.getMaterial(Number(id), u.id);
    if (!m) throw httpError(404, 'Material not found');
    if (!rateLimit('mat-ask:' + u.id, 10)) throw httpError(429, 'Please wait a minute before asking again');
    const b = (await ctx.body(8 * 1024).catch(() => ({}))) || {};
    try {
      return { $status: 201, $body: { question: await require('./analysis').ask(m, { userId: u.id, question: b.question, takeAi: require('../../lib/plans').takeAi }) } };
    } catch (e) {
      log[(e.status || 500) >= 500 ? 'error' : 'warn']('materials', 'ask failed', { id: m.id, user: u.id, status: e.status || 500, error: e.message });
      throw e;
    }
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
    return { materials: await data.listEventMaterials(Number(id), u && u.id) };
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

  route('POST', '/api/materials/(\\d+)/sale', async (ctx, [id]) => {
    const u = await requireUser(ctx.req, ctx.res);
    const b = await ctx.body();
    const m = await data.updateMaterial(Number(id), u.id, {
      forSale: b.forSale, priceKobo: b.priceKobo, callDiscountPct: b.callDiscountPct, listed: b.listed, category: b.category,
    });
    if (!m) throw httpError(404, 'Material not found');
    return m;
  });
  route('POST', '/api/materials/(\\d+)/buy', async (ctx, [id]) => {
    const u = await requireUser(ctx.req, ctx.res);
    const b = await ctx.body();
    const row = await require('../../core/db').one('SELECT * FROM materials WHERE id=$1', [Number(id)]);
    if (!row) throw httpError(404, 'Material not found');
    const material = require("./data").materialOut(row);
    const sale = require('./sale');
    const method = b && b.method === 'paystack' ? 'paystack' : 'credits';
    const opts = { eventId: b && b.eventId, meetingCode: b && (b.meetingCode || b.code), returnPath: b && b.returnPath };
    if (method === 'paystack') return sale.startPaystack(u, material, opts);
    return sale.buyWithCredits(u, material, opts);
  });
  route('GET', '/api/materials/(\\d+)/quote', async (ctx, [id]) => {
    const u = await getAuthUser(ctx.req, ctx.res);
    const row = await require('../../core/db').one('SELECT * FROM materials WHERE id=$1', [Number(id)]);
    if (!row) throw httpError(404, 'Material not found');
    const q = ctx.url.searchParams || new URL(ctx.req.url, 'http://localhost').searchParams;
    return require('./sale').quote(require('./data').materialOut(row), { eventId: q.get('eventId'), meetingCode: q.get('meetingCode') || q.get('code'), userId: u && u.id });
  });
};
