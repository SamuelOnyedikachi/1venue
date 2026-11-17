// Voice typing: hover or focus an eligible text box and a small mic appears at its edge; tap it to
// start or stop dictation (toggle mode). While it listens the field stays fully editable: you can type,
// delete and move the caret, and spoken words land at the caret. Nothing is made readonly and focus is
// never taken away (important on iPhone, where a blur closes the keyboard).
//
// Engine: Whisper on Replicate (server, /api/stt?mode=dictate) is primary. Speech is cut into short
// clips at natural pauses (simple energy VAD, ~0.6 s of silence or STT segment max), so silence is
// never sent and text lands a second or two after each phrase. The browser's Web Speech API is the
// fallback (no token configured, daily cap reached, guest outside a room, service error).
//
// Never in password / email / phone / one-time-code / payment fields. On by default after a
// one-time consent prompt; Settings → Voice typing turns it off (per device).
//
// Tap-to-talk fields (data-voice="off" + an explicit mic button, e.g. the feed composer) never listen on
// focus. listenOn(el, { manual: true, onEnd }) starts a session that stops for good when the user taps the
// mic again, types / pastes / deletes, leaves the field or page, posts, or after a silence timeout. It never
// restarts itself, and nothing about it is persisted.
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
const SILENCE_MS = 12000;
class Session {
  constructor(el, kind, { manual = false, keepTyping = false, onEnd = null, silenceMs = SILENCE_MS } = {}) {
    this.el = el; this.kind = kind; this.seq = 0; this.nextApply = 0; this.results = new Map(); this.inflight = 0; this.alive = true;
    this.anchor = null; this.interimLen = 0;
    this.manual = manual; this.keepTyping = keepTyping; // keepTyping: like auto mode, Web Speech restarts itself until you tap stop this.onEnd = onEnd; this.silenceMs = silenceMs; this.lastHeard = Date.now();
    this.onUserInput = (e) => { if (!e.isTrusted) return; this.anchor = null; this.interimLen = 0; };
    el.addEventListener('input', this.onUserInput);
    if (keepTyping) {
      // Mic toggle: typing never stops dictation. If grey interim words are showing when you type, they are
      // lifted out first (the final words arrive moments later at your caret), so nothing you type is clobbered.
      this.onTypeOver = (e) => { if (e.isTrusted) this.dropInterim(); };
      el.addEventListener('beforeinput', this.onTypeOver);
      el.addEventListener('compositionstart', this.onTypeOver);
      this.watch = setInterval(() => {
        if (!el.isConnected) return this.stop('gone');
        if (!this.inflight && Date.now() - this.lastHeard > Math.max(this.silenceMs, 30000)) this.stop('silence');
      }, 500);
    } else if (manual) {
      // The user typing, deleting, pasting or dropping text ends tap-to-talk (voice inserts never fire beforeinput).
      this.onUserEdit = (e) => { if (e.isTrusted) this.stop('typing'); };
      el.addEventListener('beforeinput', this.onUserEdit);
      this.watch = setInterval(() => {
        if (!el.isConnected) return this.stop('gone');
        if (!this.inflight && Date.now() - this.lastHeard > this.silenceMs) this.stop('silence');
      }, 500);
    }
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
    // Auto-focus sessions keep the recogniser alive; tap-to-talk never restarts itself.
    sr.onend = () => { if (this.manual) { this.stop('ended'); return; } if (this.alive && session === this) setTimeout(() => { try { this.alive && sr.start(); } catch { /* */ } }, 250); };
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
    if (s === 'hearing') this.lastHeard = Date.now();
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
    this.lastHeard = Date.now();
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
  /** Remove the interim (not yet final) words, keeping the user's caret / selection where it was. */
  dropInterim() {
    const el = this.el;
    if (!this.interimLen || this.anchor == null) return;
    const a = this.anchor, n = this.interimLen, ss = el.selectionStart, se = el.selectionEnd;
    el.value = el.value.slice(0, a) + el.value.slice(a + n);
    const fix = (p) => (p == null ? p : p >= a + n ? p - n : p > a ? a : p);
    try { el.setSelectionRange(fix(ss), fix(se)); } catch { /* */ }
    this.anchor = null; this.interimLen = 0;
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
  stop(reason = 'stopped') {
    if (!this.alive) return; this.alive = false;
    this.el.removeEventListener('input', this.onUserInput);
    if (this.onUserEdit) this.el.removeEventListener('beforeinput', this.onUserEdit);
    if (this.onTypeOver) { this.el.removeEventListener('beforeinput', this.onTypeOver); this.el.removeEventListener('compositionstart', this.onTypeOver); }
    clearInterval(this.watch);
    this.seg && this.seg.stop(); this.seg = null;
    if (this.clone) { this.clone.stop(); this.clone = null; }
    if (this.sr) { try { this.sr.onend = null; this.sr.stop(); } catch { /* */ } this.sr = null; }
    this.unwatch && this.unwatch();
    if (this.kind === 'bar') this.el.closest('.cmdbar')?.classList.remove('listening', 'hearing', 'pending');
    else delete this.el.dataset.voiceState;
    if (session === this) session = null;
    releaseLocal(this.manual ? 0 : 4000); // tap-to-talk: release the mic right away
    try { this.onEnd && this.onEnd(reason); } catch { /* */ }
  }
}

/**
 * Start listening in `el`. opts.manual = tap-to-talk (works even on data-voice="off" fields and with the
 * auto setting off); opts.onEnd(reason) fires once when it stops. Resolves true when listening started.
 */
export async function listenOn(el, opts = {}) { return begin(el, opts); }
export const isListening = (el) => !!(session && session.alive && (!el || session.el === el));
export function stopListening(el, reason = 'user') { if (session && (!el || session.el === el)) session.stop(reason); }
async function begin(el, opts = {}) {
  const manual = !!opts.manual, toggle = !!opts.keepTyping;
  const kind = toggle ? voiceKind(el) : manual ? (el && /^(TEXTAREA|INPUT)$/.test(el.tagName) && !el.disabled && !el.readOnly ? 'text' : null) : voiceKind(el);
  if (!kind || (!manual && !toggle && !voicePrefs.enabled)) return false;
  if (session && session.el === el && session.manual === manual && !!session.keepTyping === toggle) return true;
  stop();
  if (toggle) write({ consent: true }); // tapping the mic is the consent
  if (!voicePrefs.consented) { askConsent(el, opts); return false; }
  const s = session = new Session(el, kind, opts);
  const ok = await s.start().catch(() => false);
  if (!ok) {
    if (session === s) s.stop('failed');
    if ((manual || toggle) && !engine()) toast('Voice typing isn’t available in this browser', { icon: 'micOff' });
    return false;
  }
  try { opts.onStart && opts.onStart(); } catch { /* */ }
  return true;
}
export function stop() { if (session) session.stop(); }
function restart() { const el = session && session.el; stop(); if (el && document.activeElement === el) begin(el); }

/* ---------- one-time consent (doesn't steal focus until you answer) ---------- */
let consentEl = null, consentOpts = {};
function askConsent(el, opts = {}) {
  consentOpts = opts;
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
    const o = consentOpts; consentOpts = {};
    if (a === 'ok') { write({ consent: true, on: true }); const t = consentEl; consentEl = null; if (t && t.isConnected) { t.focus(); begin(t, o); } }
    else { write({ consent: true, on: false }); toast('Voice typing off — turn it on in Settings', { icon: 'micOff' }); o.onEnd && o.onEnd('declined'); }
  });
  document.body.append(box);
}

