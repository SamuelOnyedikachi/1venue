// /materials: the materials library. Upload PDF, PowerPoint, Word, CSV, Excel or images, save YouTube
// links, and open any material on its own page (/materials/:id) for a preview and AI analysis.
import { icon } from '../icons.js';
import { h, api, toast, toastErr, reportClientError } from '../ui.js';
import { MARKET_CATEGORIES, priceLabel, materialOpenAttrs, takeMaterialReturnScroll } from '../material-sale.js';
import { requireLogin } from '../app.js';
import { ytId } from '../room/youtube.js';
import { ACCEPT, kindIcon, materialThumb, materialSub, uploadMaterial } from '../materials-lib.js';

const PRICE_PER_CREDIT_KOBO = 50000;
const creditsFromKobo = (k) => (k > 0 ? Math.max(1, Math.round(Number(k) / PRICE_PER_CREDIT_KOBO)) : 0);
const nairaFromKobo = (k) => (k > 0 ? (Number(k) / 100) : '');

async function saveSale(m, patch) {
  const priceKobo = patch.priceKobo !== undefined ? patch.priceKobo : m.priceKobo;
  const forSale = priceKobo != null && Number(priceKobo) > 0;
  const body = {
    forSale,
    priceKobo: forSale ? priceKobo : null,
    callDiscountPct: patch.callDiscountPct !== undefined ? patch.callDiscountPct : (m.callDiscountPct || 0),
    listed: patch.listed != null ? patch.listed : !!m.listed,
    category: patch.category !== undefined ? patch.category : (m.category || null),
  };
  const updated = await api(`/api/materials/${m.id}/sale`, { method: 'POST', body });
  Object.assign(m, updated);
  return m;
}

function thumbCell(m) {
  const src = materialThumb(m);
  if (!src) {
    return h('span', { class: 'mat-lib-ph', html: icon(kindIcon(m.kind), { size: 20 }), title: m.kind || '' });
  }
  const img = h('img', { class: 'mat-lib-thumb', src, alt: m.title || '', 'data-lightbox': '1' });
  img.addEventListener('click', (ev) => ev.stopPropagation());
  return img;
}

function saleRow(m, { onSaved }) {
  const price = h('input', {
    class: 'input sm mat-lib-num', type: 'number', min: '0', step: '50',
    value: nairaFromKobo(m.priceKobo) === '' ? '' : String(nairaFromKobo(m.priceKobo)),
    placeholder: 'Free', 'aria-label': 'Price in naira',
  });
  const credits = h('input', {
    class: 'input sm mat-lib-num', type: 'number', min: '0', step: '1',
    value: creditsFromKobo(m.priceKobo) || '',
    placeholder: '—', 'aria-label': 'Price in credits',
  });
  const disc = h('input', {
    class: 'input sm mat-lib-num', type: 'number', min: '0', max: '90', step: '5',
    value: String(m.callDiscountPct || 0), 'aria-label': 'Call discount percent',
  });
  const listed = h('input', { type: 'checkbox', checked: !!m.listed, 'aria-label': 'List on marketplace' });
  const cat = h('select', { class: 'input sm mat-lib-cat', 'aria-label': 'Marketplace category' },
    h('option', { value: '' }, 'Category'),
    ...MARKET_CATEGORIES.map((c) => h('option', { value: c, selected: m.category === c }, c)));

  const commit = async (patch) => {
    try { await saveSale(m, patch); onSaved && onSaved(m); } catch (e) { toastErr(e); }
  };
  price.onchange = price.onblur = () => {
    const v = price.value === '' ? null : Math.round(Number(price.value) * 100);
    if (v != null && v > 0 && v < 5000) { toast('The lowest sale price is ₦50', { icon: 'alert' }); return; }
    credits.value = v ? String(creditsFromKobo(v)) : '';
    commit({ priceKobo: v });
  };
  credits.onchange = credits.onblur = () => {
    const c = credits.value === '' ? 0 : Math.round(Number(credits.value));
    const v = c > 0 ? c * PRICE_PER_CREDIT_KOBO : null;
    price.value = v ? String(v / 100) : '';
    commit({ priceKobo: v });
  };
  disc.onchange = disc.onblur = () => commit({ callDiscountPct: Number(disc.value) || 0 });
  listed.onchange = () => commit({ listed: listed.checked });
  cat.onchange = () => commit({ category: cat.value || null });

  return { price, credits, disc, listed, cat };
}

