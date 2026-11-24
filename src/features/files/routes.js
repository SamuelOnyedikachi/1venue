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
    let mime = String(ctx.req.headers['content-type'] || 'application/octet-stream').split(';')[0].trim().toLowerCase();
    const purpose = uploads.normalizePurpose(ctx.url.searchParams.get('purpose'));
    const declared = Number(ctx.req.headers['content-length']) || 0;
    let filename = 'upload';
    try { filename = decodeURIComponent(String(ctx.req.headers['x-file-name'] || 'upload')); } catch (_) { filename = String(ctx.req.headers['x-file-name'] || 'upload'); }
    const mwb = require('../../lib/mwb');
    const board = mwb.looksMwb({ name: filename, mime }); // 1venue whiteboard file: browsers send no MIME for .mwb
    if (board) mime = mwb.MWB_MIME;
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
      if (board) { // sniff: the name says whiteboard, so the bytes must be one
        const info = mwb.sniffMwb(buf);
        if (!info) throw httpError(415, 'That .mwb file isn’t a 1venue whiteboard (it may be damaged)');
        if (!mwb.isMwbName(filename)) filename = filename.replace(/\.[^.]*$/, '') + '.mwb';
        f.board = info.pages;
      }
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

  // Direct-to-R2 video: client PUTs to a presigned URL, then confirms.
  route('POST', '/api/files/presign', async (ctx) => {
    const uploads = require('../../venue/uploads');
    const storage = require('../../venue/storage');
    const u = await getAuthUser(ctx.req, ctx.res);
    const rp = roomParticipant(ctx.req);
    if (!u && !rp) throw httpError(401, 'Sign in or join a room to upload');
    const b = await ctx.body();
    const mime = String((b && b.mime) || '').split(';')[0].trim().toLowerCase() || 'application/octet-stream';
    const size = Number(b && b.size);
    const durationSec = Number(b && b.durationSec);
    let filename = String((b && (b.filename || b.name)) || 'video.webm').slice(0, 120);
    const purpose = uploads.normalizePurpose((b && b.purpose) || 'chat');
    const maxSec = (require('../../config').UPLOADS.maxVideoSeconds) || 900;
    if (!mime.startsWith('video/')) throw httpError(415, 'Only video uploads can be sent this way');
    if (!Number.isSafeInteger(size) || size <= 0) throw httpError(400, 'The upload size is missing');
    if (!Number.isFinite(durationSec) || durationSec <= 0) throw httpError(400, 'The video length is missing');
    if (durationSec > maxSec) throw httpError(413, `Videos can be up to ${Math.round(maxSec / 60)} minutes`);
    const max = uploads.precheck({ mime, declaredSize: size, rateKey: u ? `u:${u.id}` : `ip:${clientIp(ctx.req)}` });
    if (size > max) throw httpError(413, `Videos can be up to ${uploads.fmtMB(max)}`);
    const ownerKey = !u && rp ? `p:${rp.participant.id}` : null;
    await uploads.quota(data, { size, userId: u && u.id, ownerKey, roomCode: rp && rp.code });
    const id = storage.newId();
    const now = new Date();
    const key = `${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, '0')}/${id}-${storage.slugName(filename)}`;
    const signed = storage.presignPut(key, { mime, expires: 900 });
    const rec = { id, driver: storage.driver(), objectKey: key, filename, mime, size, ownerUserId: u && u.id, ownerKey, purpose, roomCode: rp && rp.code };
    // Held until /complete confirms the object exists; quota already reserved by size.
    await require('../../venue/data').insertFile(rec);
    return { id, key, method: signed.method, uploadUrl: signed.url, headers: signed.headers, expiresIn: signed.expires, mime, size };
  });
  route('POST', '/api/files/complete', async (ctx) => {
    const storage = require('../../venue/storage');
    const u = await getAuthUser(ctx.req, ctx.res);
    const rp = roomParticipant(ctx.req);
    if (!u && !rp) throw httpError(401, 'Sign in or join a room to upload');
    const b = await ctx.body();
    const id = String((b && b.id) || '');
    if (!id) throw httpError(400, 'Missing file id');
    const rec = await data.getFile(id);
    if (!rec) throw httpError(404, 'Upload not found');
    const ownerOk = (u && Number(rec.owner_user_id) === Number(u.id)) || (rp && rec.owner_key === `p:${rp.participant.id}`);
    if (!ownerOk) throw httpError(404, 'Upload not found');
    const head = await storage.headObject(rec.object_key);
    if (!head) throw httpError(409, 'The file is not in storage yet');
    if (head.size != null && Number(rec.size_bytes) && head.size > Number(rec.size_bytes) * 1.05) throw httpError(413, 'The uploaded file is larger than declared');
    return { id: rec.id, url: storage.publicUrl(rec), filename: rec.filename, mime: rec.mime, size: Number(rec.size_bytes) };
  });
};
