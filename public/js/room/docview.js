// Word documents and spreadsheets presented in a meeting (content type "doc"). The paged JSON comes
// from /api/convert/doc; whoever holds the remote turns pages and scrolls, everyone else follows.
import { h, esc } from '../ui.js';
import { icon } from '../icons.js';

const cache = new Map();
async function loadDoc(url, headers) {
  if (cache.has(url)) return cache.get(url);
  const res = await fetch('/api/convert/doc?url=' + encodeURIComponent(url), { credentials: 'include', headers });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Could not open this document');
  cache.set(url, data); if (cache.size > 10) cache.delete(cache.keys().next().value);
  return data;
}
const paraHtml = (t) => esc(t).split(/\n{2,}/).map((p) => (/^\s*[-•*]\s/.test(p) ? `<p class="doc-li">${p.replace(/^\s*[-•*]\s/, '')}</p>` : `<p>${p.replace(/\n/g, '<br>')}</p>`)).join('');

/** Render a page of a doc into `el` (exported for tests / previews). */
export function renderDocPage(doc, page) {
  const n = doc.pageCount || 1; const pg = Math.min(n, Math.max(1, page || 1));
  if (doc.kind === 'table') {
    const per = doc.rowsPerPage || 50; const start = (pg - 1) * per;
    const rows = doc.rows.slice(start, start + per);
    return h('div', { class: 'doc-table-wrap' }, h('table', { class: 'doc-table' },
      h('thead', null, h('tr', null, h('th', { class: 'doc-rn' }, '#'), ...doc.header.map((x) => h('th', null, x)))),
      h('tbody', null, ...rows.map((r, i) => h('tr', null, h('td', { class: 'doc-rn' }, String(start + i + 1)), ...r.map((v) => h('td', { class: /^[-+]?[\d,.]+%?$/.test(v) ? 'num' : '' }, v)))))));
  }
  return h('article', { class: 'doc-page', html: paraHtml(doc.pages[pg - 1] || '') });
}

export function mountDoc(body, { R, c, canControl }) {
  body.classList.add('doc-body');
  const scroller = h('div', { class: 'doc-scroll', tabindex: '0', 'aria-label': c.title || 'Document' }, h('div', { class: 'doc-loading' }, 'Opening document…'));
  const count = h('span', { class: 'tiny muted slide-count', 'aria-live': 'polite' });
  const prev = h('button', { class: 'icon-btn glass', type: 'button', 'aria-label': 'Previous page', onclick: () => go(-1), html: icon('chevronLeft') });
  const next = h('button', { class: 'icon-btn glass', type: 'button', 'aria-label': 'Next page', onclick: () => go(1), html: icon('chevronRight') });
  const badge = h('span', { class: 'doc-kind' }, h('span', { html: icon(c.docKind === 'table' ? 'grid' : 'file', { size: 14 }) }), c.docKind === 'table' ? 'Spreadsheet' : 'Document');
  body.append(scroller, h('div', { class: 'present-tools slide-controls doc-controls' }, badge, canControl ? prev : null, count, canControl ? next : null, canControl ? null : h('span', { class: 'tiny muted' }, 'Following the presenter')));
  let doc = null; let pg = c.page || 1; let applying = false;
  const n = () => (doc ? doc.pageCount : c.pageCount || 1);
  function show(p) {
    pg = Math.min(n(), Math.max(1, p || 1));
    count.textContent = `${pg} / ${n()}`; prev.disabled = pg <= 1; next.disabled = pg >= n();
    if (!doc) return;
    scroller.replaceChildren(renderDocPage(doc, pg));
    scroller.scrollTop = 0;
    if (c.scroll && typeof c.scroll.y === 'number' && !canControl) applyScroll(c.scroll);
  }
  function go(d) { if (canControl) R.setContentPage(pg + d); }
  function applyScroll(s) {
    if (canControl || !s || typeof s.y !== 'number' || (R.content && R.content.scrollMode === 'free')) return;
    applying = true;
    scroller.scrollTop = s.y * Math.max(0, scroller.scrollHeight - scroller.clientHeight);
    setTimeout(() => { applying = false; }, 60);
  }
  let st = null;
  if (canControl) scroller.addEventListener('scroll', () => {
    if (applying) return; clearTimeout(st);
    st = setTimeout(() => { const max = Math.max(1, scroller.scrollHeight - scroller.clientHeight); R.send('content-update', { scroll: { y: Math.round((scroller.scrollTop / max) * 1000) / 1000, page: pg } }); }, 120);
  }, { passive: true });
  const key = (e) => { if (!canControl || e.target.closest('input,textarea,select,[contenteditable]')) return; if (e.key === 'ArrowRight' || e.key === 'PageDown') { e.preventDefault(); go(1); } else if (e.key === 'ArrowLeft' || e.key === 'PageUp') { e.preventDefault(); go(-1); } };
  document.addEventListener('keydown', key);
  show(pg);
  loadDoc(c.url, R.headers ? R.headers() : {}).then((d) => { doc = d; show(R.content && R.content.page ? R.content.page : pg); })
    .catch((e) => scroller.replaceChildren(h('div', { class: 'empty-card' }, h('span', { html: icon('alert') }), h('b', null, e.message || 'Could not open this document'))));
  R.applyPage = show; R.applyScroll = applyScroll;
  return () => { document.removeEventListener('keydown', key); R.applyPage = null; R.applyScroll = null; };
}
