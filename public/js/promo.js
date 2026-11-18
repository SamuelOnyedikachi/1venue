// "Promoted" cards: admin-picked events / posts (see src/features/promotions).
// Wide screens: a right sidebar with up to 3 cards. Phones / narrow: one inline card in the page.
// Views are counted only when a card actually scrolls into view; clicks via sendBeacon.
import { icon } from './icons.js';
import { h, api, avatar, esc, profilePath } from './ui.js';
import { eventCard } from './components.js';

const cache = new Map(); // placement -> { at, p }
const TTL = 60_000;
const WIDE = '(min-width: 1180px)';
export function loadPromos(placement, { profileUserId } = {}) {
  const key = profileUserId ? `${placement}:${profileUserId}` : placement;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL) return hit.p;
  const qs = new URLSearchParams({ placement });
  if (profileUserId) qs.set('profileUserId', String(profileUserId));
  const p = api(`/api/promotions?${qs}`).then((r) => r.items || []).catch(() => []);
  cache.set(key, { at: Date.now(), p });
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
const tag = () => h('span', { class: 'promo-tag' }, 'Promoted');

/** One promoted card (event or post). */
export function promoCard(item, { compact = false, tagged = true } = {}) {
  let el;
  if (item.type === 'event' && item.event) {
    el = eventCard(item.event, { compact });
    el.classList.add('promo-card');
    if (tagged) {
      const body = el.querySelector('.body');
      if (body) {
        const cat = body.querySelector('.ev-cat');
        const pills = h('div', { class: 'ev-pills' }, tag());
        if (cat) pills.append(cat);
        body.prepend(pills);
      }
    }
  } else if (item.post) {
    const p = item.post; const img = (p.media || []).find((m) => /^image\//.test(m.mime || 'image/') && m.url);
    el = h('a', { class: 'card hover promo-card promo-post', href: profilePath(p.author), 'data-link': '' },
      img ? h('div', { class: 'cover' }, h('img', { src: img.url, alt: '', loading: 'lazy' })) : null,
      h('div', { class: 'body' }, tagged ? tag() : null,
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
    aside.append(h('div', { class: 'promo-rail-head tiny faint' }, 'Promoted'), ...items.slice(0, 3).map((it) => promoCompact(it)).filter(Boolean));
    // Generic inline card for pages without their own slot (Books, Venues): right after the page title.
    if (inline && !window.matchMedia(WIDE).matches) {
      const head = mainCol.querySelector('.page-head, .venues-head') || mainCol.firstElementChild;
      const rows = items.slice(0, 3).map((it) => promoCompact(it)).filter(Boolean);
      if (rows.length && head) {
        const box = h('section', { class: 'promo-inline promo-inline-rows', 'aria-label': 'Promoted' },
          h('div', { class: 'promo-rail-head tiny faint' }, 'Promoted'), ...rows);
        head.after(box);
      }
    }
  });
}

/** Compact rail row: thumbnail, 2-line title, "host · date". The whole row is one link. */
export function promoCompact(item) {
  const ev = item.type === 'event' ? item.event : null;
  const post = item.post;
  const href = ev ? `/e/${ev.slug}` : (post ? profilePath(post.author) : '#');
  const thumbSrc = ev?.coverUrl || (post && (post.media || []).find((m) => m.url && /^image\//.test(m.mime || 'image/')))?.url;
  const title = ev?.title || String(post?.body || '').slice(0, 80) || (post?.author?.name || 'Promoted');
  const date = ev?.startsAt ? new Date(ev.startsAt).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' }) : null;
  const host = ev?.host?.name;
  const thumb = h('div', { class: 'feed-promo-thumb' },
    thumbSrc ? h('img', { src: thumbSrc, alt: '', loading: 'lazy' }) : h('div', { class: 'feed-promo-ph', html: icon('calendar', { size: 16 }) }));
  const sub = [host, date].filter(Boolean).join(' · ');
  const el = h('a', {
    class: 'feed-promo',
    href,
    'data-link': '',
    'aria-label': `Promoted: ${title}`,
  }, thumb, h('div', { class: 'feed-promo-body' },
    h('div', { class: 'feed-promo-title' }, title),
    sub ? h('div', { class: 'tiny muted feed-promo-sub' }, sub) : null));
  el.dataset.promo = item.id;
  el.addEventListener('click', () => click(item.id));
  io && io.observe(el);
  return el;
}

/** Phones / narrow: one promoted card inside a list (after its Nth child, from data-promo-slot). */
export function promoInline(list, placement, { wide = WIDE } = {}) {
  if (!list || window.matchMedia(wide).matches) return;
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
