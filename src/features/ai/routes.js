/**
 * AI helpers: ask, catch-up, translate, titles, scripture detection.
 * JSON API routes (see src/core/router.js for the route() contract).
 */
module.exports = function routes(route, kit) {
  const { config, clientIp, rateLimit, getAuthUser, data, ai, bible, httpError, roomParticipant, int, requireUser } = kit;
  const usage = require('../../lib/usage');
  const { mockFineTune } = require('./finetune');

  // ------------------------------------------------------------ AI
  async function aiGuard(ctx) {
    if (!require('../../lib/features').features.ai) throw httpError(404, 'AI is disabled');
    const u = await getAuthUser(ctx.req, ctx.res);
    const rp = roomParticipant(ctx.req);
    if (!u && !rp) throw httpError(401, 'Sign in or join a room to use AI');
    if (!rateLimit(`ai:${clientIp(ctx.req)}`, 30)) throw httpError(429, 'AI rate limit, try again in a minute');
    return { u, rp };
  }
  async function roomContext(rp) {
    if (!rp || !rp.meeting.historyId) return '';
    return data.transcriptToText(await data.getTranscript(rp.meeting.historyId, { limit: 1500 }));
  }
  const plans = require('../../lib/plans');
  /**
   * Spend points from the shared daily AI pool. Inside a room the room's paying host is charged
   * (guests count against the host's venue pool, with a per-IP daily cap); otherwise the user's own pool.
   */
  async function spend(ctx, kind, { u, rp }) {
    const ownerId = rp ? ((rp.meeting.limits && rp.meeting.limits.ownerUserId) || rp.meeting.hostUserId || null) : u ? u.id : null;
    const self = !!(u && ownerId && u.id === ownerId);
    const guestIp = self ? null : clientIp(ctx.req);
    const t = await plans.takeAi({ kind, ownerId, guestIp });
    if (!t.ok) {
      if (t.guestCap) throw httpError(429, 'You’ve reached today’s AI limit in this room. Try again tomorrow.');
      throw httpError(429, self ? `You’ve used today’s AI allowance (${t.limit} points). Upgrade for more, or try again tomorrow.` : 'The host’s AI allowance for today is used up. Try again tomorrow.');
    }
    return t;
  }
  async function metered(ctx, kind, who, fn) {
    const t = await spend(ctx, kind, who);
    try { return { ...(await fn()), aiLeft: t.left }; } catch (e) { await t.refund(); throw e; }
  }
  const aiOut = (r) => ({ text: r.text, provider: r.provider, model: r.model, mock: !!r.mock });
  route('POST', '/api/ai/ask', async (ctx) => {
    const who = await aiGuard(ctx);
    const { rp } = who;
    const b = await ctx.body();
    if (!b.question) throw httpError(400, 'Ask a question');
    const context = (await roomContext(rp)) || (rp ? `Session: ${rp.meeting.name}` : '');
    return metered(ctx, 'ask', who, async () => aiOut(await ai().ask(String(b.question).slice(0, 1000), context)));
  });
  route('POST', '/api/ai/catchup', async (ctx) => {
    const who = await aiGuard(ctx);
    const { rp } = who;
    if (!rp) throw httpError(400, 'Catch-up works inside a room');
    const segs = rp.meeting.historyId ? await data.getTranscript(rp.meeting.historyId, { limit: 2000 }) : [];
    const minutes = Math.min(60, Math.max(2, int((await ctx.body()).minutes, 10)));
    const since = Date.now() - minutes * 60000;
    const recent = data.transcriptToText(segs.filter((s) => new Date(s.at).getTime() >= since));
    if (!recent) return { text: 'Nothing has been said in that window yet, or captions are off.', provider: 'local', mock: true };
    return metered(ctx, 'catchup', who, async () => aiOut(await ai().catchUp(recent, minutes)));
  });
  route('POST', '/api/ai/translate', async (ctx) => {
    const who = await aiGuard(ctx);
    const b = await ctx.body();
    return metered(ctx, 'translate', who, async () => aiOut(await ai().translate(String(b.text || ''), String(b.lang || 'English').slice(0, 30))));
  });
  route('POST', '/api/ai/title', async (ctx) => {
    const who = await aiGuard(ctx);
    const b = await ctx.body();
    const notes = String(b.notes || '');
    const t = await spend(ctx, 'title', who);
    let r;
    try { r = await ai().titleDescription(notes, b.category); } catch (e) { await t.refund(); throw e; }
    let out = {};
    try { out = JSON.parse(String(r.text).replace(/^```(json)?|```$/g, '').trim()); } catch (_) { out = { title: String(r.text).split('\n')[0].slice(0, 80), description: String(r.text).slice(0, 400) }; }
    const tags = Array.isArray(out.tags)
      ? out.tags.map((t) => String(t).trim().toLowerCase().replace(/^#/, '').slice(0, 32)).filter(Boolean).slice(0, 12)
      : [];
    const title = out.title || '';
    const theme = require('../../lib/palette').pickPalette({ suggestion: out.palette, title: title || notes, description: out.description || '', category: out.category || b.category });
    const hints = require('./draft').enrichDraft(notes, out, {
      tzOffset: Number(b.tzOffset) || 0,
      now: b.now ? new Date(b.now) : new Date(),
      category: b.category,
    });
    return {
      title, description: out.description || '', tags, theme,
      category: hints.category || null, venue: hints.venue,
      start: hints.start, end: hints.end, hasTime: hints.hasTime, endHasTime: hints.endHasTime,
      provider: r.provider, mock: !!r.mock, aiLeft: t.left,
    };
  });

  const finetuneLimit = () => Number(config.AI.finetuneDailyLimit || 0);
  route('GET', '/api/ai/finetune', async (ctx) => {
    const u = await getAuthUser(ctx.req, ctx.res);
    const limit = finetuneLimit();
    const used = u ? await usage.used(`u:${u.id}`, 'finetune') : 0;
    let left = Math.max(0, limit - used);
    if (u) {
      const s = await plans.getSettings();
      const ent = await plans.entitlements(u.id, { settings: s });
      const w = plans.aiWeight(s, 'finetune');
      if (w > 0) left = Math.min(left, Math.floor(Math.max(0, ent.limits.aiDaily - await plans.aiUsed(u.id)) / w));
    }
    return { enabled: limit > 0, dailyLimit: limit, used, left };
  });
  route('POST', '/api/ai/finetune', async (ctx) => {
    const u = await requireUser(ctx.req, ctx.res);
    await aiGuard(ctx);
    const limit = finetuneLimit();
    if (limit <= 0) throw httpError(503, 'Fine-tune is turned off');
    const raw = String((await ctx.body()).text || '').trim();
    if (!raw) throw httpError(400, 'Write something first');
    if (raw.length > 2000) throw httpError(400, 'That post is a little long to fine-tune');
    const took = await usage.take(`u:${u.id}`, 'finetune', 1, limit);
    if (!took.ok) throw httpError(429, `You’ve used your ${limit} fine-tunes for today — try again tomorrow`);
    let pool;
    try { pool = await spend(ctx, 'finetune', { u, rp: null }); } catch (e) { await usage.refund(`u:${u.id}`, 'finetune', 1).catch(() => {}); throw e; }
    try {
      const r = await ai().fineTune(raw);
      let text = String(r.text || '').trim();
      if (!text) text = mockFineTune(raw);
      return { text, provider: r.provider, model: r.model, mock: !!r.mock, left: Math.max(0, limit - took.used), used: took.used, aiLeft: pool.left };
    } catch (e) {
      await usage.refund(`u:${u.id}`, 'finetune', 1).catch(() => {});
      await pool.refund();
      throw e;
    }
  });
  route('POST', '/api/ai/scripture', async (ctx) => {
    const who = await aiGuard(ctx);
    const b = await ctx.body();
    const query = String(b.query || '').slice(0, 300);
    const corpus = String(b.corpus || 'bible').toLowerCase() === 'quran' ? 'quran' : 'bible';
    let translation = b.translation || null;
    // Keep hydration inside the active corpus
    if (corpus === 'quran' && !/^quran_/i.test(translation || '')) translation = 'quran_en_sahih';
    if (corpus === 'bible' && /^quran_/i.test(translation || '')) translation = config.BIBLE?.defaultTranslation || 'eng_kjv';

    const t = await spend(ctx, 'scripture', who);
    let r;
    try { r = await ai().scripture(query, translation, corpus); } catch (e) { await t.refund(); throw e; }
    const parsed = String(r.text).split('\n').map((l) => l.trim()).filter(Boolean).map((l) => {
      const [ref, why] = l.replace(/^[-*\d.\s]+/, '').split('|').map((x) => (x || '').trim());
      return bible().parseReference(ref) ? { reference: ref, why: why || '' } : null;
    }).filter(Boolean).slice(0, 6);

    // Drop cross-corpus accidents (e.g. Bible refs while in Qur’an mode)
    const filtered = parsed.filter((item) => {
      const p = bible().parseReference(item.reference);
      if (!p) return false;
      const book = bible().BOOKS.find((x) => x.id === p.book);
      const isQ = book && book.testament === 'Quran';
      return corpus === 'quran' ? isQ : !isQ;
    });

    const refs = [];
    for (const item of filtered) {
      try {
        let tryTr = translation;
        let p;
        try {
          p = await bible().passage(item.reference, tryTr);
        } catch (err) {
          // Deuterocanonical hits when the active translation lacks them → load via WEBc
          const parsedRef = bible().parseReference(item.reference);
          const book = parsedRef && bible().BOOKS.find((x) => x.id === parsedRef.book);
          if (corpus === 'bible' && book && book.testament === 'DC') {
            tryTr = 'eng_webc';
            p = await bible().passage(item.reference, tryTr);
          } else throw err;
        }
        const verses = (p.verses || []).map((v) => ({
          v: v.v,
          text: String(v.text).replace(/^¶\s*/, '').trim(),
        }));
        const text = verses.map((v) => `${v.v} ${v.text}`).join(' ');
        refs.push({
          reference: p.reference || item.reference,
          why: item.why,
          text,
          verses: verses.slice(0, 8),
          translation: p.translation?.id || tryTr,
          short: p.translation?.short || '',
          book: p.book,
          chapter: p.chapter,
          selected: p.selected || null,
          deuterocanon: !!(bible().BOOKS.find((x) => x.id === p.book)?.testament === 'DC'),
        });
      } catch {
        refs.push({ reference: item.reference, why: item.why, text: '', verses: [] });
      }
    }
    return { refs, query, corpus, provider: r.provider, mock: !!r.mock };
  });
};
