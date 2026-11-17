/**
 * Commerce: self-serve promotions, event tickets (free + paid tiers), donations, a host earnings
 * ledger and manual payouts. Money rules mirror billing and the credit wallet: Paystack hosted
 * checkout, every grant re-verified with /transaction/verify, unique references and provider ids,
 * integer kobo. 1venue keeps a platform fee (admin setting platform.feeBps, default 5%) from
 * tickets and donations; the rest is the host's balance. Payouts and refunds are marked by an
 * admin by hand (no automated transfers).
 */
const crypto = require('node:crypto');
const { q, tx, one, many } = require('../../core/db');
const plans = require('../../lib/plans');
const gateway = require('../wallet/paystack');
const fail = (status, message, extra) => Object.assign(new Error(message), { status, expose: true }, extra || {});
const asJson = (v) => { if (!v) return {}; if (typeof v === 'object') return v; try { return JSON.parse(v); } catch (_) { return {}; } };

const paymentOut = (p) => ({ reference: p.reference, kind: p.kind, eventId: p.event_id ? Number(p.event_id) : null, tierId: p.tier_id ? Number(p.tier_id) : null, promotionId: p.promotion_id ? Number(p.promotion_id) : null,
  quantity: Number(p.quantity), priceKobo: Number(p.price_kobo), feeKobo: Number(p.fee_kobo || 0), subtotalKobo: Number(p.subtotal_kobo ?? p.price_kobo), processingFeeKobo: Number(p.processing_fee_kobo || 0), feePercent: p.fee_percent == null ? 0 : Number(p.fee_percent), displayCurrency: p.display_currency || p.currency || 'NGN', displayTotalMinor: p.display_total_minor == null ? Number(p.price_kobo) : Number(p.display_total_minor), status: p.status, refunded: p.refund_status === 'refunded', createdAt: p.created_at, paidAt: p.paid_at,
  authorizationUrl: p.status === 'pending' ? p.authorization_url || null : null, error: p.last_error || null });
const getPayment = (ref) => one('SELECT * FROM commerce_payments WHERE reference=$1', [ref]);
async function settings() { return plans.platform(await plans.getSettings()); }

// ---------------------------------------------------------------- checkout
async function initialize(user, f, returnPath) {
  const s = gateway.settings();
  if (!s.enabled) throw fail(503, 'Payments are not available yet');
  if (!user.email) throw fail(400, 'Add an email address to your account before paying');
  if (!Number.isSafeInteger(f.priceKobo) || f.priceKobo < 100) throw fail(400, 'This amount is too small');
  const ref = '1vc-' + crypto.randomBytes(16).toString('hex');
  // price_kobo = amount charged (subtotal + processing fee). Host splits and platform fee use the subtotal.
  const m = await require('../../lib/money').checkoutAmounts(user.id, f.priceKobo);
  const p = await one(`INSERT INTO commerce_payments (reference, kind, user_id, host_user_id, event_id, tier_id, quantity, detail, payer_email, price_kobo, fee_bps, fee_kobo, provider_mode, subtotal_kobo, processing_fee_kobo, fee_percent, display_currency, display_total_minor, fx_rate)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19) RETURNING *`,
  [ref, f.kind, user.id, f.hostUserId || null, f.eventId || null, f.tierId || null, f.quantity || 1, f.detail ? JSON.stringify(f.detail) : null, String(user.email).toLowerCase(), m.total, f.feeBps || 0, f.feeKobo || 0, s.mode, m.subtotal, m.fee, m.percent, m.displayCurrency, m.displayTotal, m.fxRate]);
  const back = new URL(returnPath + (returnPath.includes('?') ? '&' : '?') + 'reference=' + ref, s.callback).href;
  const result = await gateway.call('/transaction/initialize', { email: p.payer_email, amount: Number(p.price_kobo), currency: 'NGN', reference: ref, callback_url: back,
    metadata: { commerce_reference: ref, user_id: String(user.id), kind: f.kind, event_id: f.eventId ? String(f.eventId) : null } });
  if (result.reference !== ref) throw fail(502, 'Paystack returned an unexpected payment reference');
  const url = gateway.checkoutUrl(result.authorization_url, s);
  await q('UPDATE commerce_payments SET authorization_url=$2 WHERE reference=$1', [ref, url]);
  return { ...paymentOut(p), authorizationUrl: url };
}
async function ownEvent(userId, eventId) {
  const ev = await one('SELECT * FROM events WHERE id=$1', [eventId]);
  if (!ev || ev.host_user_id !== userId) throw fail(404, 'Event not found or not yours');
  return ev;
}

