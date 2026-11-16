// /materials/:id: one material on its own page. Preview (images, slide pages, a document's text or a
// spreadsheet's first rows), download the original, and an AI analysis (summary, key points and, for
// spreadsheets, a data overview) that is computed once and stored.
import { icon } from '../icons.js';
import { h, api, esc, toast, toastErr } from '../ui.js';
import { state } from '../app.js';
import { kindIcon, kindLabel, materialSub } from '../materials-lib.js';

const fmtNum = (n) => (typeof n === 'number' ? n.toLocaleString(undefined, { maximumFractionDigits: 2 }) : String(n ?? ''));
const ANALYSABLE = ['pdf', 'pptx', 'doc', 'sheet'];
const put = (el, ...kids) => el.append(...kids.filter(Boolean)); // Element.append(null) would print "null"

export async function mount(view, { id }) {
  let m;
  try { m = await api('/api/materials/' + id); }
  catch (e) {
    view.append(h('div', { class: 'card pad col', style: { gap: '.6rem' } }, h('h1', null, 'Material unavailable'), h('p', { class: 'muted' }, e.message || 'This material is not available.'),
      e.status === 401 ? h('a', { class: 'btn primary', href: '/login?next=' + encodeURIComponent(location.pathname), 'data-link': '' }, 'Sign in') : h('a', { class: 'btn', href: '/materials', 'data-link': '' }, 'Back to materials')));
    return;
  }
  document.title = `${m.title} — 1venue`;
  const p = m.payload || {};
  const head = h('div', { class: 'mat-head' },
    state.user ? h('a', { class: 'btn sm ghost', href: '/materials', 'data-link': '', html: icon('chevronLeft', { size: 16 }) + 'Materials' }) : null,
    h('div', { class: 'row gap-s', style: { alignItems: 'center', minWidth: 0 } },
      h('span', { class: 'ico-tile', 'data-group': 'content', html: icon(kindIcon(m.kind), { size: 20 }) }),
      h('div', { style: { minWidth: 0 } }, h('h1', { class: 'mat-title' }, m.title), h('div', { class: 'tiny muted' }, materialSub(m)))),
    p.sourceUrl ? h('a', { class: 'btn sm', href: p.sourceUrl, target: '_blank', rel: 'noopener', download: p.sourceName || '', html: icon('download', { size: 15 }) + 'Original' }) : null);

  const previewEl = h('section', { class: 'card pad layer mat-preview', 'aria-label': 'Preview' });
  const analysisEl = h('section', { class: 'card pad layer mat-analysis', 'aria-label': 'AI analysis' });
  put(view, head, h('div', { class: 'mat-layout' }, previewEl, ANALYSABLE.includes(m.kind) ? analysisEl : null));

  // ---- preview
  if (m.kind === 'image' && p.url) put(previewEl, h('div', { class: 'mat-pages', 'data-lb-group': 'material' }, h('img', { class: 'mat-page-img', src: p.url, alt: m.title, 'data-lightbox': '' })));
  else if (m.kind === 'youtube' && p.videoId) put(previewEl, h('div', { class: 'mat-video' }, h('iframe', { src: `https://www.youtube-nocookie.com/embed/${encodeURIComponent(p.videoId)}`, title: m.title, allow: 'encrypted-media; picture-in-picture', allowfullscreen: true, loading: 'lazy' })));
  else if (Array.isArray(p.pages) && p.pages.length) {
    put(previewEl, h('div', { class: 'row between wrap', style: { gap: '.5rem', marginBottom: '.6rem' } }, h('b', null, `${p.pages.length} page${p.pages.length === 1 ? '' : 's'}`), h('span', { class: 'tiny muted' }, 'Tap a page to view it full screen')),
      h('div', { class: 'mat-pages', 'data-lb-group': 'material' }, ...p.pages.map((u, i) => h('img', { class: 'mat-page-img', src: u, alt: `Page ${i + 1}`, loading: i > 3 ? 'lazy' : 'eager', 'data-lightbox': '' }))));
  } else if (p.sourceUrl) {
    put(previewEl, h('div', { class: 'tiny muted' }, 'Loading preview…'));
    api(`/api/materials/${m.id}/preview`).then((pv) => {
      previewEl.replaceChildren();
      if (pv.table) {
        const t = pv.table;
        put(previewEl, h('div', { class: 'row between wrap', style: { gap: '.5rem', marginBottom: '.6rem' } },
          h('b', null, `${fmtNum(t.totalRows)} row${t.totalRows === 1 ? '' : 's'} · ${pv.stats.columns} column${pv.stats.columns === 1 ? '' : 's'}`),
          pv.sheets && pv.sheets.length > 1 ? h('span', { class: 'tiny muted' }, `Showing “${pv.sheets[0]}” (${pv.sheets.length} sheets)`) : t.totalRows > t.rows.length ? h('span', { class: 'tiny muted' }, `First ${t.rows.length} rows`) : null),
          h('div', { class: 'mat-table-wrap', tabindex: '0', role: 'region', 'aria-label': 'Spreadsheet preview' },
            h('table', { class: 'mat-table' }, h('thead', null, h('tr', null, ...t.header.map((c) => h('th', { scope: 'col' }, c)))),
              h('tbody', null, ...t.rows.map((r) => h('tr', null, ...t.header.map((_, i) => h('td', null, r[i] ?? ''))))))));
      } else {
        put(previewEl, h('div', { class: 'mat-text' }, ...String(pv.text || '').split(/\n{1,}/).filter(Boolean).slice(0, 120).map((para) => (/^Slide \d+:$/.test(para) ? h('h3', null, para.replace(':', '')) : h('p', null, para)))),
          pv.truncated ? h('p', { class: 'tiny muted' }, 'Preview shortened. Download the original for the full document.') : null);
      }
    }).catch((e) => { previewEl.replaceChildren(h('p', { class: 'muted small' }, e.message || 'No preview available.')); });
  } else put(previewEl, h('p', { class: 'muted small' }, 'No preview available.'));

  // ---- analysis
  if (!ANALYSABLE.includes(m.kind)) return;
  const btn = h('button', { class: 'btn primary', type: 'button', 'data-group': 'ai', html: icon('sparkles', { size: 16 }) + 'Analyse' });
  const status = h('p', { class: 'tiny muted', role: 'status', 'aria-live': 'polite' });
  function paint(a) {
    analysisEl.replaceChildren(h('div', { class: 'row between wrap', style: { gap: '.5rem', alignItems: 'center' } },
      h('h2', { class: 'mat-h2', html: icon('sparkles', { size: 18 }) + ' AI analysis' }), a || !m.canEdit ? null : btn));
    if (!a) {
      if (!p.sourceUrl) put(analysisEl, h('p', { class: 'muted small' }, 'This material was saved before analysis existed. Upload the file again to analyse it.'));
      else if (!m.canEdit) put(analysisEl, h('p', { class: 'muted small' }, 'No analysis yet. The owner can run one.'));
      else put(analysisEl, h('p', { class: 'muted small' }, `Get a summary and key points${m.kind === 'sheet' ? ', plus a data overview,' : ''} from this ${kindLabel(m.kind).toLowerCase()}. Uses ${(state.config && state.config.aiWeights && state.config.aiWeights.analysis) || 2} AI points, once.`), status);
      if (!p.sourceUrl) btn.disabled = true;
      return;
    }
    put(analysisEl, 
      a.summary ? h('p', { class: 'mat-summary' }, a.summary) : null,
      a.keyPoints && a.keyPoints.length ? h('div', null, h('h3', { class: 'mat-h3' }, 'Key points'), h('ul', { class: 'mat-points' }, ...a.keyPoints.map((k) => h('li', { html: icon('check', { size: 14 }) + esc(k) })))) : null);
    if (a.data) {
      put(analysisEl, h('h3', { class: 'mat-h3' }, 'Data overview'),
        h('div', { class: 'mat-stats' }, h('div', null, h('b', null, fmtNum(a.data.rowCount)), h('span', null, 'rows')), h('div', null, h('b', null, fmtNum(a.data.columns.length)), h('span', null, 'columns')), h('div', null, h('b', null, fmtNum(a.data.columns.filter((c) => c.type === 'number').length)), h('span', null, 'numeric'))),
        h('div', { class: 'mat-table-wrap' }, h('table', { class: 'mat-table compact' },
          h('thead', null, h('tr', null, h('th', null, 'Column'), h('th', null, 'Type'), h('th', null, 'Details'))),
          h('tbody', null, ...a.data.columns.slice(0, 30).map((c) => h('tr', null, h('td', null, c.name), h('td', null, c.type),
            h('td', null, c.type === 'number' ? `min ${fmtNum(c.min)} · max ${fmtNum(c.max)} · avg ${fmtNum(c.mean)}` : `${fmtNum(c.distinct)} distinct${c.top && c.top[0] ? ` · top “${c.top[0].value}” (${c.top[0].count})` : ''}${c.empty ? ` · ${c.empty} empty` : ''}`)))))),
        a.dataCommentary ? h('p', { class: 'small' }, a.dataCommentary) : null);
    }
    put(analysisEl, h('p', { class: 'tiny faint' }, a.mock ? 'Offline preview analysis (AI service not configured).' : `Analysed with ${a.model || 'AI'}${a.createdAt ? ' · ' + new Date(a.createdAt).toLocaleString() : ''}`));
  }
  btn.onclick = async () => {
    btn.disabled = true; btn.classList.add('busy'); status.textContent = 'Reading the file and analysing… this can take up to a minute.';
    try { const r = await api(`/api/materials/${m.id}/analyse`, { method: 'POST', body: {} }); paint(r.analysis); if (!r.analysis.cached) toast('Analysis ready', { icon: 'sparkles', group: 'ai' }); }
    catch (e) { status.textContent = ''; toastErr(e); btn.disabled = false; btn.classList.remove('busy'); }
  };
  paint(null);
  api(`/api/materials/${m.id}/analysis`).then((r) => { if (r.analysis) paint(r.analysis); }).catch(() => {});
}
