// Custom voice-note player. Native <audio controls> often render blank in a Document
// Picture-in-Picture window because the element is created in the opener and adopted
// into about:blank, and default controls also disappear on accent-coloured bubbles.
import { icon } from './icons.js';

export function isVoiceAtt(a) {
  if (!a || typeof a !== 'object') return false;
  const kind = a.kind || a.type || '';
  const mime = a.mime || a.contentType || a.content_type || '';
  const name = a.name || a.filename || '';
  const url = attUrl(a);
  return kind === 'voice' || kind === 'audio' || /^audio\//.test(mime) || /\.(webm|m4a|mp3|ogg|wav|aac)(\?|$)/i.test(url || name);
}

export function attUrl(a) {
  if (!a) return '';
  const raw = a.url || a.href || a.src || a.fileUrl || a.file_url || a.path || a.dataUrl || '';
  if (!raw) return '';
  try { return new URL(raw, document.baseURI).href; } catch { return String(raw); }
}

function fmt(t) {
  if (!Number.isFinite(t) || t < 0) return '0:00';
  const s = Math.floor(t);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function barsFor(url, n = 22) {
  let h = 0;
  const s = String(url || 'v');
  for (let i = 0; i < s.length; i++) h = (h * 33 + s.charCodeAt(i)) >>> 0;
  const out = [];
  for (let i = 0; i < n; i++) {
    h = (h * 1664525 + 1013904223) >>> 0;
    out.push(0.22 + (h % 80) / 100);
  }
  return out;
}

function node(doc, tag, props = {}, ...kids) {
  const el = doc.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'html') el.innerHTML = v;
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k in el && typeof v !== 'string') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) {
    if (kid == null || kid === false) continue;
    el.append(kid instanceof Node ? kid : doc.createTextNode(String(kid)));
  }
  return el;
}

/** Play/pause + waveform progress + duration. Builds the <audio> in `doc` (required for PiP). */
export function voicePlayer(a, { doc = document, onAccent = false } = {}) {
  const url = attUrl(a);
  const audio = doc.createElement('audio');
  audio.preload = 'metadata';
  audio.playsInline = true;
  audio.setAttribute('playsinline', '');
  if (url) audio.src = url;

  const play = node(doc, 'button', { class: 'vp-play', type: 'button', 'aria-label': 'Play voice note', html: icon('play', { size: 16 }) });
  const wave = node(doc, 'button', { class: 'vp-wave', type: 'button', 'aria-label': 'Seek' });
  const heights = barsFor(url);
  wave.append(...heights.map((ht) => {
    const i = doc.createElement('i');
    i.style.height = `${Math.round(ht * 100)}%`;
    return i;
  }));
  const time = node(doc, 'span', { class: 'vp-time' }, '0:00');
  const wrap = node(doc, 'div', { class: 'vp' + (onAccent ? ' on-accent' : '') }, play, wave, time, audio);
  audio.hidden = true;

  const paint = () => {
    const dur = Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : 0;
    const cur = audio.currentTime || 0;
    time.textContent = audio.paused && cur < 0.15 && dur ? fmt(dur) : fmt(dur ? Math.max(0, dur - cur) : cur);
    const p = dur ? cur / dur : 0;
    [...wave.children].forEach((b, i) => b.classList.toggle('on', i / heights.length <= p));
    play.innerHTML = icon(audio.paused ? 'play' : 'pause', { size: 16 });
    play.setAttribute('aria-label', audio.paused ? 'Play voice note' : 'Pause voice note');
    wrap.classList.toggle('playing', !audio.paused);
  };
  play.onclick = (e) => {
    e.preventDefault(); e.stopPropagation();
    if (!audio.src) return;
    if (audio.paused) audio.play().catch(() => {});
    else audio.pause();
  };
  wave.onclick = (e) => {
    e.preventDefault(); e.stopPropagation();
    if (!audio.duration) return;
    const r = wave.getBoundingClientRect();
    const x = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
    audio.currentTime = x * audio.duration;
    if (audio.paused) audio.play().catch(() => {});
    paint();
  };
  audio.addEventListener('timeupdate', paint);
  audio.addEventListener('loadedmetadata', paint);
  audio.addEventListener('ended', () => { audio.currentTime = 0; paint(); });
  audio.addEventListener('play', paint);
  audio.addEventListener('pause', paint);
  paint();
  return wrap;
}
