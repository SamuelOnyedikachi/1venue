/**
 * Word documents and spreadsheets shared in a meeting (content type "doc").
 * The presenter's file is extracted once on the server (materials/extract.js), turned into a small
 * paged JSON document and saved to storage like slide images. Everyone fetches that JSON through
 * GET /api/convert/doc (same origin, so R2 CORS never matters) and the presenter's page and scroll
 * position are synced over the existing content-update channel.
 *   text  pages of ~2,200 characters, split on paragraph boundaries (DOCX, DOC, PDF text)
 *   table header + rows, 50 rows a page (CSV, XLSX, XLS)
 */
const ROWS_PER_PAGE = 50;
const MAX_ROWS = 2000;
const MAX_COLS = 20;
const CHARS_PER_PAGE = 2200;
const MAX_PAGES = 120;

function textPages(text) {
  const paras = String(text || '').replace(/\r/g, '').split(/\n{2,}|\n(?=\s*[-•*]\s)/).map((p) => p.trim()).filter(Boolean);
  const pages = []; let cur = '';
  for (let p of paras) {
    while (p.length > CHARS_PER_PAGE) { if (cur) { pages.push(cur); cur = ''; } pages.push(p.slice(0, CHARS_PER_PAGE)); p = p.slice(CHARS_PER_PAGE); }
    if (cur && cur.length + p.length + 2 > CHARS_PER_PAGE) { pages.push(cur); cur = ''; }
    cur = cur ? `${cur}\n\n${p}` : p;
    if (pages.length >= MAX_PAGES) break;
  }
  if (cur && pages.length < MAX_PAGES) pages.push(cur);
  return pages.length ? pages : ['(This document has no readable text)'];
}
/** extract() output -> { v, kind, title, pageCount, pages | header+rows+rowsPerPage } */
function buildDoc(x, title) {
  if (x.rows) {
    const header = (x.rows[0] || []).slice(0, MAX_COLS).map((h, i) => String(h || `Column ${i + 1}`).slice(0, 80));
    const rows = x.rows.slice(1, MAX_ROWS + 1).map((r) => header.map((_, i) => String(r[i] ?? '').slice(0, 160)));
    return { v: 1, kind: 'table', title, header, rows, rowsPerPage: ROWS_PER_PAGE, totalRows: Math.max(0, x.rows.length - 1), sheets: x.sheets || [], pageCount: Math.max(1, Math.ceil(rows.length / ROWS_PER_PAGE)) };
  }
  const pages = textPages(x.text);
  return { v: 1, kind: 'text', title, pages, pageCount: pages.length };
}
const DOC_TYPES = new Set(['docx', 'doc', 'csv', 'xlsx', 'xls', 'pdf']);

module.exports = { buildDoc, textPages, DOC_TYPES, ROWS_PER_PAGE };
