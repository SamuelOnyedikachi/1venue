/**
 * Money: currencies, FX display conversion and the processing fee.
 *
 *   CURRENCY_BASE            currency every stored price is in and the gateway charges (default NGN)
 *   FX_RATES                 JSON, units of each currency per 1 base unit, e.g. {"USD":0.00062,"GBP":0.00049}
 *                            (admin can override from /admin → Currency; saved in app_settings 'fx')
 *   PROCESSING_FEE_PERCENT   added on top of every checkout (default 3)
 *
 * All amounts are integer minor units (kobo for NGN). Prices are stored and charged in the base
 * currency; other currencies are for display, and every payment row records the currency the person
 * saw, the converted total and the rate used.
 */
const CURRENCIES = {
  NGN: 'Nigerian naira', USD: 'US dollar', GBP: 'British pound', EUR: 'Euro',
  GHS: 'Ghanaian cedi', KES: 'Kenyan shilling', ZAR: 'South African rand', CAD: 'Canadian dollar',
};
// PLACEHOLDER rates (units per 1 NGN, Nov 2026 ballpark). Set FX_RATES or edit them in /admin before going live.
const PLACEHOLDER_RATES = { NGN: 1, USD: 0.00062, GBP: 0.00049, EUR: 0.00057, GHS: 0.0095, KES: 0.08, ZAR: 0.0112, CAD: 0.00087 };

const fail = (status, message) => Object.assign(new Error(message), { status });
const base = () => (CURRENCIES[String(process.env.CURRENCY_BASE || '').toUpperCase()] ? String(process.env.CURRENCY_BASE).toUpperCase() : 'NGN');
const isCurrency = (c) => Object.prototype.hasOwnProperty.call(CURRENCIES, String(c || '').toUpperCase());
/** Decimal places of a currency (2 for all supported ones; JPY-style 0 would also work). */
const digits = (c) => { try { return new Intl.NumberFormat('en', { style: 'currency', currency: c }).resolvedOptions().maximumFractionDigits; } catch { return 2; } };

function feePercent() {
  const raw = process.env.PROCESSING_FEE_PERCENT;
  const n = raw == null || raw === '' ? 3 : Number(raw);
  return Number.isFinite(n) && n >= 0 && n <= 20 ? n : 3;
}
/** Subtotal (integer minor units) → { subtotal, fee, total, percent }. Fee rounds half-up to the currency's minor unit. */
function withFee(subtotal, percent = feePercent()) {
  if (!Number.isSafeInteger(subtotal) || subtotal < 0) throw fail(400, 'Invalid amount');
  const fee = Math.round((subtotal * Math.round(percent * 10000)) / 1000000); // percent kept to 4 dp, integer maths
  return { subtotal, fee, total: subtotal + fee, percent };
}

/**
 * Did the gateway collect enough? When our processing fee was added (processing_fee_kobo > 0) it covers the
 * gateway's own fee, so the customer must have paid at least the total. Without it (fee 0, legacy rows) the
 * gateway must have passed its fee on, so the amount minus its fees must still cover the price.
 */
function paidEnough(amount, fees, payment) {
  const price = Number(payment.price_kobo);
  return Number(payment.processing_fee_kobo || 0) > 0 ? amount >= price : amount - fees >= price;
}

function parseRates(text) {
  if (!text) return {};
  let o; try { o = typeof text === 'string' ? JSON.parse(text) : text; } catch { return {}; }
  const out = {};
  for (const [k, v] of Object.entries(o || {})) { const c = k.toUpperCase(); const n = Number(v); if (isCurrency(c) && Number.isFinite(n) && n > 0 && n < 1e9) out[c] = n; }
  return out;
}
let cache = null;
/** { rates, configured, source } — admin rates over env FX_RATES over placeholders. */
async function rates({ fresh = false } = {}) {
  if (!fresh && cache && Date.now() - cache.at < 30000) return cache.value;
  let saved = {};
  try { const db = require('../../db'); const r = (await db.q("SELECT value FROM app_settings WHERE key='fx'")).rows[0]; saved = r ? parseRates(r.value) : {}; } catch { saved = {}; }
  const env = parseRates(process.env.FX_RATES);
  const b = base();
  const out = {};
  for (const c of Object.keys(CURRENCIES)) out[c] = c === b ? 1 : saved[c] || env[c] || (b === 'NGN' ? PLACEHOLDER_RATES[c] : null);
  const configured = Object.keys(CURRENCIES).filter((c) => c !== b).every((c) => saved[c] || env[c]);
  const value = { base: b, rates: out, configured, placeholder: Object.keys(CURRENCIES).filter((c) => c !== b && !saved[c] && !env[c]) };
  cache = { at: Date.now(), value };
  return value;
}
const clearCache = () => { cache = null; };
async function saveRates(actorId, input) {
  const clean = parseRates(input);
  const db = require('../../db');
  await db.q(`INSERT INTO app_settings (key, value, updated_by, updated_at) VALUES ('fx', $1, $2, NOW())
    ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_by=EXCLUDED.updated_by, updated_at=NOW()`, [JSON.stringify(clean), actorId || null]);
  clearCache();
  return rates({ fresh: true });
}
/** Base minor units → minor units of `to`, half-up. */
function convert(minor, to, r) {
  const b = r.base || base();
  if (!to || to === b) return minor;
  const rate = r.rates[to];
  if (!rate) return null;
  return Math.round((minor / 10 ** digits(b)) * rate * 10 ** digits(to));
}
function format(minor, currency, locale = 'en') {
  return new Intl.NumberFormat(locale, { style: 'currency', currency, currencyDisplay: 'narrowSymbol', minimumFractionDigits: digits(currency), maximumFractionDigits: digits(currency) }).format(minor / 10 ** digits(currency));
}
/** What a payment row records about the price the person saw. */
async function displayFor(totalMinor, currency) {
  const r = await rates();
  const cur = isCurrency(currency) ? String(currency).toUpperCase() : r.base;
  const shown = convert(totalMinor, cur, r);
  return shown == null ? { currency: r.base, total: totalMinor, rate: '1' } : { currency: cur, total: shown, rate: String(r.rates[cur]) };
}
async function userCurrency(userId) {
  if (!userId) return base();
  try { const db = require('../../db'); const row = (await db.q('SELECT currency FROM billing_profiles WHERE user_id=$1', [userId])).rows[0]; return row && isCurrency(row.currency) ? row.currency : base(); } catch { return base(); }
}
/** Everything a checkout needs to price `subtotal` for a user: gateway amounts + what they see. */
async function checkoutAmounts(userId, subtotal) {
  const f = withFee(subtotal);
  const cur = await userCurrency(userId);
  const d = await displayFor(f.total, cur);
  return { ...f, currency: base(), displayCurrency: d.currency, displayTotal: d.total, fxRate: d.rate };
}
async function publicConfig(userId) {
  const r = await rates();
  return { base: r.base, chargeCurrency: r.base, currency: await userCurrency(userId), currencies: Object.entries(CURRENCIES).map(([code, name]) => ({ code, name, digits: digits(code) })), rates: r.rates, ratesConfigured: r.configured, placeholderRates: r.placeholder, feePercent: feePercent() };
}
module.exports = { CURRENCIES, PLACEHOLDER_RATES, base, isCurrency, digits, feePercent, withFee, paidEnough, parseRates, rates, saveRates, clearCache, convert, format, displayFor, userCurrency, checkoutAmounts, publicConfig };