// ---------------------------------------------------------------- self-serve promotions
const PLACEMENTS = plans.PROMO_PLACEMENTS;
/** Server-side price for days x placements (see plans.promoQuote), plus the processing fee in the payer's display currency. */
async function quotePromotion(days, placements, userId) {
  const q0 = plans.promoQuote(await plans.getSettings(), { days: parseInt(days, 10), placements });
  const m = await require('../../lib/money').checkoutAmounts(userId || null, q0.priceKobo);
  return { ...q0, processingFeeKobo: m.fee, feePercent: m.percent, totalKobo: m.total, displayCurrency: m.displayCurrency, displayTotalMinor: m.displayTotal };
}
async function ownPromotion(userId, id) {
  const p = await one('SELECT * FROM promotions WHERE id=$1', [id]);
  if (!p || Number(p.owner_user_id) !== Number(userId)) throw fail(404, 'Promotion not found');
  return p;
}
/**
 * Start a paid promotion, or extend one of mine with { extendId } (same event; the extra days and the chosen
 * placements are priced again on the server, then added on top of the current end date once paid).
 */
async function startPromotion(user, { eventId, days, placements, extendId } = {}) {
  await plans.requireFeature(user.id, 'selfPromo', 'Promotions');
  let extend = null;
  if (extendId != null) {
    extend = await ownPromotion(user.id, parseInt(extendId, 10));
    if (extend.review_status === 'rejected') throw fail(400, 'A rejected promotion cannot be extended');
    if (extend.target_type !== 'event') throw fail(400, 'Only event promotions can be extended');
    eventId = extend.event_id;
    if (placements == null) placements = asPlacements(extend.placements);
  }
  const ev = await ownEvent(user.id, parseInt(eventId, 10));
  if (ev.visibility !== 'public' || ['draft', 'cancelled'].includes(ev.status)) throw fail(400, 'Only public, published events can be promoted');
  const quote = plans.promoQuote(await plans.getSettings(), { days: parseInt(days, 10), placements });
  const detail = { days: quote.days, placements: quote.placements.map((l) => l.id), perDayKobo: quote.perDayKobo, grossKobo: quote.grossKobo, discountPercent: quote.discountPercent, discountKobo: quote.discountKobo };
  if (extend) detail.extendPromotionId = Number(extend.id);
  return initialize(user, { kind: 'promotion', hostUserId: user.id, eventId: ev.id, priceKobo: quote.priceKobo, detail }, '/host?tab=promote');
}
const asPlacements = (v) => { if (Array.isArray(v)) return v; if (typeof v === 'string') { try { const a = JSON.parse(v); if (Array.isArray(a)) return a; } catch (_) { /* PG text form */ } return v.replace(/[{}]/g, '').split(',').filter(Boolean); } return []; };
const coverOf = (r) => r.cover_url || r.image_url || null;
async function myPromotions(userId) {
  const rows = await many(`SELECT p.*, e.title, e.slug, e.starts_at AS event_starts_at, e.status AS event_status, e.cover_url FROM promotions p LEFT JOIN events e ON e.id=p.event_id WHERE p.owner_user_id=$1 ORDER BY p.id DESC LIMIT 100`, [userId]);
  const now = Date.now();
  return rows.map((r) => {
    const start = r.starts_at ? new Date(r.starts_at).getTime() : null, end = r.ends_at ? new Date(r.ends_at).getTime() : null;
    const live = !!r.active && r.review_status !== 'pending' && r.review_status !== 'rejected' && start != null && start <= now && (end == null || end > now);
    const state = r.review_status === 'rejected' ? 'rejected' : r.review_status === 'pending' ? 'pending' : end != null && end <= now ? 'ended' : !r.active ? 'paused' : start != null && start > now ? 'scheduled' : 'live';
    const totalDays = start != null && end != null ? Math.max(1, Math.round((end - start) / 86400000)) : Number(r.days || 0) || null;
    const elapsed = start != null && end != null ? Math.min(totalDays, Math.max(0, (now - start) / 86400000)) : 0;
    return { id: Number(r.id), eventId: r.event_id ? Number(r.event_id) : null, title: r.title, slug: r.slug, cover: coverOf(r), eventStartsAt: r.event_starts_at || null, eventStatus: r.event_status || null,
      days: r.days, review: r.review_status, active: !!r.active, startsAt: r.starts_at, endsAt: r.ends_at, placements: asPlacements(r.placements), state,
      totalDays, daysElapsed: Math.round(elapsed * 10) / 10, daysLeft: totalDays != null ? Math.max(0, Math.round((totalDays - elapsed) * 10) / 10) : null,
      views: Number(r.views), clicks: Number(r.clicks), ctr: r.views ? Math.round((r.clicks / r.views) * 1000) / 10 : 0, live,
      canPause: !!r.owner_user_id && r.review_status === 'approved' && state !== 'ended', canExtend: r.review_status !== 'rejected' && r.target_type === 'event' };
  });
}
/** Owner pause/resume. Paused days still count down (the slot was paid for); resuming does not move the end date. */
async function pausePromotion(userId, id, paused) {
  const p = await ownPromotion(userId, id);
  if (p.review_status !== 'approved') throw fail(409, 'This promotion is waiting for review');
  if (p.ends_at && new Date(p.ends_at) <= new Date()) throw fail(409, 'This promotion has ended');
  await q('UPDATE promotions SET active=$2 WHERE id=$1', [id, !paused]);
  return (await myPromotions(userId)).find((x) => x.id === Number(id));
}
async function reviewPromotion(adminId, promoId, decision) {
  const p = await one('SELECT * FROM promotions WHERE id=$1', [promoId]);
  if (!p) throw fail(404, 'Promotion not found');
  if (decision === 'approve') {
    const now = new Date();
    const end = p.days ? new Date(now.getTime() + p.days * 86400000) : p.ends_at;
    await q("UPDATE promotions SET review_status='approved', active=$2, starts_at=$3, ends_at=$4 WHERE id=$1", [promoId, true, now, end]);
  } else if (decision === 'reject') {
    await q("UPDATE promotions SET review_status='rejected', active=$2 WHERE id=$1", [promoId, false]);
  } else throw fail(400, 'Choose approve or reject');
  if (p.owner_user_id) await q('INSERT INTO plan_audit (user_id, actor_user_id, action, detail) VALUES ($1,$2,$3,$4)', [p.owner_user_id, adminId, 'promotion_' + decision, JSON.stringify({ promotionId: promoId })]);
  return { id: promoId, review: decision === 'approve' ? 'approved' : 'rejected' };
}

