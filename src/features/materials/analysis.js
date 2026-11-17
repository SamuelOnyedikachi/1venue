/**
 * Material analysis: extract text on the server, send a capped excerpt to Llama 3 70B Instruct on
 * Replicate, store the result (material_analyses) so each file is analysed — and charged — once.
 * Spreadsheet numbers (columns, row count, min / max / mean) are computed locally; the model only comments.
 * AI_MOCK=true or no REPLICATE_API_TOKEN: a local heuristic result, same shape, marked mock: true.
 */
const { cleanText, cleanList } = require('../../lib/safe-text');
const crypto = require('node:crypto');
const config = require('../../config');
const log = require('../../lib/log');
const { extract } = require('./extract');

const fail = (status, message) => Object.assign(new Error(message), { status, expose: true });
const sourceOf = (m) => {
  const p = m.payload || {};
  if (p.sourceUrl) return { url: p.sourceUrl, name: p.sourceName || m.title, mime: p.sourceMime || '' };
  return null;
};
/** Cache key: changes when the material's file changes. */
const sourceKey = (m) => { const s = sourceOf(m); return s ? crypto.createHash('sha1').update(`${m.kind}|${s.url}`).digest('hex') : null; };

/** Read an uploaded file's bytes from storage, by its stored URL (/files/<id>/… or the S3 public base). */
async function readStored(url, maxBytes = 50 * 1048576) {
  const { one } = require('../../core/db');
  const storage = require('../../venue/storage');
  let row = null;
  const m = /^\/files\/([\w-]{10,40})\//.exec(url);
  if (m) row = await one('SELECT * FROM files WHERE id=$1', [m[1]]);
  else {
    const base = String((config.STORAGE.s3 && config.STORAGE.s3.publicBaseUrl) || '').replace(/\/$/, '');
    if (base && url.startsWith(base + '/')) {
      const key = url.slice(base.length + 1).split('/').map((s) => { try { return decodeURIComponent(s); } catch { return s; } }).join('/');
      row = await one('SELECT * FROM files WHERE object_key=$1', [key]);
    }
  }
  if (!row) throw fail(404, 'The original file is no longer in storage');
  const f = await storage.open(row);
  if (f.buffer) return { buf: f.buffer, row };
  const chunks = []; let n = 0;
  for await (const c of f.stream) { n += c.length; if (n > maxBytes) { f.stream.destroy(); throw fail(413, 'This file is too large to analyse'); } chunks.push(c); }
  return { buf: Buffer.concat(chunks), row };
}

/** Extract once per process for previews (small LRU); analysis re-extracts only when it is not cached in the DB. */
const lru = new Map();
async function extracted(m) {
  const key = sourceKey(m);
  if (!key) throw fail(422, 'This material has no original file to read. Upload it again to analyse it.');
  if (lru.has(key)) { const v = lru.get(key); lru.delete(key); lru.set(key, v); return v; }
  const s = sourceOf(m);
  const { buf, row } = await readStored(s.url);
  const out = await extract({ buf, name: s.name || row.filename, mime: s.mime || row.mime });
  lru.set(key, out); if (lru.size > 20) lru.delete(lru.keys().next().value);
  return out;
}
/** Preview for the material page: text excerpt (documents) or a table (spreadsheets). */
async function preview(m) {
  const x = await extracted(m);
  if (x.preview) return { type: x.type, table: x.preview, sheets: x.sheets || [], stats: { rowCount: x.stats.rowCount, columns: x.stats.columns.length } };
  return { type: x.type, text: x.text.slice(0, 6000), truncated: x.text.length > 6000, chars: x.text.length };
}

// ---------------------------------------------------------------- LLM
const SYSTEM = 'You analyse documents for a live-events and meetings app. Reply with one JSON object only, no prose before or after it.';
function prompt(m, x, excerpt) {
  const sheet = !!x.stats;
  const shape = sheet
    ? '{"summary": "2-4 sentences", "keyPoints": ["3-6 short points"], "dataCommentary": "2-4 sentences on trends, outliers and data quality, using the stats given"}'
    : '{"summary": "2-4 sentences", "keyPoints": ["3-7 short points"]}';
  const stats = sheet ? `\nColumn stats (computed exactly, trust these numbers): ${JSON.stringify(x.stats.columns.slice(0, 25))}\nRows: ${x.stats.rowCount}\n` : '';
  return `Analyse this ${({ pdf: 'PDF', docx: 'Word document', doc: 'Word document', pptx: 'presentation', ppt: 'presentation', csv: 'CSV spreadsheet', xlsx: 'Excel spreadsheet', xls: 'Excel spreadsheet' })[x.type] || 'file'} titled "${m.title}".${stats}\nContent excerpt:\n"""\n${excerpt}\n"""\n\nReturn JSON exactly in this shape: ${shape}`;
}
function parseJson(text) {
  const t = String(text || '');
  const a = t.indexOf('{'), b = t.lastIndexOf('}');
  if (a >= 0 && b > a) { try { return JSON.parse(t.slice(a, b + 1)); } catch { /* fall through */ } }
  return { summary: cleanText(t, { max: 1500 }), keyPoints: [] };
}
const clean = (o, sheet) => ({
  summary: cleanText(o.summary, { max: 2000 }),
  keyPoints: cleanList(o.keyPoints, { max: 300, limit: 8 }),
  ...(sheet ? { dataCommentary: cleanText(o.dataCommentary, { max: 2000 }) } : {}),
});

