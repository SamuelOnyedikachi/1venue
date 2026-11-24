// Call ringtone and message tone (small MP3s made for 1venue, no third-party audio).
// The ringtone loops until the call is answered or declined; each can be muted in Message settings.
const KEYS = { ring: 'venue.tone.ring.muted', message: 'venue.tone.message.muted' };
export const toneMuted = (k) => { try { return localStorage.getItem(KEYS[k]) === '1'; } catch { return false; } };
export const setToneMuted = (k, v) => { try { localStorage.setItem(KEYS[k], v ? '1' : '0'); } catch { /* private mode */ } };

// Browsers only allow sound after a user gesture. This module is imported by the app shell so these
// listeners are already installed before a WebSocket can deliver the first call or message.
const cache = {};
function audio(name) { if (!cache[name]) { cache[name] = new Audio(`/sounds/${name}.mp3`); cache[name].preload = 'auto'; } return cache[name]; }
let unlocked = false, unlocking = false, ringing = false;
export function unlockTones() {
  const ring = audio('ringtone');
  // If autoplay rejected the active ringtone, retry the same element while this gesture is active.
  if (ringing && !toneMuted('ring')) {
    ring.muted = false;
    ring.play().then(() => { unlocked = true; }).catch(() => {});
    return;
  }
  if (unlocked || unlocking) return;
  unlocking = true;
  const warm = (ringing ? ['message'] : ['message', 'ringtone']).map((name) => {
    const a = audio(name);
    a.muted = true;
    return a.play().then(() => {
      a.pause();
      a.currentTime = 0;
      // Keep the warm-up muted. Unmute only when an actual message or call
      // tone is played; some mobile browsers can leak a brief sound when
      // the element is unmuted immediately after this silent playback.
      return true;
    }).catch(() => {
      a.muted = false;
      return false;
    });
  });
  Promise.all(warm).then((ok) => { if (ok.every(Boolean)) unlocked = true; }).finally(() => { unlocking = false; });
}
if (typeof window !== 'undefined') {
  window.addEventListener('pointerdown', unlockTones, { capture: true });
  window.addEventListener('keydown', unlockTones, { capture: true });
}

let lastMsg = 0;
/** Short two-note chime for an incoming message (throttled so a burst plays once). */
let toneCtx = null;
function resumeToneCtx() {
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    if (!toneCtx) toneCtx = new AC();
    if (toneCtx.state === 'suspended') toneCtx.resume().catch(() => {});
  } catch { /* no audio context */ }
}

export function playMessageTone() {
  if (toneMuted('message') || Date.now() - lastMsg < 1500) return;
  lastMsg = Date.now();
  resumeToneCtx();
  const a = audio('message'); a.muted = false; a.volume = 0.85; a.currentTime = 0;
  a.play().catch(() => {
    // Main tab may be hidden while the PiP is focused; try a one-shot in the PiP document.
    try {
      const pip = window.documentPictureInPicture && window.documentPictureInPicture.window;
      if (pip && !pip.closed) {
        const b = pip.document.createElement('audio');
        b.src = '/sounds/message.mp3';
        b.volume = 0.85;
        b.play().catch(() => {});
      }
    } catch { /* ignore */ }
  });
}

function pipWin() {
  try {
    const w = window.documentPictureInPicture && window.documentPictureInPicture.window;
    return w && !w.closed ? w : null;
  } catch { return null; }
}

/** Start the looping ringtone (plus vibration on phones). Returns stop(). */
export function startRingtone() {
  let vib = null, pipAudio = null;
  const buzz = () => { try { navigator.vibrate && navigator.vibrate([400, 200, 400]); } catch { /* ignore */ } };
  buzz(); vib = setInterval(buzz, 2600);
  const a = audio('ringtone'); a.muted = false; a.loop = true; a.volume = 1; ringing = true;
  const stopPip = () => { if (pipAudio) { try { pipAudio.pause(); pipAudio.remove(); } catch { /* */ } pipAudio = null; } };
  const startPip = () => {
    const w = pipWin();
    if (!w || toneMuted('ring')) return null;
    stopPip();
    try {
      const b = w.document.createElement('audio');
      try { b.src = new URL('/sounds/ringtone.mp3', document.baseURI).href; } catch { b.src = '/sounds/ringtone.mp3'; }
      b.loop = true; b.volume = 1;
      (w.document.body || w.document.documentElement).append(b);
      pipAudio = b;
      return b.play().then(() => { unlocked = true; });
    } catch { return null; }
  };
  if (!toneMuted('ring')) {
    a.currentTime = 0;
    if (pipWin()) {
      const p = startPip();
      if (p && p.catch) p.catch(() => { a.play().then(() => { unlocked = true; }).catch(() => {}); });
    } else {
      a.play().then(() => { unlocked = true; }).catch(() => { const p = startPip(); if (p && p.catch) p.catch(() => {}); });
    }
  }
  return () => {
    clearInterval(vib); try { navigator.vibrate && navigator.vibrate(0); } catch { /* ignore */ }
    if (ringing) ringing = false;
    try { a.pause(); a.currentTime = 0; } catch { /* ignore */ }
    stopPip();
  };
}
