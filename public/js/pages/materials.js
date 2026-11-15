import { icon } from '../icons.js';
import { h, api, esc, toast, toastErr, uploadFile, reportClientError, deckKind, DECK_HELP } from '../ui.js';
import { state, navigate, requireLogin } from '../app.js';
import { ytId } from '../room/youtube.js';

const kindLabel = (k) => ({ slides: 'Slides', image: 'Image', youtube: 'YouTube', pdf: 'PDF', pptx: 'PPTX' }[k] || k);
function materialThumb(m) {
  if (!m) return null;
  if (m.kind === 'youtube' && m.payload?.videoId) return `https://i.ytimg.com/vi/${m.payload.videoId}/mqdefault.jpg`;
  if (m.kind === 'image' && m.payload?.url) return m.payload.url;
  const pages = m.payload?.pages;
  if (Array.isArray(pages) && pages[0]) return pages[0];
  return null;
}

export async function mount(view) {
  if (!requireLogin('Sign in to manage materials')) return;
  view.append(h('div', { class: 'page-head' },
    h('h1', { html: `<span class="ico-tile" data-group="content">${icon('folder', { size: 20 })}</span> Materials` })));

  const listEl = h('div', { class: 'stack', style: { gap: '.75rem' } });
  const formCard = h('div', { class: 'card pad layer col', style: { gap: '.75rem' } });

  async function reload() {
    listEl.replaceChildren(h('div', { class: 'tiny muted' }, 'Loading…'));
    try {
      const r = await api('/api/materials');
      const items = r.materials || [];
      if (!items.length) {
        listEl.replaceChildren(h('div', { class: 'empty sm' }, h('p', null, 'No materials yet. Add a deck or link above.')));
        return;
      }
      listEl.replaceChildren();
      items.forEach((m) => {
        const pages = m.payload?.pages || [];
        const sub = m.kind === 'youtube'
          ? (m.payload?.videoId || 'YouTube')
          : m.kind === 'image'
            ? '1 image'
            : `${pages.length} page${pages.length === 1 ? '' : 's'}`;
        const th = materialThumb(m);
        listEl.append(h('div', { class: 'card pad layer row between wrap', style: { gap: '.6rem', alignItems: 'center' } },
          h('div', { class: 'row gap-s grow', style: { minWidth: 0 } },
            th ? h('img', { class: 'mat-thumb', src: th, alt: '' }) : h('span', { class: 'ico-tile', 'data-group': 'content', html: icon(m.kind === 'youtube' ? 'youtube' : m.kind === 'image' ? 'image' : 'presentation', { size: 18 }) }),
            h('div', { class: 'grow', style: { minWidth: 0 } },
              h('b', { class: 'ellipsis' }, m.title),
              h('div', { class: 'tiny muted' }, `${kindLabel(m.kind)} · ${sub}`),
            ),
          ),
          h('div', { class: 'row gap-xs' },
            h('button', { class: 'btn sm danger', type: 'button', html: icon('trash', { size: 14 }) + 'Remove', onclick: async () => {
              try {
                await api(`/api/materials/${m.id}`, { method: 'DELETE' });
                toast('Removed', { icon: 'check' });
                reload();
              } catch (e) { toastErr(e); }
            } }),
          ),
        ));
      });
    } catch (e) {
      listEl.replaceChildren(h('div', { class: 'tiny muted' }, e.message || 'Failed to load'));
    }
  }

  const title = h('input', { class: 'input', placeholder: 'Title', maxlength: 120 });
  const yt = h('input', { class: 'input', placeholder: 'YouTube URL (optional)', type: 'url' });
  const fileIn = h('input', { type: 'file', accept: 'application/pdf,image/*,.pptx,application/vnd.openxmlformats-officedocument.presentationml.presentation', multiple: true, class: 'hidden' });
  let busy = false;
  const status = h('div', { class: 'tiny muted' });

  async function saveFromFiles(files) {
    if (!files.length || busy) return;
    busy = true;
    status.textContent = 'Working…';
    // Every step is named so a failure is reported as e.g. "upload page 3/14" in the server log.
    let step = 'start';
    const meta = { file: files[0]?.name, mime: files[0]?.type || '(none)', size: files[0]?.size, pages: undefined };
    try {
      const t = title.value.trim() || files[0].name.replace(/\.[^.]+$/, '').slice(0, 80);
      if (files.length > 1 || files.every((f) => f.type.startsWith('image/'))) {
        if (!files.every((f) => f.type.startsWith('image/'))) throw new Error('Multi-select only works for images');
        const pages = [];
        for (let i = 0; i < files.length; i++) {
          step = `upload image ${i + 1}/${files.length}`;
          status.textContent = `Uploading ${i + 1}/${files.length}…`;
          pages.push((await uploadFile(files[i], { purpose: 'content' })).url);
        }
        step = 'save material'; meta.pages = pages.length;
        await api('/api/materials', { method: 'POST', body: { title: t, kind: 'slides', payload: { pages } } });
      } else {
        const f = files[0];
        const name = f.name.replace(/\.[^.]+$/, '').slice(0, 80);
        step = 'detect type';
        const kind = await deckKind(f);
        meta.kind = kind || 'unknown';
        if (DECK_HELP[kind]) throw new Error(DECK_HELP[kind]);
        if (kind === 'pdf') {
          step = 'load PDF renderer'; status.textContent = 'Rendering PDF…';
          const { pdfToImages } = await import('../room/pdfslides.js');
          step = 'render PDF';
          const { files: imgs, truncated, total } = await pdfToImages(f, { onProgress: (i, n) => { status.textContent = `Page ${i}/${n}…`; } });
          if (!imgs.length) throw new Error('That PDF has no pages we could read');
          const pages = [];
          for (let i = 0; i < imgs.length; i++) {
            step = `upload page ${i + 1}/${imgs.length}`;
            status.textContent = `Uploading ${i + 1}/${imgs.length}…`;
            pages.push((await uploadFile(imgs[i], { purpose: 'content' })).url);
          }
          step = 'save material'; meta.pages = pages.length; status.textContent = 'Saving…';
          await api('/api/materials', { method: 'POST', body: { title: t || name, kind: 'pdf', payload: { pages, sourceName: f.name, sourceMime: f.type } } });
          if (truncated) toast(`Only first ${imgs.length} of ${total} pages saved`, { icon: 'alert' });
        } else if (kind === 'pptx') {
          step = 'convert PPTX'; status.textContent = 'Converting PPTX… (this can take a few seconds)';
          let res;
          try {
            res = await fetch('/api/convert/pptx?title=' + encodeURIComponent(t || name), {
              method: 'POST', body: f, credentials: 'include',
              headers: { 'Content-Type': 'application/vnd.openxmlformats-officedocument.presentationml.presentation' },
            });
          } catch (err) { throw new Error('Could not reach the server to convert the PPTX. Check your connection and try again.'); }
          const data = await res.json().catch(() => ({}));
          if (!res.ok) { const err = new Error(data.error || `PPTX conversion failed (HTTP ${res.status})`); err.status = res.status; throw err; }
          if (!Array.isArray(data.pages) || !data.pages.length) throw new Error('No slides were produced from this presentation');
          step = 'save material'; meta.pages = data.pages.length; status.textContent = 'Saving…';
          await api('/api/materials', { method: 'POST', body: { title: data.title || t || name, kind: 'pptx', payload: { pages: data.pages, sourceName: f.name, sourceMime: f.type } } });
          if (data.truncated) toast(`Only first ${data.pages.length} of ${data.total} pages saved`, { icon: 'alert' });
        } else if (kind === 'image') {
          step = 'upload image'; status.textContent = 'Uploading…';
          const r = await uploadFile(f, { purpose: 'content' });
          step = 'save material';
          await api('/api/materials', { method: 'POST', body: { title: t || name, kind: 'image', payload: { url: r.url } } });
        } else throw new Error(`“${f.name}” isn’t a PDF, PPTX or image${f.type ? ` (${f.type})` : ''}`);
      }
      title.value = '';
      toast('Material saved', { icon: 'check', group: 'content' });
      reload();
    } catch (e) {
      const msg = reportClientError('materials', e, { step, ...meta });
      status.textContent = `Couldn’t save: ${msg}`;
      status.classList.add('err');
      busy = false; fileIn.value = '';
      return;
    }
    busy = false; status.textContent = ''; status.classList.remove('err'); fileIn.value = '';
  }

  fileIn.onchange = () => saveFromFiles(Array.from(fileIn.files || []));

  formCard.append(
    h('div', { class: 'row gap-s', style: { alignItems: 'center' } },
      h('span', { class: 'ico-tile', 'data-group': 'content', html: icon('plus', { size: 16 }) }),
      h('span', { class: 'lbl', style: { margin: 0 } }, 'Add material')),
    h('div', { class: 'grid2' }, title, yt),
    h('div', { class: 'row gap-s wrap' },
      h('button', { class: 'btn primary', type: 'button', html: icon('upload', { size: 16 }) + ' Upload PDF / PPTX / images', onclick: () => fileIn.click() }),
      h('button', { class: 'btn', type: 'button', html: icon('youtube', { size: 16 }) + ' Save YouTube link', onclick: async () => {
        const id = ytId(yt.value);
        if (!id) return toast('Paste a valid YouTube URL', { icon: 'alert' });
        try {
          await api('/api/materials', { method: 'POST', body: { title: title.value.trim() || 'YouTube video', kind: 'youtube', payload: { videoId: id } } });
          yt.value = ''; title.value = '';
          toast('Saved', { icon: 'check' });
          reload();
        } catch (e) { toastErr(e); }
      } }),
      fileIn,
    ),
    status,
  );

  view.append(formCard, h('div', { class: 'sec-sub', style: { marginTop: '1.25rem' } }, 'Your library'), listEl);
  reload();
}
