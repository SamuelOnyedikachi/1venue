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
const AI_KINDS = ['ask', 'catchup', 'translate', 'title', 'summary', 'finetune', 'scripture', 'analysis', 'transcribe'];
// Phase 2/3 feature switches per plan (0 = off, 1 = on), editable from /admin like the limits.
const FEATURE_KEYS = ['branding', 'recurring', 'reminders', 'whatsapp', 'exports', 'analytics', 'badge', 'selfPromo', 'ticketing', 'replays', 'callVideo'];
// Numeric Phase 3 limits per plan: organisation members (0 = cannot create an organisation), replay storage.
// Messages: standing group size, call size (2 = 1:1 only) and message history in days (0 = forever).
const EXTRA_LIMIT_KEYS = ['orgMembers', 'replayMB', 'groupMembers', 'callParticipants', 'historyDays'];
// Site-wide money and scheduling settings (not per plan).
const PLATFORM_KEYS = {
  feeBps: [500, 5000], // platform cut of tickets and donations, basis points (500 = 5%)
  promoDayKobo: [100000, 1e10], // self-serve promotion price per day
  promoMaxDays: [30, 365],
  promoApproval: [1, 1], // 1 = admin approves paid promotions before they go live
  payoutMinKobo: [500000, 1e12],
  ticketMaxPerOrder: [10, 100],
  donationMinKobo: [10000, 1e10],
  reminderLeadA: [1440, 20160], // minutes before start
  reminderLeadB: [60, 20160], // 0 turns the second reminder off
  whatsappEnabled: [1, 1], // still needs WHATSAPP_TOKEN + WHATSAPP_PHONE_NUMBER_ID in env
  verifiedBoost: [1, 1], // 1 = verified hosts rank higher in Discover
  replayUploadMB: [500, 20480], // manual replay upload size cap
  seriesMax: [52, 200], // occurrences one recurring series may create
};

