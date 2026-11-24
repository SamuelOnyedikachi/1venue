/**
 * Sell event materials: Paystack or wallet credits, 20% platform cut, live-only promo discounts.
 */
'use strict';
const { q, tx, one, many } = require('../../core/db');
const { USE_PG } = require('../../../db');
const plans = require('../../lib/plans');
const { PRICE_PER_CREDIT_KOBO, UNITS_PER_CREDIT, fail: creditFail } = require('../wallet/rules');
const fail = (status, message, extra) => Object.assign(new Error(message), { status, expose: true }, extra || {});

function asBool(v) { return v === true || v === 1 || v === '1' || v === 'true'; }

function saleFields(r) {
  if (!r) return {};
  const forSale = asBool(r.for_sale != null ? r.for_sale : r.forSale);
  const rawPrice = r.price_kobo != null ? r.price_kobo : r.priceKobo;
  const priceKobo = rawPrice == null ? null : Number(rawPrice);
  const rawDisc = r.call_discount_pct != null ? r.call_discount_pct : r.callDiscountPct;
  const callDiscountPct = Math.min(90, Math.max(0, Number(rawDisc) || 0));
  const listed = asBool(r.listed);
  const category = r.category ? String(r.category).slice(0, 40) : null;
  return { forSale, priceKobo, callDiscountPct, listed, category };
}

function sanitizeSale({ forSale, priceKobo, callDiscountPct, listed, category } = {}) {
  const out = {};
  if (forSale != null) out.for_sale = asBool(forSale) ? (USE_PG ? true : 1) : (USE_PG ? false : 0);
  if (priceKobo !== undefined) {
    if (priceKobo == null || priceKobo === '') out.price_kobo = null;
    else {
      const n = Number(priceKobo);
      if (!Number.isSafeInteger(n) || n < 0 || n > 1e10) throw fail(400, 'Price must be a whole number of kobo');
      if (n !== 0 && n < 5000) throw fail(400, 'The lowest sale price is ₦50');
      out.price_kobo = n;
    }
  }
  if (callDiscountPct !== undefined) {
    const n = Number(callDiscountPct);
    if (!Number.isSafeInteger(n) || n < 0 || n > 90) throw fail(400, 'The call discount must be 0 to 90 percent');
    out.call_discount_pct = n;
  }
  if (asBool(out.for_sale) && (out.price_kobo == null && priceKobo === undefined)) {
    /* existing price kept by caller */
  }
  if (listed != null) out.listed = asBool(listed) ? (USE_PG ? true : 1) : (USE_PG ? false : 0);
  if (category !== undefined) {
    const CAT = ['Teaching', 'Worship', 'Study', 'Music', 'Training', 'Kids', 'Business', 'Other'];
    const c = category == null || category === '' ? null : String(category).trim();
    out.category = c && CAT.includes(c) ? c : (c ? 'Other' : null);
  }
  return out;
}

async function isEventLive(eventId, meetingCode) {
  if (meetingCode) {
    try {
      const m = require('../../rooms/store').getMeeting(String(meetingCode).toUpperCase().replace(/-/g, ''));
      if (m && !m.ended) return true;
    } catch (_) { /* store not ready */ }
  }
  if (!eventId) return false;
  const ev = await one('SELECT id, status FROM events WHERE id=$1', [eventId]);
  if (ev && ev.status === 'live') return true;
  try {
    for (const m of require('../../rooms/store').allMeetings().values()) {
      if (Number(m.eventId) === Number(eventId) && !m.ended) return true;
    }
  } catch (_) { /* ignore */ }
  return false;
}

function promoPrice(priceKobo, pct, live) {
  const price = Number(priceKobo);
  const d = Math.min(90, Math.max(0, Number(pct) || 0));
  if (!live || !d || !Number.isSafeInteger(price) || price <= 0) return price;
  return Math.max(0, Math.round(price * (100 - d) / 100));
}

async function purchased(materialId, userId) {
  if (!userId) return false;
  return !!(await one('SELECT 1 FROM material_purchases WHERE material_id=$1 AND user_id=$2', [materialId, userId]));
}

async function quote(material, { eventId, meetingCode, userId } = {}) {
  const sale = saleFields(material);
  if (!sale.forSale || !sale.priceKobo) throw fail(400, 'This material is not for sale');
  if (userId && await purchased(material.id, userId)) throw fail(409, 'You already have this material');
  const live = await isEventLive(eventId, meetingCode);
  const priceKobo = promoPrice(sale.priceKobo, sale.callDiscountPct, live);
  if (!priceKobo) throw fail(400, 'This material is not for sale at this price');
  const settings = await plans.platform(await plans.getSettings());
  const feeBps = settings.materialsFeeBps != null ? settings.materialsFeeBps : 2000;
  const split = plans.feeSplit(priceKobo, feeBps);
  const credits = Math.max(1, Math.ceil(priceKobo / PRICE_PER_CREDIT_KOBO));
  return { priceKobo, listPriceKobo: sale.priceKobo, promo: live && sale.callDiscountPct > 0, callDiscountPct: live ? sale.callDiscountPct : 0, feeBps, feeKobo: split.fee, netKobo: split.net, credits, creditUnits: credits * UNITS_PER_CREDIT };
}