function mockResult(m, x) {
  const sentences = String(x.text || '').replace(/\s+/g, ' ').split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter((s) => s.length > 20);
  const words = String(x.text || '').toLowerCase().match(/[a-z\u00c0-\u024f]{5,}/g) || [];
  const freq = new Map(); for (const w of words) freq.set(w, (freq.get(w) || 0) + 1);
  const top = [...freq].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([w]) => w);
  if (x.stats) {
    const nums = x.stats.columns.filter((c) => c.type === 'number');
    return {
      summary: `“${m.title}” has ${x.stats.rowCount} row${x.stats.rowCount === 1 ? '' : 's'} across ${x.stats.columns.length} column${x.stats.columns.length === 1 ? '' : 's'} (${nums.length} numeric).`,
      keyPoints: x.stats.columns.slice(0, 6).map((c) => (c.type === 'number' ? `${c.name}: ${c.min} to ${c.max}, average ${c.mean}` : `${c.name}: ${c.distinct} distinct value${c.distinct === 1 ? '' : 's'}${c.top && c.top[0] ? `, most common “${c.top[0].value}”` : ''}`)),
      dataCommentary: nums.length ? `The numeric columns are ${nums.map((c) => c.name).join(', ')}. ${x.stats.columns.some((c) => c.empty) ? 'Some cells are empty.' : 'No empty cells were found.'}` : 'No numeric columns were found.',
    };
  }
  return {
    summary: sentences.slice(0, 2).join(' ').slice(0, 600) || `“${m.title}” contains little readable text.`,
    keyPoints: [...sentences.slice(2, 5).map((s) => s.slice(0, 200)), ...(top.length ? [`Frequent terms: ${top.join(', ')}`] : [])],
  };
}

async function callModel(m, x) {
  const excerpt = x.text.slice(0, Math.max(1000, config.MATERIALS.maxChars));
  const token = config.STT.replicate.token;
  if (config.AI.mock || !token) return { result: mockResult(m, x), model: 'mock', mock: true };
  const { run } = require('../../lib/replicate');
  const out = await run({
    token, apiBase: config.STT.replicate.apiBase, model: config.MATERIALS.model, tag: 'materials', timeoutMs: config.MATERIALS.timeoutMs, wait: 60,
    input: { prompt: prompt(m, x, excerpt), system_prompt: SYSTEM, max_tokens: 900, temperature: 0.3 },
  });
  const text = Array.isArray(out.output) ? out.output.join('') : String(out.output || '');
  return { result: parseJson(text), model: config.MATERIALS.model, mock: false };
}

const inflight = new Map();
/**
 * analyse(material, { userId, takeAi }) -> stored analysis. Cached per source file; only a fresh
 * analysis spends AI points (weight "analysis", default 2), and a failed call refunds them.
 */
async function analyse(m, { userId, force = false, data, takeAi }) {
  const key = sourceKey(m);
  if (!key) throw fail(422, 'This material has no original file to read. Upload it again to analyse it.');
  if (!force) { const cached = await data.getAnalysis(m.id); if (cached && cached.sourceKey === key) return { ...cached, cached: true }; }
  if (inflight.has(m.id)) return inflight.get(m.id);
  const job = (async () => {
    const x = await extracted(m);
    if (!String(x.text || '').trim()) throw fail(422, 'No readable text was found in this file');
    const t = await takeAi({ kind: 'analysis', ownerId: userId });
    if (!t.ok) throw fail(429, `Not enough AI points left today (${t.left} of ${t.limit}). Upgrade your plan for more.`);
    let r;
    try { r = await callModel(m, x); } catch (e) { await t.refund(); throw e; }
    const sheet = !!x.stats;
    const result = { ...clean(r.result, sheet), type: x.type, mock: r.mock, cost: t.cost, ...(sheet ? { data: { rowCount: x.stats.rowCount, columns: x.stats.columns, truncated: !!x.stats.truncated, sheets: x.sheets || [] } } : { chars: x.text.length }) };
    const saved = await data.saveAnalysis(m.id, { sourceKey: key, result, model: r.model, userId });
    log.info('materials', 'analysed', { id: m.id, user: userId, type: x.type, model: r.model, cost: t.cost, chars: x.text.length });
    return { ...saved, cached: false };
  })();
  inflight.set(m.id, job);
  try { return await job; } finally { inflight.delete(m.id); }
}

