// Messages: the signed-in user socket (/ws/me). One per tab, reconnects with backoff. It keeps the
// unread badges on the nav in sync (server counts, so they survive refresh), shows the incoming-call
// sheet on any page, and re-emits every event on `bus` for the Messages page.
import { api, toast } from '../ui.js';

export const bus = new EventTarget();
let ws = null, userId = null, retry = 0, timer = null, active = null, unreadTotal = 0;
const emit = (type, detail) => bus.dispatchEvent(new CustomEvent(type, { detail }));
export const unread = () => unreadTotal;

function paintBadges() {
  document.querySelectorAll('[data-nav="/messages"]').forEach((a) => {
    let b = a.querySelector('.nav-badge');
    if (!unreadTotal) { b?.remove(); return; }
    if (!b) { b = document.createElement('span'); b.className = 'nav-badge'; a.append(b); }
    b.textContent = unreadTotal > 99 ? '99+' : String(unreadTotal);
    b.setAttribute('aria-label', `${unreadTotal} unread`);
  });
  try { if (navigator.setAppBadge) unreadTotal ? navigator.setAppBadge(unreadTotal) : navigator.clearAppBadge(); } catch { /* unsupported */ }
}
let refreshT = null;
export function refreshUnread() {
  clearTimeout(refreshT);
  refreshT = setTimeout(async () => {
    if (!userId) return;
    try { const r = await api('/api/messages/unread'); unreadTotal = r.total || 0; paintBadges(); emit('unread', r); } catch { /* offline */ }
  }, 250);
}
function sendVisible() {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'visible', visible: document.visibilityState === 'visible', conversationId: active }));
}
/** The Messages page tells us which thread is on screen (no push / no unread bump for it). */
export function setActiveConversation(id) { active = id || null; sendVisible(); }
export function typing(conversationId) { if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'typing', conversationId })); }

function connect() {
  if (!userId || (ws && ws.readyState <= 1)) return;
  const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws/me`;
  try { ws = new WebSocket(url); } catch { schedule(); return; }
  ws.onopen = () => {
    retry = 0; sendVisible(); refreshUnread(); emit('open');
    // A call that started ringing while this tab was closed (e.g. opened from a push notification).
    api('/api/messages/calls/current').then((r) => r.calls.filter((c) => c.state === 'ringing' && c.myState === 'invited')
      .forEach((c) => import('./call.js').then((m) => m.incoming({ ...c, title: c.title || 'Incoming call' })))).catch(() => {});
  };
  ws.onmessage = (e) => {
    let m; try { m = JSON.parse(e.data); } catch { return; }
    if (m.type === 'message') {
      const mine = m.message && m.message.fromUserId === userId;
      if (!mine && !(document.visibilityState === 'visible' && Number(active) === Number(m.conversationId))) {
        refreshUnread();
        if (!location.pathname.startsWith('/messages') && m.message.kind !== 'call') toast(`${m.message.fromName}: ${m.message.text || 'sent an attachment'}`.slice(0, 120), { icon: 'chat', group: 'people', action: { label: 'Open', run: () => import('../app.js').then((a) => a.navigate(`/messages/${m.conversationId}`)) } });
      }
    } else if (m.type === 'unread' || m.type === 'read' || m.type === 'conversation-updated') refreshUnread();
    else if (m.type === 'call-ring') import('./call.js').then((c) => c.incoming(m.call)).catch(() => {});
    else if (m.type && m.type.startsWith('call-')) import('./call.js').then((c) => c.onEvent(m)).catch(() => {});
    emit(m.type, m);
  };
  ws.onclose = () => { ws = null; emit('close'); schedule(); };
  ws.onerror = () => { try { ws.close(); } catch { /* ignore */ } };
}
function schedule() {
  clearTimeout(timer);
  if (!userId) return;
  const wait = Math.min(30000, 1000 * 2 ** retry++) + Math.random() * 500;
  timer = setTimeout(connect, wait);
}
/** Start (or stop, with null) the user socket for the signed-in user. */
export function startLive(id) {
  if (id === userId) { paintBadges(); return; }
  userId = id || null; unreadTotal = 0; paintBadges();
  clearTimeout(timer); try { ws && ws.close(); } catch { /* ignore */ } ws = null;
  if (userId) connect();
}
document.addEventListener('visibilitychange', () => { sendVisible(); if (document.visibilityState === 'visible') { connect(); refreshUnread(); } });
window.addEventListener('online', () => connect());

// ---------------------------------------------------------------- web push (only when the server has VAPID keys)
const b64 = (s) => { const p = '='.repeat((4 - (s.length % 4)) % 4); const raw = atob((s + p).replace(/-/g, '+').replace(/_/g, '/')); return Uint8Array.from([...raw].map((c) => c.charCodeAt(0))); };
export async function pushState() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) return { supported: false };
  const cfg = await api('/api/messages/push/config').catch(() => ({ enabled: false }));
  if (!cfg.enabled) return { supported: true, enabled: false };
  const reg = await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.getSubscription();
  return { supported: true, enabled: true, on: !!sub && Notification.permission === 'granted', permission: Notification.permission, publicKey: cfg.publicKey };
}
export async function enablePush() {
  const st = await pushState();
  if (!st.enabled) throw new Error('Notifications are not set up on this server yet');
  if ((await Notification.requestPermission()) !== 'granted') throw new Error('Notifications are blocked in your browser settings');
  const reg = await navigator.serviceWorker.ready;
  const sub = (await reg.pushManager.getSubscription()) || await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64(st.publicKey) });
  await api('/api/messages/push/subscribe', { method: 'POST', body: sub.toJSON() });
  return true;
}
export async function disablePush() {
  const reg = await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.getSubscription();
  if (sub) { await api('/api/messages/push/unsubscribe', { method: 'POST', body: { endpoint: sub.endpoint } }).catch(() => {}); await sub.unsubscribe(); }
}
