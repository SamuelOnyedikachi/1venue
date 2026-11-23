// Materials picker (Create page): a searchable multi-select dropdown of your materials with type icons,
// and "Upload materials" inside it, so a new file is uploaded and attached in one step.
// Accessible combobox: the search box owns a listbox (aria-multiselectable); arrows move, Enter toggles, Esc closes.
import { icon } from './icons.js';
import { h, api, toast, reportClientError } from './ui.js';
import { ACCEPT, kindIcon, kindLabel, materialThumb, materialSub, uploadMaterial } from './materials-lib.js';
import { saleEditor, priceLabel } from './material-sale.js';

let uid = 0;
/** materialPicker({ selected: number[], onChange(ids) }) -> { el, set(ids) } */
export function materialPicker({ selected = [], onChange = () => {} } = {}) {
  const id = `matpick-${++uid}`;
  let ids = [...selected], all = [], open = false, active = 0, busy = false, loaded = false;
  const chips = h('div', { class: 'row wrap mp-chips', style: { gap: '.4rem' } });
  const countEl = h('span', { class: 'mp-count' });
  const trigger = h('button', { type: 'button', class: 'mp-trigger', 'aria-haspopup': 'listbox', 'aria-expanded': 'false', 'aria-controls': id + '-panel' },
    h('span', { class: 'mp-trigger-ico', html: icon('folder', { size: 16 }) }), h('span', { class: 'grow mp-trigger-label' }, 'Add materials to this event'), countEl, h('span', { class: 'mp-caret', html: icon('chevronDown', { size: 16 }) }));
  const search = h('input', { class: 'input mp-search', type: 'search', placeholder: 'Search your materials…', autocomplete: 'off', role: 'combobox', 'aria-expanded': 'true', 'aria-controls': id + '-list', 'aria-autocomplete': 'list', 'aria-label': 'Search materials', 'data-voice': 'off' });
  const list = h('div', { class: 'mp-list', id: id + '-list', role: 'listbox', 'aria-multiselectable': 'true', 'aria-label': 'Your materials' });
  const fileIn = h('input', { type: 'file', accept: ACCEPT, multiple: true, class: 'hidden' });
  const upStatus = h('span', { class: 'tiny muted mp-up-status', role: 'status', 'aria-live': 'polite' });
  const upBtn = h('button', { type: 'button', class: 'mp-upload' }, h('span', { class: 'ico-tile sm', 'data-group': 'content', html: icon('upload', { size: 16 }) }),
    h('span', { class: 'grow' }, h('b', null, 'Upload materials'), h('span', { class: 'tiny muted', style: { display: 'block' } }, 'PDF, PowerPoint, Word, CSV, Excel, images')), upStatus);
  upBtn.addEventListener('mousedown', (e) => e.preventDefault());
  upBtn.onclick = () => { if (!busy) fileIn.click(); };
  const panel = h('div', { class: 'mp-panel', id: id + '-panel', hidden: true }, h('div', { class: 'mp-search-row', html: icon('search', { size: 16 }) }, search), upBtn, list, fileIn);
  const el = h('div', { class: 'mp' }, trigger, panel, chips);

  const filtered = () => { const q = search.value.trim().toLowerCase(); return all.filter((m) => !q || m.title.toLowerCase().includes(q) || kindLabel(m.kind).toLowerCase().includes(q)); };
  const thumbEl = (m, cls) => { const th = materialThumb(m); return th ? h('img', { class: cls, src: th, alt: '', loading: 'lazy' }) : h('span', { class: `${cls} mp-ico`, 'data-kind': m.kind, html: icon(kindIcon(m.kind), { size: 18 }) }); };
  function paintList() {
    const items = filtered();
    if (!loaded) { list.replaceChildren(h('div', { class: 'mp-empty tiny muted' }, 'Loading…')); return; }
    if (!items.length) { list.replaceChildren(h('div', { class: 'mp-empty tiny muted' }, all.length ? 'No materials match. Try another word, or upload one.' : 'No materials yet. Upload your first one above.')); search.removeAttribute('aria-activedescendant'); return; }
    active = Math.min(active, items.length - 1);
    list.replaceChildren(...items.map((m, i) => {
      const on = ids.includes(m.id);
      const opt = h('div', { class: 'mp-opt' + (i === active ? ' active' : ''), id: `${id}-o${m.id}`, role: 'option', 'aria-selected': String(on), tabindex: '-1' },
        thumbEl(m, 'mp-thumb'), h('span', { class: 'grow mp-opt-text' }, h('b', { class: 'ellipsis' }, m.title), h('span', { class: 'tiny muted ellipsis' }, materialSub(m))),
        h('span', { class: 'mp-check', html: on ? icon('check', { size: 14 }) : '' }));
      opt.addEventListener('mousedown', (e) => e.preventDefault()); // keep focus in the search box (no keyboard flicker on phones)
      opt.onclick = () => { active = i; toggle(m.id); };
      return opt;
    }));
    const a = items[active]; if (a) search.setAttribute('aria-activedescendant', `${id}-o${a.id}`);
  }
  function paintChips() {
    countEl.textContent = ids.length ? String(ids.length) : '';
    countEl.hidden = !ids.length;
    chips.replaceChildren(...ids.map((mid) => all.find((m) => m.id === mid)).filter(Boolean).map((m) => h('div', { class: 'chip-mat-wrap col', style: { gap: '.35rem' } },
      h('span', { class: 'chip-mat' }, thumbEl(m, 'chip-mat-thumb'), h('span', { class: 'ellipsis' }, m.title + (m.forSale ? ` · ${priceLabel(m)}` : '')),
        h('button', { class: 'rm', type: 'button', 'aria-label': `Remove ${m.title}`, onclick: () => toggle(m.id) }, '−')),
      saleEditor(m, { onSaved: (u) => { const i = all.findIndex((x) => x.id === u.id); if (i >= 0) all[i] = u; paintChips(); } }))));
  }
  function toggle(mid) { ids = ids.includes(mid) ? ids.filter((x) => x !== mid) : [...ids, mid]; onChange(ids); paintList(); paintChips(); }
  function setOpen(v) {
    open = v; panel.hidden = !v; trigger.setAttribute('aria-expanded', String(v)); el.classList.toggle('open', v);
    if (v) { paintList(); setTimeout(() => { if (matchMedia('(hover:hover)').matches) search.focus(); }, 0); }
  }
  trigger.onclick = () => setOpen(!open);
  search.addEventListener('input', () => { active = 0; paintList(); });
  search.addEventListener('keydown', (e) => {
    const items = filtered();
    if (e.key === 'ArrowDown') { e.preventDefault(); active = Math.min(items.length - 1, active + 1); paintList(); list.querySelector('.active')?.scrollIntoView({ block: 'nearest' }); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); active = Math.max(0, active - 1); paintList(); list.querySelector('.active')?.scrollIntoView({ block: 'nearest' }); }
    else if (e.key === 'Enter') { e.preventDefault(); if (items[active]) toggle(items[active].id); }
    else if (e.key === 'Escape') { e.preventDefault(); setOpen(false); trigger.focus(); }
  });
  document.addEventListener('pointerdown', (e) => { if (open && !el.contains(e.target)) setOpen(false); });
  el.addEventListener('keydown', (e) => { if (e.key === 'Escape' && open) { setOpen(false); trigger.focus(); } });

  fileIn.onchange = async () => {
    const files = Array.from(fileIn.files || []); fileIn.value = '';
    if (!files.length || busy) return;
    busy = true; upBtn.classList.add('busy');
    let step = 'start';
    try {
      const { material, notes } = await uploadMaterial(files, { onStatus: (t) => { upStatus.textContent = t; }, onStep: (s) => { step = s; } });
      notes.forEach((n) => toast(n, { icon: 'alert' }));
      all = [material, ...all.filter((m) => m.id !== material.id)];
      if (!ids.includes(material.id)) ids = [...ids, material.id];
      onChange(ids); search.value = ''; active = 0; paintList(); paintChips();
      toast(`Added “${material.title}”`, { icon: 'check', group: 'content' });
    } catch (e) { toast(reportClientError('materials', e, { step, file: files[0]?.name, mime: files[0]?.type, size: files[0]?.size }), { icon: 'alert' }); }
    finally { busy = false; upBtn.classList.remove('busy'); upStatus.textContent = ''; }
  };

  api('/api/materials').then((r) => { all = r.materials || []; loaded = true; paintList(); paintChips(); }).catch(() => { loaded = true; paintList(); });
  paintChips();
  return { el, set(next) { ids = [...next]; paintList(); paintChips(); }, get: () => ids };
}
