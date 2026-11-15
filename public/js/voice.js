// Voice typing: every eligible text box listens while it is focused, and types what it hears.
//
// Engine: Whisper on Replicate (server, /api/stt?mode=dictate) is primary. Speech is cut into short
// clips at natural pauses (simple energy VAD, ~0.6 s of silence or STT segment max), so silence is
// never sent and text lands a second or two after each phrase. The browser's Web Speech API is the
// fallback (no token configured, daily cap reached, guest outside a room, service error).
//
// Never in password / email / phone / one-time-code / payment fields. On by default after a
// one-time consent prompt; Settings → Voice typing turns it off (per device).
//
// In meetings (room bridge): mic muted -> a separate local capture that is never published;
// mic open -> the published track is cloned (one capture, so Android doesn't fight over the mic),
// or, when your live captions are already running, your own caption lines are reused (no double cost).
import { state } from './app.js';
import { api, toast } from './ui.js';
import { spokenToQuery } from './spoken-ref.js';
import { voiceKind } from './voice-fields.js';
export { voiceKind };

const LS = 'venue.voice';
const SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition;
const WS_LANG = { en: 'en-NG', yo: 'yo-NG', ig: 'ig-NG', ha: 'ha-NG', pcm: 'en-NG', fr: 'fr-FR', ar: 'ar-SA' };
const isAndroid = /Android/i.test(navigator.userAgent || '');
const read = () => { try { return JSON.parse(localStorage.getItem(LS) || '{}'); } catch { return {}; } };
const write = (patch) => { const v = { ...read(), ...patch }; try { localStorage.setItem(LS, JSON.stringify(v)); } catch { /* */ } return v; };

export const voicePrefs = {
  get enabled() { return read().on !== false; },
  get consented() { return read().consent === true; },
  set(on) { write({ on: !!on, ...(on ? { consent: true } : {}) }); if (!on) stop(); window.dispatchEvent(new CustomEvent('voice-prefs')); },
};

/* ---------- which fields listen: see voice-fields.js ---------- */

/* ---------- room bridge (set by room.js while you are in a meeting) ---------- */
let bridge = null;
export function setRoomBridge(b) { bridge = b; if (session) restart(); }
export function roomMicChanged() { if (session && bridge) restart(); }
/** Your own final caption line in a room (captions already transcribed it): feed the focused field. */
export function feedOwnCaption(text) { if (session && session.source === 'captions') session.final(text); }

/* ---------- engine choice ---------- */
let cappedUntil = Number(sessionStorage.getItem('venue.voiceCapped') || 0);
let clashWarned = false;
function engine() {
  const cfg = (state.config && state.config.stt) || {};
  const serverOk = cfg.server && window.MediaRecorder && Date.now() > cappedUntil && (state.user || bridge);
  if (serverOk) return 'whisper';
  if (SpeechRec) return 'webspeech';
  return null;
}
const langHint = () => (bridge && bridge.lang && bridge.lang()) || (state.prefs && state.prefs.captionLang) || '';

/* ---------- mic stream (kept briefly between fields so hopping boxes is instant) ---------- */
let ownStream = null, ownStop = null;
async function localStream() {
  clearTimeout(ownStop);
  if (ownStream && ownStream.getAudioTracks().some((t) => t.readyState === 'live')) return ownStream;
  ownStream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 } });
  return ownStream;
}
function releaseLocal(delay = 4000) {
  clearTimeout(ownStop);
  ownStop = setTimeout(() => { if (ownStream && !session) { ownStream.getTracks().forEach((t) => t.stop()); ownStream = null; } }, delay);
}

