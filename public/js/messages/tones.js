// Call ringtone and message tone (small MP3s made for 1venue, no third-party audio).
// The ringtone loops until the call is answered or declined; each can be muted in Message settings.
const KEYS = { ring: 'venue.tone.ring.muted', message: 'venue.tone.message.muted' };
export const toneMuted = (k) => { try { return localStorage.getItem(KEYS[k]) === '1'; } catch { return false; } };
export const setToneMuted = (k, v) => { try { localStorage.setItem(KEYS[k], v ? '1' : '0'); } catch { /* private mode */ } };

// Browsers only allow sound after a user gesture: warm both files up on the first tap or key press.
const cache = {};
function audio(name) { if (!cache[name]) { cache[name] = new Audio(`/sounds/${name}.mp3`); cache[name].preload = 'auto'; } return cache[name]; }
let unlocked = false;
function unlock() {
  if (unlocked) return; unlocked = true;
  for (const n of ['message', 'ringtone']) { const a = audio(n); a.muted = true; a.play().then(() => { a.pause(); a.currentTime = 0; a.muted = false; }).catch(() => { a.muted = false; }); }
}
if (typeof window !== 'undefined') { window.addEventListener('pointerdown', unlock, { once: true, capture: true }); window.addEventListener('keydown', unlock, { once: true, capture: true }); }

let lastMsg = 0;
/** Short two-note chime for an incoming message (throttled so a burst plays once). */
export function playMessageTone() {
  if (toneMuted('message') || Date.now() - lastMsg < 1500) return;
  lastMsg = Date.now();
  const a = audio('message'); a.volume = 0.85; a.currentTime = 0;
  a.play().catch(() => {});
}

/** Start the looping ringtone (plus vibration on phones). Returns stop(). */
export function startRingtone() {
  let stopped = false; let vib = null; let fallback = null;
  const buzz = () => { try { navigator.vibrate && navigator.vibrate([400, 200, 400]); } catch { /* ignore */ } };
  buzz(); vib = setInterval(buzz, 2600);
  const a = new Audio('/sounds/ringtone.mp3'); a.loop = true; a.volume = 1;
  if (!toneMuted('ring')) {
    a.play().catch(() => {
      // Autoplay blocked: a quiet Web Audio beep pattern still works once the page was touched.
      try {
        const ctx = new (window.AudioContext || window.webkitAudioContext)();
        const beep = () => { if (stopped) return; const o = ctx.createOscillator(), g = ctx.createGain(); o.type = 'triangle'; o.frequency.value = 880; g.gain.setValueAtTime(0.0001, ctx.currentTime); g.gain.exponentialRampToValueAtTime(0.25, ctx.currentTime + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.45); o.connect(g).connect(ctx.destination); o.start(); o.stop(ctx.currentTime + 0.5); };
        beep(); fallback = { ctx, iv: setInterval(beep, 1300) };
      } catch { /* no audio at all: the ringing sheet is still on screen */ }
    });
  }
  return () => {
    stopped = true; clearInterval(vib); try { navigator.vibrate && navigator.vibrate(0); } catch { /* ignore */ }
    try { a.pause(); a.src = ''; } catch { /* ignore */ }
    if (fallback) { clearInterval(fallback.iv); try { fallback.ctx.close(); } catch { /* ignore */ } }
  };
}
