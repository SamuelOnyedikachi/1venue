// Make an incoming call findable when the 1venue tab is in the background (one of many tabs):
//  (a) a system notification that stays until handled, with Answer / Decline buttons (Chromium) -
//      clicking it focuses this tab (service worker: clients.matchAll + focus, see sw.js);
//  (b) a flashing tab title "📞 Incoming call – Name" and a red badge on the favicon;
//  (c) a Document Picture-in-Picture window with Answer / Decline, when the browser has one and
//      allows it (it needs a recent user gesture, so it is best-effort and silently skipped).
// stop() undoes all of it: on answer, decline, miss, or the call being answered on another device.
let active = null;

export const ALERT_TITLE = (name) => `📞 Incoming call – ${String(name || 'Someone').slice(0, 60)}`;

/** The pieces that apply right now (exported for tests). */
export function plan({ hidden, permission, hasSW, hasPiP, activation, hasAppPip }) {
  return {
    notify: !!hidden && permission === 'granted' && !!hasSW,
    title: true,
    favicon: true,
    // Chrome allows one Document PiP per tab. Never open the small call PiP
    // when the app-wide pop-out is already open — it would replace it.
    pip: !!hidden && !!hasPiP && !!activation && !hasAppPip,
  };
}

export function hasAppPip() {
  try {
    const w = window.documentPictureInPicture && window.documentPictureInPicture.window;
    return !!(w && !w.closed);
  } catch { return false; }
}

export function startCallAlert(call, { onAnswer, onDecline } = {}) {
  stopCallAlert();
  const name = call.title || call.from?.name || 'Someone';
  const kind = call.kind === 'video' ? 'video' : 'audio';
  const a = { id: call.id, timers: [], cleanups: [] };
  active = a;
  const want = plan({
    hidden: document.hidden || !document.hasFocus(),
    permission: typeof Notification !== 'undefined' ? Notification.permission : 'denied',
    hasSW: 'serviceWorker' in navigator,
    hasPiP: 'documentPictureInPicture' in window,
    activation: navigator.userActivation ? navigator.userActivation.isActive : false,
    hasAppPip: hasAppPip(),
  });
  // (b) title flash + favicon badge
  const title0 = document.title, alt = ALERT_TITLE(name);
  let on = false;
  const flash = () => { if (active !== a) return; on = !on; document.title = on ? alt : title0; };
  flash(); a.timers.push(setInterval(flash, 1000));
  a.cleanups.push(() => { document.title = title0; });
  badgeFavicon(a);
  // (a) system notification (only useful when the tab is not in view)
  if (want.notify) {
    navigator.serviceWorker.ready.then((reg) => {
      if (active !== a) return;
      return reg.showNotification(`Incoming ${kind} call`, {
        body: `${name} is calling you on 1venue`, tag: `call-${call.id}`, renotify: true, requireInteraction: true,
        icon: call.from?.avatarUrl || '/icons/icon-192.png', badge: '/icons/icon-192.png', vibrate: [300, 150, 300, 150, 300],
        actions: [{ action: 'answer', title: 'Answer' }, { action: 'decline', title: 'Decline' }],
        data: { kind: 'call', callId: call.id, url: location.pathname + location.search },
      });
    }).catch(() => {});
    a.cleanups.push(() => closeCallNotifications(call.id));
  }
  // Tab comes back into view: the in-page ring sheet is enough, drop the system notification.
  const vis = () => { if (!document.hidden) closeCallNotifications(call.id); };
  document.addEventListener('visibilitychange', vis);
  a.cleanups.push(() => document.removeEventListener('visibilitychange', vis));
  // (c) Small call PiP only when the app-wide pop-out is not already open.
  // The standard ring card is moved into the app pop-out by placeCallUi.
  if (want.pip) openPiP(a, { name, kind, onAnswer, onDecline }).catch(() => {});
  return a;
}

export function stopCallAlert(id) {
  const a = active;
  if (!a || (id && a.id !== id)) return;
  active = null;
  a.timers.forEach(clearInterval);
  a.cleanups.reverse().forEach((f) => { try { f(); } catch { /* already gone */ } });
  closeCallNotifications(a.id);
}

export function closeCallNotifications(id) {
  if (!('serviceWorker' in navigator)) return;
  navigator.serviceWorker.getRegistration().then((reg) => reg && reg.getNotifications({ tag: `call-${id}` }))
    .then((list) => (list || []).forEach((n) => n.close())).catch(() => {});
}

function badgeFavicon(a) {
  const links = [...document.querySelectorAll('link[rel~="icon"]')];
  if (!links.length) return;
  const old = links.map((l) => ({ l, href: l.getAttribute('href'), type: l.getAttribute('type') }));
  const img = new Image();
  img.onload = () => {
    if (active !== a) return;
    try {
      const c = document.createElement('canvas'); c.width = c.height = 64;
      const x = c.getContext('2d'); x.drawImage(img, 0, 0, 64, 64);
      x.beginPath(); x.arc(46, 18, 16, 0, Math.PI * 2); x.fillStyle = '#ef4444'; x.fill();
      x.lineWidth = 4; x.strokeStyle = '#fff'; x.stroke();
      x.fillStyle = '#fff'; x.font = 'bold 20px system-ui, sans-serif'; x.textAlign = 'center'; x.textBaseline = 'middle'; x.fillText('☎', 46, 19);
      const url = c.toDataURL('image/png');
      links.forEach((l) => { l.setAttribute('href', url); l.setAttribute('type', 'image/png'); });
    } catch { /* tainted canvas etc. */ }
  };
  img.src = '/icons/icon-192.png';
  a.cleanups.push(() => old.forEach(({ l, href, type }) => { l.setAttribute('href', href); if (type) l.setAttribute('type', type); else l.removeAttribute('type'); }));
}

async function openPiP(a, { name, kind, onAnswer, onDecline }) {
  if (hasAppPip()) return;
  const pip = await window.documentPictureInPicture.requestWindow({ width: 320, height: 150 });
  if (active !== a) { pip.close(); return; }
  a.cleanups.push(() => { try { pip.close(); } catch { /* closed */ } });
  const d = pip.document;
  d.title = ALERT_TITLE(name);
  const st = d.createElement('style');
  st.textContent = 'body{margin:0;font:15px system-ui,sans-serif;background:#0f172a;color:#fff;display:flex;flex-direction:column;justify-content:center;gap:12px;height:100vh;padding:0 16px;box-sizing:border-box}b{font-size:17px;display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}small{opacity:.75}.r{display:flex;gap:10px}button{flex:1;border:0;border-radius:999px;padding:10px;font:600 15px system-ui;color:#fff;cursor:pointer}.y{background:#16a34a}.n{background:#dc2626}';
  d.head.append(st);
  const box = d.createElement('div');
  const t = d.createElement('b'); t.textContent = name;
  const s = d.createElement('small'); s.textContent = `Incoming ${kind} call · 1venue`;
  box.append(t, s);
  const row = d.createElement('div'); row.className = 'r';
  const no = d.createElement('button'); no.className = 'n'; no.textContent = 'Decline';
  const yes = d.createElement('button'); yes.className = 'y'; yes.textContent = 'Answer';
  no.onclick = () => { onDecline && onDecline(); };
  yes.onclick = () => { window.focus(); onAnswer && onAnswer(); };
  row.append(no, yes); d.body.append(box, row);
}