async function buyWithCredits(user, material, { eventId, meetingCode } = {}) {
  if (!user || !user.id) throw fail(401, 'Sign in to buy this material');
  if (Number(material.ownerUserId || material.owner_user_id) === Number(user.id)) throw fail(409, 'You already own this material');
  const qte = await quote(material, { eventId, meetingCode, userId: user.id });
  const hostId = Number(material.ownerUserId || material.owner_user_id);
  const out = await tx(async (c) => {
    const exists = (await c.query('SELECT 1 FROM material_purchases WHERE material_id=$1 AND user_id=$2', [material.id, user.id])).rows[0];
    if (exists) throw fail(409, 'You already have this material');
    const lock = USE_PG ? ' FOR UPDATE' : '';
    const w = (await c.query(`SELECT * FROM credit_wallets WHERE user_id=$1${lock}`, [user.id])).rows[0];
    const bal = Number(w?.balance_units || 0);
    if (bal < qte.creditUnits) throw fail(402, `You need ${qte.credits} credits to buy this`, { creditsNeeded: qte.credits, balance: Math.floor(bal / UNITS_PER_CREDIT) });
    const after = bal - qte.creditUnits;
    await c.query('UPDATE credit_wallets SET balance_units=$2, updated_at=NOW() WHERE user_id=$1', [user.id, after]);
    await c.query("INSERT INTO credit_ledger(user_id,kind,delta_units,balance_after_units) VALUES($1,'material',$2,$3)", [user.id, -qte.creditUnits, after]);
    const row = (await c.query(
      `INSERT INTO material_purchases (material_id, user_id, event_id, paid_with, price_kobo, fee_kobo)
       VALUES ($1,$2,$3,'credits',$4,$5) RETURNING *`,
      [material.id, user.id, eventId || null, qte.priceKobo, qte.feeKobo]
    )).rows[0];
    if (hostId) {
      await c.query(
        `INSERT INTO host_ledger (host_user_id, kind, gross_kobo, fee_kobo, net_kobo) VALUES ($1,'sale',$2,$3,$4)`,
        [hostId, qte.priceKobo, qte.feeKobo, qte.netKobo]
      );
    }
    return row;
  });
  return { ok: true, paidWith: 'credits', purchaseId: Number(out.id), ...qte };
}

async function startPaystack(user, material, { eventId, meetingCode, returnPath } = {}) {
  if (!user || !user.id) throw fail(401, 'Sign in to buy this material');
  if (Number(material.ownerUserId || material.owner_user_id) === Number(user.id)) throw fail(409, 'You already own this material');
  const qte = await quote(material, { eventId, meetingCode, userId: user.id });
  const hostId = Number(material.ownerUserId || material.owner_user_id);
  const commerce = require('../commerce/service');
  const path = returnPath || (eventId ? `/e/${eventId}` : `/materials/${material.id}`);
  return commerce.initialize(user, {
    kind: 'material',
    hostUserId: hostId || null,
    eventId: eventId || null,
    priceKobo: qte.priceKobo,
    feeBps: qte.feeBps,
    feeKobo: qte.feeKobo,
    detail: { materialId: material.id, eventId: eventId || null, meetingCode: meetingCode || null },
  }, path);
}

async function grantFromPayment(c, payment) {
  const d = (() => { try { return typeof payment.detail === 'string' ? JSON.parse(payment.detail) : (payment.detail || {}); } catch { return {}; } })();
  const materialId = d.materialId || d.material_id;
  if (!materialId) throw fail(400, 'This payment is missing its material');
  const exists = (await c.query('SELECT 1 FROM material_purchases WHERE material_id=$1 AND user_id=$2', [materialId, payment.user_id])).rows[0];
  if (exists) return;
  await c.query(
    `INSERT INTO material_purchases (material_id, user_id, payment_id, event_id, paid_with, price_kobo, fee_kobo)
     VALUES ($1,$2,$3,$4,'paystack',$5,$6)`,
    [materialId, payment.user_id, payment.id, payment.event_id || d.eventId || null, Number(payment.subtotal_kobo ?? payment.price_kobo), Number(payment.fee_kobo || 0)]
  );
}

async function accessFor(materialId, userId, { ownerId } = {}) {
  if (userId && ownerId && Number(userId) === Number(ownerId)) return { purchased: true, owner: true };
  return { purchased: await purchased(materialId, userId), owner: false };
}

module.exports = { saleFields, sanitizeSale, isEventLive, promoPrice, purchased, quote, buyWithCredits, startPaystack, grantFromPayment, accessFor };
