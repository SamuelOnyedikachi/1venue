// Whiteboard "Refine page with AI": pick a style, add an optional prompt, compare before / after, then
// insert the result as an image, replace the page with it, or discard it. Server: POST /api/whiteboards/refine.
import { h, api, sheet, toast, toastErr } from './ui.js';
import { icon } from './icons.js';
import { state } from './app.js';
import { inkOf, setInkTheme } from './wbcore.js';
import { pagePalette, snapPixels } from './wb-palette.js';

export const PRESETS = [
  ['clean', 'Clean line art', 'Tidies your strokes. Same drawing, same colours.'],
  ['math', 'Neat handwriting & math', 'Legible writing and typeset maths, exactly as written.'],
  ['diagram', 'Diagram cleanup', 'Straight arrows, neat boxes, tidy labels.'],
  ['illustration', 'Sketch → illustration', 'A polished drawing of the same subject.'],
  ['watercolor', 'Watercolour', 'A soft watercolour painting of it.'],
  ['marker', 'Marker poster', 'Bold marker lines and flat colour.'],
  ['custom', 'Custom', 'Only your prompt.'],
];
const COLOUR_PRESETS = new Set(['clean', 'math', 'diagram', 'illustration']);

const loadImg = (src) => new Promise((res, rej) => { const i = new Image(); i.crossOrigin = 'anonymous'; i.onload = () => res(i); i.onerror = () => rej(new Error('The refined image could not be loaded')); i.src = src; });

async function snapToPalette(url, palette) {
  const im = await loadImg(url);
  const c = document.createElement('canvas'); c.width = im.naturalWidth; c.height = im.naturalHeight;
  const x = c.getContext('2d'); x.drawImage(im, 0, 0);
  const d = x.getImageData(0, 0, c.width, c.height); snapPixels(d.data, palette); x.putImageData(d, 0, 0);
  return new Promise((r) => c.toBlob(r, 'image/png'));
}

export async function refineSheet(b) {
  const page = b.page;
  if (!page || (!page.strokes.length && !page.texts.length && !page.images.length)) return toast('Draw something on this page first', { icon: 'info' });
  const before = await b.snapshot({ bg: 'plain', scale: 0.8 });
  const beforeUrl = before.toDataURL('image/png');
  setInkTheme(false); const palette = pagePalette(page, inkOf); setInkTheme(document.documentElement.dataset.theme === 'dark');
  let preset = 'clean', result = null, busy = false;
  const chips = h('div', { class: 'wb-ai-presets', role: 'radiogroup', 'aria-label': 'Style' });
  const hint = h('p', { class: 'tiny muted wb-ai-hint' });
  const prompt = h('textarea', { class: 'input wb-ai-prompt', rows: 2, maxlength: 500, placeholder: 'Optional: what else should change? e.g. “make the face smile”, “add a blue sky”, “use pastel colours”' });
  const keep = h('input', { type: 'checkbox', checked: true });
  const keepRow = h('label', { class: 'wb-ai-keep' }, keep, h('span', null, 'Keep the exact board colours'), h('span', { class: 'wb-ai-swatches' }, palette.slice(1).map((c) => h('i', { style: { background: c }, title: c }))));
  const syncChips = () => {
    [...chips.children].forEach((el) => { const on = el.dataset.p === preset; el.classList.toggle('on', on); el.setAttribute('aria-checked', String(on)); });
    hint.textContent = PRESETS.find((p) => p[0] === preset)[2];
    keepRow.hidden = !COLOUR_PRESETS.has(preset) || palette.length < 2;
    prompt.placeholder = preset === 'custom' ? 'Describe what you want, e.g. “turn this into a neon sign”' : 'Optional: what else should change? e.g. “make the face smile”, “add a blue sky”';
  };
  for (const [id, label] of PRESETS) chips.append(h('button', { type: 'button', class: 'chip', role: 'radio', 'data-p': id, onclick: () => { preset = id; syncChips(); } }, label));
  const after = h('div', { class: 'wb-ai-img after empty' }, h('span', { class: 'tiny muted' }, 'The refined page shows here'));
  const compare = h('div', { class: 'wb-ai-compare' },
    h('figure', null, h('div', { class: 'wb-ai-img' }, h('img', { src: beforeUrl, alt: 'This page now' })), h('figcaption', { class: 'tiny muted' }, 'Before')),
    h('figure', null, after, h('figcaption', { class: 'tiny muted' }, 'After')));
  const go = h('button', { class: 'btn primary wb-ai-go', type: 'button' }, h('span', { html: icon('wand', { size: 16 }) }), h('span', null, 'Refine'));
  const insert = h('button', { class: 'btn', type: 'button', hidden: true }, 'Insert as image');
  const replace = h('button', { class: 'btn primary', type: 'button', hidden: true }, 'Replace page');
  const discard = h('button', { class: 'btn ghost', type: 'button', hidden: true }, 'Discard');
  const actions = h('div', { class: 'wb-ai-actions' }, discard, insert, replace, go);
  const sh = sheet({ title: `Refine page ${b.pageIndex + 1}`, icon: 'wand', group: 'ai', wide: true, body: h('div', { class: 'wb-ai' }, compare, h('div', { class: 'wb-ai-form' }, chips, hint, prompt, keepRow), actions) });
  syncChips();
  const show = (url) => {
    after.classList.remove('empty', 'busy'); after.replaceChildren(h('img', { src: url, alt: 'Refined page' }));
    [insert, replace, discard].forEach((x) => { x.hidden = false; });
    go.lastChild.textContent = 'Try again'; go.classList.remove('primary');
  };
  go.onclick = async () => {
    if (busy) return;
    if (preset === 'custom' && !prompt.value.trim()) { prompt.focus(); return toast('Describe what you want for a custom refine', { icon: 'info' }); }
    busy = true; go.disabled = true; after.classList.add('busy'); after.classList.remove('empty');
    after.replaceChildren(h('span', { class: 'spinner' }), h('span', { class: 'tiny muted' }, 'Refining… this can take up to a minute'));
    try {
      const r = await api('/api/whiteboards/refine', { method: 'POST', body: { image: beforeUrl, preset, prompt: prompt.value.trim(), palette: keep.checked ? palette : [] } });
      let url = r.url;
      if (keep.checked && !keepRow.hidden && !r.mock) { // pull the AI's colours back onto the board's exact colours
        try { const blob = await snapToPalette(url, palette); if (blob) url = await b.uploadImage(new File([blob], `refined-${preset}.png`, { type: 'image/png' })); } catch { /* keep the AI image */ }
      }
      result = url; show(url);
      if (r.mock) toast('Preview mode: the AI is off on this server, so the page comes back unchanged', { icon: 'info' });
    } catch (e) { after.classList.remove('busy'); after.classList.add('empty'); after.replaceChildren(h('span', { class: 'tiny muted' }, 'No result, try again')); toastErr(e); }
    finally { busy = false; go.disabled = false; }
  };
  insert.onclick = async () => { if (!result) return; sh.close(); await b.addImage(result).catch(toastErr); toast('Added to the page', { icon: 'check' }); };
  replace.onclick = () => { if (!result) return; sh.close(); b.replacePage(result); toast('Page replaced. Undo brings the original back.', { icon: 'check' }); };
  discard.onclick = () => sh.close();
  return sh;
}