/* ---------- speech segmenter: energy VAD + MediaRecorder clips ---------- */
export class Segmenter {
  constructor(stream, { onClip, onHearing, maxMs }) {
    this.stream = stream; this.onClip = onClip; this.onHearing = onHearing; this.maxMs = maxMs;
    this.mime = ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/mp4'].find((m) => window.MediaRecorder.isTypeSupported?.(m)) || '';
  }
  start() {
    const AC = window.AudioContext || window.webkitAudioContext;
    this.ac = new AC();
    this.ac.resume?.().catch(() => {});
    this.src = this.ac.createMediaStreamSource(this.stream);
    this.an = this.ac.createAnalyser(); this.an.fftSize = 1024; this.src.connect(this.an);
    this.buf = new Float32Array(this.an.fftSize);
    this.floor = 0.01; this.reset(); this.record();
    this.timer = setInterval(() => this.tick(), 50);
  }
  reset() { this.segMs = 0; this.speechMs = 0; this.silenceMs = 0; }
  record() {
    const rec = new MediaRecorder(this.stream, this.mime ? { mimeType: this.mime, audioBitsPerSecond: 24000 } : undefined);
    const chunks = []; rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    rec.onstop = () => { if (rec._keep && chunks.length) this.onClip(new Blob(chunks, { type: rec.mimeType || this.mime || 'audio/webm' }), rec._ms); };
    rec.start(); this.rec = rec;
  }
  cut(keep) {
    const rec = this.rec; rec._keep = keep; rec._ms = this.segMs; this.reset();
    try { rec.state !== 'inactive' && rec.stop(); } catch { /* */ }
    if (this.timer) this.record();
  }
  tick() {
    this.an.getFloatTimeDomainData(this.buf);
    let sum = 0; for (let i = 0; i < this.buf.length; i++) sum += this.buf[i] * this.buf[i];
    const rms = Math.sqrt(sum / this.buf.length);
    const thr = Math.max(0.012, this.floor * 2.8);
    const speaking = rms > thr;
    if (!speaking) this.floor = this.floor * 0.97 + rms * 0.03;
    this.segMs += 50;
    if (speaking) { this.speechMs += 50; this.silenceMs = 0; } else if (this.speechMs) this.silenceMs += 50;
    this.onHearing(speaking);
    if (this.speechMs >= 250 && this.silenceMs >= 650) this.cut(true); // phrase ended
    else if (this.speechMs && this.speechMs < 250 && this.silenceMs >= 650) this.cut(false); // a click / cough
    else if (this.speechMs && this.segMs >= this.maxMs) this.cut(true); // long phrase: keep text flowing
    else if (!this.speechMs && this.segMs >= 4000) this.cut(false); // idle: restart so clips stay short
  }
  stop() {
    clearInterval(this.timer); this.timer = null;
    try { if (this.rec && this.rec.state !== 'inactive') { this.rec._keep = this.speechMs >= 250; this.rec._ms = this.segMs; this.rec.stop(); } } catch { /* */ }
    try { this.src && this.src.disconnect(); } catch { /* */ }
    this.ac && this.ac.close().catch(() => {});
  }
}

