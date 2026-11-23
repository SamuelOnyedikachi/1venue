/** Shared sale/buy UI for materials (library, picker, event page, in-call). */
import { h, api, toast, toastErr, sheet } from './ui.js';
import { fmtMoney } from './money.js';
import { icon } from './icons.js';

export function priceLabel(m) {
  if (!m || !m.forSale || !m.priceKobo) return '';
  const live = m.promoPriceKobo != null && m.promoPriceKobo !== m.priceKobo;
  if (live) return `${fmtMoney(m.promoPriceKobo)} (${m.callDiscountPct}% off)`;
  return fmtMoney(m.priceKobo);
}

export function saleEditor(m, { onSaved } = {}) {
  const on = h('input', { type: 'checkbox', checked: !!m.forSale });
  const price = h('input', { class: 'input sm', type: 'number', min: '50', step: '50', value: m.priceKobo ? String(Math.round(m.priceKobo / 100)) : '', placeholder: 'Price (₦)', 'aria-label': 'Price in naira' });
  const disc = h('input', { class: 'input sm', type: 'number', min: '0', max: '90', step: '5', value: String(m.callDiscountPct || 0), 'aria-label': 'Discount percent during a live call' });
  const save = async () => {
    try {
      const forSale = on.checked;
      const priceKobo = price.value === '' ? null : Math.round(Number(price.value) * 100);
      const callDiscountPct = Number(disc.value) || 0;
      const body = { forSale, priceKobo, callDiscountPct };
      const updated = await api(`/api/materials/${m.id}/sale`, { method: 'POST', body });
      Object.assign(m, updated);
      toast(forSale ? 'Sale settings saved' : 'This material is no longer for sale', { icon: 'check' });
      onSaved && onSaved(m);
    } catch (e) { toastErr(e); }
  };
  return h('div', { class: 'mat-sale col', style: { gap: '.4rem' } },
    h('label', { class: 'set-row' }, h('span', { class: 'grow' }, 'For sale'), h('span', { class: 'switch' }, on, h('span'))),
    h('div', { class: 'row wrap gap-s', style: { alignItems: 'center' } },
      h('label', { class: 'grow' }, h('span', { class: 'tiny muted' }, 'Price (₦)'), price),
      h('label', { class: 'grow' }, h('span', { class: 'tiny muted' }, 'Call discount %'), disc)),
    h('button', { class: 'btn sm', type: 'button', onclick: save }, 'Save sale'));
}

export async function openBuySheet(m, { eventId, meetingCode, returnPath } = {}) {
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
      toast('You now have this material', { icon: 'check' });
      s.close();
      m.purchased = true; m.locked = false;
    } catch (e) { toastErr(e); }
  };
  s.body.replaceChildren(
    pay,
    h('div', { class: 'tiny muted' }, `The platform keeps ${((q.feeBps || 2000) / 100).toFixed(0)}%. The rest goes to the host.`),
    h('div', { class: 'col', style: { gap: '.5rem', marginTop: '.6rem' } },
      h('button', { class: 'btn primary block', type: 'button', onclick: () => go('paystack'), html: icon('creditCard', { size: 16 }) + ' Pay with card' }),
      h('button', { class: 'btn block', type: 'button', onclick: () => go('credits') }, `Pay with ${q.credits} credit${q.credits === 1 ? '' : 's'}`))
  );
  return s;
}
