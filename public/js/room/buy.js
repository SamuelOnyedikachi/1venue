import { h, toast } from '../ui.js';
import { icon } from '../icons.js';
import { openBuySheet, priceLabel } from '../material-sale.js';

let chip;

export function hideBuyChip() {
  if (chip) { chip.remove(); chip = null; }
}

export function showBuyChip(R, material) {
  hideBuyChip();
  if (!material) return;
  const stage = document.querySelector('.stage') || document.querySelector('.room') || document.body;
  chip = h('div', { class: 'buy-chip', role: 'dialog', 'aria-label': 'Buy material' },
    h('div', { class: 'buy-chip-body' },
      h('b', { class: 'ellipsis' }, material.title),
      h('div', { class: 'tiny muted' }, priceLabel(material) || 'For sale')),
    h('button', { class: 'btn xs primary', type: 'button', onclick: () => openBuySheet(material, { eventId: material.eventId || R.eventId, meetingCode: material.code || R.code }) }, 'Buy'),
    h('button', { class: 'icon-btn sm', type: 'button', 'aria-label': 'Dismiss', onclick: hideBuyChip, html: icon('x', { size: 14 }) })
  );
  stage.append(chip);
}

export function offerChat(R, m) {
  const material = m.material;
  R.data.chat.push({
    id: 'mat-' + (material && material.id) + '-' + (m.at || Date.now()),
    participantId: m.from && m.from.id,
    name: (m.from && m.from.name) || 'Host',
    at: m.at || Date.now(),
    text: '',
    attachment: { kind: 'material', material },
  });
  if (R.panel.tab !== 'chat') R.unread.chat++;
}

export function buyAttachment(a, R) {
  const m = a.material || a;
  return h('div', { class: 'msg-buy' },
    h('div', { class: 'grow' }, h('b', null, m.title || 'Material'), h('div', { class: 'tiny muted' }, priceLabel(m) || 'For sale')),
    h('button', { class: 'btn xs primary', type: 'button', onclick: () => openBuySheet(m, { eventId: m.eventId || R.eventId, meetingCode: m.code || R.code }) }, 'Buy'));
}
