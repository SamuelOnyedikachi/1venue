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

  // Word / spreadsheet sharing in meetings: { url } of an uploaded file -> a paged JSON doc in storage.
  const docs = new Map(); // small LRU of fetched docs
  route('POST', '/api/convert/doc', async (ctx) => {
    const rp = roomParticipant(ctx.req);
    const u = rp ? null : await getAuthUser(ctx.req, ctx.res);
    if (!rp && !u) throw httpError(401, 'Sign in or join a meeting to present');
    if (rp && !can(rp.meeting, rp.participant, 'screenShare')) throw httpError(403, 'The host controls who can present');
    const who = rp ? `room:${rp.code}:${rp.participant.id}` : `user:${u.id}`;
    if (!rateLimit('doc-convert:' + who, 6)) throw httpError(429, 'Please wait a minute before sharing another document');
    const b = (await ctx.body(8 * 1024)) || {};
    const { normalizeStoredFileUrl } = require('../../lib/file-url');
    const url = normalizeStoredFileUrl(b.url);
    if (!url) throw httpError(400, 'Upload the file first');
    const { readStored } = require('../materials/analysis');
    const { extract, fileType } = require('../materials/extract');
    const { buildDoc, DOC_TYPES } = require('./doc');
    const { buf, row } = await readStored(url);
    const name = String(b.name || row.filename || 'document');
    const type = fileType({ name, mime: b.mime || row.mime, buf });
    if (!DOC_TYPES.has(type)) throw httpError(415, 'Choose a Word document, CSV or Excel file');
    const title = String(b.title || name.replace(/\.[^.]+$/, '') || 'Document').trim().slice(0, 80);
    const doc = buildDoc(await extract({ buf, name, mime: b.mime || row.mime }), title);
    const storage = require('../../venue/storage');
    const saved = await storage.save(Buffer.from(JSON.stringify(doc)), { filename: `${title.replace(/[^\w.\- ]+/g, '_').slice(0, 40) || 'doc'}.json`, mime: 'application/json', ownerUserId: u ? u.id : null, ownerKey: rp ? who : null, purpose: 'content', roomCode: rp ? rp.code : null });
    log.info('content', 'doc ready', { who, type, kind: doc.kind, pages: doc.pageCount });
    return { contentType: 'doc', url: saved.url, docKind: doc.kind, pageCount: doc.pageCount, title, fileMeta: { name, size: buf.length, mime: b.mime || row.mime || '' } };
  });
  route('GET', '/api/convert/doc', async (ctx) => {
    const rp = roomParticipant(ctx.req);
    const u = rp ? null : await getAuthUser(ctx.req, ctx.res);
    if (!rp && !u) throw httpError(401, 'Join the meeting to view this document');
    const { normalizeStoredFileUrl } = require('../../lib/file-url');
    const url = normalizeStoredFileUrl(ctx.url.searchParams.get('url'));
    if (!url) throw httpError(400, 'Missing document');
    if (docs.has(url)) return docs.get(url);
    const { buf } = await require('../materials/analysis').readStored(url, 8 * 1048576);
    let doc; try { doc = JSON.parse(buf.toString('utf8')); } catch { throw httpError(422, 'This document could not be read'); }
    if (!doc || doc.v !== 1) throw httpError(422, 'This document could not be read');
    docs.set(url, doc); if (docs.size > 30) docs.delete(docs.keys().next().value);
    return doc;
  });
};
