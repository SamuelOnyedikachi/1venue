/**
 * Text and table extraction for materials, with no npm dependency.
 *   DOCX / PPTX / XLSX  minimal zip reader + regex XML parsing (all three are zips of XML parts)
 *   CSV                 quote-aware parser, delimiter sniffed (, ; tab)
 *   PDF                 pdftotext (poppler-utils, already in the Docker image for PPTX slides)
 *   DOC / XLS / PPT     LibreOffice converts to the modern format first (also already in the image)
 * Everything is capped: zip entries, rows, columns and characters, so a hostile file cannot blow up memory.
 */
const zlib = require('node:zlib');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const run = promisify(execFile);

const MAX_ENTRY = 40 * 1048576; // inflated size cap per zip part
const MAX_TEXT = 200_000; // characters kept from any document
const MAX_ROWS = 5000; // rows parsed for stats
const MAX_COLS = 60;
const fail = (status, message) => Object.assign(new Error(message), { status, expose: true });

// ---------------------------------------------------------------- file types
const EXT_KIND = { pdf: 'pdf', pptx: 'pptx', ppsx: 'pptx', ppt: 'ppt', docx: 'docx', doc: 'doc', csv: 'csv', tsv: 'csv', xlsx: 'xlsx', xls: 'xls' };
/** Which extractor a file needs: 'pdf' | 'pptx' | 'ppt' | 'docx' | 'doc' | 'csv' | 'xlsx' | 'xls' | 'image' | null. */
function fileType({ name = '', mime = '', buf = null } = {}) {
  const ext = String(name).toLowerCase().split('.').pop();
  const m = String(mime).toLowerCase();
  if (m.startsWith('image/') && !m.includes('svg')) return 'image';
  if (m === 'application/pdf') return 'pdf';
  if (m.includes('presentationml')) return 'pptx';
  if (m.includes('wordprocessingml')) return 'docx';
  if (m.includes('spreadsheetml')) return 'xlsx';
  if (m === 'application/vnd.ms-powerpoint') return 'ppt';
  if (m === 'application/msword') return 'doc';
  if (m === 'application/vnd.ms-excel' && ext !== 'csv') return 'xls';
  if (m === 'text/csv' || m === 'text/tab-separated-values') return 'csv';
  if (EXT_KIND[ext]) return EXT_KIND[ext];
  if (buf && buf.length >= 4) {
    if (buf.subarray(0, 4).toString('latin1') === '%PDF') return 'pdf';
    if (buf.readUInt32LE(0) === 0x04034b50) {
      try { const names = Object.keys(unzip(buf, () => false)); if (names.some((n) => n.startsWith('ppt/'))) return 'pptx'; if (names.some((n) => n.startsWith('word/'))) return 'docx'; if (names.some((n) => n.startsWith('xl/'))) return 'xlsx'; } catch { /* not a zip */ }
    }
  }
  return null;
}
/** Material kind for a file type. */
const kindFor = (t) => ({ pdf: 'pdf', pptx: 'pptx', ppt: 'pptx', docx: 'doc', doc: 'doc', csv: 'sheet', xlsx: 'sheet', xls: 'sheet', image: 'image' }[t] || null);

// ---------------------------------------------------------------- zip
/** Read a zip's central directory; returns { name: Buffer } for entries where want(name) is true. */
function unzip(buf, want = () => true) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw fail(422, 'This file is damaged or not a valid Office document');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out = {};
  for (let n = 0; n < count && p + 46 <= buf.length; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const method = buf.readUInt16LE(p + 10), csize = buf.readUInt32LE(p + 20), usize = buf.readUInt32LE(p + 24);
    const nl = buf.readUInt16LE(p + 28), xl = buf.readUInt16LE(p + 30), cl = buf.readUInt16LE(p + 32), lo = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nl);
    p += 46 + nl + xl + cl;
    out[name] = null;
    if (!want(name)) continue;
    if (usize > MAX_ENTRY) throw fail(413, 'This document is too large to analyse');
    if (lo + 30 > buf.length || buf.readUInt32LE(lo) !== 0x04034b50) continue;
    const start = lo + 30 + buf.readUInt16LE(lo + 26) + buf.readUInt16LE(lo + 28);
    const data = buf.subarray(start, start + csize);
    if (method === 0) out[name] = Buffer.from(data);
    else if (method === 8) out[name] = zlib.inflateRawSync(data, { maxOutputLength: MAX_ENTRY });
  }
  return out;
}

