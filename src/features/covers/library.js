/**
 * Platform library of AI-generated covers (never user uploads) with text embeddings.
 * Postgres uses pgvector when the extension is available; otherwise (and on SQLite)
 * embeddings are JSON float arrays compared with cosine similarity in JS.
 */
const { q, one, many } = require('../../core/db');
const { run } = require('../../lib/replicate');

const CAT_GROUP = {
  sermon: 'faith',
  concert: 'performance',
  talk_show: 'performance',
  seminar: 'learning',
  webinar: 'learning',
  workshop: 'learning',
  presentation: 'learning',
  class: 'learning',
  meeting: 'meeting',
  other: 'other',
};

function categoryClash(a, b) {
  const ga = CAT_GROUP[a] || 'other';
  const gb = CAT_GROUP[b] || 'other';
  if (ga === 'other' || gb === 'other' || !a || !b) return false;
  return ga !== gb;
}

function cosine(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || !a.length || a.length !== b.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    const x = Number(a[i]) || 0, y = Number(b[i]) || 0;
    dot += x * y; na += x * x; nb += y * y;
  }
  const d = Math.sqrt(na) * Math.sqrt(nb);
  return d ? dot / d : 0;
}

function parseEmbedding(raw) {
  if (Array.isArray(raw)) return raw.map(Number);
  if (typeof raw === 'string') {
    try { const j = JSON.parse(raw); return Array.isArray(j) ? j.map(Number) : []; } catch { return []; }
  }
  return [];
}

function embeddingFromOutput(out) {
  if (!out) return [];
  if (Array.isArray(out) && typeof out[0] === 'number') return out.map(Number);
  if (Array.isArray(out) && Array.isArray(out[0])) return out[0].map(Number);
  if (out.embeddings && Array.isArray(out.embeddings[0])) return out.embeddings[0].map(Number);
  if (Array.isArray(out.data) && out.data[0] && Array.isArray(out.data[0].embedding)) return out.data[0].embedding.map(Number);
  if (typeof out === 'string') return parseEmbedding(out);
  return [];
}

async function embedText(text, config) {
  const token = config.STT.replicate.token;
  const model = config.COVERS.embedModel;
  if (!token || !model || !String(text || '').trim()) return [];
  try {
    const r = await run({
      token, apiBase: config.STT.replicate.apiBase, model,
      input: { texts: JSON.stringify([String(text).slice(0, 1500)]), text: String(text).slice(0, 1500) },
      timeoutMs: 20_000, tag: 'embed', wait: 10,
    });
    return embeddingFromOutput(r.output);
  } catch (e) {
    console.error('[covers] embed failed', e.status || '', e.detail || e.message);
    return [];
  }
}

let vectorReady = null;
async function ensureVector() {
  if (vectorReady != null) return vectorReady;
  if (process.env.DB_DRIVER === 'sqlite') return (vectorReady = false);
  try {
    await q('CREATE EXTENSION IF NOT EXISTS vector');
    await q('ALTER TABLE cover_library ADD COLUMN IF NOT EXISTS embedding_vec vector');
    vectorReady = true;
  } catch (e) {
    console.warn('[covers] pgvector not available, using JS cosine:', e.message);
    vectorReady = false;
  }
  return vectorReady;
}

const sessions = new Map(); // session -> { ids: number[], at }
function shownIds(session) {
  const s = String(session || '');
  if (!s) return [];
  const row = sessions.get(s);
  if (!row) return [];
  if (Date.now() - row.at > 2 * 3600_000) { sessions.delete(s); return []; }
  return row.ids || [];
}
function rememberShown(session, id) {
  const s = String(session || '');
  if (!s || !id) return;
  const row = sessions.get(s) || { ids: [], at: Date.now() };
  if (!row.ids.includes(id)) row.ids.push(id);
  row.at = Date.now();
  sessions.set(s, row);
}

