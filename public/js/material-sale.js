/** Shared sale/buy UI for materials (library, picker, event page, in-call). */
import { h, api, toast, toastErr, sheet } from './ui.js';
import { fmtMoney } from './money.js';
import { icon } from './icons.js';
import { navigate } from './app.js';
import { kindIcon, materialThumb, materialSub } from './materials-lib.js';

export function priceLabel(m) {
  if (!m || !m.forSale || !m.priceKobo) return '';
  const live = m.promoPriceKobo != null && m.promoPriceKobo !== m.priceKobo;
  if (live) return `${fmtMoney(m.promoPriceKobo)} (${m.callDiscountPct}% off)`;
  return fmtMoney(m.priceKobo);
}

export const MARKET_CATEGORIES = ['Teaching', 'Worship', 'Study', 'Music', 'Training', 'Kids', 'Business', 'Other'];

export function saleEditor(m, { onSaved } = {}) {
  const on = h('input', { type: 'checkbox', checked: !!m.forSale });
  const listed = h('input', { type: 'checkbox', checked: !!m.listed });
  const price = h('input', { class: 'input sm', type: 'number', min: '50', step: '50', value: m.priceKobo ? String(Math.round(m.priceKobo / 100)) : '', placeholder: 'Price (₦)', 'aria-label': 'Price in naira' });
  const disc = h('input', { class: 'input sm', type: 'number', min: '0', max: '90', step: '5', value: String(m.callDiscountPct || 0), 'aria-label': 'Discount percent during a live call' });
  const cat = h('select', { class: 'input sm', 'aria-label': 'Marketplace category' },
    h('option', { value: '' }, 'Category'),
    ...MARKET_CATEGORIES.map((c) => h('option', { value: c, selected: m.category === c }, c)));
  const save = async () => {
    try {
      const forSale = on.checked;
      const priceKobo = price.value === '' ? null : Math.round(Number(price.value) * 100);
      const callDiscountPct = Number(disc.value) || 0;
      const body = { forSale, priceKobo, callDiscountPct, listed: listed.checked, category: cat.value || null };
      const updated = await api(`/api/materials/${m.id}/sale`, { method: 'POST', body });
      Object.assign(m, updated);
      toast(listed.checked ? 'Listed on the marketplace' : (forSale ? 'Sale settings saved' : 'Saved'), { icon: 'check' });
      onSaved && onSaved(m);
    } catch (e) { toastErr(e); }
  };
  return h('div', { class: 'mat-sale col', style: { gap: '.4rem' } },
    h('label', { class: 'set-row' }, h('span', { class: 'grow' }, 'For sale'), h('span', { class: 'switch' }, on, h('span'))),
    h('label', { class: 'set-row' }, h('span', { class: 'grow' }, 'List on marketplace'), h('span', { class: 'switch' }, listed, h('span'))),
    h('div', { class: 'row wrap gap-s', style: { alignItems: 'center' } },
      h('label', { class: 'grow' }, h('span', { class: 'tiny muted' }, 'Price (₦)'), price),
      h('label', { class: 'grow' }, h('span', { class: 'tiny muted' }, 'Call discount %'), disc)),
    h('label', { class: 'grow' }, h('span', { class: 'tiny muted' }, 'Category'), cat),
    h('button', { class: 'btn sm', type: 'button', onclick: save }, 'Save sale'));
}


export function materialCard(m, { buy = false } = {}) {
  const th = materialThumb(m);
  const price = m.forSale && m.priceKobo ? priceLabel(m) : 'Free';
  const href = '/materials/' + m.id;
  const go = (ev) => {
    if (buy && m.forSale && m.locked) {
      ev.preventDefault();
      openBuySheet(m, { onBought: () => navigate(href) });
    }
  };
  return h('div', { class: 'mat-card card layer' },
    h('a', { class: 'mat-card-link', href, 'data-link': '', onclick: go },
      h('div', { class: 'mat-card-thumb', 'data-kind': m.kind }, th ? h('img', { src: th, alt: '', loading: 'lazy' }) : h('span', { html: icon(kindIcon(m.kind), { size: 28 }) })),
      h('div', { class: 'mat-card-body' },
        h('b', { class: 'ellipsis' }, m.title || 'Untitled'),
        h('div', { class: 'tiny muted ellipsis' }, materialSub(m), m.category ? ' · ' + m.category : ''),
        h('div', { class: 'tiny muted ellipsis' }, (m.host && m.host.name) || '', (m.host && m.host.name) ? ' · ' : '', price))));
}

export async function openBuySheet(m, { eventId, meetingCode, returnPath, onBought } = {}) {
  const s = sheet({ title: m.title || 'Buy material', icon: 'ticket', group: 'content' });
  const status = h('div', { class: 'tiny muted' }, 'Loading price…');
  s.body.append(status);
  let q;
  try {
    const qs = new URLSearchParams();
    if (eventId) qs.set('eventId', eventId);
    if (meetingCode) qs.set('meetingCode', meetingCode);
    q = await api(`/api/materials/${m.id}/quote?${qs}`);
  } catch (e) { status.textContent = e.message || 'Could not load the price'; return s; }
  const pay = q.promo
    ? h('div', { class: 'col', style: { gap: '.3rem' } },
      h('div', { class: 'tiny muted' }, `${q.callDiscountPct}% off during this call`),
      h('b', null, fmtMoney(q.priceKobo)),
      h('s', { class: 'tiny muted' }, fmtMoney(q.listPriceKobo)))
    : h('b', null, fmtMoney(q.priceKobo));
  const go = async (method) => {
    try {
      const r = await api(`/api/materials/${m.id}/buy`, { method: 'POST', body: { method, eventId, meetingCode, returnPath: returnPath || location.pathname } });
      if (method === 'paystack') {
        if (r.authorizationUrl) location.assign(r.authorizationUrl);
        else toast('Could not start checkout', { icon: 'alert' });
        return;
      }
      m.purchased = true; m.locked = false;
      toast('You now have this material', { icon: 'check', action: { label: 'Open', run: () => navigate('/materials/' + m.id) } });
      s.close();
      onBought && onBought(m);
    } catch (e) { toastErr(e); }
  };
  s.body.replaceChildren(
    pay,
    h('div', { class: 'col', style: { gap: '.5rem', marginTop: '.6rem' } },
      h('button', { class: 'btn primary block', type: 'button', onclick: () => go('paystack'), html: icon('creditCard', { size: 16 }) + ' Pay with card' }),
      h('button', { class: 'btn block', type: 'button', onclick: () => go('credits') }, `Pay with ${q.credits} credit${q.credits === 1 ? '' : 's'}`))
  );
  return s;
}
