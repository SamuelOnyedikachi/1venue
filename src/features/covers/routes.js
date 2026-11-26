/**
 * AI event covers (ideogram-ai/ideogram-v3-turbo on Replicate by default, 16:9, text-free).
 *   POST /api/covers/generate { title, description, category, accent, accent2, attempt, session }
 *        -> { options: [{ token, url, source }], source, left }
 *        attempt 1-2 may reuse a library image; attempt 3+ always generates one fresh image.
 *   GET  /api/covers/preview/(token)
 *   POST /api/covers/pick { token, title } -> { url, materialId }
 */
const crypto = require('crypto');
const replicate = require('../../lib/replicate');
const usage = require('../../lib/usage');
const { coverPrompt, coverInput, sceneUserPrompt, SCENE_SYSTEM } = require('./prompt');
const library = require('./library');

const TTL = 30 * 60 * 1000;
const MAX_KEEP = 300;
const pending = new Map(); // token -> { buf, mime, userId, at, libraryId, source, sceneText, category, accent, accent2 }
function sweep() {
  const now = Date.now();
  for (const [k, v] of pending) if (now - v.at > TTL) pending.delete(k);
  while (pending.size > MAX_KEEP) pending.delete(pending.keys().next().value);
}

function stash(buf, mime, u, extra = {}) {
  const t = crypto.randomBytes(18).toString('base64url');
  pending.set(t, { buf, mime: /^image\//.test(mime || '') ? mime : 'image/webp', userId: u.id, at: Date.now(), ...extra });
  return t;
}

async function inventScene(config, body) {
  const fallback = '';
  const token = config.STT.replicate.token;
  if (!token || config.AI && config.AI.mock) return fallback;
  try {
    const { run, llmInput, llmText, resolveLlm } = replicate;
    const model = resolveLlm(config.NOTIFY.aiModel || config.MATERIALS.model);
    const out = await run({
      token, apiBase: config.STT.replicate.apiBase, model,
      input: llmInput({ prompt: sceneUserPrompt(body) + '\nScene:', system: SCENE_SYSTEM, maxTokens: 180, temperature: 0.6 }),
      timeoutMs: 15_000, tag: 'cover-scene', wait: 8,
    });
    const text = llmText(out.output).replace(/^["'\s]+|["'\s]+$/g, '').trim();
    return text.length >= 12 ? text.slice(0, 420) : fallback;
  } catch (e) {
    console.error('[covers] scene llm failed', e.status || '', e.detail || e.message);
    return fallback;
  }
}

module.exports = function routes(route, kit) {
  const { config, requireUser, getAuthUser, httpError, rateLimit, storage, data } = kit;
  const C = config.COVERS;
  const token = () => config.STT.replicate.token;
  const enabled = () => !!token() && C.dailyLimit > 0;

  route('GET', '/api/covers/config', async (ctx) => {
    const out = { enabled: enabled(), model: C.model, dailyLimit: C.dailyLimit, options: 1, aspectRatio: '16:9', used: 0, left: C.dailyLimit };
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
    const attempt = Math.max(1, Math.min(20, Number(b.attempt) || 1));
    const session = String(b.session || '').slice(0, 80);
    const exclude = Array.isArray(b.exclude) ? b.exclude : [];
    const scene = await inventScene(config, b);
    const prompt = coverPrompt({ ...b, scene });
    const queryText = scene || `${b.title || ''} ${b.description || ''}`.trim();

    if (attempt < 3) {
      const vec = await library.embedText(queryText || prompt, config);
      if (vec.length) {
        const skip = [...exclude];
        // Walk matches so a library row whose file has been deleted (e.g. a fresh
        // STORAGE_DIR on a test DB, or a pruned upload) is skipped, not treated as a miss.
        for (let i = 0; i < 8; i++) {
          const hit = await library.findMatch({
            scene: vec, category: b.category, userId: u.id, attempt, session, exclude: skip, threshold: C.reuseMin,
          });
          if (!hit) break;
          let buf, mime;
          try {
            const file = await library.loadFileBuffer(hit.row.file_id);
            if (file) { buf = file.buf; mime = file.mime; }
          } catch (e) { console.error('[covers] library read', e.message); }
          if (buf && buf.length) {
            const tok = stash(buf, mime, u, { libraryId: hit.row.id, source: 'library', sceneText: hit.row.scene_text, category: b.category, accent: b.accent, accent2: b.accent2 });
            library.rememberShown(session, hit.row.id);
            sweep();
            const used = await usage.used(`u:${u.id}`, 'cover');
            return {
              options: [{ token: tok, url: `/api/covers/preview/${tok}`, source: 'library', libraryId: hit.row.id }],
              source: 'library',
              left: Math.max(0, C.dailyLimit - used),
            };
          }
          skip.push(hit.row.id);
        }
      }
    }

    const took = await usage.take(`u:${u.id}`, 'cover', 1, C.dailyLimit);
    if (!took.ok) throw httpError(429, 'Please wait a moment and try again, or upload your own');
    const plans = require('../../lib/plans');
    const paid = await plans.takeAi({ kind: 'cover', ownerId: u.id });
    if (!paid.ok) {
      await usage.refund(`u:${u.id}`, 'cover', 1).catch(() => {});
      plans.throwIfAiDenied(paid);
    }
    let r;
    try {
      r = await replicate.run({
        token: token(), apiBase: config.STT.replicate.apiBase, model: C.model, timeoutMs: C.timeoutMs, tag: 'covers', wait: 15,
        input: coverInput(C.model, prompt, { seed: crypto.randomInt(1, 2 ** 31 - 1) }),
      });
    } catch (e) { await usage.refund(`u:${u.id}`, 'cover', 1).catch(() => {}); await paid.refund(); throw e; }
    const urls = (Array.isArray(r.output) ? r.output : [r.output]).filter((x) => typeof x === 'string').slice(0, 1);
    if (!urls.length) { await usage.refund(`u:${u.id}`, 'cover', 1).catch(() => {}); await paid.refund(); throw httpError(502, 'No cover came back - try again'); }
    let option = null;
    try {
      const { buf, mime } = await replicate.download(urls[0], 8 * 1048576);
      const kind = /^image\//.test(mime || '') ? mime : 'image/webp';
      const ext = kind === 'image/png' ? 'png' : kind === 'image/jpeg' ? 'jpg' : 'webp';
      const rec = await storage().save(buf, { filename: `cover-lib-${Date.now().toString(36)}.${ext}`, mime: kind, ownerUserId: null, purpose: 'cover-library' });
      const emb = await library.embedText(queryText || prompt, config);
      const entry = await library.saveEntry({
        fileId: rec.id, url: rec.url, sceneText: scene || queryText || prompt.slice(0, 400),
        category: b.category, accent: b.accent, accent2: b.accent2, embedding: emb, userId: u.id,
      }).catch((e) => { console.error('[covers] library save', e.message); return null; });
      const t = stash(buf, kind, u, { libraryId: entry && entry.id, source: 'new', sceneText: scene, category: b.category, accent: b.accent, accent2: b.accent2 });
      if (entry) library.rememberShown(session, entry.id);
      option = { token: t, url: `/api/covers/preview/${t}`, source: 'new', libraryId: entry && entry.id };
    } catch (e) { console.error('[covers] download', e.message); }
    if (!option) { await usage.refund(`u:${u.id}`, 'cover', 1).catch(() => {}); throw httpError(502, 'No cover came back - try again'); }
    sweep();
    return { options: [option], source: 'new', left: Math.max(0, C.dailyLimit - took.used) };
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
    if (p.libraryId) await library.recordUse({ libraryId: p.libraryId, userId: u.id, eventId: b.eventId || null }).catch((e) => console.error('[covers] use', e.message));
    let materialId = null;
    try {
      const m = await data.createMaterial(u.id, { title: `Cover · ${title}`.slice(0, 120), kind: 'image', payload: { url: `/files/${rec.id}/${encodeURIComponent(rec.filename)}` } });
      materialId = m.id;
    } catch (e) { console.error('[covers] material', e.message); }
    return { url: rec.url, materialId, source: p.source || 'new' };
  });

};
