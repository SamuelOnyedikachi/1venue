module.exports = function routes(route, { requireUser, getAuthUser, httpError }) {
  const service = require('./service');
  const { certificatePdf } = require('./pdf');
  const { getMeeting } = require('../../rooms/store');

  route('GET', '/api/certs/([A-Z0-9]{10})', async (ctx, [code]) => {
    const c = await service.getByCode(code);
    if (!c) throw httpError(404, 'Certificate not found');
    return c;
  });
  route('GET', '/api/certs/([A-Z0-9]{10})/pdf', async (ctx, [code]) => {
    const c = await service.getByCode(code);
    if (!c) throw httpError(404, 'Certificate not found');
    const raw = service.pdfFor(c);
    return { raw, type: 'application/pdf', headers: { 'Content-Disposition': `inline; filename="certificate-${c.code}.pdf"`, 'Content-Length': String(raw.length) } };
  });
  route('GET', '/api/certs/preview', async (ctx) => {
    const u = await getAuthUser(ctx.req, ctx.res);
    const q = ctx.url.searchParams || new URL(ctx.req.url, 'http://localhost').searchParams;
    const design = q.get('design') || 'classic';
    const accent = q.get('accent') || '#2563eb';
    const name = (u && u.displayName) || 'Your name';
    const raw = certificatePdf({
      name, title: q.get('title') || 'Your event title', date: '1 January 2026',
      host: (u && u.displayName) || 'Host', code: 'PREVIEW000', url: 'https://1venue.live/cert/PREVIEW000',
      accent, design,
    });
    return { raw, type: 'application/pdf', headers: { 'Content-Disposition': 'inline; filename="certificate-preview.pdf"', 'Content-Length': String(raw.length) } };
  });
  route('POST', '/api/events/(\\d+)/certs', async (ctx, [id]) => {
    const u = await requireUser(ctx.req, ctx.res);
    const certs = await service.saveEventCerts(Number(id), u.id, await ctx.body());
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
    if (meeting.eventId) await service.saveEventCerts(meeting.eventId, u.id, certs).catch(() => {});
    return { certs };
  });
};