// ---------------------------------------------------------------- follow-up questions (owner only)
/** Plain-text answer from the excerpt when there is no model: the sentences that share the most words. */
function mockAnswer(question, text) {
  const words = String(question).toLowerCase().match(/[a-z\u00c0-\u024f0-9]{4,}/g) || [];
  const sentences = String(text || '').replace(/\s+/g, ' ').split(/(?<=[.!?])\s+/).filter((x) => x.length > 15);
  const scored = sentences.map((x) => ({ x, n: words.filter((w) => x.toLowerCase().includes(w)).length })).filter((s) => s.n > 0).sort((a, b) => b.n - a.n).slice(0, 3);
  return scored.length ? scored.map((s) => s.x.slice(0, 300)).join(' ') : 'I couldn’t find that in the file. Try asking about something it mentions.';
}
/**
 * ask(material, { userId, question, takeAi }) -> stored { id, question, answer, ... }.
 * Uses the extracted text, the saved summary and the last few questions as context. Charged like analysis.
 */
async function ask(m, { userId, question, takeAi }) {
  const { one, many } = require('../../core/db');
  const qText = String(question || '').trim().slice(0, 500);
  if (qText.length < 3) throw fail(400, 'Type a question about this file');
  if (!sourceKey(m)) throw fail(422, 'This material has no original file to read. Upload it again to ask about it.');
  const x = await extracted(m);
  if (!String(x.text || '').trim()) throw fail(422, 'No readable text was found in this file');
  const t = await takeAi({ kind: 'analysis', ownerId: userId });
  if (!t.ok) throw fail(429, `Not enough AI points left today (${t.left} of ${t.limit}). Upgrade your plan for more.`);
  let answer, model;
  try {
    const token = config.STT.replicate.token;
    if (config.AI.mock || !token) { answer = mockAnswer(qText, x.text); model = 'mock'; }
    else {
      const prev = (await many('SELECT question, answer FROM material_queries WHERE material_id=$1 ORDER BY id DESC LIMIT 4', [m.id])).reverse();
      const a = await one('SELECT result FROM material_analyses WHERE material_id=$1', [m.id]).catch(() => null);
      let summary = ''; try { summary = a ? (typeof a.result === 'string' ? JSON.parse(a.result) : a.result).summary || '' : ''; } catch { /* none */ }
      const stats = x.stats ? `\nColumn stats (exact): ${JSON.stringify(x.stats.columns.slice(0, 25))}\nRows: ${x.stats.rowCount}` : '';
      const history = prev.map((p) => `Q: ${p.question}\nA: ${p.answer}`).join('\n\n');
      const fence = '"""';
      const prompt = `File: "${m.title}"${summary ? `\nSummary: ${summary}` : ''}${stats}\nContent excerpt:\n${fence}\n${x.text.slice(0, Math.max(1000, config.MATERIALS.maxChars))}\n${fence}\n${history ? `\nEarlier questions:\n${history}\n` : ''}\nAnswer the question using only the file. If the file does not say, say so briefly. Plain text, under 180 words.\nQuestion: ${qText}`;
      const { run } = require('../../lib/replicate');
      const out = await run({ token, apiBase: config.STT.replicate.apiBase, model: config.MATERIALS.model, tag: 'materials-ask', timeoutMs: config.MATERIALS.timeoutMs, wait: 60,
        input: { prompt, system_prompt: 'You answer questions about one document for its owner. Be accurate and concise.', max_tokens: 500, temperature: 0.2 } });
      answer = (Array.isArray(out.output) ? out.output.join('') : String(out.output || '')).trim();
      model = config.MATERIALS.model;
    }
  } catch (e) { await t.refund(); throw e; }
  answer = cleanText(answer, { max: 4000 }) || 'No answer came back. Try rephrasing.';
  const row = await one('INSERT INTO material_queries (material_id, user_id, question, answer, model, cost) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *', [m.id, userId, qText, answer, model, t.cost]);
  log.info('materials', 'question', { id: m.id, user: userId, model, cost: t.cost });
  return queryOut(row);
}
const queryOut = (r) => ({ id: Number(r.id), question: r.question, answer: r.answer, model: r.model, mock: r.model === 'mock', cost: Number(r.cost) || 0, createdAt: r.created_at });
async function listQueries(materialId) {
  const { many } = require('../../core/db');
  return (await many('SELECT * FROM material_queries WHERE material_id=$1 ORDER BY id LIMIT 100', [materialId])).map(queryOut);
}

module.exports = { analyse, preview, sourceKey, readStored, mockResult, parseJson, callModel, ask, listQueries, mockAnswer, _lru: lru };
