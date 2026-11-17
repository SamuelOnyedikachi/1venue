// Notifications are ON by default. On a first visit we show a friendly in-app card, then the browser's
// own permission prompt (it must come from a tap). If someone says "Not now" or dismisses it, we ask
// again later with a gentle backoff: 3 days, then 7, then every 14. The state lives in localStorage
// and is mirrored to the server (user_prefs) so a cleared browser doesn't nag on day one.
import { h, api, toast } from '../ui.js';
import { icon } from '../icons.js';
import { pushState, enablePush } from './live.js';

const KEY = 'venue.notify';
const DAY = 86400000;
export const BACKOFF_DAYS = [3, 7, 14];
/** When to ask next after `asks` refusals (pure; exported for tests). */
export const nextAskAt = (asks, now = Date.now()) => now + BACKOFF_DAYS[Math.min(Math.max(asks, 1), BACKOFF_DAYS.length) - 1] * DAY;
const load = () => { try { return JSON.parse(localStorage.getItem(KEY)) || { asks: 0, next: 0, state: 'default' }; } catch { return { asks: 0, next: 0, state: 'default' }; } };
function save(st) {
  try { localStorage.setItem(KEY, JSON.stringify(st)); } catch { /* private mode */ }
  api('/api/messages/settings', { method: 'PUT', body: { notifyPrompt: st } }).catch(() => {});
}
export const supported = () => typeof window !== 'undefined' && 'Notification' in window && 'serviceWorker' in navigator;

let started = false;
/** True when this device gets server web push (then the service worker shows notifications). */
export let pushOn = false;

async function subscribeQuietly() {
  try { const st = await pushState(); if (st.enabled) { if (!st.on) await enablePush(); pushOn = true; } } catch { pushOn = false; }
}
/** Ask now (must run inside a tap). Resolves to the browser's answer. */
export async function askNow() {
  if (!supported()) return 'unsupported';
  const st = load();
  let perm = Notification.permission;
  if (perm === 'default') perm = await Notification.requestPermission();
  if (perm === 'granted') { save({ ...st, state: 'granted' }); await subscribeQuietly(); toast('Notifications are on', { icon: 'bellRing' }); }
  else { const asks = st.asks + 1; save({ asks, next: nextAskAt(asks), state: perm === 'denied' ? 'denied' : 'dismissed' }); }
  return perm;
}
function card() {
  const close = (refused) => {
    el.classList.remove('in'); setTimeout(() => el.remove(), 250);
    if (refused) { const st = load(); const asks = st.asks + 1; save({ asks, next: nextAskAt(asks), state: 'dismissed' }); }
  };
  const el = h('div', { class: 'notify-card', role: 'dialog', 'aria-label': 'Turn on notifications' },
    h('span', { class: 'notify-ic', html: icon('bellRing', { size: 22 }) }),
    h('div', { class: 'notify-txt' }, h('b', null, 'Never miss a message'), h('span', null, 'Turn on notifications for new messages and calls, even when 1venue is in the background.')),
    h('div', { class: 'notify-act' },
      h('button', { class: 'btn ghost sm', type: 'button', onclick: () => close(true) }, 'Not now'),
      h('button', { class: 'btn primary sm', type: 'button', onclick: async () => { close(false); await askNow(); } }, 'Turn on')));
  document.body.append(el);
  requestAnimationFrame(() => el.classList.add('in'));
}
function deniedHint() {
  toast('Notifications are blocked for 1venue. Allow them in your browser’s site settings to get messages and calls.', { icon: 'bell', group: 'settings' });
}
/** Called once per page load when someone is signed in. */
export async function initNotifyPrompt() {
  if (started || !supported()) return; started = true;
  let st = load();
  try { const srv = (await api('/api/messages/settings')).notifyPrompt; if (srv && (Number(srv.next) || 0) > (Number(st.next) || 0)) { st = { ...st, ...srv }; try { localStorage.setItem(KEY, JSON.stringify(st)); } catch { /* ignore */ } } } catch { /* offline */ }
  const perm = Notification.permission;
  if (perm === 'granted') { subscribeQuietly(); return; }
  if (Date.now() < (Number(st.next) || 0)) return;
  setTimeout(() => {
    if (Notification.permission === 'granted') return;
    if (Notification.permission === 'denied') {
      // The browser won't show its prompt again; remind them how to allow it, on the same backoff.
      deniedHint(); const asks = st.asks + 1; save({ asks, next: nextAskAt(asks), state: 'denied' }); return;
    }
    card();
  }, 3500);
}

/** A local notification when no server push is set up (Notification API + the service worker). */
export async function localNotify({ title, body, url, tag }) {
  if (pushOn || !supported() || Notification.permission !== 'granted') return;
  try {
    const reg = await navigator.serviceWorker.ready;
    await reg.showNotification(title || '1venue', { body: body || '', tag, renotify: !!tag, icon: '/icons/icon-192.png', badge: '/icons/icon-192.png', data: { url: url || '/messages' } });
  } catch {
    try { const n = new Notification(title || '1venue', { body, tag, icon: '/icons/icon-192.png' }); n.onclick = () => { window.focus(); location.assign(url || '/messages'); }; } catch { /* unsupported */ }
  }
}
