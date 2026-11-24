/** Inline video with a poster and native seek/controls, safe to adopt into a PiP document. */
import { h } from './ui.js';

export function isVideoAtt(a) {
  if (!a) return false;
  return a.kind === 'video' || (a.mime || '').startsWith('video/');
}

export function videoPlayer(a, { doc = document, className = 'v-player' } = {}) {
  const url = a && (a.url || a.dataUrl || a.href || a.src);
  if (!url) return h('div', { class: 'tiny muted' }, (a && a.name) || 'Video');
  const el = (doc || document).createElement('video');
  el.className = 'v-player-el';
  el.src = url;
  el.controls = true;
  el.playsInline = true;
  el.preload = 'metadata';
  if (a.poster || a.posterUrl) el.poster = a.poster || a.posterUrl;
  if (a.title) el.setAttribute('aria-label', a.title);
  const wrap = h('div', { class: className });
  wrap.append(el);
  if (a.name || a.durationSec) {
    const dur = a.durationSec ? formatDur(a.durationSec) : '';
    wrap.append(h('div', { class: 'tiny muted v-player-cap' }, [a.name, dur].filter(Boolean).join(' · ')));
  }
  return wrap;
}

export function formatDur(sec) {
  const n = Math.max(0, Math.round(Number(sec) || 0));
  const m = Math.floor(n / 60), s = n % 60;
  return m + ':' + String(s).padStart(2, '0');
}

export function videoSlot(a) {
  const url = a && (a.url || a.dataUrl || a.href || a.src) || '';
  const el = h('div', { class: 'v-player-slot', 'data-video-url': url, 'data-video-poster': a && (a.poster || a.posterUrl) || '', 'data-video-name': a && a.name || '' });
  el.append(h('div', { class: 'tiny muted' }, 'Video'));
  return el;
}

export function hydrateVideoPlayers(root, doc) {
  if (!root || !root.querySelectorAll) return 0;
  const d = doc || root.ownerDocument || document;
  let n = 0;
  root.querySelectorAll('.v-player-slot').forEach((slot) => {
    if (slot.ownerDocument && slot.ownerDocument !== d) return;
    if (slot.querySelector && slot.querySelector('video')) return;
    const url = slot.getAttribute('data-video-url') || '';
    const poster = slot.getAttribute('data-video-poster') || '';
    const name = slot.getAttribute('data-video-name') || '';
    slot.replaceWith(videoPlayer({ url, poster, name }, { doc: d, className: 'v-player app-pip-att' }));
    n++;
  });
  return n;
}
