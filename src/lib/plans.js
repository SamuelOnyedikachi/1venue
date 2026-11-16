/**
 * Plans and limits: the single place that says what Free, Premium and Organisation get.
 *
 * Values come from three layers, last wins:
 *   1. DEFAULTS below
 *   2. env fallbacks, e.g. PLAN_PREMIUM_AUDIENCE=300, AI_WEIGHT_SUMMARY=2, BILLING_GRACE_DAYS=5
 *   3. the app_settings row 'plans' edited from /admin (no redeploy needed)
 * Per-account overrides (users.plan_overrides JSON) are applied on top for one user.
 *
 * Server hard ceilings still apply: MAX_AUDIENCE (stage) and MAX_PARTICIPANTS (meetings).
 */
const config = require('../config');

const PLAN_IDS = ['free', 'premium', 'organisation'];
const PAID = ['premium', 'organisation'];
const INTERVALS = ['month', 'year'];
const SLUG_TIERS = ['none', 'slug3', 'slug2'];
const LIMIT_KEYS = ['venues', 'audience', 'meeting', 'speakerSeats', 'aiDaily', 'uploadMB'];
const PRICE_KEYS = ['priceMonthKobo', 'priceYearKobo'];
const AI_KINDS = ['ask', 'catchup', 'translate', 'title', 'summary', 'finetune', 'scripture'];

const DEFAULTS = Object.freeze({
  plans: {
    free: { venues: 1, audience: 100, meeting: 25, speakerSeats: 2, aiDaily: 20, uploadMB: 250, priceMonthKobo: 0, priceYearKobo: 0 },
    premium: { venues: 3, audience: 300, meeting: 50, speakerSeats: 4, aiDaily: 200, uploadMB: 2048, priceMonthKobo: 500000, priceYearKobo: 5000000 },
    organisation: { venues: 20, audience: 1000, meeting: 50, speakerSeats: 10, aiDaily: 1000, uploadMB: 10240, priceMonthKobo: 2500000, priceYearKobo: 25000000 },
  },
  aiWeights: { ask: 1, translate: 1, title: 1, scripture: 1, summary: 2, catchup: 2, finetune: 2 },
  slugAddons: { slug3: 1000000, slug2: 2500000 }, // kobo, one-off, per venue, paid plans only
  graceDays: 5,
  aiGuestPerIpDaily: 30, // points one guest IP may spend from a host's pool per day
});

const snake = (k) => k.replace(/([a-z])([A-Z])/g, '$1_$2').toUpperCase();
const nonNegInt = (v) => { const n = Number(v); return Number.isSafeInteger(n) && n >= 0 ? n : null; };
function envNum(name) { const v = process.env[name]; if (v == null || v === '') return null; return nonNegInt(v); }

/** DEFAULTS with env fallbacks applied. */
function envDefaults() {
  const out = JSON.parse(JSON.stringify(DEFAULTS));
  for (const p of PLAN_IDS) for (const k of [...LIMIT_KEYS, ...PRICE_KEYS]) {
    const v = envNum(`PLAN_${p.toUpperCase()}_${snake(k)}`);
    if (v != null) out.plans[p][k] = v;
  }
  for (const k of AI_KINDS) { const v = envNum(`AI_WEIGHT_${k.toUpperCase()}`); if (v != null) out.aiWeights[k] = v; }
  for (const k of ['slug3', 'slug2']) { const v = envNum(`${k.toUpperCase()}_PRICE_KOBO`); if (v != null) out.slugAddons[k] = v; }
  if (envNum('PLAN_FREE_UPLOAD_MB') == null && envNum('UPLOAD_USER_QUOTA_MB') != null) out.plans.free.uploadMB = envNum('UPLOAD_USER_QUOTA_MB');
  const g = envNum('BILLING_GRACE_DAYS'); if (g != null) out.graceDays = g;
  const ip = envNum('AI_GUEST_PER_IP_DAILY'); if (ip != null) out.aiGuestPerIpDaily = ip;
  return out;
}