/* ---------- one listening session per focused field ---------- */
let session = null;
class Session {
  constructor(el, kind) {
    this.el = el; this.kind = kind; this.seq = 0; this.nextApply = 0; this.results = new Map(); this.inflight = 0; this.alive = true;
    this.anchor = null; this.interimLen = 0;
    this.onUserInput = (e) => { if (!e.isTrusted) return; this.anchor = null; this.interimLen = 0; };
    el.addEventListener('input', this.onUserInput);
  }
  async start() {
    const eng = engine();
    if (!eng) return false;
    const inRoomLive = !!(bridge && bridge.micOn());
    if (eng === 'whisper') {
      if (inRoomLive && bridge.captionsActive && bridge.captionsActive()) { this.source = 'captions'; this.state('listening'); return true; }
      let stream;
      try {
        if (inRoomLive && bridge.micTrack()) { this.clone = bridge.micTrack().clone(); stream = new MediaStream([this.clone]); this.source = 'room-track'; }
        else { stream = await localStream(); this.source = bridge ? 'room-local' : 'local'; }
      } catch (e) { this.denied(e); return false; }
      if (!this.alive) return false;
      const maxMs = Math.min(15, Math.max(2, (state.config.stt && state.config.stt.segmentMaxSeconds) || 5)) * 1000;
      this.seg = new Segmenter(stream, { maxMs, onClip: (blob, ms) => this.send(blob, ms), onHearing: (on) => this.state(on ? 'hearing' : 'listening') });
      this.seg.start();
      this.state('listening');
      if (this.source === 'room-local') this.watchClash();
      return true;
    }
    // Web Speech fallback: it opens its own capture, which can cut a live meeting mic on Android.
    if (inRoomLive && isAndroid) { if (!clashWarned) { clashWarned = true; toast('Voice typing pauses while your mic is live on this phone', { icon: 'mic' }); } return false; }
    return this.startWebSpeech();
  }
  startWebSpeech() {
    const sr = this.sr = new SpeechRec();
    sr.continuous = true; sr.interimResults = true; sr.lang = WS_LANG[langHint()] || navigator.language || 'en-NG';
    sr.onresult = (e) => {
      let interim = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i]; const t = r[0].transcript;
        if (r.isFinal) this.final(t); else interim += t;
      }
      if (interim) this.interim(interim);
      this.state(interim ? 'hearing' : 'listening');
    };
    sr.onerror = (e) => { if (e.error === 'not-allowed' || e.error === 'service-not-allowed') this.denied(e); };
    sr.onend = () => { if (this.alive && session === this) setTimeout(() => { try { this.alive && sr.start(); } catch { /* */ } }, 250); };
    try { sr.start(); } catch { return false; }
    this.source = 'webspeech'; this.state('listening');
    return true;
  }
  // A separate capture while in a room: if the meeting mic track dies right after, stop and remember.
  watchClash() {
    const t = bridge && bridge.micTrack && bridge.micTrack();
    if (!t) return;
    const onEnd = () => { if (session === this) { try { localStorage.setItem('venue.voiceClash', '1'); } catch { /* */ } toast('Voice typing paused so your meeting mic keeps working', { icon: 'mic' }); stop(); } };
    t.addEventListener('ended', onEnd, { once: true });
    this.unwatch = () => t.removeEventListener('ended', onEnd);
  }
  denied() { this.stop(); toast('Microphone permission is needed for voice typing', { icon: 'micOff' }); }
  state(s) {
    if (!this.alive) return;
    const st = this.inflight && s === 'listening' ? 'pending' : s;
    if (this.kind === 'bar') { const bar = this.el.closest('.cmdbar'); if (bar) { bar.classList.add('listening'); bar.classList.toggle('hearing', st === 'hearing'); bar.classList.toggle('pending', st === 'pending'); } }
    else this.el.dataset.voiceState = st;
  }
  async send(blob, ms) {
    const my = this.seq++; this.inflight++; this.state('pending');
    let text = '';
    try {
      const sp = new URLSearchParams({ mode: 'dictate' });
      const l = langHint(); if (l) sp.set('lang', l);
      if (bridge && bridge.code) sp.set('code', bridge.code);
      const r = await fetch('/api/stt?' + sp, { method: 'POST', body: blob, credentials: 'include', headers: { 'Content-Type': blob.type || 'audio/webm', 'X-Audio-Ms': String(Math.round(ms || 0)), ...(bridge ? bridge.headers() : {}) } });
      const j = await r.json().catch(() => ({}));
      if (r.ok) text = j.text || '';
      else if (r.status === 429 || r.status === 503 || r.status === 401 || j.fallback === 'webspeech') {
        cappedUntil = Date.now() + (r.status === 429 && j.fallback ? 6 * 3600e3 : 10 * 60e3);
        try { sessionStorage.setItem('venue.voiceCapped', String(cappedUntil)); } catch { /* */ }
        if (SpeechRec && session === this && this.seg) { this.seg.stop(); this.seg = null; if (this.clone) { this.clone.stop(); this.clone = null; } this.startWebSpeech(); }
      }
    } catch { /* network: drop this clip */ }
    this.inflight--;
    this.results.set(my, text);
    while (this.results.has(this.nextApply)) { const t = this.results.get(this.nextApply); this.results.delete(this.nextApply); this.nextApply++; if (t) this.final(t); }
    this.state('listening');
  }
  // Text insertion: interim text is shown in place and replaced by the final words.
  place(text, isFinal) {
    const el = this.el; if (!this.alive || !el.isConnected) return;
    if (this.kind === 'date') { if (isFinal) this.date(text); return; }
    if (this.kind === 'bar') {
      el.value = isFinal ? spokenToQuery(text) : text.trim();
      el.dispatchEvent(new Event('input', { bubbles: true }));
      return;
    }
    let t = text.replace(/\s+/g, ' ').trim();
    if (!t) return;
    if (el.tagName === 'INPUT' && isFinal) t = t.replace(/[.。]+$/, '');
    if (this.anchor == null) { this.anchor = el.selectionStart ?? el.value.length; this.interimLen = 0; }
    const before = el.value.slice(0, this.anchor), after = el.value.slice(this.anchor + this.interimLen);
    const sep = before && !/\s$/.test(before) ? ' ' : '';
    if (!before.trim() && el.tagName === 'INPUT') t = t.charAt(0).toUpperCase() + t.slice(1);
    const ins = sep + t + (isFinal && el.tagName === 'TEXTAREA' ? ' ' : '');
    const max = el.maxLength > 0 ? el.maxLength : Infinity;
    el.value = (before + ins + after).slice(0, max);
    if (isFinal) { this.anchor = Math.min(el.value.length, before.length + ins.length); this.interimLen = 0; }
    else this.interimLen = ins.length;
    const caret = before.length + ins.length;
    try { el.setSelectionRange(caret, caret); } catch { /* */ }
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }
  interim(t) { this.place(t, false); }
  final(t) { this.place(t, true); }
  async date(text) {
    const el = this.el;
    try {
      const r = await api('/api/voice/date', { method: 'POST', body: { text, tzOffset: new Date().getTimezoneOffset(), now: new Date().toISOString() } });
      if (!r || !r.start) return;
      const keepTime = !r.hasTime && /T\d\d:\d\d/.test(el.value) ? el.value.slice(11, 16) : null;
      const val = (v, timeKnown, keep) => (el.type === 'date' ? v.slice(0, 10) : timeKnown ? v : `${v.slice(0, 10)}T${keep || '10:00'}`);
      el.value = val(r.start, r.hasTime, keepTime);
      el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true }));
      if (r.end && el._voiceEnd) { el._voiceEnd.value = val(r.end, r.endHasTime, null); el._voiceEnd.dispatchEvent(new Event('change', { bubbles: true })); }
    } catch { toast('Didn’t catch a date — try “February 16 2027 at 6pm”', { icon: 'calendar' }); }
  }
  stop() {
    if (!this.alive) return; this.alive = false;
    this.el.removeEventListener('input', this.onUserInput);
    this.seg && this.seg.stop(); this.seg = null;
    if (this.clone) { this.clone.stop(); this.clone = null; }
    if (this.sr) { try { this.sr.onend = null; this.sr.stop(); } catch { /* */ } this.sr = null; }
    this.unwatch && this.unwatch();
    if (this.kind === 'bar') this.el.closest('.cmdbar')?.classList.remove('listening', 'hearing', 'pending');
    else delete this.el.dataset.voiceState;
    if (session === this) session = null;
    releaseLocal();
  }
}

