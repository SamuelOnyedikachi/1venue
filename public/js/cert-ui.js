import { h } from './ui.js';

const DESIGNS = [
  ['classic', 'Classic'],
  ['modern', 'Modern'],
  ['minimal', 'Minimal'],
];

export function certEditor(certs = {}, { accent = '#2563eb', onChange } = {}) {
  let enabled = !!certs.enabled;
  let design = ['classic', 'modern', 'minimal'].includes(certs.design) ? certs.design : 'classic';
  let minMinutes = certs.minMinutes || 10;
  const emit = () => onChange && onChange({ enabled, design, minMinutes });
  const on = h('input', { type: 'checkbox', checked: enabled, onchange: () => { enabled = on.checked; emit(); paint(); } });
  const mins = h('input', { class: 'input sm', type: 'number', min: '1', max: '180', value: String(minMinutes), oninput: () => { minMinutes = Math.min(180, Math.max(1, Number(mins.value) || 10)); emit(); } });
  const picks = h('div', { class: 'cert-picks' });
  function paint() {
    picks.replaceChildren(...DESIGNS.map(([id, label]) => h('button', {
      type: 'button', class: 'cert-pick' + (design === id ? ' on' : ''), 'data-design': id,
      style: { '--cert-accent': accent },
      onclick: () => { design = id; emit(); paint(); },
    }, h('div', { class: 'cert-pick-art' }), h('b', null, label))));
  }
  paint();
  const el = h('div', { class: 'col cert-editor', style: { gap: '.55rem' } },
    h('label', { class: 'set-row' }, h('span', { class: 'grow' }, 'Send a certificate when the event ends'), h('span', { class: 'switch' }, on, h('span'))),
    h('div', { class: 'tiny muted' }, 'Everyone who stays past the minimum time gets a PDF by Notification and email, in your event colour.'),
    picks,
    h('label', null, h('span', { class: 'tiny muted' }, 'Minimum minutes attended'), mins));
  el.get = () => ({ enabled, design, minMinutes });
  el.setAccent = (a) => { accent = a; paint(); };
  return el;
}
