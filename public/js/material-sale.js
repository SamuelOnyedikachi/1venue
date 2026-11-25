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

const PRICE_PER_CREDIT_KOBO = 50000;
const RETURN_KEY = 'venue.matReturn';

export function creditsFromKobo(k) {
  return k > 0 ? Math.max(1, Math.round(Number(k) / PRICE_PER_CREDIT_KOBO)) : 0;
}

export function buyLabel(m) {
  const kobo = (m && m.promoPriceKobo != null && m.promoPriceKobo !== m.priceKobo) ? m.promoPriceKobo : (m && m.priceKobo);
  const price = priceLabel(m);
  const cr = creditsFromKobo(kobo);
  if (price && cr) return `Buy · ${price} or ${cr} credit${cr === 1 ? '' : 's'}`;
  if (price) return 'Buy · ' + price;
  return 'Buy';
}

export function stashMaterialReturn(id, { href, label, scroll } = {}) {
  const rec = {
    id: Number(id),
    href: href || (location.pathname + location.search),
    label: label || 'Materials',
    scroll: scroll != null ? Number(scroll) : Math.round(window.scrollY || 0),
    at: Date.now(),
  };
  try { sessionStorage.setItem(RETURN_KEY, JSON.stringify(rec)); } catch { /* private mode */ }
  return rec;
}

export function readMaterialReturn(id) {
  try {
    const rec = JSON.parse(sessionStorage.getItem(RETURN_KEY) || 'null');
    if (!rec || (id != null && Number(rec.id) !== Number(id))) return null;
    if (rec.at && Date.now() - rec.at > 6 * 3600e3) return null;
    return rec;
  } catch { return null; }
}

/** Consume a saved scroll position when returning to /market or /materials. */
export function takeMaterialReturnScroll(prefix) {
  const rec = readMaterialReturn();
  if (!rec || !rec.href || !String(rec.href).startsWith(prefix) || rec.scroll == null) return null;
  const y = Number(rec.scroll);
  try {
    rec.scroll = null;
    sessionStorage.setItem(RETURN_KEY, JSON.stringify(rec));
  } catch { /* ignore */ }
  return Number.isFinite(y) ? y : null;
}

export function resolveMaterialBack(m, { id, search, state: hist, stashed } = {}) {
  const from = String((search instanceof URLSearchParams ? search : new URLSearchParams(search || '')).get('from') || (hist && hist.from) || '');
  const rec = stashed !== undefined ? stashed : readMaterialReturn(id != null ? id : (m && m.id));
  const marketHref = (rec && rec.href && rec.href.startsWith('/market')) ? rec.href : '/market';
  const matsHref = (rec && rec.href && /^\/materials\/?(\?|$)/.test(rec.href)) ? rec.href : '/materials';
  if (from === 'market' || (rec && rec.label === 'Marketplace')) return { href: marketHref, label: 'Marketplace', scroll: rec && rec.scroll };
  if (from === 'materials' || (rec && rec.label === 'Materials')) return { href: matsHref, label: 'Materials', scroll: rec && rec.scroll };
  if (m && (m.owner || m.canEdit)) return { href: '/materials', label: 'Materials' };
  if (m && m.listed) return { href: '/market', label: 'Marketplace' };
  return { href: '/materials', label: 'Materials' };
}

export function materialOpenAttrs(id, from) {
  const label = from === 'market' ? 'Marketplace' : 'Materials';
  return {
    href: `/materials/${id}?from=${from}`,
    'data-link': '',
    onclick: () => stashMaterialReturn(id, { href: location.pathname + location.search, label }),
  };
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


export function materialCard(m, { buy = false, from } = {}) {
  const th = materialThumb(m);
  const price = m.forSale && m.priceKobo ? priceLabel(m) : 'Free';
  const href = '/materials/' + m.id + (from ? ('?from=' + encodeURIComponent(from)) : '');
  const go = (ev) => {
    if (from) stashMaterialReturn(m.id, { href: location.pathname + location.search, label: from === 'market' ? 'Marketplace' : 'Materials' });
    if (!from && buy && m.forSale && m.locked) {
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
      const r = await api(`/api/materials/${m.id}/buy`, { method: 'POST', body: { method, eventId, meetingCode, returnPath: returnPath || (location.pathname + location.search) } });
      if (method === 'paystack') {
        if (r.authorizationUrl) location.assign(r.authorizationUrl);
        else toast('Could not start checkout', { icon: 'alert' });
        return;
      }
      m.purchased = true; m.locked = false;
      toast('You now have this material', { icon: 'check', action: onBought ? null : { label: 'Open', run: () => navigate('/materials/' + m.id) } });
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