// ---------------------------------------------------------------- tickets
const tierOut = (t) => ({ id: Number(t.id), name: t.name, priceKobo: Number(t.price_kobo), quantity: t.quantity == null ? null : Number(t.quantity), sold: Number(t.sold),
  remaining: t.quantity == null ? null : Math.max(0, Number(t.quantity) - Number(t.sold)), active: !!t.active });
async function tiers(eventId, { all = false } = {}) {
  return (await many(`SELECT * FROM ticket_tiers WHERE event_id=$1 ${all ? '' : 'AND active'} ORDER BY sort_order, id`, [eventId])).map(tierOut);
}
/** Host replaces the tier list. Tiers with sales are kept (deactivated if removed) and cannot drop below sold. */
async function saveTiers(user, eventId, list) {
  const ev = await ownEvent(user.id, eventId);
  await plans.requireFeature(user.id, 'ticketing', 'Ticketing');
  if (!Array.isArray(list) || list.length > 10) throw fail(400, 'Up to 10 ticket tiers');
  const existing = new Map((await many('SELECT * FROM ticket_tiers WHERE event_id=$1', [ev.id])).map((t) => [Number(t.id), t]));
  const keep = new Set();
  let i = 0;
  for (const raw of list) {
    const name = String(raw.name || '').trim().slice(0, 60);
    if (!name) throw fail(400, 'Every tier needs a name');
    const price = Number(raw.priceKobo || 0);
    if (!Number.isSafeInteger(price) || (price !== 0 && price < 5000) || price > 1e10) throw fail(400, 'Price must be free or at least ₦50');
    const qty = raw.quantity == null || raw.quantity === '' ? null : Number(raw.quantity);
    if (qty != null && (!Number.isSafeInteger(qty) || qty < 0 || qty > 1e6)) throw fail(400, 'Quantity must be a whole number');
    const active = raw.active !== false;
    const cur = raw.id ? existing.get(Number(raw.id)) : null;
    if (cur) {
      if (qty != null && qty < Number(cur.sold)) throw fail(400, `${name}: ${cur.sold} already sold`);
      if (Number(cur.sold) > 0 && price !== Number(cur.price_kobo)) throw fail(400, `${name}: the price cannot change after sales`);
      await q('UPDATE ticket_tiers SET name=$2, price_kobo=$3, quantity=$4, active=$5, sort_order=$6 WHERE id=$1', [cur.id, name, price, qty, active, i++]);
      keep.add(Number(cur.id));
    } else {
      const r = await one('INSERT INTO ticket_tiers (event_id, name, price_kobo, quantity, active, sort_order) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id', [ev.id, name, price, qty, active, i++]);
      keep.add(Number(r.id));
    }
  }
  for (const [id, t] of existing) if (!keep.has(id)) {
    if (Number(t.sold) > 0) await q('UPDATE ticket_tiers SET active=$2 WHERE id=$1', [id, false]);
    else await q('DELETE FROM ticket_tiers WHERE id=$1', [id]);
  }
  return tiers(ev.id, { all: true });
}
async function myTickets(userId, eventId) {
  if (!userId) return [];
  return (await many(`SELECT t.code, t.status, t.created_at, tt.name FROM tickets t LEFT JOIN ticket_tiers tt ON tt.id=t.tier_id WHERE t.user_id=$1 AND t.event_id=$2 ORDER BY t.id`, [userId, eventId]))
    .map((t) => ({ code: t.code, status: t.status, tier: t.name, createdAt: t.created_at }));
}
async function publicTickets(eventId, userId) {
  const ev = await one('SELECT id, host_user_id FROM events WHERE id=$1', [eventId]);
  if (!ev) throw fail(404, 'Event not found');
  const ent = await plans.entitlements(ev.host_user_id);
  const p = await settings();
  return { tiers: ent.features.ticketing ? await tiers(eventId) : [], required: ent.features.ticketing && (await tiers(eventId)).length > 0, mine: await myTickets(userId, eventId),
    donations: ent.features.ticketing, donationMinKobo: p.donationMinKobo, maxPerOrder: p.ticketMaxPerOrder, purchasesEnabled: gateway.enabled() };
}
const ticketCode = () => crypto.randomBytes(5).toString('hex').toUpperCase();
async function issueTickets(c, { tierId, eventId, userId, paymentId, quantity }) {
  for (let i = 0; i < quantity; i++) await c.query('INSERT INTO tickets (code, tier_id, event_id, user_id, payment_id) VALUES ($1,$2,$3,$4,$5)', [ticketCode(), tierId, eventId, userId, paymentId || null]);
}
async function getTicket(user, eventId, { tierId, quantity } = {}) {
  const ev = await one('SELECT * FROM events WHERE id=$1', [eventId]);
  if (!ev || ['draft', 'cancelled'].includes(ev.status)) throw fail(404, 'Event not found');
  const ent = await plans.entitlements(ev.host_user_id);
  if (!ent.features.ticketing) throw fail(404, 'Tickets are not available for this event');
  const tier = await one('SELECT * FROM ticket_tiers WHERE id=$1 AND event_id=$2 AND active', [tierId, eventId]);
  if (!tier) throw fail(404, 'Ticket type not found');
  const p = await settings();
  const qty = parseInt(quantity, 10) || 1;
  if (qty < 1 || qty > p.ticketMaxPerOrder) throw fail(400, `Choose 1 to ${p.ticketMaxPerOrder} tickets`);
  if (tier.quantity != null && Number(tier.sold) + qty > Number(tier.quantity)) throw fail(409, 'Not enough tickets left');
  if (Number(tier.price_kobo) === 0) {
    if (await one("SELECT 1 FROM tickets WHERE user_id=$1 AND tier_id=$2 AND status='valid'", [user.id, tier.id])) throw fail(409, 'You already have this ticket');
    await tx(async (c) => {
      const r = await c.query('UPDATE ticket_tiers SET sold=sold+1 WHERE id=$1 AND (quantity IS NULL OR sold+1 <= quantity)', [tier.id]);
      if (!r.rowCount) throw fail(409, 'Sold out');
      await issueTickets(c, { tierId: tier.id, eventId, userId: user.id, quantity: 1 });
    });
    return { free: true, tickets: await myTickets(user.id, eventId) };
  }
  const gross = Number(tier.price_kobo) * qty;
  const split = plans.feeSplit(gross, p.feeBps);
  return initialize(user, { kind: 'ticket', hostUserId: ev.host_user_id, eventId, tierId: tier.id, quantity: qty, priceKobo: gross, feeBps: p.feeBps, feeKobo: split.fee }, `/e/${ev.slug}`);
}
async function donate(user, eventId, amountKobo) {
  const ev = await one('SELECT * FROM events WHERE id=$1', [eventId]);
  if (!ev || ['draft', 'cancelled'].includes(ev.status)) throw fail(404, 'Event not found');
  const ent = await plans.entitlements(ev.host_user_id);
  if (!ent.features.ticketing) throw fail(404, 'Donations are not available for this event');
  const p = await settings();
  const amount = Number(amountKobo);
  if (!Number.isSafeInteger(amount) || amount < p.donationMinKobo || amount > 1e11) throw fail(400, `The smallest gift is ₦${(p.donationMinKobo / 100).toLocaleString('en-NG')}`);
  const split = plans.feeSplit(amount, p.feeBps);
  return initialize(user, { kind: 'donation', hostUserId: ev.host_user_id, eventId, priceKobo: amount, feeBps: p.feeBps, feeKobo: split.fee }, `/e/${ev.slug}`);
}
/** Room join gate: events with ticket tiers need a valid ticket (hosts, speakers and venue managers skip). */
async function canJoinEvent(eventId, user) {
  const ev = await one('SELECT id, host_user_id FROM events WHERE id=$1', [eventId]);
  if (!ev) return { ok: true };
  const has = await one('SELECT 1 FROM ticket_tiers WHERE event_id=$1 AND active LIMIT 1', [eventId]);
  if (!has) return { ok: true };
  const ent = await plans.entitlements(ev.host_user_id);
  if (!ent.features.ticketing) return { ok: true };
  if (!user) return { ok: false, reason: 'Sign in with the account that has your ticket to join this event.' };
  if (user.id === ev.host_user_id) return { ok: true };
  if (await one("SELECT 1 FROM tickets WHERE event_id=$1 AND user_id=$2 AND status='valid' LIMIT 1", [eventId, user.id])) return { ok: true };
  if (await one('SELECT 1 FROM event_speakers WHERE event_id=$1 AND user_id=$2 LIMIT 1', [eventId, user.id])) return { ok: true };
  return { ok: false, reason: 'This event needs a ticket. Get one on the event page, then join again.' };
}

