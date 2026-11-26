module.exports = function routes(route, { requireUser, getAuthUser, httpError }) {
  const service = require('./service');
  const { getMeeting } = require('../../rooms/store');

  function pdfResponse(raw, filename, inline = true) {
    return {
      raw,
      type: 'application/pdf',
      headers: {
        'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename="${filename}"`,
        'Content-Length': String(raw.length),
        'Cache-Control': 'private, max-age=60',
      },
    };
  }

  async function maybePng(ctx, raw) {
    const q = ctx.url.searchParams || new URL(ctx.req.url, 'http://localhost').searchParams;
    const format = String(q.get('format') || '').toLowerCase();
    if (format !== 'png') return pdfResponse(raw, 'certificate.pdf');
    try {
      const { pdfToPng } = require('./pdf');
      const png = await pdfToPng(raw, { dpi: 130 });
      return {
        raw: png,
        type: 'image/png',
        headers: { 'Content-Disposition': 'inline; filename="certificate.png"', 'Content-Length': String(png.length), 'Cache-Control': 'private, max-age=30' },
      };
    } catch (e) {
      return pdfResponse(raw, 'certificate.pdf');
    }
  }

  route('GET', '/api/certs/catalogue', async () => service.catalogue());

  route('GET', '/api/certs/([A-Z0-9]{10})', async (ctx, [code]) => {
    const c = await service.getByCode(code);
    if (!c) throw httpError(404, 'Certificate not found');
    return c;
  });
  route('GET', '/api/certs/([A-Z0-9]{10})/pdf', async (ctx, [code]) => {
    const c = await service.getByCode(code);
    if (!c) throw httpError(404, 'Certificate not found');
    const raw = await service.pdfFor(c);
    const q = ctx.url.searchParams || new URL(ctx.req.url, 'http://localhost').searchParams;
    const inline = q.get('download') !== '1';
    if (String(q.get('format') || '').toLowerCase() === 'png') return maybePng(ctx, raw);
    return pdfResponse(raw, `certificate-${c.code}.pdf`, inline);
  });

  async function previewFrom(ctx, settings) {
    const u = await getAuthUser(ctx.req, ctx.res);
    const name = settings.name || (u && (u.displayName || u.display_name)) || 'Alex Okonkwo';
    const raw = await service.previewPdf({
      ...settings,
      hostName: settings.hostName || settings.issuerName || (u && (u.displayName || u.display_name)) || 'Host',
      eventTitle: settings.eventTitle || settings.programme || settings.title || 'Your event title',
    }, { name });
    return maybePng(ctx, raw);
  }

  route('GET', '/api/certs/preview', async (ctx) => {
    const q = ctx.url.searchParams || new URL(ctx.req.url, 'http://localhost').searchParams;
    return previewFrom(ctx, {
      design: q.get('design') || 'classic',
      accent: q.get('accent') || '#2563eb',
      title: q.get('title') || undefined,
      programme: q.get('programme') || q.get('title') || undefined,
      eventTitle: q.get('title') || undefined,
    });
  });

  route('POST', '/api/certs/preview', async (ctx) => {
    await requireUser(ctx.req, ctx.res);
    const body = await ctx.body().catch(() => ({}));
    return previewFrom(ctx, body || {});
  });

  route('POST', '/api/events/(\\d+)/certs', async (ctx, [id]) => {
    const u = await requireUser(ctx.req, ctx.res);
    const certs = await service.saveEventCerts(Number(id), u, await ctx.body());
    if (!certs) throw httpError(404, 'Event not found');
    return { certs };
  });
  route('POST', '/api/rooms/([A-Za-z0-9]+)/certs', async (ctx, [code]) => {
    const u = await requireUser(ctx.req, ctx.res);
    const meeting = getMeeting(String(code).toUpperCase());
    if (!meeting) throw httpError(404, 'Meeting not found');
    if (!service.isLiveManager(meeting, u.id)) throw httpError(403, 'Only the host or a co-host can change certificates');
    const certs = service.applyToMeeting(meeting, await ctx.body());
    if (meeting.historyId) await service.persistHistoryCerts(meeting.historyId, certs).catch(() => null);
    if (meeting.eventId) {
      const saved = await service.saveEventCerts(meeting.eventId, u, certs).catch(() => null);
      if (saved) meeting.settings.certs = saved;
      return { certs: saved || certs };
    }
    return { certs };
  });

  async function sessionManage(ctx, id) {
    const u = await requireUser(ctx.req, ctx.res);
    const history = await require('../sessions/data').getHistory(Number(id));
    if (!history) throw httpError(404, 'Session not found');
    const meeting = getMeeting(String(history.code).toUpperCase());
    if (!await service.canManageHistory(history, u, meeting)) throw httpError(403, 'Only the host or a co-host can manage certificates');
    return { u, history, meeting };
  }

  route('GET', '/api/sessions/(\\d+)/certs', async (ctx, [id]) => {
    const { history, meeting } = await sessionManage(ctx, id);
    const ev = history.event_id ? await require('../../core/db').one('SELECT settings FROM events WHERE id=$1', [history.event_id]).catch(() => null) : null;
    let evCerts = null;
    try { evCerts = ev && ev.settings && (typeof ev.settings === 'object' ? ev.settings.certs : JSON.parse(ev.settings).certs); } catch { evCerts = null; }
    const histCerts = (() => { try { const s = history.settings && (typeof history.settings === 'object' ? history.settings : JSON.parse(history.settings)); return s && s.certs; } catch { return null; } })();
    const live = meeting && meeting.settings && meeting.settings.certs;
    return {
      certs: service.normalizeCerts(live || histCerts || evCerts || {}),
      issued: await service.listForHistory(history.id),
      live: !!(meeting && meeting.historyId === history.id),
    };
  });

  route('POST', '/api/sessions/(\\d+)/certs', async (ctx, [id]) => {
    const { history, meeting } = await sessionManage(ctx, id);
    const certs = await service.saveHistoryCerts(history, await ctx.body(), meeting);
    return { certs };
  });

  route('POST', '/api/sessions/(\\d+)/certs/issue', async (ctx, [id]) => {
    const { history, meeting } = await sessionManage(ctx, id);
    const issued = await service.issueForHistory(history.id, { meeting });
    return { issued, count: issued.length };
  });

  route('POST', '/api/sessions/(\\d+)/certs/manual', async (ctx, [id]) => {
    const { history, meeting } = await sessionManage(ctx, id);
    const issued = await service.issueManual(history.id, await ctx.body(), { meeting });
    if (!issued.length) throw httpError(400, 'Add at least one participant name');
    return { issued, count: issued.length };
  });

  route('GET', '/api/users/([\\w.-]+)/certs', async (ctx, [idOrName]) => {
    const me = await getAuthUser(ctx.req, ctx.res);
    let userId = Number(idOrName);
    if (!Number.isFinite(userId)) {
      const row = await require('../../core/db').one('SELECT id FROM users WHERE LOWER(username)=LOWER($1)', [idOrName]).catch(() => null);
      if (!row) throw httpError(404, 'User not found');
      userId = Number(row.id);
    }
    const mine = !!(me && Number(me.id) === userId);
    const certs = await service.listForUser(userId, { includePrivate: mine });
    return { certs, isMe: mine };
  });

  route('PATCH', '/api/certs/([A-Z0-9]{10})/visibility', async (ctx, [code]) => {
    const u = await requireUser(ctx.req, ctx.res);
    const body = await ctx.body().catch(() => ({}));
    const cert = await service.setPublic(code, u, body && (body.isPublic ?? body.public));
    if (cert === null) throw httpError(404, 'Certificate not found');
    if (cert === false) throw httpError(403, 'You can only change visibility on your own certificates');
    return { cert };
  });
};

