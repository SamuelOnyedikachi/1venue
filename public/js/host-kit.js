// Shared building blocks for the host tools and billing pages: section cards, striped tables that turn into
// card rows on phones, icon actions with tooltips, filter chips, stat tiles, empty states and the 7/30/90/custom date-range picker.
import { h, toastErr } from './ui.js';
import { icon } from './icons.js';

/** A section card: icon tile, title, optional description and header actions, then the body. */
export function panel({ icon: ic, title, desc, actions, id, cls = '' } = {}, ...body) {
  return h('section', { class: `card ht-panel ${cls}`.trim(), id: id || null },
    h('header', { class: 'ht-panel-head' },
      ic ? h('span', { class: 'ico-tile ht-ico', html: icon(ic, { size: 18 }) }) : null,
      h('div', { class: 'grow ht-panel-title' }, h('h2', null, title), desc ? h('p', { class: 'small muted' }, desc) : null),
      actions ? h('div', { class: 'ht-panel-actions' }, actions) : null),
    h('div', { class: 'ht-panel-body' }, ...body));
}
/** Striped table. cols: [{ label, cls?, num? }]; rows: arrays of cells (Node | string). Card rows on phones. */
export function table(cols, rows, { empty: emptyEl = null, cls = '', caption = null } = {}) {
  if (!rows.length && emptyEl) return emptyEl;
  return h('div', { class: `ht-table-wrap ${cls}`.trim() }, h('table', { class: 'ht-table' },
    caption ? h('caption', { class: 'sr-only' }, caption) : null,
    h('thead', null, h('tr', null, ...cols.map((c) => h('th', { scope: 'col', class: [c.cls, c.num ? 'num' : ''].filter(Boolean).join(' ') || null }, c.label)))),
    h('tbody', null, ...rows.map((r) => h('tr', { class: r.cls || null }, ...r.map((cell, i) => h('td', { 'data-label': cols[i] && cols[i].label ? cols[i].label : null, class: [cols[i] && cols[i].cls, cols[i] && cols[i].num ? 'num' : ''].filter(Boolean).join(' ') || null }, cell)))))));
}
/** Icon-only action: a link (href) or a button (onClick). Always has an aria-label and a tooltip. */
export function iconBtn(ic, label, { href, onClick, download, cls = '', tip = label, disabled = false, size = 18 } = {}) {
  const props = { class: `ht-ib ${cls}`.trim(), 'aria-label': label, 'data-tip': tip, html: icon(ic, { size }) };
  if (href) return h('a', { ...props, href, download: download === undefined ? null : download, 'aria-disabled': disabled ? 'true' : null, tabindex: disabled ? '-1' : null });
  const b = h('button', { ...props, type: 'button', disabled });
  if (onClick) b.onclick = async (e) => { b.disabled = true; try { await onClick(e); } catch (err) { toastErr(err); } finally { if (b.isConnected) b.disabled = false; } };
  return b;
}
/** CSV + Excel download icons for one export path. */
export function downloads(path, what, { disabled = false } = {}) {
  const x = path + (path.includes('?') ? '&' : '?') + 'format=xlsx';
  return h('span', { class: 'ht-dl' },
    iconBtn('fileCsv', `Download ${what} as CSV`, { href: disabled ? null : path, download: '', cls: 'csv', tip: 'CSV', disabled, onClick: disabled ? () => {} : null }),
    iconBtn('fileSheet', `Download ${what} as Excel`, { href: disabled ? null : x, download: '', cls: 'xls', tip: 'Excel', disabled, onClick: disabled ? () => {} : null }));
}
/** Filter chips (single choice). opts: [[id, label]]. */
export function chips(opts, value, onPick, { label = 'Filter' } = {}) {
  const wrap = h('div', { class: 'chips ht-chips', role: 'radiogroup', 'aria-label': label });
  const paint = (v) => { for (const b of wrap.children) { const on = b.dataset.id === v; b.classList.toggle('on', on); b.setAttribute('aria-checked', String(on)); } };
  for (const [id, l, ic] of opts) wrap.append(h('button', { type: 'button', class: 'chip', role: 'radio', 'data-id': id, html: (ic ? icon(ic, { size: 14 }) : '') + `<span>${l}</span>`, onclick: () => { paint(id); onPick(id); } }));
  paint(value);
  wrap.set = paint;
  return wrap;
}
export const stat = (value, label, { ic, tone = '' } = {}) => h('div', { class: `ht-stat ${tone}`.trim() },
  ic ? h('span', { class: 'ht-stat-ic', html: icon(ic, { size: 16 }) }) : null,
  h('strong', null, String(value)), h('span', { class: 'tiny muted' }, label));
