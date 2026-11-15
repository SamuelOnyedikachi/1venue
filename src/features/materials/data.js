/**
 * materials queries (PostgreSQL, parameterised). Split out of src/venue/data.js;
 * src/venue/data.js still re-exports everything for older call sites.
 */
const { q, one, many } = require('../../core/db');
const { normalizeStoredFileUrl } = require('../../lib/file-url');

// ---------------------------------------------------------------- materials
function materialOut(r) {
  if (!r) return null;
  const payload = typeof r.payload === 'string' ? JSON.parse(r.payload) : (r.payload || {});
  return {
    id: Number(r.id),
    title: r.title,
    kind: r.kind,
    payload,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
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
  // slides | pdf | pptx — store page image URLs (+ optional source meta)
  const raw = Array.isArray(p.pages) ? p.pages : [];
  const pages = raw.map(normalizeStoredFileUrl).filter(Boolean).slice(0, 200);
  if (!pages.length) {
    const e = new Error(raw.length ? 'Those pages were not uploaded to 1venue storage — try the upload again' : 'Add at least one page or image');
    e.status = 400; e.reason = raw.length ? `0 of ${raw.length} page urls accepted (first: ${String(raw[0]).slice(0, 120)})` : 'no pages';
    throw e;
  }
  return {
    pages,
    sourceName: p.sourceName ? String(p.sourceName).slice(0, 120) : null,
    sourceMime: p.sourceMime ? String(p.sourceMime).slice(0, 80) : null,
  };
}
async function listMaterials(userId, { limit = 50 } = {}) {
  const rows = await many(
    `SELECT * FROM materials WHERE owner_user_id=$1 ORDER BY updated_at DESC LIMIT $2`,
    [userId, Math.min(100, Math.max(1, limit))]
  );
  return rows.map(materialOut);
}
async function getMaterial(id, userId) {
  const r = await one(`SELECT * FROM materials WHERE id=$1 AND owner_user_id=$2`, [id, userId]);
  return materialOut(r);
}
async function createMaterial(userId, { title, kind, payload }) {
  const k = ['slides', 'image', 'youtube', 'pdf', 'pptx'].includes(kind) ? kind : 'slides';
  const t = String(title || 'Untitled').trim().slice(0, 120) || 'Untitled';
  const pl = sanitizeMaterialPayload(k, payload);
  const r = await one(
    `INSERT INTO materials (owner_user_id, title, kind, payload) VALUES ($1,$2,$3,$4) RETURNING *`,
    [userId, t, k, JSON.stringify(pl)]
  );
  return materialOut(r);
}
async function updateMaterial(id, userId, { title, payload } = {}) {
  const cur = await one(`SELECT * FROM materials WHERE id=$1 AND owner_user_id=$2`, [id, userId]);
  if (!cur) return null;
  const t = title != null ? (String(title).trim().slice(0, 120) || cur.title) : cur.title;
  const pl = payload != null ? sanitizeMaterialPayload(cur.kind, payload) : (typeof cur.payload === 'string' ? JSON.parse(cur.payload) : cur.payload);
  const r = await one(
    `UPDATE materials SET title=$3, payload=$4, updated_at=NOW() WHERE id=$1 AND owner_user_id=$2 RETURNING *`,
    [id, userId, t, JSON.stringify(pl)]
  );
  return materialOut(r);
}
async function deleteMaterial(id, userId) {
  const r = await q(`DELETE FROM materials WHERE id=$1 AND owner_user_id=$2`, [id, userId]);
  return r.rowCount > 0;
}
async function listEventMaterials(eventId) {
  const rows = await many(
    `SELECT m.* FROM event_materials em JOIN materials m ON m.id=em.material_id
     WHERE em.event_id=$1 ORDER BY em.sort_order, m.title`,
    [eventId]
  );
  return rows.map(materialOut);
}
async function setEventMaterials(eventId, userId, materialIds) {
  const ev = await one(`SELECT id FROM events WHERE id=$1 AND host_user_id=$2`, [eventId, userId]);
  if (!ev) { const e = new Error('Event not found'); e.status = 404; throw e; }
  const ids = (Array.isArray(materialIds) ? materialIds : []).map(Number).filter(Boolean).slice(0, 40);
  await q(`DELETE FROM event_materials WHERE event_id=$1`, [eventId]);
  for (let i = 0; i < ids.length; i++) {
    const m = await one(`SELECT id FROM materials WHERE id=$1 AND owner_user_id=$2`, [ids[i], userId]);
    if (m) await q(`INSERT INTO event_materials (event_id, material_id, sort_order) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, [eventId, ids[i], i]);
  }
  return listEventMaterials(eventId);
}

module.exports = { materialOut, sanitizeMaterialPayload, listMaterials, getMaterial, createMaterial, updateMaterial, deleteMaterial, listEventMaterials, setEventMaterials };
