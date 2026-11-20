/**
 * AI event covers (black-forest-labs/flux-schnell on Replicate, 16:9, text-free).
 *   POST /api/covers/generate { title, description, category, accent, accent2 }
 *        -> { options: [{ token, url }], left }   (AI_COVER_OPTIONS images per generation)
 *   GET  /api/covers/preview/(token)              the generated image (only for the user who made it)
 *   POST /api/covers/pick { token, title }        saves THIS one: file storage (purpose cover) + Materials
 *        -> { url, materialId }
 * Unpicked images are never stored: they live in memory for 30 minutes and are dropped.
 * Daily cap: AI_COVER_DAILY_LIMIT generations per user (UTC day).
 */
const crypto = require('crypto');
const replicate = require('../../lib/replicate');
const usage = require('../../lib/usage');
const { coverPrompt, coverNegative } = require('./prompt');

const TTL = 30 * 60 * 1000;
const MAX_KEEP = 300;
const pending = new Map(); // token -> { buf, mime, userId, at }
function sweep() {
  const now = Date.now();
  for (const [k, v] of pending) if (now - v.at > TTL) pending.delete(k);
  while (pending.size > MAX_KEEP) pending.delete(pending.keys().next().value);
}

module.exports = function routes(route, kit) {
  const { config, requireUser, getAuthUser, httpError, rateLimit, storage, data } = kit;
  const C = config.COVERS;
  const token = () => config.STT.replicate.token; // the one REPLICATE_API_TOKEN
  const enabled = () => !!token() && C.dailyLimit > 0;

  route('GET', '/api/covers/config', async (ctx) => {
    const out = { enabled: enabled(), model: C.model, dailyLimit: C.dailyLimit, options: C.options, aspectRatio: '16:9', used: 0, left: C.dailyLimit };
    const u = await getAuthUser(ctx.req, ctx.res);
    if (u && enabled()) {
      const n = await usage.used(`u:${u.id}`, 'cover');
      out.used = n;
      out.left = Math.max(0, C.dailyLimit - n);
    }
    return out;
  });

  route('POST', '/api/covers/generate', async (ctx) => {
    const u = await requireUser(ctx.req, ctx.res);
    if (!enabled()) throw httpError(503, 'AI covers are off (set REPLICATE_API_TOKEN)');
    if (!rateLimit(`cover:${u.id}`, 6)) throw httpError(429, 'One moment - covers are still being made');
    const b = await ctx.body(16 * 1024);
    const took = await usage.take(`u:${u.id}`, 'cover', 1, C.dailyLimit);
    if (!took.ok) throw httpError(429, `You’ve made ${C.dailyLimit} covers today - try again tomorrow, or upload your own`);
    let r;
    try {
      r = await replicate.run({
        token: token(), apiBase: config.STT.replicate.apiBase, model: C.model, timeoutMs: C.timeoutMs, tag: 'covers',
        input: (() => {
          const model = C.model || '';
          const schnell = /schnell/i.test(model);
          const input = { prompt: coverPrompt(b), aspect_ratio: '16:9', num_outputs: C.options, output_format: 'webp', output_quality: 90, seed: crypto.randomInt(1, 2 ** 31 - 1) };
          if (schnell) { input.megapixels = '1'; input.go_fast = true; input.num_inference_steps = 4; }
          else { input.num_inference_steps = 28; input.guidance = 3.5; input.negative_prompt = coverNegative(); }
          return input;
        })(),
      });
    } catch (e) { await usage.refund(`u:${u.id}`, 'cover', 1).catch(() => {}); throw e; }
    const urls = (Array.isArray(r.output) ? r.output : [r.output]).filter((x) => typeof x === 'string').slice(0, C.options);
    sweep();
    const options = [];
    for (const url of urls) {
      try {
        const { buf, mime } = await replicate.download(url, 8 * 1048576);
        const t = crypto.randomBytes(18).toString('base64url');
        pending.set(t, { buf, mime: /^image\//.test(mime || '') ? mime : 'image/webp', userId: u.id, at: Date.now() });
        options.push({ token: t, url: `/api/covers/preview/${t}` });
      } catch (e) { console.error('[covers] download', e.message); }
    }
    if (!options.length) { await usage.refund(`u:${u.id}`, 'cover', 1).catch(() => {}); throw httpError(502, 'No cover came back - try again'); }
    return { options, left: Math.max(0, C.dailyLimit - took.used) };
  });

  route('GET', '/api/covers/preview/([\\w-]{16,40})', async (ctx, [t]) => {
    const u = await requireUser(ctx.req, ctx.res);
    const p = pending.get(t);
    if (!p || p.userId !== u.id) throw httpError(404, 'That preview expired - generate again');
    return { raw: p.buf, type: p.mime, headers: { 'Cache-Control': 'private, max-age=1800' } };
  });

  route('POST', '/api/covers/pick', async (ctx) => {
    const u = await requireUser(ctx.req, ctx.res);
    const b = await ctx.body(4096);
    const p = pending.get(String(b.token || ''));
    if (!p || p.userId !== u.id) throw httpError(404, 'That preview expired - generate again');
    const uploads = require('../../venue/uploads');
    await uploads.quota(data, { size: p.buf.length, userId: u.id, ownerKey: null, roomCode: null });
    const title = String(b.title || 'Event').replace(/\s+/g, ' ').trim().slice(0, 90) || 'Event';
    const ext = p.mime === 'image/png' ? 'png' : p.mime === 'image/jpeg' ? 'jpg' : 'webp';
    const name = `cover-${title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'event'}.${ext}`;
    const rec = await storage().save(p.buf, { filename: name, mime: p.mime, ownerUserId: u.id, purpose: 'cover' });
    pending.delete(String(b.token));
    let materialId = null;
    try {
      const m = await data.createMaterial(u.id, { title: `Cover · ${title}`.slice(0, 120), kind: 'image', payload: { url: `/files/${rec.id}/${encodeURIComponent(rec.filename)}` } });
      materialId = m.id;
    } catch (e) { console.error('[covers] material', e.message); }
    return { url: rec.url, materialId };
  });

};