export const stats = (...tiles) => h('div', { class: 'ht-stats' }, ...tiles);
export const empty = (ic, title, text, action = null) => h('div', { class: 'ht-empty' },
  h('span', { class: 'ht-empty-ic', html: icon(ic, { size: 22 }) }), h('div', null, h('strong', null, title), text ? h('p', { class: 'small muted' }, text) : null), action);
/** A status pill. tone: ok | wait | bad | muted | accent */
export const pill = (text, tone = 'muted', ic = null) => h('span', { class: `ht-pill ${tone}`, html: (ic ? icon(ic, { size: 13 }) : '') + `<span>${String(text).replace(/</g, '&lt;')}</span>` });
export const field = (label, input, hint = null) => h('label', { class: 'ht-field' }, h('span', { class: 'ht-field-l' }, label), input, hint);
export const actionBtn = (text, fn, { primary = false, ic = null, cls = '' } = {}) => {
  const b = h('button', { class: `btn${primary ? ' primary' : ''} ${cls}`.trim(), type: 'button', html: (ic ? icon(ic, { size: 16 }) : '') + `<span>${text}</span>` });
  b.onclick = async () => { b.disabled = true; try { await fn(); } catch (e) { toastErr(e); } finally { if (b.isConnected) b.disabled = false; } };
  return b;
};
export const dayFmt = (d) => (d ? new Date(d).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : '');
export const whenFmt = (d) => (d ? new Date(d).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }) : '');

const isoDay = (d) => new Date(d).toISOString().slice(0, 10);
/** 7 / 30 / 90 / custom date range. Mutates `R` (`{ days, from, to }`) and calls onChange. */
export function rangePicker(R, onChange) {
  const inp = (attrs = {}) => h('input', { class: 'input', ...attrs });
  const preset = R.from ? 'custom' : String(R.days || 30);
  const from = inp({ type: 'date', value: R.from || isoDay(new Date(Date.now() - 29 * 864e5)), max: isoDay(new Date()), 'aria-label': 'From' });
  const to = inp({ type: 'date', value: R.to || isoDay(new Date()), max: isoDay(new Date()), 'aria-label': 'To' });
  const err = h('span', { class: 'tiny ht-err', role: 'alert' });
  const apply = h('button', { class: 'btn primary sm', type: 'button' }, 'Apply');
  const custom = h('div', { class: 'ht-custom', hidden: preset !== 'custom' }, field('From', from), field('To', to), apply, err);
  apply.onclick = () => {
    err.textContent = '';
    if (!from.value || !to.value) { err.textContent = 'Pick both dates.'; return; }
    if (from.value > to.value) { err.textContent = 'The start date must be before the end date.'; return; }
    const today = isoDay(new Date());
    if (to.value > today) { err.textContent = 'The end date cannot be in the future.'; return; }
    if ((Date.parse(to.value) - Date.parse(from.value)) / 864e5 > 365) { err.textContent = 'Choose at most 366 days.'; return; }
    Object.assign(R, { days: null, from: from.value, to: to.value }); onChange();
  };
  const c = chips([['7', '7 days'], ['30', '30 days'], ['90', '90 days'], ['custom', 'Custom', 'calendar']], preset, (id) => {
    if (id === 'custom') { custom.hidden = false; from.focus(); return; }
    custom.hidden = true; Object.assign(R, { days: id, from: null, to: null }); onChange();
  }, { label: 'Date range' });
  return h('div', { class: 'ht-range' }, c, custom);
}
export const rangeLabel = (r) => (r.preset ? `Last ${r.days} days` : `${dayFmt(r.from + 'T00:00:00Z')} – ${dayFmt(r.to + 'T00:00:00Z')}`);
