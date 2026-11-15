/**
 * Uploads (POST /api/files).
 * JSON API routes (see src/core/router.js for the route() contract).
 * Every step is logged as "[upload] …" so a failed upload always leaves a reason in the runtime log.
 */
const log = require('../../lib/log');

module.exports = function routes(route, kit) {
  const { readRaw, clientIp, getAuthUser, can, data, storage, httpError, roomParticipant } = kit;

  // ------------------------------------------------------------ files
  route('POST', '/api/files', async (ctx) => {
    const uploads = require('../../venue/uploads');
    const t0 = Date.now();
    const mime = String(ctx.req.headers['content-type'] || 'application/octet-stream').split(';')[0].trim().toLowerCase();
    const purpose = uploads.normalizePurpose(ctx.url.searchParams.get('purpose'));
    const declared = Number(ctx.req.headers['content-length']) || 0;
    let filename = 'upload';
    try { filename = decodeURIComponent(String(ctx.req.headers['x-file-name'] || 'upload')); } catch (_) { filename = String(ctx.req.headers['x-file-name'] || 'upload'); }
    const f = { purpose, mime, declared, name: filename.slice(0, 80) };
    try {
      const u = await getAuthUser(ctx.req, ctx.res);
      const rp = roomParticipant(ctx.req);
      f.who = u ? `u:${u.id}` : rp ? `room:${rp.code}:${rp.participant.id}` : 'anon';
      log.info('upload', 'received', f);
      if (!u && !rp) throw httpError(401, 'Sign in or join a room to upload');
      const ownerKey = !u && rp ? `p:${rp.participant.id}` : null;
      // Decks (PDF pages / image sets) send many images at once: presenters in a room, and signed-in
      // users building a material, get the content batch limit instead of the 12/min default.
      const contentBatch = purpose === 'content' && (rp ? can(rp.meeting, rp.participant, 'screenShare') : !!u);
      const max = uploads.precheck({ contentBatch, mime, declaredSize: declared, rateKey: u ? `u:${u.id}` : `ip:${clientIp(ctx.req)}` });
      let buf;
      try { buf = await readRaw(ctx.req, max); } catch (e) { if (e.status === 413) throw httpError(413, `That file is too big (max ${uploads.fmtMB(max)})`); throw e; }
      if (!buf.length) throw httpError(400, 'The file is empty');
      const roomCode = rp ? rp.code : null;
      await uploads.quota(data, { size: buf.length, userId: u && u.id, ownerKey, roomCode });
      const rec = await storage().save(buf, { filename, mime, ownerUserId: u && u.id, ownerKey, roomCode, purpose });
      log.info('upload', 'ok', { ...f, id: rec.id, driver: rec.driver, bytes: rec.size, url: rec.url, ms: Date.now() - t0 });
      return { id: rec.id, url: rec.url, filename: rec.filename, mime: rec.mime, size: rec.size };
    } catch (e) {
      const status = e.status || 500;
      log[status >= 500 ? 'error' : 'warn']('upload', 'failed', { ...f, status, error: e.message, step: e.step, ms: Date.now() - t0 });
      throw e;
    }
  });
};
