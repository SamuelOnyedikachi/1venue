/**
 * Credit price, packs, meeting rates and AI credit costs. All overridable by env.
 *
 * 1 credit = CREDIT_PRICE_KOBO (default 1000 kobo = ₦10). 1 credit = UNITS_PER_CREDIT units
 * (60_000, so 1 unit is 1 ms at a 1-credit-per-minute rate). Meeting and AI charges use
 * fractional credits but settle in whole units.
 */
const UNITS_PER_CREDIT = 60000;

function envNum(name, fallback) {
  const raw = process.env[name];
  if (raw == null || raw === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

function envInt(name, fallback, lo, hi) {
  const n = Math.round(envNum(name, fallback));
  if (!Number.isSafeInteger(n)) return fallback;
  if (lo != null && n < lo) return fallback;
  if (hi != null && n > hi) return fallback;
  return n;
}

/** Kobo charged per credit (default ₦10). */
function pricePerCreditKobo() {
  return envInt('CREDIT_PRICE_KOBO', 1000, 1, 1e9);
}

function welcomeCredits() {
  return envInt('BILLING_WELCOME_CREDITS', 100, 0, 1e7);
}

function freeMinutes() {
  return envInt('BILLING_FREE_MINUTES', 20, 0, 24 * 60);
}

function freeUntilMs(from = Date.now()) {
  return Math.floor(from) + freeMinutes() * 60 * 1000;
}

function bundles() {
  const raw = process.env.CREDIT_BUNDLES;
  const list = raw
    ? String(raw).split(/[,\s]+/).map((x) => Number(x)).filter((n) => Number.isSafeInteger(n) && n > 0)
    : [500, 1500, 3000, 6000];
  return list.length ? list : [500, 1500, 3000, 6000];
}

function roomCreditsPerMin() { return envNum('MEETING_ROOM_CREDITS_PER_MIN', 1.5); }
function publisherCreditsPerMin() { return envNum('MEETING_PUBLISHER_CREDITS_PER_MIN', 0.3); }
function viewerCreditsPerMin() { return envNum('MEETING_VIEWER_CREDITS_PER_MIN', 0.1); }
function paidEntryHostShareBps() { return envInt('PAID_ENTRY_HOST_SHARE_BPS', 8000, 0, 10000); }

/**
 * Base room rate covers the host plus one other person. Extra publishers (cam, mic
 * or screen on) and extra viewers are added on top.
 */
function roomComposition(publishers, viewers) {
  const pubs = Math.max(0, Math.floor(Number(publishers) || 0));
  const views = Math.max(0, Math.floor(Number(viewers) || 0));
  const included = 2;
  const pubExtra = Math.max(0, pubs - included);
  const includedLeft = Math.max(0, included - pubs);
  const viewExtra = Math.max(0, views - includedLeft);
  return { publishers: pubs, viewers: views, pubExtra, viewExtra };
}

function creditsPerMinute(publishers, viewers) {
  const { pubExtra, viewExtra } = roomComposition(publishers, viewers);
  return roomCreditsPerMin() + pubExtra * publisherCreditsPerMin() + viewExtra * viewerCreditsPerMin();
}

/** Units to debit for `elapsedMs` of a room with the given publisher/viewer counts. */
function unitsForElapsed(elapsedMs, publishers, viewers) {
  const elapsed = Math.max(0, Math.floor(elapsedMs));
  if (!elapsed) return 0;
  const perMin = creditsPerMinute(publishers, viewers);
  return Math.max(0, Math.floor((elapsed * perMin * UNITS_PER_CREDIT) / 60000));
}

function paidEntryUnitsForElapsed(elapsedMs) {
  const elapsed = Math.max(0, Math.floor(elapsedMs));
  if (!elapsed) return 0;
  return Math.max(0, Math.floor((elapsed * roomCreditsPerMin() * UNITS_PER_CREDIT) / 60000));
}

function splitHostShare(netUnits, bps = paidEntryHostShareBps()) {
  const net = Math.max(0, Math.floor(Number(netUnits) || 0));
  const b = Math.max(0, Math.min(10000, Math.floor(Number(bps) || 0)));
  const host = Math.floor((net * b) / 10000);
  return { host, platform: net - host };
}

const AI_CREDIT_DEFAULTS = {
  ask: 1, translate: 1, title: 1, scripture: 1, summary: 1, catchup: 1,
  finetune: 1, analysis: 1, transcribe: 1, cover: 10, whiteboard_ai: 15,
};

function aiCredits(kind, { seconds = 0, chars = 0 } = {}) {
  const k = String(kind || '').toLowerCase();
  if (k === 'stt' || k === 'captions' || k === 'caption') {
    const perMin = envNum('AI_CREDIT_STT_PER_MIN', 2);
    return Math.max(0, Math.ceil((Math.max(0, Number(seconds) || 0) / 60) * perMin));
  }
  if (k === 'tts' || k === 'voice') {
    const perK = envNum('AI_CREDIT_TTS_PER_1K', 5);
    return Math.max(0, Math.ceil((Math.max(0, Number(chars) || 0) / 1000) * perK));
  }
  const fallback = AI_CREDIT_DEFAULTS[k] != null ? AI_CREDIT_DEFAULTS[k] : 1;
  const envName = `AI_CREDIT_${k.toUpperCase()}`;
  return Math.max(0, envNum(envName, fallback));
}

function includedCredits(plan) {
  const id = plan === 'premium' ? 'pro' : plan;
  const fallback = { free: 0, pro: 2000, business: 5000, organisation: 12000 }[id] ?? 0;
  return envInt(`PLAN_${String(id || 'free').toUpperCase()}_INCLUDED_CREDITS`, fallback, 0, 1e9);
}

function aiRatePerUserHourly() {
  return envInt('AI_RATE_PER_USER_HOURLY', 60, 1, 10000);
}

module.exports = {
  UNITS_PER_CREDIT,
  pricePerCreditKobo,
  welcomeCredits,
  freeMinutes,
  freeUntilMs,
  bundles,
  roomCreditsPerMin,
  publisherCreditsPerMin,
  viewerCreditsPerMin,
  paidEntryHostShareBps,
  roomComposition,
  creditsPerMinute,
  unitsForElapsed,
  paidEntryUnitsForElapsed,
  splitHostShare,
  aiCredits,
  includedCredits,
  aiRatePerUserHourly,
  AI_CREDIT_DEFAULTS,
};