// ---------------------------------------------------------------- XML helpers
const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const decode = (s) => String(s).replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (m, e) => (e[0] === '#' ? String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)) : ENT[e.toLowerCase()] || m));
/** Paragraph text from WordprocessingML / DrawingML: one string per paragraph. */
function paragraphs(xml, p, t) {
  const out = [];
  const reP = new RegExp(`<${p}\\b[^>]*>([\\s\\S]*?)</${p}>`, 'g');
  const reT = new RegExp(`<${t}\\b[^>]*>([^<]*)</${t}>|<(?:w:tab|a:tab)\\b[^>]*/>|<(?:w:br|a:br)\\b[^>]*/>`, 'g');
  let m;
  while ((m = reP.exec(xml))) {
    let s = '', n;
    reT.lastIndex = 0;
    while ((n = reT.exec(m[1]))) s += n[1] != null ? decode(n[1]) : /tab/.test(n[0]) ? '\t' : '\n';
    s = s.replace(/[ \t]+/g, ' ').trim();
    if (s) out.push(s);
  }
  return out;
}
const clip = (s, n = MAX_TEXT) => (s.length > n ? s.slice(0, n) : s);

function docxText(buf) {
  const z = unzip(buf, (n) => n === 'word/document.xml');
  if (!z['word/document.xml']) throw fail(422, 'No text found in this Word document');
  return clip(paragraphs(z['word/document.xml'].toString('utf8'), 'w:p', 'w:t').join('\n'));
}
function pptxText(buf) {
  const z = unzip(buf, (n) => /^ppt\/slides\/slide\d+\.xml$/.test(n));
  const slides = Object.keys(z).filter((n) => z[n]).sort((a, b) => Number(a.match(/(\d+)\.xml$/)[1]) - Number(b.match(/(\d+)\.xml$/)[1]));
  if (!slides.length) throw fail(422, 'No slides found in this presentation');
  return clip(slides.map((n, i) => `Slide ${i + 1}:\n` + paragraphs(z[n].toString('utf8'), 'a:p', 'a:t').join('\n')).join('\n\n'));
}

const colIndex = (ref) => { let n = 0; for (const ch of String(ref).replace(/\d+$/, '')) n = n * 26 + (ch.charCodeAt(0) - 64); return n - 1; };
/** First worksheet of an XLSX as rows of strings (plus all sheet names). */
function xlsxRows(buf) {
  const z = unzip(buf, (n) => n === 'xl/workbook.xml' || n === 'xl/_rels/workbook.xml.rels' || n === 'xl/sharedStrings.xml' || /^xl\/worksheets\/sheet\d+\.xml$/.test(n));
  const wb = z['xl/workbook.xml'] ? z['xl/workbook.xml'].toString('utf8') : '';
  const sheets = [...wb.matchAll(/<sheet\b[^>]*?name="([^"]*)"[^>]*?r:id="([^"]*)"/g)].map((m) => ({ name: decode(m[1]), rid: m[2] }));
  const rels = z['xl/_rels/workbook.xml.rels'] ? z['xl/_rels/workbook.xml.rels'].toString('utf8') : '';
  let target = null;
  if (sheets[0]) { const r = new RegExp(`<Relationship\\b[^>]*Id="${sheets[0].rid}"[^>]*/>`).exec(rels); const t = r && /Target="([^"]+)"/.exec(r[0]); if (t) target = 'xl/' + t[1].replace(/^\/?xl\//, '').replace(/^\.\//, ''); }
  if (!target || !z[target]) target = Object.keys(z).filter((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n) && z[n]).sort()[0];
  if (!target || !z[target]) throw fail(422, 'No worksheet found in this spreadsheet');
  const shared = [];
  if (z['xl/sharedStrings.xml']) {
    for (const m of z['xl/sharedStrings.xml'].toString('utf8').matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)) shared.push(decode([...m[1].matchAll(/<t\b[^>]*>([^<]*)<\/t>/g)].map((x) => x[1]).join('')));
  }
  const rows = [];
  const xml = z[target].toString('utf8');
  for (const rm of xml.matchAll(/<row\b[^>]*?(?:\/>|>([\s\S]*?)<\/row>)/g)) {
    if (rows.length >= MAX_ROWS + 1) break;
    const row = [];
    for (const cm of (rm[1] || '').matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = cm[1], body = cm[2] || '';
      const ref = /\br="([A-Z]+)\d*"/.exec(attrs); const ci = ref ? colIndex(ref[1]) : row.length;
      if (ci >= MAX_COLS) continue;
      const t = (/\bt="(\w+)"/.exec(attrs) || [])[1];
      const v = (/<v>([^<]*)<\/v>/.exec(body) || [])[1];
      let val = '';
      if (t === 's') val = shared[Number(v)] ?? '';
      else if (t === 'inlineStr') val = decode([...body.matchAll(/<t\b[^>]*>([^<]*)<\/t>/g)].map((x) => x[1]).join(''));
      else if (t === 'b') val = v === '1' ? 'TRUE' : 'FALSE';
      else val = v != null ? decode(v) : '';
      while (row.length < ci) row.push('');
      row[ci] = val;
    }
    rows.push(row);
  }
  return { rows: trimRows(rows), sheets: sheets.map((s) => s.name) };
}

