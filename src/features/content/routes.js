/**
 * Content: convert PPTX decks to slide images (room presenters or signed-in users).
 * JSON API routes (see src/core/router.js for the route() contract).
 */
const log = require('../../lib/log');

module.exports = function routes(route, kit) {
  const { readRaw, rateLimit, getAuthUser, can, httpError, roomParticipant } = kit;

  // Convert office decks without blocking room signalling. Room credentials also support guest presenters.
  // Say once at boot whether PPTX conversion can work here (LibreOffice + poppler in the image).
  if (process.env.NODE_ENV !== 'test') setTimeout(() => {
    const { execFile } = require('node:child_process');
    const probe = (bin, args) => new Promise((r) => execFile(bin, args, { timeout: 20000 }, (err, so, se) => r(err ? null : String(so || se).split('\n')[0].trim())));
    Promise.all([probe('soffice', ['--version']).then((v) => v || probe('libreoffice', ['--version'])), probe('pdftoppm', ['-v'])]).then(([lo, pp]) => {
      if (lo && pp) log.info('pptx', 'converter ready', { libreoffice: lo.slice(0, 60), poppler: pp.slice(0, 40) });
      else log.warn('pptx', 'converter MISSING: PPTX uploads will fail', { libreoffice: lo || 'not found', poppler: pp || 'not found', fix: 'build with the repo Dockerfile (installs libreoffice-impress-nogui + poppler-utils)' });
    });
  }, 3000).unref();

  // Convert office decks without blocking room signalling. Room credentials also support guest presenters.
  route('POST', '/api/convert/pptx', async (ctx) => {
    const t0 = Date.now();
    const f = { bytes: Number(ctx.req.headers['content-length']) || 0, mime: String(ctx.req.headers['content-type'] || '').split(';')[0].toLowerCase(), title: String(ctx.url.searchParams.get('title') || '').slice(0, 80) };
    log.info('pptx', 'received', f); // very first thing, before auth / limits, so every attempt is visible
    try {
      const rp = roomParticipant(ctx.req);
      const u = rp ? null : await getAuthUser(ctx.req, ctx.res);
      f.who = rp ? `room:${rp.code}:${rp.participant.id}` : u ? `user:${u.id}` : 'anon';
      if (!rp && !u) throw httpError(401, 'Sign in or join a meeting to present');
      if (rp && !can(rp.meeting, rp.participant, 'screenShare')) throw httpError(403, 'The host controls who can present');
      if (!rateLimit('pptx:' + f.who, 4)) throw httpError(429, 'Please wait a minute before converting another deck');
      const converter = require('../../venue/pptx');
      if (!converter.MIMES.has(f.mime)) throw httpError(415, 'Choose a PPTX presentation');
      if (f.bytes > converter.MAX_BYTES) throw httpError(413, 'PPTX must be 50 MB or smaller');
      const buf = await readRaw(ctx.req, converter.MAX_BYTES);
      if (!buf.length) throw httpError(400, 'The file is empty');
      const title = (f.title.trim() || 'Slides').slice(0, 80);
      const out = await converter.convertPptxToSlides(buf, {
        ownerUserId: u ? u.id : null,
        ownerKey: rp ? `room:${rp.code}:${rp.participant.id}` : null,
        roomCode: rp ? rp.code : null,
        title,
      });
      log.info('pptx', 'ok', { who: f.who, pages: out.pages.length, total: out.total, ms: Date.now() - t0 });
      return { contentType: 'slides', pages: out.pages, title: out.title, total: out.total, truncated: out.truncated };
    } catch (e) {
      const status = e.status || 500;
      log[status >= 500 ? 'error' : 'warn']('pptx', 'failed', { ...f, status, error: e.message, ms: Date.now() - t0 });
      throw e;
    }
  });
};