async function begin(el) {
  const kind = voiceKind(el);
  if (!kind || !voicePrefs.enabled) return;
  if (session && session.el === el) return;
  stop();
  if (!voicePrefs.consented) { askConsent(el); return; }
  const s = session = new Session(el, kind);
  const ok = await s.start().catch(() => false);
  if (!ok && session === s) s.stop();
}
export function stop() { if (session) session.stop(); }
function restart() { const el = session && session.el; stop(); if (el && document.activeElement === el) begin(el); }

/* ---------- one-time consent (doesn't steal focus until you answer) ---------- */
let consentEl = null;
function askConsent(el) {
  if (document.querySelector('.voice-consent')) return;
  const box = document.createElement('div');
  box.className = 'voice-consent'; box.setAttribute('role', 'dialog'); box.setAttribute('aria-label', 'Voice typing');
  box.innerHTML = `<div class="vc-body"><strong>Voice typing is on</strong><p>While you’re in a text box, 1venue listens and types what you say. Clips of speech are transcribed by Whisper on Replicate, or by your browser’s speech service. Never in password, email, phone or code fields. Turn it off any time in Settings.</p></div>
    <div class="vc-actions"><button type="button" class="btn sm ghost" data-a="off">Turn off</button><button type="button" class="btn sm primary" data-a="ok">Allow</button></div>`;
  consentEl = el;
  box.addEventListener('mousedown', (e) => e.preventDefault()); // keep focus in the field
  box.addEventListener('click', (e) => {
    const a = e.target.closest('button')?.dataset.a; if (!a) return;
    box.remove();
    if (a === 'ok') { write({ consent: true, on: true }); const t = consentEl; consentEl = null; if (t && t.isConnected) { t.focus(); begin(t); } }
    else { write({ consent: true, on: false }); toast('Voice typing off — turn it on in Settings', { icon: 'micOff' }); }
  });
  document.body.append(box);
}

let inited = false;
export function initVoice() {
  if (inited) return; inited = true;
  if (!navigator.mediaDevices?.getUserMedia && !SpeechRec) return;
  document.addEventListener('focusin', (e) => { const el = e.target; if (voiceKind(el)) begin(el); });
  document.addEventListener('focusout', (e) => {
    if (!session || e.target !== session.el) return;
    const s = session;
    setTimeout(() => { if (session === s && document.activeElement !== s.el) s.stop(); }, 120);
  });
  document.addEventListener('visibilitychange', () => { if (document.hidden) stop(); });
  window.addEventListener('pagehide', stop);
}
