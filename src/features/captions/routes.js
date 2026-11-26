/**
 * Speech-to-text (Whisper on Replicate first; see src/venue/stt.js).
 *
 *   POST /api/stt?mode=caption&code=…   a room speaker's caption chunk: broadcast + stored in the transcript
 *   POST /api/stt?mode=dictate[&code=…] voice typing (/ bar, text boxes): text is returned only, never
 *                                        broadcast or stored. Signed-in users anywhere; room guests with
 *                                        their room credential.
 *   GET  /api/stt/config                 engine + caps for this caller (no secrets)
 *
 * Body: one short self-contained audio clip (webm/opus, ogg or mp4), cut by the client at a pause
 * (silence is never sent). Header X-Audio-Ms: clip length, used for the daily caps.
 * Caps (seconds of speech per UTC day): STT_DAILY_SECONDS_PER_USER (voice typing),
 * STT_DAILY_CAPTION_SECONDS_PER_USER (captions), STT_DAILY_SECONDS_TOTAL (whole server).
 * When a cap is hit the answer is 429 { fallback: 'webspeech' } and the browser switches to its
 * own speech recognition.
 */
const usage = require('../../lib/usage');

module.exports = function routes(route, kit) {
  const { config, readRaw, rateLimit, store, data, stt, httpError, roomParticipant, getAuthUser } = kit;
  const S = config.STT;

  // Clip length in seconds: trust the client's X-Audio-Ms within sane bounds, but never below what the
  // byte size implies at a very high bitrate (64 kbps), so a lying header can't dodge the cap for long.
  const clipSeconds = (req, bytes) => {
    const hdr = Number(req.headers['x-audio-ms']) || 0;
    const fromBytes = bytes / 8000; // 64 kbps -> 8000 bytes/s
    return Math.min(30, Math.max(1, Math.ceil(Math.max(hdr / 1000, fromBytes))));
  };
  const LANGS = new Set(['en', 'yo', 'ig', 'ha', 'pcm', 'fr', 'ar']);
  const langOf = (v) => { const l = String(v || '').toLowerCase().split(/[-_]/)[0]; return LANGS.has(l) ? l : 'auto'; };

  async function who(ctx) {
    const rp = roomParticipant(ctx.req, ctx.url.searchParams.get('code'));
    const u = await getAuthUser(ctx.req, ctx.res);
    if (!rp && !u) return null;
    const key = u ? `u:${u.id}` : (rp.participant.userId ? `u:${rp.participant.userId}` : `p:${rp.participant.id}`);
    return { rp, u, key };
  }

  route('GET', '/api/stt/config', async (ctx) => {
    const st = stt().status();
    const w = await who(ctx).catch(() => null);
    let left = null, captionLeft = null;
    if (w && st.primary === 'replicate') {
      left = S.dailySecondsPerUser > 0 ? Math.max(0, S.dailySecondsPerUser - await usage.used(w.key, 'stt')) : null;
      captionLeft = S.dailyCaptionSecondsPerUser > 0 ? Math.max(0, S.dailyCaptionSecondsPerUser - await usage.used(w.key, 'stt_caption')) : null;
    }
    return { ...st, signedIn: !!(w && w.u), allowed: !!w, secondsLeft: left, captionSecondsLeft: captionLeft };
  });

  route('POST', '/api/stt', async (ctx) => {
    const mode = ctx.url.searchParams.get('mode') === 'dictate' ? 'dictate' : 'caption';
    const w = await who(ctx);
    if (!w) throw httpError(401, mode === 'dictate' ? 'Sign in to use voice typing' : 'Join the room to send captions');
    if (mode === 'caption' && !w.rp) throw httpError(401, 'Join the room to send captions');
    const rlKey = w.rp ? `stt:${w.rp.participant.id}` : `stt:${w.key}`;
    if (!rateLimit(rlKey, mode === 'dictate' ? 60 : 40)) throw httpError(429, 'Speech rate limit');
    const buf = await readRaw(ctx.req, S.maxChunkBytes);
    if (!buf.length) throw httpError(400, 'Empty audio');
    const lang = langOf(ctx.url.searchParams.get('lang'));
    const mime = String(ctx.req.headers['content-type'] || 'audio/webm').split(';')[0];
    const secs = clipSeconds(ctx.req, buf.length);

    // Daily caps apply to the paid engine (Replicate). Over a cap -> other configured servers, else Web Speech.
    let skipReplicate = false; const taken = [];
    if (stt().replicateOn()) {
      const kind = mode === 'dictate' ? 'stt' : 'stt_caption';
      const lim = mode === 'dictate' ? S.dailySecondsPerUser : S.dailyCaptionSecondsPerUser;
      const mine = await usage.take(w.key, kind, secs, lim);
      if (mine.ok) {
        taken.push([w.key, kind]);
        const all = await usage.take('*', 'stt', secs, S.dailySecondsTotal);
        if (all.ok) taken.push(['*', 'stt']); else skipReplicate = true;
      } else skipReplicate = true;
      if (skipReplicate) for (const [k, kd] of taken.splice(0)) await usage.refund(k, kd, secs);
    }
    const plans = require('../../lib/plans');
    const payer = w.u?.id || w.userId || (w.rp && w.rp.participant && w.rp.participant.userId);
    let paid = { ok: true, refund: async () => {} };
    if (payer && !skipReplicate) {
      paid = await plans.takeAi({ kind: 'stt', ownerId: payer, seconds: secs });
      if (!paid.ok) {
        for (const [k, kd] of taken) await usage.refund(k, kd, secs).catch(() => {});
        plans.throwIfAiDenied(paid);
      }
    }
    let out;
    try {
      out = await stt().transcribe(buf, mime, lang === 'auto' ? null : lang, { skipReplicate });
    } catch (e) {
      await paid.refund();
      for (const [k, kd] of taken) await usage.refund(k, kd, secs).catch(() => {});
      if (skipReplicate) { const err = httpError(429, 'Daily voice limit reached - using your browser’s speech recognition'); err.fallback = 'webspeech'; throw err; }
      throw e;
    }
    const text = out && out.text;
    if (text && mode === 'caption') {
      const rp = w.rp; const p = rp.participant;
      store.broadcast(rp.code, { type: 'caption', participantId: p.id, name: p.name, text, final: true, lang: lang === 'auto' ? 'en' : lang, at: Date.now() });
      if (rp.meeting.transcribe !== false) await data.addTranscriptSegment({ historyId: rp.meeting.historyId, code: rp.code, speakerKey: p.userId ? `u:${p.userId}` : `p:${p.id}`, speakerName: p.name, text, lang: lang === 'auto' ? 'en' : lang, source: 'stt' });
    }
    return { text: text || '', provider: out && out.provider, seconds: secs };
  });
};