// ---------------------------------------------------------------- verification and settlement
async function mark(ref, status, error = null) { await q("UPDATE commerce_payments SET status=$2, last_error=$3 WHERE reference=$1 AND status<>'paid'", [ref, status, error]); }
function validVerified(p, r) {
  const meta = gateway.metadata(r.metadata);
  const requested = r.requested_amount == null ? r.amount : r.requested_amount;
  const idOk = typeof r.id === 'number' ? Number.isSafeInteger(r.id) && r.id > 0 : typeof r.id === 'string' && /^[1-9]\d{0,29}$/.test(r.id);
  const fees = r.fees == null ? 0 : r.fees;
  return idOk && Number.isSafeInteger(r.amount) && Number.isSafeInteger(fees) && fees >= 0 && requested === Number(p.price_kobo) && require('../../lib/money').paidEnough(r.amount, fees, p)
    && r.currency === p.currency && r.domain === p.provider_mode && typeof r.customer?.email === 'string' && r.customer.email.toLowerCase() === p.payer_email
    && meta.commerce_reference === p.reference && String(meta.user_id) === String(p.user_id);
}
async function confirm(payment) {
  if (payment.status === 'paid') return paymentOut(payment);
  const r = await gateway.call('/transaction/verify/' + encodeURIComponent(payment.reference));
  if (r.reference !== payment.reference) throw fail(502, 'Paystack returned an unexpected payment reference');
  if (r.status !== 'success') {
    const status = ['failed', 'abandoned', 'reversed'].includes(r.status) ? 'failed' : 'pending';
    await mark(payment.reference, status, status === 'failed' ? String(r.gateway_response || r.status).slice(0, 200) : null);
    return { ...paymentOut(payment), status };
  }
  if (!validVerified(payment, r)) { await mark(payment.reference, 'review', 'verification_mismatch'); throw fail(409, 'The verified payment details do not match this purchase.'); }
  try { return await settle(payment, r); }
  catch (e) {
    if (e.code === '23505') { await mark(payment.reference, 'review', 'duplicate_provider_transaction'); throw fail(409, 'This transaction has already been assigned to another purchase'); }
    throw e;
  }
}
async function settle(purchase, verified) {
  const settingsNow = await settings();
  const out = await tx(async (c) => {
    const p = (await c.query('SELECT * FROM commerce_payments WHERE reference=$1 FOR UPDATE', [purchase.reference])).rows[0];
    // provider_id is only ever set here, so a payment that has it was already settled once (paid, or
    // review after selling out). Never settle it again, even if a late webhook arrives after a refund.
    if (p.status === 'paid' || p.provider_id) return p;
    let status = 'paid'; let err = null;
    if (p.kind === 'ticket') {
      const r = await c.query('UPDATE ticket_tiers SET sold=sold+$2 WHERE id=$1 AND (quantity IS NULL OR sold+$2 <= quantity)', [p.tier_id, Number(p.quantity)]);
      if (!r.rowCount) { status = 'review'; err = 'sold_out_refund_needed'; }
      else await issueTickets(c, { tierId: p.tier_id, eventId: p.event_id, userId: p.user_id, paymentId: p.id, quantity: Number(p.quantity) });
    }
    if (p.kind === 'promotion' && asJson(p.detail).extendPromotionId) {
      const d = asJson(p.detail);
      const cur = (await c.query('SELECT * FROM promotions WHERE id=$1', [d.extendPromotionId])).rows[0];
      if (cur) {
        // Extra days go on top of the current end (or from now if it already ended); approved promotions stay approved.
        const base = cur.ends_at && new Date(cur.ends_at) > new Date() ? new Date(cur.ends_at) : new Date();
        const ends = cur.review_status === 'pending' ? null : new Date(base.getTime() + d.days * 86400000);
        const starts = cur.ends_at && new Date(cur.ends_at) <= new Date() ? new Date() : cur.starts_at;
        await c.query('UPDATE promotions SET days=COALESCE(days,0)+$2, ends_at=COALESCE($3, ends_at), starts_at=$4, placements=$5, active=$6 WHERE id=$1',
          [cur.id, d.days, ends, starts, d.placements || PLACEMENTS, cur.review_status === 'pending' ? !!cur.active : true]);
        await c.query('UPDATE commerce_payments SET promotion_id=$2 WHERE id=$1', [p.id, cur.id]);
      }
    } else if (p.kind === 'promotion') {
      const d = asJson(p.detail);
      const approval = !!settingsNow.promoApproval;
      const now = new Date();
      const promo = (await c.query(`INSERT INTO promotions (target_type, event_id, placements, starts_at, ends_at, active, weight, note, owner_user_id, review_status, days, payment_reference)
        VALUES ('event',$1,$2,$3,$4,$5,10,$6,$7,$8,$9,$10) RETURNING id`, [p.event_id, d.placements || PLACEMENTS, now, approval ? null : new Date(now.getTime() + d.days * 86400000), !approval, 'Self-serve', p.user_id, approval ? 'pending' : 'approved', d.days, p.reference])).rows[0];
      await c.query('UPDATE commerce_payments SET promotion_id=$2 WHERE id=$1', [p.id, promo.id]);
    }
    const paid = (await c.query('UPDATE commerce_payments SET status=$2, provider_id=$3, amount_paid_kobo=$4, paid_at=NOW(), last_error=$5 WHERE id=$1 RETURNING *', [p.id, status, String(verified.id), verified.amount, err])).rows[0];
    if (status === 'paid' && (p.kind === 'ticket' || p.kind === 'donation') && p.host_user_id) {
      const split = plans.feeSplit(Number(p.subtotal_kobo ?? p.price_kobo), Number(p.fee_bps));
      await c.query(`INSERT INTO host_ledger (host_user_id, kind, payment_id, gross_kobo, fee_kobo, net_kobo) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING`,
        [p.host_user_id, p.kind === 'ticket' ? 'sale' : 'donation', p.id, split.gross, split.fee, split.net]);
    }
    return paid;
  });
  return paymentOut(out);
}

