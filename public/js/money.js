// Money on the client: credits (2 decimals), prices in the person's currency, the processing-fee breakdown.
// Mirrors src/lib/money.js; the server decides what is charged.
import { h, api, sheet, toastErr } from './ui.js';
import { icon } from './icons.js';

const DEFAULT = { base: 'NGN', chargeCurrency: 'NGN', currency: 'NGN', rates: { NGN: 1 }, feePercent: 3, currencies: [{ code: 'NGN', name: 'Nigerian naira', digits: 2 }] };
let M = DEFAULT, loading = null;
export const moneyConfig = () => M;
/** Load /api/money once (again after the currency changes: loadMoney(true)). */
export function loadMoney(fresh = false) {
  if (!fresh && loading) return loading;
  loading = api('/api/money').then((r) => { M = { ...DEFAULT, ...r }; return M; }).catch(() => M);
  return loading;
}
export function setCurrency(code) { M = { ...M, currency: code }; }

const digitsOf = (c) => (M.currencies.find((x) => x.code === c) || {}).digits ?? 2;
/** Credits with at most 2 decimals: 30 → "30", 32.0499 → "32.05", 7.5 → "7.50". */
export function fmtCredits(n) {
  const v = Math.round(Number(n || 0) * 100) / 100;
  const whole = Number.isInteger(v);
  return new Intl.NumberFormat(undefined, { minimumFractionDigits: whole ? 0 : 2, maximumFractionDigits: 2 }).format(v);
}
/** Coin glyph standing in for the word "credits" (screen readers still hear "credits"). */
export const coinHtml = (size = 16) => icon('coin', { size, cls: 'coin', label: 'credits' });
export const creditsEl = (n, { size = 16, cls = '' } = {}) => h('span', { class: `credits ${cls}`.trim() }, h('span', { class: 'credits-n' }, fmtCredits(n)), h('span', { class: 'credits-coin', html: coinHtml(size) }));

/** Base minor units → minor units of `to` (half-up), or null when there is no rate. */
export function convert(minor, to = M.currency) {
  if (!to || to === M.base) return minor;
  const r = M.rates && M.rates[to];
  if (!r) return null;
  return Math.round((minor / 10 ** digitsOf(M.base)) * r * 10 ** digitsOf(to));
}
export function format(minor, currency) {
  const d = digitsOf(currency);
  return new Intl.NumberFormat(undefined, { style: 'currency', currency, currencyDisplay: 'narrowSymbol', minimumFractionDigits: d, maximumFractionDigits: d }).format(minor / 10 ** d);
}
/** Symbol, ISO code and fraction digits for the payer's display currency. */
export function currencyParts(currency = M.currency) {
  const code = String(currency || M.currency || M.base || 'NGN').toUpperCase();
  const digits = digitsOf(code);
  let symbol = code;
  try {
    const parts = new Intl.NumberFormat(undefined, { style: 'currency', currency: code, currencyDisplay: 'narrowSymbol' }).formatToParts(0);
    symbol = (parts.find((p) => p.type === 'currency') || {}).value || code;
  } catch (_) { /* keep the code */ }
  return { code, symbol, digits };
}
/** Display-currency minor units → base (NGN kobo). Null when there is no rate. */
export function toBase(minor, from = M.currency) {
  if (!from || from === M.base) return Math.round(Number(minor || 0));
  const r = M.rates && M.rates[from];
  if (!r) return null;
  return Math.round((Number(minor) / 10 ** digitsOf(from) / r) * 10 ** digitsOf(M.base));
}
/** Major units in `currency` (e.g. 5000 naira) → base minor units. */
export function majorToBaseMinor(major, currency = M.currency) {
  const d = digitsOf(currency);
  const displayMinor = Math.round(Number(major || 0) * 10 ** d);
  const base = toBase(displayMinor, currency);
  return base == null ? displayMinor : base;
}
/** A base-currency price shown in the person's currency (falls back to the base). */
export function fmtMoney(minorBase, { currency = M.currency, whole = false } = {}) {
  const v = convert(Number(minorBase || 0), currency);
  if (v == null) return format(Number(minorBase || 0), M.base);
  if (!whole) return format(v, currency);
  const d = digitsOf(currency);
  return new Intl.NumberFormat(undefined, { style: 'currency', currency, currencyDisplay: 'narrowSymbol', minimumFractionDigits: v % 10 ** d === 0 ? 0 : d, maximumFractionDigits: v % 10 ** d === 0 ? 0 : d }).format(v / 10 ** d);
}
/** Same maths as the server's withFee(): integer minor units, half-up. */
export function withFee(subtotal, percent = M.feePercent) {
  const fee = Math.round((subtotal * Math.round(percent * 10000)) / 1000000);
  return { subtotal, fee, total: subtotal + fee, percent };
}
const pct = (p) => `${new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(p)}%`;
/** Subtotal / Processing fee (3%) / Total, in the person's currency, with the charged amount when it differs. */
export function breakdownEl(subtotalBase, { label = 'Subtotal' } = {}) {
  const b = withFee(subtotalBase);
  const row = (k, v, cls = '') => h('div', { class: `mb-row ${cls}` }, h('span', null, k), h('span', null, v));
  return h('div', { class: 'money-breakdown', role: 'group', 'aria-label': 'Price breakdown' },
    row(label, fmtMoney(b.subtotal)),
    row(`Processing fee (${pct(b.percent)})`, fmtMoney(b.fee)),
    row('Total', fmtMoney(b.total), 'total'),
    M.currency !== M.base ? h('p', { class: 'tiny muted mb-note' }, `Charged in ${M.base} as ${format(b.total, M.base)}. ${M.currency} amounts are estimates at the current exchange rate.`) : null);
}
/** Confirm sheet before any hosted checkout. start() returns { authorizationUrl }. */
export async function checkoutSheet({ title, what, subtotalKobo, start }) {
  await loadMoney();
  const pay = h('button', { class: 'btn primary', type: 'button', html: icon('lock', { size: 16 }) + 'Continue to secure checkout' });
  const cancel = h('button', { class: 'btn ghost', type: 'button' }, 'Cancel');
  const s = sheet({ title: title || 'Checkout', icon: 'lock', body: h('div', { class: 'checkout-sheet' }, what ? h('p', { class: 'small' }, what) : null, breakdownEl(subtotalKobo), h('div', { class: 'row', style: { gap: '.5rem', justifyContent: 'flex-end', marginTop: '.8rem' } }, cancel, pay)) });
  cancel.onclick = () => s.close();
  pay.onclick = async () => { pay.disabled = true; try { const r = await start(); location.assign(r.authorizationUrl); } catch (e) { pay.disabled = false; toastErr(e); } };
  return s;
}
