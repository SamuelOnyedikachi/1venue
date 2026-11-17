/**
 * /billing history: every payment I made (plan + short links, credits, promotions / tickets / donations) in one
 * list, printable HTML receipts for paid ones, and removing the saved renewal card.
 */
const { q, one, many } = require('../../core/db');
const fail = (status, message) => Object.assign(new Error(message), { status, expose: true });
const LABEL = { free: 'Free', premium: 'Premium', organisation: 'Organisation' };
const asJson = (v) => { if (!v) return {}; if (typeof v === 'object') return v; try { return JSON.parse(v); } catch (_) { return {}; } };

function describe(source, r) {
  if (source === 'plan') {
    if (r.kind === 'slug_addon') return { kind: 'Short link', what: `${r.slug_tier === 'slug3' ? '3' : '4'}-character venue link${r.venue_name ? ' for ' + r.venue_name : ''}` };
    return { kind: r.kind === 'renewal' ? 'Renewal' : 'Plan', what: `${LABEL[r.plan] || r.plan || 'Plan'} plan, ${r.billing_interval === 'year' ? 'annual' : 'monthly'}` };
  }
  if (source === 'credits') return { kind: 'Credits', what: `${(Number(r.credit_units) / require('../wallet/rules').UNITS_PER_CREDIT).toLocaleString('en-NG', { maximumFractionDigits: 2 })} meeting credits${r.source === 'auto_topup' ? ' (auto top-up)' : ''}` };
  const d = asJson(r.detail);
  if (r.kind === 'promotion') return { kind: 'Promotion', what: `${d.extendPromotionId ? 'Extra ' : ''}${d.days || '?'} days promoting ${r.event_title || 'an event'}` };
  if (r.kind === 'ticket') return { kind: 'Ticket', what: `${r.quantity || 1} × ticket${Number(r.quantity) > 1 ? 's' : ''} for ${r.event_title || 'an event'}` };
  return { kind: 'Donation', what: `Gift to ${r.event_title || 'an event'}` };
}
function out(source, r) {
  return { source, reference: r.reference, ...describe(source, r), status: r.status, refunded: r.refund_status === 'refunded',
    totalKobo: Number(r.price_kobo), subtotalKobo: Number(r.subtotal_kobo ?? r.price_kobo), feeKobo: Number(r.processing_fee_kobo || 0), feePercent: r.fee_percent == null ? 0 : Number(r.fee_percent),
    displayCurrency: r.display_currency || r.currency || 'NGN', displayTotalMinor: r.display_total_minor == null ? Number(r.price_kobo) : Number(r.display_total_minor),
    createdAt: r.created_at, paidAt: r.paid_at || null, authorizationUrl: r.status === 'pending' ? r.authorization_url || null : null, receipt: r.status === 'paid' ? `/api/billing/receipts/${r.reference}` : null };
}
async function rowsFor(userId, limit = 200) {
  const [plan, credits, commerce] = await Promise.all([
    many('SELECT b.*, v.name AS venue_name FROM billing_payments b LEFT JOIN venues v ON v.id=b.venue_id WHERE b.user_id=$1 ORDER BY b.id DESC LIMIT $2', [userId, limit]),
    many('SELECT * FROM credit_payments WHERE user_id=$1 ORDER BY id DESC LIMIT $2', [userId, limit]).catch(() => []),
    many('SELECT c.*, e.title AS event_title FROM commerce_payments c LEFT JOIN events e ON e.id=c.event_id WHERE c.user_id=$1 ORDER BY c.id DESC LIMIT $2', [userId, limit]).catch(() => []),
  ]);
  return [...plan.map((r) => out('plan', r)), ...credits.map((r) => out('credits', r)), ...commerce.map((r) => out('commerce', r))]
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}
async function history(userId) { return { payments: (await rowsFor(userId)).slice(0, 200) }; }

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const naira = (k) => '₦' + (Number(k) / 100).toLocaleString('en-NG', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
/** A printable HTML receipt for one of my paid payments ("Print → Save as PDF" makes the PDF). */
async function receipt(userId, reference) {
  if (!/^[A-Za-z0-9-]{1,80}$/.test(String(reference || ''))) throw fail(404, 'Receipt not found');
  const p = (await rowsFor(userId, 500)).find((x) => x.reference === reference);
  if (!p || p.status !== 'paid') throw fail(404, 'Receipt not found');
  const u = await one('SELECT display_name, username, email FROM users WHERE id=$1', [userId]);
  const prof = await one('SELECT * FROM billing_profiles WHERE user_id=$1', [userId]).catch(() => null);
  const addr = prof ? [prof.line1, prof.line2, prof.city, prof.state, prof.postal_code, prof.country].filter(Boolean).join(', ') : '';
  const when = new Date(p.paidAt || p.createdAt).toUTCString().replace(' GMT', ' UTC');
  const disp = p.displayCurrency && p.displayCurrency !== 'NGN' ? `<tr><td>Shown to you as</td><td>${esc(p.displayCurrency)} ${(p.displayTotalMinor / 100).toFixed(2)} (approx.)</td></tr>` : '';
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Receipt ${esc(p.reference)} · 1venue</title>
<style>body{font:15px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:#111827;background:#f6f7fb;margin:0;padding:2rem}main{max-width:640px;margin:auto;background:#fff;border:1px solid #e5e7eb;border-radius:16px;padding:2rem}
h1{font-size:1.4rem;margin:0 0 .25rem}.muted{color:#6b7280}table{width:100%;border-collapse:collapse;margin:1.2rem 0}td{padding:.55rem 0;border-bottom:1px solid #eef0f4}td:last-child{text-align:right;font-variant-numeric:tabular-nums}
tr.total td{font-weight:700;border-bottom:0;font-size:1.05rem}.badge{display:inline-block;padding:.15rem .6rem;border-radius:999px;background:#dcfce7;color:#166534;font-size:.8rem;font-weight:600}
.badge.ref{background:#fee2e2;color:#991b1b}@media print{body{background:#fff;padding:0}main{border:0}.noprint{display:none}}</style></head><body><main>
<p class="muted" style="margin:0">1venue</p><h1>Receipt</h1><p class="muted" style="margin:0">${esc(p.reference)} · ${esc(when)}</p>
<p><span class="badge${p.refunded ? ' ref' : ''}">${p.refunded ? 'Refunded' : 'Paid'}</span></p>
<p style="margin:.2rem 0"><strong>Billed to</strong><br>${esc((u && (u.display_name || u.username)) || '')}<br>${esc((u && u.email) || '')}${addr ? '<br>' + esc(addr) : ''}</p>
<table><tr><td>${esc(p.kind)}: ${esc(p.what)}</td><td>${naira(p.subtotalKobo)}</td></tr>
<tr><td>Processing fee${p.feePercent ? ` (${p.feePercent}%)` : ''}</td><td>${naira(p.feeKobo)}</td></tr>
<tr class="total"><td>Total charged (NGN)</td><td>${naira(p.totalKobo)}</td></tr>${disp}</table>
<p class="muted" style="font-size:.85rem">Paid through Paystack. Use your browser's Print to save this receipt as a PDF.</p></main></body></html>`;
  return { raw: html, type: 'text/html; charset=utf-8', headers: { 'Cache-Control': 'private, no-store', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; img-src 'self'", 'X-Content-Type-Options': 'nosniff' } };
}
/** Forget the saved renewal card. The plan stays until the period ends; renewing then needs a manual payment. */
async function removeCard(userId) {
  const r = await q(`UPDATE subscriptions SET authorization_code=NULL, card_last4=NULL, card_brand=NULL, card_exp=NULL, auth_email=NULL, updated_at=NOW() WHERE user_id=$1 AND authorization_code IS NOT NULL`, [userId]);
  if (!r.rowCount) throw fail(404, 'No saved card');
  return require('./service').summary(userId);
}
module.exports = { history, receipt, removeCard, describe };