/** Validate and merge a partial settings object (from admin) over a base. Throws {status:400}. */
function mergeSettings(base, patch) {
  const bad = (m) => { const e = new Error(m); e.status = 400; throw e; };
  const out = JSON.parse(JSON.stringify(base));
  if (!patch || typeof patch !== 'object') return out;
  const num = (v, label, max = 1e12) => { const n = nonNegInt(v); if (n == null || n > max) bad(`${label} must be a whole number from 0 to ${max}`); return n; };
  if (patch.plans) for (const [p, vals] of Object.entries(patch.plans)) {
    if (!PLAN_IDS.includes(p)) bad(`Unknown plan ${p}`);
    for (const [k, v] of Object.entries(vals || {})) {
      if (![...LIMIT_KEYS, ...PRICE_KEYS].includes(k)) bad(`Unknown limit ${k}`);
      out.plans[p][k] = num(v, `${p}.${k}`);
    }
  }
  if (patch.aiWeights) for (const [k, v] of Object.entries(patch.aiWeights)) { if (!AI_KINDS.includes(k)) bad(`Unknown AI feature ${k}`); out.aiWeights[k] = num(v, `weight ${k}`, 1000); }
  if (patch.slugAddons) for (const [k, v] of Object.entries(patch.slugAddons)) { if (!['slug3', 'slug2'].includes(k)) bad(`Unknown add-on ${k}`); out.slugAddons[k] = num(v, `${k} price`); }
  if (patch.graceDays != null) out.graceDays = num(patch.graceDays, 'Grace days', 60);
  if (patch.aiGuestPerIpDaily != null) out.aiGuestPerIpDaily = num(patch.aiGuestPerIpDaily, 'Guest AI per IP', 1e6);
  for (const p of PAID) for (const k of PRICE_KEYS) if (out.plans[p][k] < 100) bad(`${p} ${k} must be at least 100 kobo`);
  return out;
}

/** Only the leaves of `next` that differ from `base`. */
function diff(base, next) {
  const out = {};
  for (const [k, v] of Object.entries(next)) {
    if (v && typeof v === 'object') { const d = diff(base[k] || {}, v); if (Object.keys(d).length) out[k] = d; }
    else if (base[k] !== v) out[k] = v;
  }
  return out;
}

// ---------------------------------------------------------------- DB-backed settings (cached)
let cache = null; let cacheAt = 0;
const TTL = 30000;
function db() { return require('../core/db'); }
async function getSettings({ fresh = false } = {}) {
  if (!fresh && cache && Date.now() - cacheAt < TTL) return cache;
  let saved = null;
  try { const r = await db().one("SELECT value FROM app_settings WHERE key='plans'"); saved = r ? JSON.parse(r.value) : null; } catch (_) { saved = null; }
  let merged;
  try { merged = mergeSettings(envDefaults(), saved); } catch (_) { merged = envDefaults(); }
  cache = merged; cacheAt = Date.now();
  return merged;
}
async function saveSettings(patch, actorId) {
  const current = await getSettings({ fresh: true });
  const next = mergeSettings(current, patch);
  // Store only what differs from env defaults, so env changes still flow through for untouched values.
  await db().q(`INSERT INTO app_settings (key, value, updated_by, updated_at) VALUES ('plans', $1, $2, NOW())
    ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_by=EXCLUDED.updated_by, updated_at=NOW()`, [JSON.stringify(diff(envDefaults(), next)), actorId || null]);
  cache = next; cacheAt = Date.now();
  return next;
}
async function resetSettings(actorId) {
  await db().q("DELETE FROM app_settings WHERE key='plans'");
  cache = null;
  void actorId;
  return getSettings({ fresh: true });
}
function clearCache() { cache = null; }

// ---------------------------------------------------------------- pure helpers
const ms = (d) => (d == null ? null : new Date(d).getTime());

/** Which plan a subscription row grants at `now`. Grace keeps the paid plan; cancelled keeps it to period end. */
function effectivePlan(sub, now = Date.now()) {
  if (!sub || !PAID.includes(sub.plan)) return 'free';
  const t = typeof now === 'number' ? now : ms(now);
  const end = ms(sub.current_period_end);
  if (sub.status === 'comp') return end == null || t < end ? sub.plan : 'free';
  if (!['active', 'past_due', 'cancelled'].includes(sub.status)) return 'free';
  if (end != null && t < end) return sub.plan;
  const grace = ms(sub.grace_until);
  if (sub.status !== 'cancelled' && !sub.cancel_at_period_end && grace != null && t < grace) return sub.plan;
  return 'free';
}
function parseOverrides(v) {
  if (!v) return {};
  let o = v;
  if (typeof v === 'string') { try { o = JSON.parse(v); } catch (_) { return {}; } }
  const out = {};
  for (const k of LIMIT_KEYS) { const n = nonNegInt(o && o[k]); if (n != null) out[k] = n; }
  return out;
}
/** Plan limits for a plan id with optional per-account overrides. */
function limitsFor(settings, plan, overrides) {
  const base = settings.plans[PLAN_IDS.includes(plan) ? plan : 'free'];
  const l = { ...base, ...parseOverrides(overrides) };
  return {
    venues: l.venues, audience: Math.min(l.audience, config.MAX_AUDIENCE), meeting: Math.min(l.meeting, config.MAX_PARTICIPANTS),
    speakerSeats: Math.min(50, Math.max(1, l.speakerSeats)), aiDaily: l.aiDaily, uploadBytes: l.uploadMB * 1024 * 1024, uploadMB: l.uploadMB,
  };
}
/** Venue link rights: paid plans get clean links; shorter links need the venue's slug add-on and a paid plan. */
function slugRights(plan, slugTier = 'none') {
  const paid = PAID.includes(plan);
  return { clean: paid, tier: paid && SLUG_TIERS.includes(slugTier) ? slugTier : 'none' };
}
function aiWeight(settings, kind) { const w = settings.aiWeights[kind]; return w == null ? 1 : w; }
function priceFor(settings, plan, interval) {
  if (!PAID.includes(plan) || !INTERVALS.includes(interval)) return null;
  return settings.plans[plan][interval === 'year' ? 'priceYearKobo' : 'priceMonthKobo'];
}
const planRank = (p) => PLAN_IDS.indexOf(p);
function addInterval(from, interval) {
  const d = new Date(from);
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + (interval === 'year' ? 12 : 1));
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, last));
  return d;
}