/** Quote-aware CSV parser; the delimiter is sniffed from the first line. */
function csvRows(text) {
  const s = String(text).replace(/^\uFEFF/, '');
  const first = s.slice(0, s.indexOf('\n') >= 0 ? s.indexOf('\n') : s.length);
  const cnt = (c) => first.split(c).length - 1;
  const d = [',', ';', '\t'].sort((a, b) => cnt(b) - cnt(a))[0];
  const rows = []; let row = [], cell = '', q = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) { if (c === '"') { if (s[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += c; continue; }
    if (c === '"' && cell === '') q = true;
    else if (c === d) { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && s[i + 1] === '\n') i++;
      row.push(cell); cell = ''; rows.push(row.slice(0, MAX_COLS)); row = [];
      if (rows.length > MAX_ROWS) break;
    } else cell += c;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row.slice(0, MAX_COLS)); }
  return trimRows(rows);
}
function trimRows(rows) {
  const out = rows.map((r) => r.map((v) => String(v ?? '').trim())).filter((r) => r.some((v) => v !== ''));
  return out;
}

// ---------------------------------------------------------------- table stats (computed locally, never by the LLM)
const NUM = /^[-+]?(?:[₦$€£]\s?)?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?%?$/;
const toNum = (v) => Number(String(v).replace(/[₦$€£,%\s]/g, ''));
function tableStats(rows) {
  if (!rows.length) return { columns: [], rowCount: 0 };
  const header = rows[0].map((h, i) => h || `Column ${i + 1}`);
  const body = rows.slice(1);
  const width = Math.min(MAX_COLS, Math.max(header.length, ...body.slice(0, 200).map((r) => r.length)));
  while (header.length < width) header.push(`Column ${header.length + 1}`);
  const columns = header.slice(0, width).map((name, i) => {
    const vals = body.map((r) => r[i] ?? '').filter((v) => v !== '');
    const nums = vals.filter((v) => NUM.test(v)).map(toNum).filter(Number.isFinite);
    const col = { name, filled: vals.length, empty: body.length - vals.length };
    if (vals.length && nums.length / vals.length >= 0.8) {
      const sum = nums.reduce((a, b) => a + b, 0);
      Object.assign(col, { type: 'number', min: Math.min(...nums), max: Math.max(...nums), mean: Math.round((sum / nums.length) * 100) / 100, sum: Math.round(sum * 100) / 100 });
    } else {
      const freq = new Map();
      for (const v of vals) freq.set(v, (freq.get(v) || 0) + 1);
      col.type = 'text'; col.distinct = freq.size;
      col.top = [...freq].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([value, count]) => ({ value: value.slice(0, 60), count }));
    }
    return col;
  });
  return { columns, rowCount: body.length, truncated: rows.length > MAX_ROWS };
}
/** Short preview table: header + up to `n` rows, `c` columns. */
const previewTable = (rows, n = 50, c = 20) => ({ header: (rows[0] || []).slice(0, c), rows: rows.slice(1, n + 1).map((r) => r.slice(0, c).map((v) => String(v).slice(0, 120))), totalRows: Math.max(0, rows.length - 1) });
/** Plain-text rendering of a table for the LLM (first rows only). */
const tableText = (rows, n = 40) => rows.slice(0, n + 1).map((r) => r.join(' | ')).join('\n');

