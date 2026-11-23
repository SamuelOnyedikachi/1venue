// /materials: the materials library. Upload PDF, PowerPoint, Word, CSV, Excel or images, save YouTube
// links, and open any material on its own page (/materials/:id) for a preview and AI analysis.
import { icon } from '../icons.js';
import { h, api, toast, toastErr, reportClientError } from '../ui.js';
import { saleEditor, priceLabel } from '../material-sale.js';
import { requireLogin } from '../app.js';
import { ytId } from '../room/youtube.js';
import { ACCEPT, kindIcon, materialThumb, materialSub, uploadMaterial } from '../materials-lib.js';

export async function mount(view) {
  if (!requireLogin('Sign in to manage materials')) return;
  view.append(h('div', { class: 'page-head' },
    h('h1', { html: `<span class="ico-tile" data-group="content">${icon('folder', { size: 20 })}</span> Materials` }),
    h('p', { class: 'muted small' }, 'Slides, documents and spreadsheets you can attach to events and present in calls. Open one to preview it or get an AI summary.')));

  const listEl = h('div', { class: 'mat-grid' });

  async function reload() {
    listEl.replaceChildren(h('div', { class: 'tiny muted' }, 'Loading…'));
    try {
      const items = (await api('/api/materials')).materials || [];
      if (!items.length) { listEl.replaceChildren(h('div', { class: 'empty sm' }, h('p', null, 'No materials yet. Upload a file or save a YouTube link above.'))); return; }
      listEl.replaceChildren(...items.map((m) => {
        const th = materialThumb(m);
        return h('div', { class: 'mat-card card layer' },
          h('a', { class: 'mat-card-link', href: `/materials/${m.id}`, 'data-link': '' },
            h('div', { class: 'mat-card-thumb', 'data-kind': m.kind }, th ? h('img', { src: th, alt: '', loading: 'lazy' }) : h('span', { html: icon(kindIcon(m.kind), { size: 28 }) })),
            h('div', { class: 'mat-card-body' }, h('b', { class: 'ellipsis' }, m.title), h('div', { class: 'tiny muted ellipsis' }, materialSub(m), m.forSale ? ` · ${priceLabel(m)}` : ''))),
          h('div', { class: 'mat-card-sale' }, saleEditor(m, { onSaved: () => reload() })),
          h('button', { class: 'icon-btn sm mat-card-rm', type: 'button', 'aria-label': `Remove ${m.title}`, 'data-tip': 'Remove', html: icon('trash', { size: 15 }), onclick: async () => {
            if (!confirm(`Remove “${m.title}”?`)) return;
            try { await api(`/api/materials/${m.id}`, { method: 'DELETE' }); toast('Removed', { icon: 'check' }); reload(); } catch (e) { toastErr(e); }
          } }));
      }));
    } catch (e) { listEl.replaceChildren(h('div', { class: 'tiny muted' }, e.message || 'Failed to load')); }
  }

  const title = h('input', { class: 'input', placeholder: 'Title (optional)', maxlength: 120 });
  const yt = h('input', { class: 'input', placeholder: 'YouTube URL', type: 'url' });
  const fileIn = h('input', { type: 'file', accept: ACCEPT, multiple: true, class: 'hidden' });
  const status = h('div', { class: 'tiny muted', role: 'status', 'aria-live': 'polite' });
  let busy = false;

  async function saveFromFiles(files) {
    if (!files.length || busy) return;
    busy = true; status.classList.remove('err');
    let step = 'start';
    const meta = { file: files[0]?.name, mime: files[0]?.type || '(none)', size: files[0]?.size };
    try {
      const { notes } = await uploadMaterial(files, { title: title.value, onStatus: (t) => { status.textContent = t; }, onStep: (s) => { step = s; } });
      notes.forEach((n) => toast(n, { icon: 'alert' }));
      title.value = ''; status.textContent = '';
      toast('Material saved', { icon: 'check', group: 'content' });
      reload();
    } catch (e) {
      status.textContent = `Couldn’t save: ${reportClientError('materials', e, { step, ...meta })}`;
      status.classList.add('err');
    } finally { busy = false; fileIn.value = ''; }
  }
  fileIn.onchange = () => saveFromFiles(Array.from(fileIn.files || []));

  const drop = h('button', { class: 'mat-drop', type: 'button', onclick: () => fileIn.click() },
    h('span', { class: 'ico-tile', 'data-group': 'content', html: icon('upload', { size: 20 }) }),
    h('b', null, 'Upload materials'),
    h('span', { class: 'tiny muted' }, 'PDF, PowerPoint, Word, CSV, Excel or images · drop files here'));
  drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', (e) => { e.preventDefault(); drop.classList.remove('over'); saveFromFiles(Array.from(e.dataTransfer?.files || [])); });

  const formCard = h('div', { class: 'card pad layer col', style: { gap: '.75rem' } },
    drop, title,
    h('div', { class: 'row gap-s', style: { alignItems: 'stretch' } }, yt,
      h('button', { class: 'btn', type: 'button', html: icon('youtube', { size: 16 }) + ' Save link', onclick: async () => {
        const id = ytId(yt.value);
        if (!id) return toast('Paste a valid YouTube URL', { icon: 'alert' });
        try {
          await api('/api/materials', { method: 'POST', body: { title: title.value.trim() || 'YouTube video', kind: 'youtube', payload: { videoId: id } } });
          yt.value = ''; title.value = ''; toast('Saved', { icon: 'check' }); reload();
        } catch (e) { toastErr(e); }
      } })),
    fileIn, status);

  view.append(formCard, h('div', { class: 'sec-sub', style: { marginTop: '1.25rem' } }, 'Your library'), listEl);
  reload();
}