const DEFAULTS = Object.freeze({
  plans: {
    free: { venues: 1, audience: 100, meeting: 25, speakerSeats: 2, aiDaily: 20, uploadMB: 250, priceMonthKobo: 0, priceYearKobo: 0 },
    premium: { venues: 3, audience: 300, meeting: 50, speakerSeats: 4, aiDaily: 200, uploadMB: 2048, priceMonthKobo: 500000, priceYearKobo: 5000000 },
    organisation: { venues: 20, audience: 1000, meeting: 50, speakerSeats: 10, aiDaily: 1000, uploadMB: 10240, priceMonthKobo: 2500000, priceYearKobo: 25000000 },
  },
  aiWeights: { ask: 1, translate: 1, title: 1, scripture: 1, summary: 2, catchup: 2, finetune: 2, analysis: 2, transcribe: 2 },
  slugAddons: { slug3: 1000000, slug2: 2500000 }, // kobo, one-off, per venue, paid plans only
  graceDays: 5,
  aiGuestPerIpDaily: 30, // points one guest IP may spend from a host's pool per day
  features: {
    free: { branding: 0, recurring: 0, reminders: 0, whatsapp: 0, exports: 0, analytics: 0, badge: 0, selfPromo: 1, ticketing: 0, replays: 0, orgMembers: 0, replayMB: 0, callVideo: 0, groupMembers: 8, callParticipants: 2, historyDays: 365 },
    premium: { branding: 1, recurring: 1, reminders: 1, whatsapp: 1, exports: 1, analytics: 1, badge: 1, selfPromo: 1, ticketing: 0, replays: 0, orgMembers: 0, replayMB: 0, callVideo: 1, groupMembers: 32, callParticipants: 8, historyDays: 0 },
    organisation: { branding: 1, recurring: 1, reminders: 1, whatsapp: 1, exports: 1, analytics: 1, badge: 1, selfPromo: 1, ticketing: 1, replays: 1, orgMembers: 25, replayMB: 51200, callVideo: 1, groupMembers: 64, callParticipants: 16, historyDays: 0 },
  },
  platform: Object.fromEntries(Object.entries(PLATFORM_KEYS).map(([k, [d]]) => [k, d])),
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
  for (const p of PLAN_IDS) for (const k of [...FEATURE_KEYS, ...EXTRA_LIMIT_KEYS]) {
    const v = envNum(`PLAN_${p.toUpperCase()}_${snake(k)}`);
    if (v != null) out.features[p][k] = FEATURE_KEYS.includes(k) ? (v ? 1 : 0) : v;
  }
  for (const [k, [, max]] of Object.entries(PLATFORM_KEYS)) { const v = envNum(`PLATFORM_${snake(k)}`); if (v != null && v <= max) out.platform[k] = v; }
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
  if (patch.features) for (const [p, vals] of Object.entries(patch.features)) {
    if (!PLAN_IDS.includes(p)) bad(`Unknown plan ${p}`);
    for (const [k, v] of Object.entries(vals || {})) {
      if (FEATURE_KEYS.includes(k)) out.features[p][k] = num(v, `${p}.${k}`, 1);
      else if (EXTRA_LIMIT_KEYS.includes(k)) out.features[p][k] = num(v, `${p}.${k}`, 1e7);
      else bad(`Unknown feature ${k}`);
    }
  }
  if (patch.platform) for (const [k, v] of Object.entries(patch.platform)) {
    if (!PLATFORM_KEYS[k]) bad(`Unknown platform setting ${k}`);
    out.platform[k] = num(v, k, PLATFORM_KEYS[k][1]);
  }
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
/** Feature switches and extra limits for a plan: { branding: true, ..., orgMembers, replayMB }. */
function featuresFor(settings, plan) {
  const f = (settings.features || DEFAULTS.features)[PLAN_IDS.includes(plan) ? plan : 'free'];
  const out = {};
  for (const k of FEATURE_KEYS) out[k] = !!f[k];
  for (const k of EXTRA_LIMIT_KEYS) out[k] = f[k] || 0;
  return out;
}
const platform = (settings) => ({ ...DEFAULTS.platform, ...(settings.platform || {}) });
/** Platform fee on a gross amount in kobo: rounded half up to whole kobo; net = gross - fee. */
function feeSplit(grossKobo, feeBps) {
  const g = Number(grossKobo); const b = Number(feeBps);
  if (!Number.isSafeInteger(g) || g < 0 || !Number.isSafeInteger(b) || b < 0 || b > 10000) throw Object.assign(new Error('Invalid amount'), { status: 400 });
  const fee = Math.floor((g * b + 5000) / 10000);
  return { gross: g, fee, net: g - fee };
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
  const limits = limitsFor(s, plan, u && u.plan_overrides);
  // Organisation members inherit their organisation's plan features and room sizes (venues, AI and
  // storage stay personal, so a team cannot multiply them).
  const orgPlan = await orgPlanFor(userId);
  let featurePlan = plan;
  if (orgPlan && planRank(orgPlan) > planRank(plan)) {
    featurePlan = orgPlan;
    const ol = limitsFor(s, orgPlan);
    for (const k of ['audience', 'meeting', 'speakerSeats']) limits[k] = Math.max(limits[k], ol[k]);
  }
  return { plan, orgPlan: orgPlan || null, limits, features: featuresFor(s, featurePlan), subscription: sub, overrides: parseOverrides(u && u.plan_overrides) };
}
/** Best plan among the organisations this user belongs to (by the org owner's subscription). */
async function orgPlanFor(userId) {
  let rows = [];
  try { rows = (await db().q('SELECT DISTINCT o.owner_user_id FROM org_members m JOIN organisations o ON o.id=m.org_id WHERE m.user_id=$1 AND o.owner_user_id<>$1', [userId])).rows; } catch (_) { return null; }
  let best = null;
  for (const r of rows.slice(0, 10)) {
    const p = effectivePlan(await subscriptionOf(r.owner_user_id));
    if (p !== 'free' && (!best || planRank(p) > planRank(best))) best = p;
  }
  return best;
}
/** Throw 403 with an upgrade hint unless the user's plan includes `feature`. Returns entitlements. */
async function requireFeature(userId, feature, label) {
  const ent = await entitlements(userId);
  if (!ent.features[feature]) {
    throw Object.assign(new Error(`${label || 'This feature'} is not included in your plan. Upgrade to use it.`), { status: 403, upgrade: true, expose: true });
  }
  return ent;
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
  PLAN_IDS, PAID, INTERVALS, SLUG_TIERS, LIMIT_KEYS, PRICE_KEYS, AI_KINDS, DEFAULTS, FEATURE_KEYS, EXTRA_LIMIT_KEYS, PLATFORM_KEYS,
  featuresFor, platform, feeSplit, requireFeature, orgPlanFor,
  envDefaults, mergeSettings, diff, getSettings, saveSettings, resetSettings, clearCache,
  effectivePlan, parseOverrides, limitsFor, slugRights, aiWeight, priceFor, planRank, addInterval,
  subscriptionOf, entitlements, takeAi, aiUsed,
};
