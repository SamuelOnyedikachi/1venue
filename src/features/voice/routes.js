/**
 * Voice typing helpers.
 *   POST /api/voice/date { text, now?, tzOffset? } -> { start: 'YYYY-MM-DDTHH:mm', end, hasTime } | 422
 * Signed-in users or room participants (same auth as /api/stt dictation).
 */
const { parseSpokenDate } = require('./date');

module.exports = function routes(route, kit) {
  const { getAuthUser, roomParticipant, rateLimit, clientIp, httpError } = kit;
  route('POST', '/api/voice/date', async (ctx) => {
    const u = await getAuthUser(ctx.req, ctx.res);
    if (!u && !roomParticipant(ctx.req)) throw httpError(401, 'Sign in to use voice typing');
    if (!rateLimit(`vdate:${u ? u.id : clientIp(ctx.req)}`, 60)) throw httpError(429, 'Too many requests');
    const b = await ctx.body(4096);
    const tz = Number(b.tzOffset);
    const now = b.now ? new Date(b.now) : new Date();
    const r = parseSpokenDate(String(b.text || ''), { now: Number.isNaN(now.getTime()) ? new Date() : now, tzOffset: Number.isFinite(tz) && Math.abs(tz) <= 14 * 60 ? tz : 0 });
    if (!r) return { $status: 422, $body: { error: 'No date heard', start: null } };
    return r;
  });
};