// ---------------------------------------------------------------- external tools (PDF, legacy Office)
async function withTmp(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), '1venue-extract-'));
  try { return await fn(dir); } finally { fs.rm(dir, { recursive: true, force: true }).catch(() => {}); }
}
async function pdfText(buf) {
  return withTmp(async (dir) => {
    const p = path.join(dir, 'in.pdf'); await fs.writeFile(p, buf);
    try {
      const { stdout } = await run('pdftotext', ['-l', '60', '-enc', 'UTF-8', p, '-'], { timeout: 60000, maxBuffer: 8 * 1048576, encoding: 'utf8' });
      return clip(String(stdout).replace(/\f/g, '\n').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim());
    } catch (e) {
      if (e.code === 'ENOENT') throw fail(503, 'PDF analysis needs poppler-utils (pdftotext) on the server. Rebuild the app image.');
      throw fail(422, 'Could not read text from this PDF');
    }
  });
}
/** Convert a legacy Office file (doc/xls/ppt) to its modern format with LibreOffice. */
async function officeUpgrade(buf, from, to) {
  return withTmp(async (dir) => {
    const input = path.join(dir, `in.${from}`); await fs.writeFile(input, buf);
    let bin = 'soffice';
    try { bin = require('../../venue/pptx').officeBin(); } catch { /* default */ }
    try {
      await run(bin, ['--headless', '--norestore', '--nolockcheck', `-env:UserInstallation=file://${dir}/lo`, '--convert-to', to, '--outdir', dir, input], { timeout: 120000, env: { ...process.env, HOME: dir, TMPDIR: dir } });
    } catch (e) {
      if (e.code === 'ENOENT') throw fail(503, `Old .${from} files need LibreOffice on the server. Save it as .${to} and try again.`);
      throw fail(422, `Could not read this .${from} file. Save it as .${to} and try again.`);
    }
    return fs.readFile(path.join(dir, `in.${to}`)).catch(() => { throw fail(422, `Could not read this .${from} file. Save it as .${to} and try again.`); });
  });
}

/**
 * extract({ buf, name, mime }) -> { type, text, rows?, sheets?, stats?, preview? }
 * text is what the LLM reads; rows/stats/preview only for spreadsheets.
 */
async function extract({ buf, name = '', mime = '' }) {
  if (!buf || !buf.length) throw fail(400, 'The file is empty');
  const type = fileType({ name, mime, buf });
  if (!type || type === 'image') throw fail(415, 'Only PDF, Word, PowerPoint, CSV and Excel files can be analysed');
  if (type === 'pdf') return { type, text: await pdfText(buf) };
  if (type === 'docx') return { type, text: docxText(buf) };
  if (type === 'doc') return { type, text: docxText(await officeUpgrade(buf, 'doc', 'docx')) };
  if (type === 'pptx') return { type, text: pptxText(buf) };
  if (type === 'ppt') return { type, text: pptxText(await officeUpgrade(buf, 'ppt', 'pptx')) };
  let rows, sheets = [];
  if (type === 'csv') rows = csvRows(buf.toString('utf8'));
  else ({ rows, sheets } = xlsxRows(type === 'xls' ? await officeUpgrade(buf, 'xls', 'xlsx') : buf));
  return { type, rows, sheets, stats: tableStats(rows), preview: previewTable(rows), text: clip(tableText(rows)) };
}

module.exports = { extract, fileType, kindFor, unzip, docxText, pptxText, xlsxRows, csvRows, tableStats, previewTable, MAX_TEXT };
