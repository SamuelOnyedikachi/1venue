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
    const people = meeting.participants ? [...meeting.participants.values()] : [];
    const host = people.find((p) => p.role === 'host');
    if (!host || Number(host.userId) !== Number(u.id)) throw httpError(403, 'Only the host can change certificates');
    const certs = service.applyToMeeting(meeting, await ctx.body());
    if (meeting.eventId) {
      const saved = await service.saveEventCerts(meeting.eventId, u, certs).catch(() => null);
      if (saved) meeting.settings.certs = saved;
      return { certs: saved || certs };
    }
    return { certs };
  });
};
