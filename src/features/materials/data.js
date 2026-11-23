/**
 * materials queries (PostgreSQL, parameterised). Split out of src/venue/data.js;
 * src/venue/data.js still re-exports everything for older call sites.
 */
const { q, one, many } = require('../../core/db');
const { normalizeStoredFileUrl } = require('../../lib/file-url');

// ---------------------------------------------------------------- materials
const KINDS = ['slides', 'image', 'youtube', 'pdf', 'pptx', 'doc', 'sheet'];
function materialOut(r) {
  if (!r) return null;
  const payload = typeof r.payload === 'string' ? JSON.parse(r.payload) : (r.payload || {});
  const sale = require('./sale').saleFields(r);
  return {
    id: Number(r.id),
    title: r.title,
    kind: r.kind,
    payload,
    createdAt: r.created_at,
    ownerUserId: r.owner_user_id, orgId: r.org_id || null,
    updatedAt: r.updated_at,
    ...sale,
  };
}
function lockedPayload(m) {
  const p = m.payload || {};
  if (Array.isArray(p.pages) && p.pages.length) return { pages: p.pages.slice(0, 1) };
  if (p.url) return { url: p.url };
  if (p.videoId) return { videoId: p.videoId, url: p.url };
  return {};
}
async function withAccess(m, userId, { eventId, live } = {}) {
  if (!m) return m;
  const sale = require('./sale');
  const acc = await sale.accessFor(m.id, userId, { ownerId: m.ownerUserId });
  m.purchased = acc.purchased;
  m.owner = acc.owner;
  if (m.forSale && m.priceKobo && (live || (eventId && await sale.isEventLive(eventId)))) {
    m.promoPriceKobo = sale.promoPrice(m.priceKobo, m.callDiscountPct, true);
    m.callDiscountLive = m.promoPriceKobo !== m.priceKobo;
  }
  if (m.forSale && !acc.purchased && !acc.owner) {
    m.locked = true;
    m.payload = lockedPayload(m);
  } else m.locked = false;
  return m;
}
function sanitizeMaterialPayload(kind, payload) {
  const p = payload && typeof payload === 'object' ? payload : {};
  if (kind === 'youtube') {
    const videoId = String(p.videoId || '').trim();
    if (!/^[\w-]{11}$/.test(videoId)) { const e = new Error('Invalid YouTube video'); e.status = 400; throw e; }
    return { videoId, url: `https://www.youtube.com/watch?v=${videoId}` };
  }
  if (kind === 'image') {
    const url = normalizeStoredFileUrl(String(p.url || ''));
    if (!url) { const e = new Error('Image must be a file uploaded to 1venue'); e.status = 400; e.reason = `image url not accepted: ${String(p.url || '').slice(0, 120) || '(empty)'}`; throw e; }
    return { url };
  }
  const source = {
    sourceName: p.sourceName ? String(p.sourceName).slice(0, 120) : null,
    sourceMime: p.sourceMime ? String(p.sourceMime).slice(0, 120) : null,
    // The original file (PDF / PPTX / DOCX / XLSX / CSV) as uploaded, so it can be analysed and downloaded.
    sourceUrl: p.sourceUrl ? normalizeStoredFileUrl(String(p.sourceUrl)) : null,
    sourceSize: Number.isFinite(Number(p.sourceSize)) && Number(p.sourceSize) > 0 ? Math.round(Number(p.sourceSize)) : null,
  };
  if (p.sourceUrl && !source.sourceUrl) { const e = new Error('That file was not uploaded to 1venue storage - try the upload again'); e.status = 400; e.reason = `source url not accepted: ${String(p.sourceUrl).slice(0, 120)}`; throw e; }
  if (kind === 'doc' || kind === 'sheet') {
    // Word documents and spreadsheets: the file itself; previews are extracted on the server.
    if (!source.sourceUrl) { const e = new Error('Upload the file first'); e.status = 400; e.reason = 'no source url'; throw e; }
    return source;
  }
  // slides | pdf | pptx - store page image URLs (+ optional source meta)
  const raw = Array.isArray(p.pages) ? p.pages : [];
  const pages = raw.map(normalizeStoredFileUrl).filter(Boolean).slice(0, 200);
  if (!pages.length) {
    const e = new Error(raw.length ? 'Those pages were not uploaded to 1venue storage - try the upload again' : 'Add at least one page or image');
    e.status = 400; e.reason = raw.length ? `0 of ${raw.length} page urls accepted (first: ${String(raw[0]).slice(0, 120)})` : 'no pages';
    throw e;
  }
  return { pages, ...source };
}
async function listMaterials(userId, { limit = 50 } = {}) {
  const rows = await many(
    // Own materials plus the shared library of every organisation the user belongs to.
    `SELECT * FROM materials WHERE owner_user_id=$1 OR (org_id IS NOT NULL AND org_id IN (SELECT org_id FROM org_members WHERE user_id=$1)) ORDER BY updated_at DESC LIMIT $2`,
    [userId, Math.min(100, Math.max(1, limit))]
  );
  return rows.map(materialOut);
}
async function getMaterial(id, userId) {
  const r = await one(`SELECT * FROM materials WHERE id=$1 AND (owner_user_id=$2 OR (org_id IS NOT NULL AND org_id IN (SELECT org_id FROM org_members WHERE user_id=$2)))`, [id, userId]);
  return materialOut(r);
}
async function createMaterial(userId, { title, kind, payload }) {
  const k = KINDS.includes(kind) ? kind : 'slides';
  const t = String(title || 'Untitled').trim().slice(0, 120) || 'Untitled';
  const pl = sanitizeMaterialPayload(k, payload);
  const r = await one(
    `INSERT INTO materials (owner_user_id, title, kind, payload) VALUES ($1,$2,$3,$4) RETURNING *`,
    [userId, t, k, JSON.stringify(pl)]
  );
  return materialOut(r);
}
async function updateMaterial(id, userId, { title, payload, forSale, priceKobo, callDiscountPct } = {}) {
  const cur = await one(`SELECT * FROM materials WHERE id=$1 AND owner_user_id=$2`, [id, userId]);
  if (!cur) return null;
  const t = title != null ? (String(title).trim().slice(0, 120) || cur.title) : cur.title;
  const pl = payload != null ? sanitizeMaterialPayload(cur.kind, payload) : (typeof cur.payload === 'string' ? JSON.parse(cur.payload) : cur.payload);
  const sale = require('./sale').sanitizeSale({ forSale, priceKobo, callDiscountPct });
  const for_sale = sale.for_sale != null ? sale.for_sale : cur.for_sale;
  const price_kobo = sale.price_kobo !== undefined ? sale.price_kobo : cur.price_kobo;
  const call_discount_pct = sale.call_discount_pct != null ? sale.call_discount_pct : cur.call_discount_pct;
  if ((for_sale === true || for_sale === 1) && (price_kobo == null || Number(price_kobo) < 5000)) {
    const e = new Error('Set a price of at least ₦50 to mark this for sale'); e.status = 400; throw e;
  }
  const r = await one(
    `UPDATE materials SET title=$3, payload=$4, for_sale=$5, price_kobo=$6, call_discount_pct=$7, updated_at=NOW() WHERE id=$1 AND owner_user_id=$2 RETURNING *`,
    [id, userId, t, JSON.stringify(pl), for_sale, price_kobo, call_discount_pct || 0]
  );
  return materialOut(r);
}
async function deleteMaterial(id, userId) {
  const r = await q(`DELETE FROM materials WHERE id=$1 AND owner_user_id=$2`, [id, userId]);
  return r.rowCount > 0;
}
async function listEventMaterials(eventId, userId) {
  const rows = await many(
    `SELECT m.* FROM event_materials em JOIN materials m ON m.id=em.material_id
     WHERE em.event_id=$1 ORDER BY em.sort_order, m.title`,
    [eventId]
  );
  const live = await require('./sale').isEventLive(eventId);
  const out = [];
  for (const r of rows) out.push(await withAccess(materialOut(r), userId, { eventId, live }));
  return out;
}
async function setEventMaterials(eventId, userId, materialIds) {
  const ev = await one(`SELECT id FROM events WHERE id=$1 AND host_user_id=$2`, [eventId, userId]);
  if (!ev) { const e = new Error('Event not found'); e.status = 404; throw e; }
  const ids = (Array.isArray(materialIds) ? materialIds : []).map(Number).filter(Boolean).slice(0, 40);
  await q(`DELETE FROM event_materials WHERE event_id=$1`, [eventId]);
  for (let i = 0; i < ids.length; i++) {
    const m = await one(`SELECT id FROM materials WHERE id=$1 AND (owner_user_id=$2 OR (org_id IS NOT NULL AND org_id IN (SELECT org_id FROM org_members WHERE user_id=$2)))`, [ids[i], userId]);
    if (m) await q(`INSERT INTO event_materials (event_id, material_id, sort_order) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, [eventId, ids[i], i]);
  }
  return listEventMaterials(eventId);
}

/**
 * A material someone may open on its own page: their own, their organisation's shared library, or one
 * attached to a public event (or an event they host). Returns { material, canEdit } or null.
 */
async function viewableMaterial(id, userId) {
  if (userId) {
    const own = await getMaterial(id, userId);
    if (own) return { material: own, canEdit: true };
    if (await require('./sale').purchased(id, userId)) {
      const bought = await one('SELECT * FROM materials WHERE id=$1', [id]);
      return bought ? { material: await withAccess(materialOut(bought), userId), canEdit: false } : null;
    }
  }
  const r = await one(
    `SELECT m.* FROM materials m WHERE m.id=$1 AND EXISTS (SELECT 1 FROM event_materials em JOIN events e ON e.id=em.event_id
       WHERE em.material_id=m.id AND (e.visibility='public' OR e.host_user_id=$2))`,
    [id, userId || 0]
  );
  const m = r ? await withAccess(materialOut(r), userId) : null;
  return m ? { material: m, canEdit: false } : null;
}
function analysisOut(r) {
  if (!r) return null;
  let result = {}; try { result = (typeof r.result === 'string' ? JSON.parse(r.result) : r.result) || {}; } catch { /* damaged row */ }
  const { cleanText, cleanList } = require('../../lib/safe-text');
  const out = { ...result, summary: cleanText(result.summary, { max: 2000 }), keyPoints: cleanList(result.keyPoints, { max: 300, limit: 8 }) };
  if (result.dataCommentary !== undefined) out.dataCommentary = cleanText(result.dataCommentary, { max: 2000 });
  return { ...out, sourceKey: r.source_key, model: r.model, createdAt: r.created_at };
}
async function getAnalysis(materialId) {
  return analysisOut(await one(`SELECT * FROM material_analyses WHERE material_id=$1`, [materialId]));
}
async function saveAnalysis(materialId, { sourceKey, result, model, userId }) {
  const r = await one(
    `INSERT INTO material_analyses (material_id, source_key, result, model, created_by) VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (material_id) DO UPDATE SET source_key=EXCLUDED.source_key, result=EXCLUDED.result, model=EXCLUDED.model, created_by=EXCLUDED.created_by, created_at=NOW()
     RETURNING *`,
    [materialId, sourceKey, JSON.stringify(result), model || null, userId || null]
  );
  return analysisOut(r);
}

module.exports = { KINDS, viewableMaterial, getAnalysis, saveAnalysis, materialOut, withAccess, sanitizeMaterialPayload, listMaterials, getMaterial, createMaterial, updateMaterial, deleteMaterial, listEventMaterials, setEventMaterials };
