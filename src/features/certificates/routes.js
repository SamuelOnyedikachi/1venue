module.exports = function routes(route, { requireUser, getAuthUser, httpError, readRaw }) {
  const service = require('./service');
  const { certificatePdf, pdfToPng } = require('./pdf');
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

  route('GET', '/api/certs/lookup', async (ctx) => {
    await requireUser(ctx.req, ctx.res);
    const q = ctx.url.searchParams || new URL(ctx.req.url, 'http://localhost').searchParams;
    const u = await service.lookupUsername(q.get('username') || '');
    if (!u) throw httpError(404, 'No 1venue account with that username');
    return { id: Number(u.id), username: u.username, displayName: u.display_name, avatarUrl: u.avatar_url };
  });

  route('GET', '/api/me/signature', async (ctx) => {
    const u = await requireUser(ctx.req, ctx.res);
    const s = await service.getUserSignature(u.id);
    return { signature: s };
  });

  route('POST', '/api/me/signature', async (ctx) => {
    const u = await requireUser(ctx.req, ctx.res);
    const body = await ctx.body().catch(() => ({}));
    let input = body && (body.dataUrl || body.image || body.url);
    if (!input && ctx.req.headers['content-type'] && String(ctx.req.headers['content-type']).startsWith('image/') && readRaw) {
      input = await readRaw(ctx.req, service.signatures.MAX_BYTES);
    }
    if (!input) throw httpError(400, 'Send a signature image');
    const stored = await service.signatures.cleanAndStore(input, { ownerUserId: u.id });
    await service.saveUserSignature(u.id, stored.url);
    return { url: stored.url, width: stored.width, height: stored.height, dataUrl: stored.dataUrl };
  });

  route('POST', '/api/certs/signature/clean', async (ctx) => {
    const u = await requireUser(ctx.req, ctx.res);
    const ct = String(ctx.req.headers['content-type'] || '');
    let input = null;
    if (ct.startsWith('image/') && readRaw) {
      input = await readRaw(ctx.req, service.signatures.MAX_BYTES);
    } else {
      const body = await ctx.body().catch(() => ({}));
      input = body && (body.dataUrl || body.image);
    }
    if (!input) throw httpError(400, 'Send a signature image');
    const stored = await service.signatures.cleanAndStore(input, { ownerUserId: u.id });
    return { url: stored.url, width: stored.width, height: stored.height, dataUrl: stored.dataUrl };
  });

  route('GET', '/api/certs/sign/([A-Za-z0-9_-]+)', async (ctx, [token]) => {
    const req = await service.getSignRequest(token);
    if (!req) throw httpError(404, 'This signature link is not valid');
    const viewer = await getAuthUser(ctx.req, ctx.res);
    return { request: req, viewerId: viewer ? Number(viewer.id) : null };
  });

  route('POST', '/api/certs/sign/([A-Za-z0-9_-]+)', async (ctx, [token]) => {
    const req = await service.getSignRequest(token);
    if (!req) throw httpError(404, 'This signature link is not valid');
    const viewer = await getAuthUser(ctx.req, ctx.res);
    if (viewer && Number(viewer.id) !== Number(req.userId)) {
      throw httpError(403, 'This invitation belongs to a different 1venue account');
    }
    const body = await ctx.body().catch(() => ({}));
    let url = null;
    if (body && body.useSaved) {
      url = req.savedSignatureUrl;
      if (!url) throw httpError(400, 'You do not have a saved signature yet');
    } else if (body && (body.dataUrl || body.image)) {
      const stored = await service.signatures.cleanAndStore(body.dataUrl || body.image, { ownerUserId: req.userId });
      url = stored.url;
    } else if (body && body.typed) {
      // Typed fallback: no image; PDF will render the name in a script font.
      url = null;
      await service.applySignedUrl(req, '', { saveToProfile: false });
      return { request: await service.getSignRequest(token), typed: true };
    } else {
      throw httpError(400, 'Draw a signature, use your saved one, or confirm a typed name');
    }
    const updated = await service.applySignedUrl(req, url, { saveToProfile: body.saveToProfile !== false });
    return { request: updated };
  });

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
    const u = await requireUser(ctx.req, ctx.res);
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
    const body = await ctx.body();
    const certs = service.applyToMeeting(meeting, body);
    if (meeting.eventId) {
      try {
        const saved = await service.saveEventCerts(meeting.eventId, u, certs);
        if (saved) meeting.settings.certs = saved;
        return { certs: saved || certs };
      } catch (e) {
        if (e.status) throw e;
      }
    } else if (certs && certs.signatories && certs.signatories.some((s) => s.source === 'account')) {
      certs.signatories = await service.ensureSignatories(certs.signatories, { eventId: null, host: u, eventTitle: meeting.name || meeting.title });
      meeting.settings.certs = certs;
    }
    return { certs };
  });
};