function pickReuse({ attempt, scored, threshold, excludeIds }) {
  const skip = new Set((excludeIds || []).map(Number));
  const ok = scored.filter((x) => x.score >= threshold && !skip.has(Number(x.row.id)))
    .sort((a, b) => b.score - a.score);
  if (attempt <= 1) return ok[0] || null;
  if (attempt === 2) return ok[1] || ok.find((x) => !skip.has(Number(x.row.id))) || null;
  return null;
}

async function findMatch({ scene, category, userId, attempt, session, exclude = [], threshold, now = Date.now() }) {
  if (attempt >= 3) return null;
  const rows = await many('SELECT id, file_id, url, scene_text, category, accent, accent2, embedding FROM cover_library').catch(() => []);
  if (!rows.length) return null;
  const weekAgo = new Date(now - 7 * 86400_000).toISOString();
  const usedByHost = userId
    ? await many('SELECT library_id FROM cover_library_uses WHERE user_id=$1', [userId]).catch(() => [])
    : [];
  const usedRecent = await many(
    "SELECT library_id FROM cover_library_uses WHERE used_at >= $1 AND (event_id IS NOT NULL OR user_id <> $2)",
    [weekAgo, userId || 0],
  ).catch(() => []);
  const banned = new Set([
    ...usedByHost.map((r) => Number(r.library_id)),
    ...usedRecent.map((r) => Number(r.library_id)),
    ...shownIds(session),
    ...exclude.map(Number),
  ]);
  const scored = [];
  for (const row of rows) {
    if (banned.has(Number(row.id))) continue;
    if (categoryClash(category, row.category)) continue;
    const score = cosine(scene, parseEmbedding(row.embedding));
    scored.push({ row, score });
  }
  const hit = pickReuse({ attempt, scored, threshold, excludeIds: [...shownIds(session), ...exclude] });
  return hit;
}

async function saveEntry({ fileId, url, sceneText, category, accent, accent2, embedding, userId }) {
  const vecOn = await ensureVector();
  const emb = process.env.DB_DRIVER === 'sqlite' ? JSON.stringify(embedding || []) : (embedding || []);
  let row;
  if (vecOn && embedding && embedding.length) {
    const literal = '[' + embedding.map(Number).join(',') + ']';
    row = await one(
      `INSERT INTO cover_library (file_id, url, scene_text, category, accent, accent2, embedding, embedding_vec, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8::vector,$9) RETURNING *`,
      [fileId || null, url, sceneText, category || null, accent || null, accent2 || null, emb, literal, userId || null],
    ).catch(async (e) => {
      console.warn('[covers] vector insert failed, storing JSON only', e.message);
      return one(
        `INSERT INTO cover_library (file_id, url, scene_text, category, accent, accent2, embedding, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
        [fileId || null, url, sceneText, category || null, accent || null, accent2 || null, emb, userId || null],
      );
    });
  } else {
    row = await one(
      `INSERT INTO cover_library (file_id, url, scene_text, category, accent, accent2, embedding, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [fileId || null, url, sceneText, category || null, accent || null, accent2 || null, emb, userId || null],
    );
  }
  return row;
}

async function recordUse({ libraryId, userId, eventId }) {
  if (!libraryId) return;
  await q('INSERT INTO cover_library_uses (library_id, user_id, event_id) VALUES ($1,$2,$3)', [libraryId, userId || null, eventId || null]);
}

async function loadFileBuffer(fileId) {
  if (!fileId) return null;
  const row = await one('SELECT * FROM files WHERE id=$1', [fileId]);
  if (!row) return null;
  const storage = require('../../venue/storage');
  const { stream } = await storage.open(row);
  const chunks = [];
  for await (const c of stream) chunks.push(c);
  return { buf: Buffer.concat(chunks), mime: row.mime || 'image/webp' };
}

module.exports = {
  categoryClash, cosine, parseEmbedding, embeddingFromOutput, embedText,
  pickReuse, findMatch, saveEntry, recordUse, loadFileBuffer, rememberShown, shownIds, ensureVector, CAT_GROUP,
};