/* ---------- the mic toggle: appears on hover / focus of an eligible field ---------- */
// One floating button for the whole app, positioned at the field's right edge (inputs: centred;
// textareas: bottom corner). pointerdown / mousedown / touchend are cancelled so tapping it never
// blurs the field or closes the phone keyboard.
const micEligible = (el) => !!(el && el.nodeType === 1 && voicePrefs.enabled && voiceKind(el) && !el.classList.contains('no-vmic') && el.offsetParent !== null);
let micBtn = null, micFor = null, hideT = 0, hovering = false;
function micPaint() {
  if (!micBtn) return;
  const on = !!(micFor && isListening(micFor));
  micBtn.classList.toggle('on', on);
  micBtn.setAttribute('aria-pressed', String(on));
  micBtn.setAttribute('aria-label', on ? 'Stop voice typing' : 'Start voice typing');
  micBtn.dataset.tip = on ? 'Stop voice typing' : 'Voice typing';
}
function micPlace() {
  if (!micBtn || !micFor || micBtn.hidden) return;
  if (!micFor.isConnected) { micHide(true); return; }
  const r = micFor.getBoundingClientRect();
  if (r.bottom < 0 || r.top > innerHeight || !r.width) { micBtn.style.visibility = 'hidden'; return; }
  micBtn.style.visibility = '';
  const size = 28, pad = 6;
  const ta = micFor.tagName === 'TEXTAREA' && r.height > 56;
  micBtn.style.top = `${Math.round(ta ? r.bottom - size - pad : r.top + (r.height - size) / 2)}px`;
  micBtn.style.left = `${Math.round(r.right - size - pad)}px`;
}
function micShow(el) {
  clearTimeout(hideT);
  if (micFor !== el) { micFor?.classList.remove('has-vmic'); micFor = el; el.classList.add('has-vmic'); }
  micBtn.hidden = false; micPlace(); micPaint();
  requestAnimationFrame(() => micBtn.classList.add('in'));
}
function micHide(now = false) {
  clearTimeout(hideT);
  const go = () => {
    if (!micFor) return;
    if (!now && (isListening(micFor) || document.activeElement === micFor || hovering)) return;
    micBtn.classList.remove('in'); micBtn.hidden = true; micFor.classList.remove('has-vmic'); micFor = null;
  };
  if (now) go(); else hideT = setTimeout(go, 220);
}
function micToggle() {
  const el = micFor; if (!el) return;
  if (isListening(el)) { stopListening(el, 'user'); micPaint(); return; }
  if (document.activeElement !== el) { try { el.focus({ preventScroll: true }); } catch { el.focus(); } }
  listenOn(el, { keepTyping: true, onStart: micPaint, onEnd: () => { micPaint(); if (document.activeElement !== el) micHide(); } }).then(micPaint);
}
function initMic() {
  micBtn = document.createElement('button');
  micBtn.type = 'button'; micBtn.className = 'vmic'; micBtn.hidden = true; micBtn.tabIndex = -1;
  micBtn.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 10a7 7 0 0 0 14 0M12 17v4"/></svg>';
  micPaint();
  const keep = (e) => e.preventDefault();
  micBtn.addEventListener('pointerdown', keep); micBtn.addEventListener('mousedown', keep);
  let touched = 0;
  micBtn.addEventListener('touchend', (e) => { e.preventDefault(); touched = Date.now(); micToggle(); }); // iOS: no synthetic click, no blur
  micBtn.addEventListener('click', () => { if (Date.now() - touched > 600) micToggle(); });
  micBtn.addEventListener('mouseenter', () => { hovering = true; clearTimeout(hideT); });
  micBtn.addEventListener('mouseleave', () => { hovering = false; micHide(); });
  document.body.append(micBtn);
  const hoverable = matchMedia('(hover: hover)');
  document.addEventListener('mouseover', (e) => { if (!hoverable.matches) return; const el = e.target; if (micEligible(el)) { hovering = true; micShow(el); } });
  document.addEventListener('mouseout', (e) => { if (e.target === micFor && e.relatedTarget !== micBtn) { hovering = false; micHide(); } });
  document.addEventListener('focusin', (e) => { if (micEligible(e.target)) micShow(e.target); });
  document.addEventListener('focusout', (e) => { if (e.target === micFor) micHide(); });
  // Keyboard: Alt+M toggles dictation in the focused field.
  document.addEventListener('keydown', (e) => { if (e.altKey && !e.ctrlKey && !e.metaKey && (e.key === 'm' || e.key === 'µ') && micFor && document.activeElement === micFor) { e.preventDefault(); micToggle(); } });
  addEventListener('scroll', micPlace, { passive: true, capture: true });
  addEventListener('resize', micPlace, { passive: true });
  window.visualViewport?.addEventListener('resize', micPlace, { passive: true });
  window.addEventListener('voice-prefs', () => { if (!voicePrefs.enabled) micHide(true); });
}

let inited = false;
export function initVoice() {
  if (inited) return; inited = true;
  if (!navigator.mediaDevices?.getUserMedia && !SpeechRec) return;
  initMic();
  // Moving to another field ends dictation in the previous one (it never types somewhere you are not).
  document.addEventListener('focusin', (e) => { if (session && session.keepTyping && e.target !== session.el && /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) session.stop('moved'); });
  document.addEventListener('focusout', (e) => {
    if (!session || e.target !== session.el || session.keepTyping) return; // the mic toggle survives brief blurs (e.g. a picker)
    const s = session;
    setTimeout(() => { if (session === s && document.activeElement !== s.el) s.stop(); }, 120);
  });
  document.addEventListener('visibilitychange', () => { if (document.hidden) stop(); });
  window.addEventListener('pagehide', stop);
}