// ---------------------------------------------------------------- earnings and payouts
async function balance(hostId, c) {
  const run = c ? (s, a) => c.query(s, a) : q;
  return Number((await run('SELECT COALESCE(SUM(net_kobo),0) AS b FROM host_ledger WHERE host_user_id=$1', [hostId])).rows[0].b);
}
/**
 * Best-effort split of older one-box payout details into bank / number / name. Idempotent: only rows with no
 * structured fields yet; the original bank_details text is never changed. bank_parse = parsed | partial.
 */
async function backfillPayoutBanks(where = '', args = []) {
  const { parseBankText } = require('../../lib/banks');
  const rows = await many(`SELECT id, bank_details FROM payout_requests WHERE bank_parse IS NULL AND bank_name IS NULL AND account_number IS NULL AND bank_details IS NOT NULL ${where} LIMIT 500`, args).catch(() => []);
  for (const r of rows) {
    const b = parseBankText(r.bank_details);
    await q('UPDATE payout_requests SET bank_name=$2, account_number=$3, account_name=$4, bank_parse=$5 WHERE id=$1 AND bank_parse IS NULL', [r.id, b.bankName, b.accountNumber, b.accountName, b.complete ? 'parsed' : 'partial']);
  }
  return rows.length;
}
async function earnings(hostId) {
  await backfillPayoutBanks('AND host_user_id=$1', [hostId]);
  const [b, ledger, payouts, totals] = await Promise.all([
    balance(hostId),
    many(`SELECT l.*, cp.reference, cp.event_id, e.title FROM host_ledger l LEFT JOIN commerce_payments cp ON cp.id=l.payment_id LEFT JOIN events e ON e.id=cp.event_id WHERE l.host_user_id=$1 ORDER BY l.id DESC LIMIT 100`, [hostId]),
    many('SELECT * FROM payout_requests WHERE host_user_id=$1 ORDER BY id DESC LIMIT 50', [hostId]),
    one(`SELECT COALESCE(SUM(CASE WHEN kind IN ('sale','donation') THEN gross_kobo ELSE 0 END),0) AS gross, COALESCE(SUM(CASE WHEN kind IN ('sale','donation') THEN fee_kobo ELSE 0 END),0) AS fees FROM host_ledger WHERE host_user_id=$1`, [hostId]),
  ]);
  const p = await settings();
  const last = payouts.find((r) => r.account_number && r.bank_name && r.bank_parse === 'entered') || payouts.find((r) => r.account_number && r.bank_name);
  return { balanceKobo: b, grossKobo: Number(totals.gross), feesKobo: Number(totals.fees), feeBps: p.feeBps, payoutMinKobo: p.payoutMinKobo,
    banks: require('../../lib/banks').NAMES, lastBank: last ? { bankName: last.bank_name, accountNumber: last.account_number, accountName: last.account_name } : null,
    ledger: ledger.map((l) => ({ id: Number(l.id), kind: l.kind, grossKobo: Number(l.gross_kobo), feeKobo: Number(l.fee_kobo), netKobo: Number(l.net_kobo), event: l.title || null, reference: l.reference || null, at: l.created_at })),
    payouts: payouts.map(payoutOut) };
}
const payoutOut = (r) => ({ id: Number(r.id), hostUserId: r.host_user_id, amountKobo: Number(r.amount_kobo), status: r.status, bankDetails: r.bank_details,
  bank: { bankName: r.bank_name || null, accountNumber: r.account_number || null, accountName: r.account_name || null, source: r.bank_parse || null }, note: r.note, adminNote: r.admin_note, paidReference: r.paid_reference, requestedAt: r.requested_at, decidedAt: r.decided_at });