// ---------------------------------------------------------------- per-user resolution
async function subscriptionOf(userId) {
  if (!userId) return null;
  return db().one('SELECT * FROM subscriptions WHERE user_id=$1', [userId]).catch(() => null);
}
/** Entitlements for a user (or free for anonymous): { plan, limits, subscription }. */
async function entitlements(userId, { settings } = {}) {
  const s = settings || await getSettings();
  if (!userId) return { plan: 'free', limits: limitsFor(s, 'free'), subscription: null };
  const [sub, u] = await Promise.all([subscriptionOf(userId), db().one('SELECT plan_overrides FROM users WHERE id=$1', [userId]).catch(() => null)]);
  const plan = effectivePlan(sub);
  return { plan, limits: limitsFor(s, plan, u && u.plan_overrides), subscription: sub, overrides: parseOverrides(u && u.plan_overrides) };
}

// ---------------------------------------------------------------- AI pool
/**
 * Spend AI points from one shared daily pool. In a room, the room host's pool pays (so guests
 * cannot bypass the host's allowance); outside a room the signed-in user's own pool pays.
 * Guests also have a per-IP daily cap so one person cannot drain a host's pool.
 * Returns { ok, cost, used, limit, left, refund() }.
 */
async function takeAi({ kind, ownerId, guestIp }) {
  const usage = require('./usage');
  const s = await getSettings();
  const cost = aiWeight(s, kind);
  const ent = await entitlements(ownerId, { settings: s });
  const limit = ent.limits.aiDaily;
  const key = ownerId ? `u:${ownerId}` : `ip:${guestIp || 'unknown'}`;
  if (!cost) return { ok: true, cost: 0, used: await usage.used(key, 'ai'), limit, left: limit, refund: async () => {} };
  if (limit <= 0) return { ok: false, cost, used: 0, limit, left: 0, refund: async () => {} };
  if (guestIp && ownerId && s.aiGuestPerIpDaily > 0) {
    const g = await usage.take(`ip:${guestIp}`, `ai-guest:${ownerId}`, cost, s.aiGuestPerIpDaily);
    if (!g.ok) return { ok: false, cost, used: g.used, limit: s.aiGuestPerIpDaily, left: 0, guestCap: true, refund: async () => {} };
  }
  const r = await usage.take(key, 'ai', cost, limit);
  const refundGuest = async () => { if (guestIp && ownerId && s.aiGuestPerIpDaily > 0) await usage.refund(`ip:${guestIp}`, `ai-guest:${ownerId}`, cost).catch(() => {}); };
  if (!r.ok) { await refundGuest(); return { ok: false, cost, used: r.used, limit, left: Math.max(0, limit - r.used), refund: async () => {} }; }
  return { ok: true, cost, used: r.used, limit, left: Math.max(0, limit - r.used), refund: async () => { await usage.refund(key, 'ai', cost).catch(() => {}); await refundGuest(); } };
}
async function aiUsed(userId) { return require('./usage').used(`u:${userId}`, 'ai'); }

module.exports = {
  PLAN_IDS, PAID, INTERVALS, SLUG_TIERS, LIMIT_KEYS, PRICE_KEYS, AI_KINDS, DEFAULTS,
  envDefaults, mergeSettings, diff, getSettings, saveSettings, resetSettings, clearCache,
  effectivePlan, parseOverrides, limitsFor, slugRights, aiWeight, priceFor, planRank, addInterval,
  subscriptionOf, entitlements, takeAi, aiUsed,
};
