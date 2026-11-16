// Shared materials helpers: type icons, thumbnails, and one upload pipeline used by the Materials
// library, the material page and the Create page's materials picker.
import { api, uploadFile, deckKind } from './ui.js';

export const ACCEPT = 'application/pdf,image/*,.pdf,.ppt,.pptx,.doc,.docx,.csv,.xls,.xlsx,'
  + 'application/vnd.openxmlformats-officedocument.presentationml.presentation,application/vnd.ms-powerpoint,'
  + 'application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/msword,'
  + 'text/csv,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

export const KIND = {
  slides: { label: 'Slides', icon: 'presentation' },
  image: { label: 'Image', icon: 'image' },
  youtube: { label: 'YouTube', icon: 'youtube' },
  pdf: { label: 'PDF', icon: 'fileText' },
  pptx: { label: 'PowerPoint', icon: 'presentation' },
  doc: { label: 'Word', icon: 'file' },
  sheet: { label: 'Spreadsheet', icon: 'grid' },
};
export const kindLabel = (k) => (KIND[k] ? KIND[k].label : k);
export const kindIcon = (k) => (KIND[k] ? KIND[k].icon : 'file');

export function materialThumb(m) {
  if (!m) return null;
  if (m.kind === 'youtube' && m.payload?.videoId) return `https://i.ytimg.com/vi/${m.payload.videoId}/mqdefault.jpg`;
  if (m.kind === 'image' && m.payload?.url) return m.payload.url;
  const pages = m.payload?.pages;
  return Array.isArray(pages) && pages[0] ? pages[0] : null;
}
export function materialSub(m) {
  const pages = m.payload?.pages || [];
  if (m.kind === 'youtube') return 'YouTube video';
  if (m.kind === 'image') return 'Image';
  if (m.kind === 'doc' || m.kind === 'sheet') return `${kindLabel(m.kind)}${m.payload?.sourceName ? ' · ' + m.payload.sourceName : ''}`;
  return `${kindLabel(m.kind)} · ${pages.length} page${pages.length === 1 ? '' : 's'}`;
}