/**
 * { amountKobo, bankName, accountNumber, accountName } (separate fields, validated; NGN numbers are 10 digits).
 * The older { bankDetails } free text still works and is split best-effort.
 */
async function requestPayout(hostId, { amountKobo, bankDetails, bankName, accountNumber, accountName, note } = {}) {
  const p = await settings();
  const amount = Number(amountKobo);
  if (!Number.isSafeInteger(amount) || amount < p.payoutMinKobo) throw fail(400, `The smallest payout is ₦${(p.payoutMinKobo / 100).toLocaleString('en-NG')}`);
  const banks = require('../../lib/banks');
  let bank, fields;
  if (bankName != null || accountNumber != null || accountName != null) {
    fields = banks.cleanBankFields({ bankName, accountNumber, accountName }); bank = fields.bankDetails; fields.source = 'entered';
  } else {
    bank = String(bankDetails || '').trim().slice(0, 300);
    if (bank.length < 6) throw fail(400, 'Add your bank name, account number and account name');
    const b = banks.parseBankText(bank); fields = { ...b, source: b.complete ? 'parsed' : 'partial' };
  }
  return tx(async (c) => {
    await c.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [hostId]);
    if ((await c.query("SELECT 1 FROM payout_requests WHERE host_user_id=$1 AND status='requested'", [hostId])).rows[0]) throw fail(409, 'You already have a payout request waiting');
    if (await balance(hostId, c) < amount) throw fail(409, 'That is more than your available balance');
    const r = (await c.query('INSERT INTO payout_requests (host_user_id, amount_kobo, bank_details, note, bank_name, account_number, account_name, bank_parse) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *',
      [hostId, amount, bank, note ? String(note).slice(0, 300) : null, fields.bankName || null, fields.accountNumber || null, fields.accountName || null, fields.source])).rows[0];
    await c.query("INSERT INTO host_ledger (host_user_id, kind, payout_id, net_kobo) VALUES ($1,'payout',$2,$3)", [hostId, r.id, -amount]);
    return payoutOut(r);
  });
}
async function decidePayout(adminId, id, { action, reference, note } = {}) {
  if (!['paid', 'rejected'].includes(action)) throw fail(400, 'Choose paid or rejected');
  return tx(async (c) => {
    const r = (await c.query('SELECT * FROM payout_requests WHERE id=$1 FOR UPDATE', [id])).rows[0];
    if (!r) throw fail(404, 'Payout not found');
    if (r.status !== 'requested') throw fail(409, 'This payout was already decided');
    const u = (await c.query('UPDATE payout_requests SET status=$2, paid_reference=$3, admin_note=$4, decided_at=NOW(), decided_by=$5 WHERE id=$1 RETURNING *', [id, action, reference ? String(reference).slice(0, 120) : null, note ? String(note).slice(0, 300) : null, adminId])).rows[0];
    if (action === 'rejected') await c.query("INSERT INTO host_ledger (host_user_id, kind, payout_id, net_kobo) VALUES ($1,'payout_reversal',$2,$3) ON CONFLICT DO NOTHING", [r.host_user_id, r.id, Number(r.amount_kobo)]);
    return payoutOut(u);
  });
}
async function listPayouts(status) {
  await backfillPayoutBanks();
  const rows = await many(`SELECT p.*, u.email, u.username FROM payout_requests p LEFT JOIN users u ON u.id=p.host_user_id ${status ? 'WHERE p.status=$1' : ''} ORDER BY p.id DESC LIMIT 200`, status ? [status] : []);
  return rows.map((r) => ({ ...payoutOut(r), email: r.email, username: r.username }));
}
/** Admin marks a paid ticket/donation/promotion as refunded (the money is returned outside 1venue). */
async function markRefunded(adminId, reference, note) {
  return tx(async (c) => {
    const p = (await c.query('SELECT * FROM commerce_payments WHERE reference=$1 FOR UPDATE', [reference])).rows[0];
    if (!p) throw fail(404, 'Payment not found');
    if (!['paid', 'review'].includes(p.status) || !p.provider_id) throw fail(409, 'Only completed payments can be refunded');
    if (p.refund_status === 'refunded') throw fail(409, 'Already refunded');
    await c.query('UPDATE commerce_payments SET refund_status=$2, refunded_at=NOW(), refunded_by=$3, last_error=COALESCE($4, last_error) WHERE id=$1', [p.id, 'refunded', adminId, note ? String(note).slice(0, 200) : null]);
    if (p.kind === 'ticket') {
      const n = (await c.query("UPDATE tickets SET status='refunded' WHERE payment_id=$1 AND status='valid'", [p.id])).rowCount;
      if (n) await c.query('UPDATE ticket_tiers SET sold=CASE WHEN sold >= $2 THEN sold - $2 ELSE 0 END WHERE id=$1', [p.tier_id, n]);
    }
    if (p.kind === 'promotion' && p.promotion_id) await c.query("UPDATE promotions SET active=$2, review_status='rejected' WHERE id=$1", [p.promotion_id, false]);
    const sale = (await c.query("SELECT * FROM host_ledger WHERE payment_id=$1 AND kind IN ('sale','donation')", [p.id])).rows[0];
    if (sale) await c.query("INSERT INTO host_ledger (host_user_id, kind, payment_id, gross_kobo, fee_kobo, net_kobo) VALUES ($1,'refund',$2,$3,$4,$5) ON CONFLICT DO NOTHING", [sale.host_user_id, p.id, -Number(sale.gross_kobo), -Number(sale.fee_kobo), -Number(sale.net_kobo)]);
    return { reference, refunded: true };
  });
}
async function adminPayments({ status, kind } = {}) {
  const where = []; const args = [];
  if (status) { args.push(status); where.push(`p.status=$${args.length}`); }
  if (kind) { args.push(kind); where.push(`p.kind=$${args.length}`); }
  const rows = await many(`SELECT p.*, u.email, e.title FROM commerce_payments p LEFT JOIN users u ON u.id=p.user_id LEFT JOIN events e ON e.id=p.event_id ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY p.id DESC LIMIT 200`, args);
  return rows.map((r) => ({ ...paymentOut(r), payer: r.email, event: r.title, hostUserId: r.host_user_id }));
}
async function myPayments(userId) { return (await many('SELECT * FROM commerce_payments WHERE user_id=$1 ORDER BY id DESC LIMIT 50', [userId])).map(paymentOut); }

module.exports = { paymentOut, getPayment, confirm, settle, validVerified, quotePromotion, startPromotion, myPromotions, pausePromotion, reviewPromotion, tiers, saveTiers, publicTickets, getTicket, donate, canJoinEvent, myTickets,
  balance, earnings, requestPayout, backfillPayoutBanks, decidePayout, listPayouts, markRefunded, adminPayments, myPayments };
