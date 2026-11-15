// "Promoted" cards: admin-picked events / posts (see src/features/promotions).
// Wide screens: a right sidebar with up to 3 cards. Phones / narrow: one inline card in the page.
// Views are counted only when a card actually scrolls into view; clicks via sendBeacon.
import { icon } from './icons.js';
import { h, api, avatar, esc, profilePath } from './ui.js';
import { eventCard } from './components.js';

const cache = new Map(); // placement -> { at, p }
const TTL = 60_000;
const WIDE = '(min-width: 1180px)';
export function loadPromos(placement) {
  const hit = cache.get(placement);
  if (hit && Date.now() - hit.at < TTL) return hit.p;
  const p = api(`/api/promotions?placement=${encodeURIComponent(placement)}`).then((r) => r.items || []).catch(() => []);
  cache.set(placement, { at: Date.now(), p });
  return p;
}

let seenQ = new Set(), seenT = null;
const counted = new Set();
const io = typeof IntersectionObserver === 'function' ? new IntersectionObserver((es) => {
  for (const e of es) {
    if (!e.isIntersecting) continue;
    const id = Number(e.target.dataset.promo); io.unobserve(e.target);
    if (!id || counted.has(id)) continue;
    counted.add(id); seenQ.add(id);
  }
  if (seenQ.size && !seenT) seenT = setTimeout(() => { const ids = [...seenQ]; seenQ = new Set(); seenT = null; api('/api/promotions/seen', { method: 'POST', body: { ids } }).catch(() => {}); }, 1200);
}, { threshold: 0.5 }) : null;
function click(id) {
  const url = `/api/promotions/${id}/click`;
  try { if (navigator.sendBeacon && navigator.sendBeacon(url, new Blob(['{}'], { type: 'application/json' }))) return; } catch { /* fall through */ }
  fetch(url, { method: 'POST', credentials: 'same-origin', keepalive: true, headers: { 'Content-Type': 'application/json' }, body: '{}' }).catch(() => {});
}
const tag = () => h('span', { class: 'promo-tag', html: icon('sparkle', { size: 11 }) + 'Promoted' });

/** One promoted card (event or post). */
export function promoCard(item, { compact = false } = {}) {
  let el;
  if (item.type === 'event' && item.event) {
    el = eventCard(item.event, { compact });
    el.classList.add('promo-card');
    el.querySelector('.body')?.prepend(tag());
  } else if (item.post) {
    const p = item.post; const img = (p.media || []).find((m) => /^image\//.test(m.mime || 'image/') && m.url);
    el = h('a', { class: 'card hover promo-card promo-post', href: profilePath(p.author), 'data-link': '' },
      img ? h('div', { class: 'cover' }, h('img', { src: img.url, alt: '', loading: 'lazy' })) : null,
      h('div', { class: 'body' }, tag(),
        h('div', { class: 'row', style: { gap: '.5rem' } }, avatar(p.author?.name, p.author?.avatarUrl, 'sm'), h('strong', { class: 'small' }, p.author?.name || '')),
        h('p', { class: 'small promo-text', html: esc(String(p.body || '').slice(0, 180)) })));
  } else return null;
  el.dataset.promo = item.id;
  el.setAttribute('aria-label', `Promoted: ${item.event?.title || item.post?.author?.name || ''}`);
  el.addEventListener('click', () => click(item.id));
  io && io.observe(el);
  return el;
}

/** Wrap a mounted page in [content | sidebar]. CSS shows the sidebar only on wide screens. */
export function attachPromoRail(view, placement, { inline = true } = {}) {
  if (!view || view.querySelector('.rail-layout')) return;
  const mainCol = h('div', { class: 'rail-main' });
  mainCol.append(...view.childNodes);
  const aside = h('aside', { class: 'promo-rail', 'aria-label': 'Promoted' });
  view.append(h('div', { class: 'rail-layout' }, mainCol, aside));
  loadPromos(placement).then((items) => {
    if (!items.length || !aside.isConnected) { view.querySelector('.rail-layout')?.classList.add('no-rail'); return; }
    aside.append(h('div', { class: 'promo-rail-head tiny faint' }, 'Promoted'), ...items.slice(0, 3).map((it) => promoCard(it, { compact: true })).filter(Boolean));
    // Generic inline card for pages without their own slot (Books, Venues): right after the page title.
    if (inline && !window.matchMedia(WIDE).matches) {
      const head = mainCol.querySelector('.page-head, .venues-head') || mainCol.firstElementChild;
      const card = promoCard(items[0], { compact: true });
      if (card && head) { const box = h('div', { class: 'promo-inline' }, card); head.after(box); }
    }
  });
}

/** Phones / narrow: one promoted card inside a list (after its Nth child, from data-promo-slot). */
export function promoInline(list, placement) {
  if (!list || window.matchMedia(WIDE).matches) return;
  loadPromos(placement).then((items) => {
    if (!items.length || !list.isConnected || list.querySelector('.promo-inline')) return;
    const n = Math.max(0, parseInt(list.dataset.promoSlot || '3', 10));
    const card = promoCard(items[0]);
    if (!card) return;
    const box = h('div', { class: 'promo-inline' }, card);
    const ref = list.children[Math.min(n, list.children.length)];
    ref ? list.insertBefore(box, ref) : list.append(box);
  });
}