export async function mount(view, params = {}) {
  if (!requireLogin('Sign in to manage materials')) return;
  view.append(h('div', { class: 'page-head' },
    h('h1', { html: `<span class="ico-tile" data-group="content">${icon('folder', { size: 20 })}</span> Materials` }),
    h('p', { class: 'muted small' }, 'Slides, documents and spreadsheets you can attach to events and present in calls. Open one to preview it or get an AI summary.')));

  const listEl = h('div', { class: 'mat-lib' });
  let tab = (params.tab || new URLSearchParams(location.search).get('tab')) === 'purchased' ? 'purchased' : 'library';
  const syncTabUrl = () => {
    const href = tab === 'purchased' ? '/materials?tab=purchased' : '/materials';
    if (location.pathname + location.search !== href) history.replaceState(history.state || {}, '', href);
  };
  syncTabUrl();
  let items = [];

  async function reload() {
    listEl.replaceChildren(h('div', { class: 'tiny muted' }, 'Loading…'));
    const path = tab === 'purchased' ? '/api/materials?filter=purchased' : '/api/materials';
    try {
      const r = await api(path);
      items = r.materials || r.items || [];
      paintList();
    } catch (e) { listEl.replaceChildren(h('div', { class: 'empty' }, h('p', { class: 'muted' }, e.message))); }
  }

  function selectedIds() {
    return [...listEl.querySelectorAll('tbody input.mat-lib-mark:checked')].map((el) => Number(el.dataset.id));
  }
  function selectedItems() {
    const ids = new Set(selectedIds());
    return items.filter((m) => ids.has(m.id));
  }

  async function bulkList(listed) {
    const sel = selectedItems();
    if (!sel.length) return;
    try {
      for (const m of sel) await saveSale(m, { listed });
      toast(listed ? 'Listed on the marketplace' : 'Unlisted', { icon: 'check' });
      paintList();
    } catch (e) { toastErr(e); }
  }
  async function bulkPrice(raw) {
    const sel = selectedItems();
    if (!sel.length) return;
    const v = raw === '' || raw == null ? null : Math.round(Number(raw) * 100);
    if (v != null && !Number.isFinite(v)) { toast('Enter a price in naira', { icon: 'alert' }); return; }
    if (v != null && v > 0 && v < 5000) { toast('The lowest sale price is ₦50', { icon: 'alert' }); return; }
    try {
      for (const m of sel) await saveSale(m, { priceKobo: v });
      toast('Price updated', { icon: 'check' });
      paintList();
    } catch (e) { toastErr(e); }
  }
  async function bulkDelete() {
    const sel = selectedItems();
    if (!sel.length) return;
    if (!confirm(`Delete ${sel.length} material${sel.length === 1 ? '' : 's'}? This cannot be undone.`)) return;
    try {
      for (const m of sel) await api(`/api/materials/${m.id}`, { method: 'DELETE' });
      toast('Removed', { icon: 'check' });
      reload();
    } catch (e) { toastErr(e); }
  }

  function paintList() {
    if (!items.length) {
      listEl.replaceChildren(h('div', { class: 'empty' }, h('p', { class: 'muted' }, tab === 'purchased' ? 'Nothing purchased yet.' : 'Nothing here yet. Upload a file or paste a YouTube link.')));
      return;
    }
    if (tab === 'purchased') {
      const rows = items.map((m) => h('tr', null,
        h('td', { class: 'mat-lib-td-thumb' }, thumbCell(m)),
        h('td', null, h('a', { class: 'mat-lib-title', ...materialOpenAttrs(m.id, 'materials') }, m.title || 'Untitled'), h('div', { class: 'tiny muted' }, materialSub(m) + (priceLabel(m) ? ' · ' + priceLabel(m) : ''))),
        h('td', { class: 'hide-sm' }, m.kind || ''),
        h('td', { class: 'mat-lib-td-act' }, h('a', { class: 'btn sm ghost', ...materialOpenAttrs(m.id, 'materials') }, 'Open'))));
      listEl.replaceChildren(h('div', { class: 'mat-lib-wrap' },
        h('table', { class: 'mat-lib-table' },
          h('thead', null, h('tr', null, h('th', { class: 'mat-lib-td-thumb' }, ''), h('th', null, 'Title'), h('th', { class: 'hide-sm' }, 'Type'), h('th', null, ''))),
          h('tbody', null, ...rows))));
      return;
    }

    const all = h('input', { type: 'checkbox', 'aria-label': 'Select all' });
    const priceIn = h('input', { class: 'input sm mat-lib-num', type: 'number', min: '0', step: '50', placeholder: '₦ price', 'aria-label': 'Bulk price in naira' });
    const bulk = h('div', { class: 'mat-lib-bulk' },
      h('span', { class: 'tiny muted mat-lib-bulk-count' }, '0 selected'),
      h('button', { type: 'button', class: 'btn sm', onclick: () => bulkList(true) }, 'List'),
      h('button', { type: 'button', class: 'btn sm', onclick: () => bulkList(false) }, 'Unlist'),
      priceIn,
      h('button', { type: 'button', class: 'btn sm', onclick: () => bulkPrice(priceIn.value) }, 'Set price'),
      h('button', { type: 'button', class: 'btn sm danger', onclick: bulkDelete, html: icon('trash', { size: 14 }) + ' Delete' }));

    const syncSel = () => {
      const n = selectedIds().length;
      const count = bulk.querySelector('.mat-lib-bulk-count');
      if (count) count.textContent = n + ' selected';
      bulk.classList.toggle('on', n > 0);
      const marks = [...listEl.querySelectorAll('tbody input.mat-lib-mark')];
      all.checked = marks.length > 0 && marks.every((el) => el.checked);
      all.indeterminate = marks.some((el) => el.checked) && !all.checked;
      for (const tr of listEl.querySelectorAll('tbody tr')) {
        const box = tr.querySelector('input.mat-lib-mark');
        tr.classList.toggle('sel', !!(box && box.checked));
      }
    };
    all.onchange = () => {
      for (const el of listEl.querySelectorAll('tbody input.mat-lib-mark')) el.checked = all.checked;
      syncSel();
    };

    const rows = items.map((m) => {
      const mark = h('input', { type: 'checkbox', class: 'mat-lib-mark', 'data-id': String(m.id), 'aria-label': 'Select ' + (m.title || 'material') });
      mark.onchange = syncSel;
      const fields = saleRow(m, { onSaved: () => {} });
      const del = h('button', {
        class: 'icon-btn sm danger', type: 'button', title: 'Delete', 'aria-label': 'Delete',
        html: icon('trash', { size: 16 }),
        onclick: async () => {
          if (!confirm(`Delete “${m.title}”?`)) return;
          try { await api(`/api/materials/${m.id}`, { method: 'DELETE' }); toast('Removed', { icon: 'check' }); reload(); } catch (e) { toastErr(e); }
        },
      });
      return h('tr', null,
        h('td', { class: 'mat-lib-td-mark' }, mark),
        h('td', { class: 'mat-lib-td-thumb' }, thumbCell(m)),
        h('td', null, h('a', { class: 'mat-lib-title', ...materialOpenAttrs(m.id, 'materials') }, m.title || 'Untitled'), h('div', { class: 'tiny muted' }, materialSub(m))),
        h('td', { class: 'hide-sm' }, m.kind || ''),
        h('td', null, fields.cat),
        h('td', null, fields.price),
        h('td', { class: 'hide-sm' }, fields.credits),
        h('td', { class: 'hide-sm' }, fields.disc),
        h('td', { class: 'mat-lib-td-sw' }, h('span', { class: 'switch sm' }, fields.listed, h('span'))),
        h('td', { class: 'mat-lib-td-act' }, h('a', { class: 'btn sm ghost', ...materialOpenAttrs(m.id, 'materials') }, 'Open'), del));
    });

    listEl.replaceChildren(
      bulk,
      h('div', { class: 'mat-lib-wrap' },
        h('table', { class: 'mat-lib-table' },
          h('thead', null, h('tr', null,
            h('th', { class: 'mat-lib-td-mark' }, all),
            h('th', { class: 'mat-lib-td-thumb' }, ''),
            h('th', null, 'Title'),
            h('th', { class: 'hide-sm' }, 'Type'),
            h('th', null, 'Category'),
            h('th', null, '₦'),
            h('th', { class: 'hide-sm' }, 'Credits'),
            h('th', { class: 'hide-sm' }, 'Call %'),
            h('th', null, 'Listed'),
            h('th', null, ''))),
          h('tbody', null, ...rows))));
    syncSel();
  }

  const tabs = h('div', { class: 'tabs', style: { margin: '0 0 .85rem' } },
    h('button', { class: 'tab' + (tab === 'library' ? ' on' : ''), type: 'button', onclick: ev => { tab = 'library'; ev.currentTarget.parentNode.querySelectorAll('.tab').forEach((b) => b.classList.toggle('on', b === ev.currentTarget)); syncTabUrl(); reload(); } }, 'Library'),
    h('button', { class: 'tab' + (tab === 'purchased' ? ' on' : ''), type: 'button', onclick: ev => { tab = 'purchased'; ev.currentTarget.parentNode.querySelectorAll('.tab').forEach((b) => b.classList.toggle('on', b === ev.currentTarget)); syncTabUrl(); reload(); } }, 'Purchased'));
  view.append(tabs, listEl);
  reload();
  const y = takeMaterialReturnScroll('/materials');
  if (y != null) requestAnimationFrame(() => window.scrollTo(0, y));

  const drop = h('div', { class: 'mat-drop', tabindex: '0', role: 'button', 'aria-label': 'Upload a file', html: `${icon('upload', { size: 28 })}<b>Drop a file here or click to upload</b><span class="tiny muted">PDF, PowerPoint, Word, Excel, CSV, images, or a video up to 15 minutes</span>` });
  const file = h('input', { type: 'file', accept: ACCEPT, hidden: true });
  const title = h('input', { class: 'input', placeholder: 'https://youtube.com/watch?v=…', 'aria-label': 'YouTube URL' });
  drop.onclick = () => file.click();
  drop.ondragover = ev => { ev.preventDefault(); drop.classList.add('over'); };
  drop.ondragleave = () => drop.classList.remove('over');
  drop.ondrop = ev => { ev.preventDefault(); drop.classList.remove('over'); if (ev.dataTransfer.files[0]) start(ev.dataTransfer.files[0]); };
  file.onchange = () => { if (file.files[0]) start(file.files[0]); file.value = ''; };

  async function start(f) {
    const status = h('div', { class: 'tiny muted' });
    drop.after(status);
    try {
      await uploadMaterial(f, {
        onStatus: (t) => { status.textContent = t; },
        onError: (err) => { reportClientError(err, { where: 'materials-upload' }); },
      });
      toast('Uploaded', { icon: 'check' });
      status.remove();
      reload();
    } catch (e) { status.textContent = e.message || 'Upload failed'; toastErr(e); }
  }

  view.append(
    h('div', { class: 'card', style: { marginTop: '1.2rem' } },
      h('h2', { style: { marginBottom: '.65rem' } }, 'Add a material'),
      drop, file,
      h('form', { class: 'row', style: { gap: '.5rem', marginTop: '.85rem', flexWrap: 'wrap' }, onsubmit: async ev => {
        ev.preventDefault();
        const id = ytId(title.value);
        if (!id) return toast('Paste a YouTube watch or youtu.be link', { icon: 'alert' });
        try {
          await api('/api/materials', { method: 'POST', body: { title: title.value.trim() || 'YouTube video', kind: 'youtube', payload: { videoId: id } } });
          title.value = ''; toast('Saved', { icon: 'check' }); reload();
        } catch (e) { toastErr(e); }
      } }, title, h('button', { class: 'btn primary' }, 'Save YouTube'))));
}
