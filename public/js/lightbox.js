// Image lightbox: one reusable full-screen viewer for content images (materials, chat and message
// photos, feed posts). Left / right across the images in the same group, swipe on touch, arrow keys,
// Esc, a counter, focus trapping, and no animation when the user prefers reduced motion.
//
// Opt in:  <img data-lightbox>, or any of the classes in SELECTOR. Group: the nearest [data-lb-group],
// else the nearest post / message list / card. Avatars and icons are never matched.
import { icon } from './icons.js';

const SELECTOR = 'img[data-lightbox], img.msg-img, img.feed-post-img, img.mat-page-img, img.post-img, .prose img';
const GROUP = '[data-lb-group], .feed-post, .msg-list, .msgs, .chat-list, .mat-pages, article, .card';
const SKIP = '.avatar, .ava, .ico-tile, .icon-btn, [data-lightbox="off"], .no-lightbox';
let cur = null;

/** Open a viewer over `images` ([{ src, alt }]) at `index`. Returns { close }. */
export function openLightbox(images, index = 0, { returnFocus = document.activeElement } = {}) {
  if (cur) cur.close();
  if (!images.length) return null;
  let i = Math.max(0, Math.min(index, images.length - 1));
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const img = document.createElement('img');
  img.className = 'lb-img'; img.decoding = 'async';
  const counter = document.createElement('div'); counter.className = 'lb-count'; counter.setAttribute('aria-live', 'polite');
  const cap = document.createElement('div'); cap.className = 'lb-cap';
  const btn = (cls, label, ic) => { const b = document.createElement('button'); b.type = 'button'; b.className = `lb-btn ${cls}`; b.setAttribute('aria-label', label); b.innerHTML = icon(ic, { size: 22 }); return b; };
  const prev = btn('lb-prev', 'Previous image', 'chevronLeft'), next = btn('lb-next', 'Next image', 'chevronRight'), close = btn('lb-close', 'Close', 'x');
  const stage = document.createElement('div'); stage.className = 'lb-stage'; stage.append(img);
  const top = document.createElement('div'); top.className = 'lb-top'; top.append(counter, close);
  const root = document.createElement('div');
  root.className = 'lb' + (reduce ? ' reduce' : '');
  root.setAttribute('role', 'dialog'); root.setAttribute('aria-modal', 'true'); root.setAttribute('aria-label', 'Image viewer');
  root.append(top, stage, prev, next, cap);
  const many = images.length > 1;
  prev.hidden = next.hidden = !many;

  function show(n, dir = 0) {
    i = (n + images.length) % images.length;
    const it = images[i];
    img.src = it.src; img.alt = it.alt || '';
    counter.textContent = many ? `${i + 1} / ${images.length}` : '';
    cap.textContent = it.alt || ''; cap.hidden = !it.alt;
    if (!reduce && dir) { img.classList.remove('from-l', 'from-r'); void img.offsetWidth; img.classList.add(dir > 0 ? 'from-r' : 'from-l'); }
    // Warm the neighbours so arrows feel instant.
    if (many) for (const k of [i + 1, i - 1]) { const p = new Image(); p.src = images[(k + images.length) % images.length].src; }
  }
  const go = (d) => { if (many) show(i + d, d); };
  prev.onclick = (e) => { e.stopPropagation(); go(-1); };
  next.onclick = (e) => { e.stopPropagation(); go(1); };
  close.onclick = () => api.close();
  stage.addEventListener('click', (e) => { if (e.target === stage) api.close(); });

  const onKey = (e) => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); api.close(); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); go(1); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); go(-1); }
    else if (e.key === 'Tab') { // focus trap
      const f = [close, prev, next].filter((b) => !b.hidden);
      const at = f.indexOf(document.activeElement);
      e.preventDefault();
      f[(at + (e.shiftKey ? -1 : 1) + f.length) % f.length].focus();
    }
  };
  // Swipe: horizontal moves between images, a downward swipe closes.
  let x0 = null, y0 = 0, dx = 0, dy = 0;
  stage.addEventListener('touchstart', (e) => { if (e.touches.length !== 1) { x0 = null; return; } x0 = e.touches[0].clientX; y0 = e.touches[0].clientY; dx = dy = 0; }, { passive: true });
  stage.addEventListener('touchmove', (e) => { if (x0 == null) return; dx = e.touches[0].clientX - x0; dy = e.touches[0].clientY - y0; if (!reduce) img.style.transform = Math.abs(dx) > Math.abs(dy) ? `translateX(${dx}px)` : dy > 0 ? `translateY(${dy}px)` : ''; }, { passive: true });
  stage.addEventListener('touchend', () => {
    if (x0 == null) return; img.style.transform = ''; x0 = null;
    if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy)) go(dx < 0 ? 1 : -1);
    else if (dy > 90) api.close();
  });

  const prevOverflow = document.documentElement.style.overflow;
  document.documentElement.style.overflow = 'hidden';
  document.addEventListener('keydown', onKey, true);
  document.body.append(root);
  show(i);
  requestAnimationFrame(() => { root.classList.add('in'); close.focus({ preventScroll: true }); });

  const api = {
    close() {
      if (cur !== api) return; cur = null;
      document.removeEventListener('keydown', onKey, true);
      document.documentElement.style.overflow = prevOverflow;
      root.classList.remove('in');
      setTimeout(() => root.remove(), reduce ? 0 : 180);
      try { returnFocus && returnFocus.focus && returnFocus.focus({ preventScroll: true }); } catch { /* */ }
    },
  };
  cur = api;
  return api;
}

/** Images in the same group as `el`, and el's index among them. */
export function groupOf(el) {
  const g = el.closest(GROUP) || el.parentElement || document.body;
  const list = [...g.querySelectorAll(SELECTOR)].filter((x) => !x.closest(SKIP) && x.src);
  const idx = list.indexOf(el);
  return { images: (idx < 0 ? [el] : list).map((x) => ({ src: x.currentSrc || x.src, alt: x.alt || '' })), index: Math.max(0, idx) };
}

let inited = false;
/** One delegated listener for the whole app (called once from app.js). */
export function initLightbox() {
  if (inited) return; inited = true;
  document.addEventListener('click', (e) => {
    const el = e.target.closest && e.target.closest(SELECTOR);
    if (!el || el.closest(SKIP) || el.closest('a[href]') || el.closest('.lb')) return;
    e.preventDefault(); e.stopPropagation();
    const { images, index } = groupOf(el);
    openLightbox(images, index, { returnFocus: el });
  }, true);
  // Make matched images reachable by keyboard.
  document.addEventListener('keydown', (e) => {
    if ((e.key === 'Enter' || e.key === ' ') && e.target.matches && e.target.matches(SELECTOR)) { e.preventDefault(); e.target.click(); }
  });
}
export const LIGHTBOX_SELECTOR = SELECTOR;
