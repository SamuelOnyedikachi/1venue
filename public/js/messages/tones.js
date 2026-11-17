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
function unlock() {
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
  window.addEventListener('pointerdown', unlock, { capture: true });
  window.addEventListener('keydown', unlock, { capture: true });
}

let lastMsg = 0;
/** Short two-note chime for an incoming message (throttled so a burst plays once). */
export function playMessageTone() {
  if (toneMuted('message') || Date.now() - lastMsg < 1500) return;
  lastMsg = Date.now();
  const a = audio('message'); a.muted = false; a.volume = 0.85; a.currentTime = 0;
  a.play().catch(() => {});
}

/** Start the looping ringtone (plus vibration on phones). Returns stop(). */
export function startRingtone() {
  let vib = null;
  const buzz = () => { try { navigator.vibrate && navigator.vibrate([400, 200, 400]); } catch { /* ignore */ } };
  buzz(); vib = setInterval(buzz, 2600);
  const a = audio('ringtone'); a.muted = false; a.loop = true; a.volume = 1; ringing = true;
  if (!toneMuted('ring')) {
    a.currentTime = 0;
    a.play().then(() => { unlocked = true; }).catch(() => {});
  }
  return () => {
    clearInterval(vib); try { navigator.vibrate && navigator.vibrate(0); } catch { /* ignore */ }
    if (ringing) ringing = false;
    try { a.pause(); a.currentTime = 0; } catch { /* ignore */ }
  };
}