const SHEET_MIME = { csv: 'text/csv', xls: 'application/vnd.ms-excel', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' };
const DOC_MIME = { doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' };
/** 'pdf' | 'pptx' | 'ppt' | 'image' | 'doc' | 'sheet' | null for a picked file. */
export async function fileKind(f) {
  const n = String(f.name || '').toLowerCase(), t = String(f.type || '').toLowerCase();
  const ext = n.split('.').pop();
  if (DOC_MIME[ext] || t.includes('wordprocessingml') || t === 'application/msword') return 'doc';
  if (SHEET_MIME[ext] || t.includes('spreadsheetml') || t === 'text/csv' || t === 'application/vnd.ms-excel') return 'sheet';
  const k = await deckKind(f);
  if (k === 'pptx' && !n.endsWith('.pptx') && !n.endsWith('.ppsx') && !t.includes('presentationml')) {
    // A zip with no telling name/type: could be a DOCX or XLSX from a phone share sheet. The server sniffs it.
    return 'pptx';
  }
  return k === 'keynote' ? null : k;
}
/** Give phones' typeless files a proper MIME so the server stores and serves them correctly. */
function typed(f) {
  if (f.type) return f;
  const ext = String(f.name || '').toLowerCase().split('.').pop();
  const type = SHEET_MIME[ext] || DOC_MIME[ext] || (ext === 'pptx' ? 'application/vnd.openxmlformats-officedocument.presentationml.presentation' : ext === 'ppt' ? 'application/vnd.ms-powerpoint' : ext === 'pdf' ? 'application/pdf' : '');
  return type ? new File([f], f.name, { type }) : f;
}

/**
 * Upload picked files and save them as ONE material (several images become one slide set).
 * onStatus(text) reports progress; onStep(step) names the step for error reports.
 * Resolves { material, notes: [] } (notes = non-fatal warnings such as truncated decks).
 */
export async function uploadMaterial(files, { title = '', onStatus = () => {}, onStep = () => {} } = {}) {
  const notes = [];
  if (!files.length) throw new Error('Choose a file');
  const save = (body) => { onStep('save material'); onStatus('Saving…'); return api('/api/materials', { method: 'POST', body }); };
  const baseName = files[0].name.replace(/\.[^.]+$/, '').slice(0, 80);
  const t = title.trim() || baseName;
  if (files.length > 1) {
    if (!files.every((f) => f.type.startsWith('image/'))) throw new Error('Pick several images, or one document at a time');
    const pages = [];
    for (let i = 0; i < files.length; i++) { onStep(`upload image ${i + 1}/${files.length}`); onStatus(`Uploading ${i + 1}/${files.length}…`); pages.push((await uploadFile(files[i], { purpose: 'content' })).url); }
    return { material: await save({ title: t, kind: 'slides', payload: { pages } }), notes };
  }
  const f = typed(files[0]);
  onStep('detect type');
  const kind = await fileKind(f);
  // The original file is kept too (analysis, download). Best effort for decks: their pages still work without it.
  const source = async (required) => {
    onStep('upload original'); onStatus('Uploading file…');
    try { const r = await uploadFile(f, { purpose: 'content' }); return { sourceUrl: r.url, sourceName: f.name, sourceMime: f.type || r.mime, sourceSize: f.size }; }
    catch (e) { if (required) throw e; notes.push('The original file could not be stored, so this material can’t be analysed.'); return { sourceName: f.name, sourceMime: f.type }; }
  };
  if (kind === 'doc' || kind === 'sheet') return { material: await save({ title: t, kind, payload: await source(true) }), notes };
  if (kind === 'image') {
    onStep('upload image'); onStatus('Uploading…');
    const r = await uploadFile(f, { purpose: 'content' });
    return { material: await save({ title: t, kind: 'image', payload: { url: r.url } }), notes };
  }
  if (kind === 'pdf') {
    onStep('load PDF renderer'); onStatus('Rendering PDF…');
    const { pdfToImages } = await import('./room/pdfslides.js');
    onStep('render PDF');
    const { files: imgs, truncated, total } = await pdfToImages(f, { onProgress: (i, n) => onStatus(`Page ${i}/${n}…`) });
    if (!imgs.length) throw new Error('That PDF has no pages we could read');
    const pages = [];
    for (let i = 0; i < imgs.length; i++) { onStep(`upload page ${i + 1}/${imgs.length}`); onStatus(`Uploading ${i + 1}/${imgs.length}…`); pages.push((await uploadFile(imgs[i], { purpose: 'content' })).url); }
    if (truncated) notes.push(`Only the first ${imgs.length} of ${total} pages were saved`);
    return { material: await save({ title: t, kind: 'pdf', payload: { pages, ...(await source(false)) } }), notes };
  }
  if (kind === 'pptx' || kind === 'ppt') {
    const src = await source(false);
    onStep('convert PowerPoint'); onStatus('Converting slides… (this can take a few seconds)');
    let res;
    try {
      res = await fetch('/api/convert/pptx?title=' + encodeURIComponent(t), { method: 'POST', body: f, credentials: 'include',
        headers: { 'Content-Type': kind === 'ppt' ? 'application/vnd.ms-powerpoint' : 'application/vnd.openxmlformats-officedocument.presentationml.presentation' } });
    } catch { throw new Error('Could not reach the server to convert the presentation. Check your connection and try again.'); }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) { const err = new Error(data.error || `Conversion failed (HTTP ${res.status})`); err.status = res.status; throw err; }
    if (!Array.isArray(data.pages) || !data.pages.length) throw new Error('No slides were produced from this presentation');
    if (data.truncated) notes.push(`Only the first ${data.pages.length} of ${data.total} slides were saved`);
    return { material: await save({ title: data.title || t, kind: 'pptx', payload: { pages: data.pages, ...src } }), notes };
  }
  throw new Error(`“${f.name}” isn’t a supported file. Use PDF, PowerPoint, Word, CSV, Excel or an image.`);
}
