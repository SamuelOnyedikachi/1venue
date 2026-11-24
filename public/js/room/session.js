/** Keep a joined meeting alive across SPA navigations, auto pop-out, and a local call-audio mute. */
import { h } from '../ui.js';
import { icon } from '../icons.js';
import { fmtCode } from './intent.js';
import { setRoomMode } from '../app.js';

let live = null;

export function getLive() { return live; }
export function liveUrl(room) { return '/' + fmtCode((room && room.code) || (live && live.code) || ''); }
export function canResume(params) {
  if (!live || !live.room || !live.room.alive || !live.room.inRoom) return false;
  const code = params && params.code ? fmtCode(params.code) : '';
  return !!(code && fmtCode(live.code) === code);
}

export function pageApi(room) {
  return {
    unmount() { room.destroy(); },
    canParkLive() { return !!(room.alive && room.inRoom && room.root && !room._leaving); },
    parkLive() { return park(room); },
  };
}

export function holder() {
  let el = document.getElementById('live-meeting-hold');
  if (!el) {
    el = h('div', { id: 'live-meeting-hold', 'aria-hidden': 'true' });
    document.body.append(el);
  }
  return el;
}

export function park(room) {
  if (!room || !room.alive || !room.inRoom) return false;
  if (live && live.room && live.room !== room) {
    try { live.room.destroy(); } catch { /* ignore */ }
  }
  if (room.root && room.root.parentNode !== holder()) holder().append(room.root);
  try { setRoomMode(false); } catch { /* ignore */ }
  live = { room, code: room.code, url: liveUrl(room) };
  // Request Document PiP in the same turn as the click (user gesture).
  startAutoPip(room);
  syncChrome(room);
  return true;
}

export async function resume(view, params) {
  if (!canResume(params)) return null;
  const room = live.room;
  room.view = view;
  if (room.root) view.append(room.root);
  closeMini();
  closeAutoPip();
  try { setRoomMode(true); } catch { /* ignore */ }
  try { room.renderStage(true); room.paintHead(true); } catch { /* ignore */ }
  return pageApi(room);
}

export function release(room) {
  if (!live || (room && live.room !== room)) return;
  closeMini();
  closeAutoPip();
  const hold = document.getElementById('live-meeting-hold');
  if (hold) hold.remove();
  unbindMediaSession();
  live = null;
}

export function bindMediaSession(room) {
  if (!room || !navigator.mediaSession) return;
  try {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: room.roomName || '1venue meeting',
      artist: '1venue',
      artwork: [{ src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' }],
    });
    navigator.mediaSession.setActionHandler('enterpictureinpicture', () => startAutoPip(room));
  } catch { /* browser may not support the action */ }
  if (room._visPip) return;
  room._visPip = () => {
    if (document.visibilityState !== 'hidden') return;
    if (!room.alive || !room.inRoom || room._leaving) return;
    setTimeout(() => {
      if (document.visibilityState !== 'hidden' || !room.alive || room._leaving) return;
      if (hasPip()) return;
      notifyReturn(room);
    }, 500);
  };
  document.addEventListener('visibilitychange', room._visPip);
}

function unbindMediaSession() {
  if (!navigator.mediaSession) return;
  try { navigator.mediaSession.setActionHandler('enterpictureinpicture', null); } catch { /* */ }
}

function hasPip() {
  try {
    const w = window.documentPictureInPicture && window.documentPictureInPicture.window;
    return !!(w && !w.closed);
  } catch { return false; }
}

export function startAutoPip(room) {
  if (!room || !room.alive) return Promise.resolve('none');
  if (hasPip()) {
    const w = window.documentPictureInPicture.window;
    if (w && w.document && w.document.querySelector('.app-pip-call')) {
      mountBar(w.document.querySelector('.app-pip-call'), room, w.document);
      return Promise.resolve('app');
    }
    if (live && live.autoPip && !live.autoPip.closed) return Promise.resolve('auto');
    // An unrelated PiP (e.g. the app pop-out without a call slot) is already open;
    // Chrome will replace it if we request another, so use the in-page mini bar.
    showMini(room);
    return Promise.resolve('mini');
  }
  if (typeof documentPictureInPicture === 'undefined' || !documentPictureInPicture.requestWindow) {
    showMini(room);
    return Promise.resolve('mini');
  }
  try {
    const p = documentPictureInPicture.requestWindow({ width: 380, height: 132 });
    return p.then((w) => {
      live && (live.autoPip = w);
      fillAutoPip(w, room);
      closeMini();
      w.addEventListener('pagehide', () => {
        if (live) live.autoPip = null;
        if (room.alive && room.inRoom && !room._leaving && (!room.root || !document.getElementById('view')?.contains(room.root))) showMini(room);
      });
      return 'auto';
    }).catch(() => { showMini(room); return 'mini'; });
  } catch {
    showMini(room);
    return Promise.resolve('mini');
  }
}

function copyTheme(doc) {
  try { doc.documentElement.dataset.theme = document.documentElement.dataset.theme; } catch { /* */ }
  const src = getComputedStyle(document.documentElement);
  const root = doc.documentElement.style;
  for (const k of ['--bg', '--text', '--muted', '--line', '--s1', '--s2', '--accent', '--accent-2', '--accent-ink', '--accent-action']) {
    try { const v = src.getPropertyValue(k); if (v) root.setProperty(k, v); } catch { /* */ }
  }
}

function fillAutoPip(win, room) {
  const doc = win.document;
  copyTheme(doc);
  doc.documentElement.style.height = '100%';
  doc.body.style.cssText = 'margin:0;height:100%;background:var(--bg,#111);color:var(--text,#eee);font:14px/1.4 system-ui,sans-serif;';
  const style = doc.createElement('style');
  style.textContent = pipCss();
  doc.head.append(style);
  const slot = doc.createElement('div');
  slot.className = 'meet-pip';
  doc.body.append(slot);
  mountBar(slot, room, doc);
}

function pipCss() {
  return `.meet-pip,.live-call-bar{display:flex;align-items:center;gap:.45rem;width:100%;box-sizing:border-box;padding:.45rem .55rem;background:var(--s1,#1a1a1a);color:inherit}
.meet-pip{height:100%}
.lcb-dot{width:8px;height:8px;border-radius:99px;background:#16a34a;flex:none;box-shadow:0 0 0 4px color-mix(in srgb,#16a34a 25%,transparent)}
.lcb-who{flex:1;min-width:0;display:flex;flex-direction:column}
.lcb-who b{font-size:.86rem;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.lcb-who span{font-size:.72rem;color:var(--muted,#888)}
.lcb-flag{font-size:.68rem;font-weight:700;color:#fff;background:color-mix(in srgb,var(--accent,#2563eb) 80%,#000);border-radius:99px;padding:.05rem .4rem;margin-left:.25rem}
.lcb-btns{display:flex;gap:.25rem;flex:none}
.lcb-btns button{width:34px;height:34px;border:0;border-radius:10px;cursor:pointer;color:inherit;background:color-mix(in srgb,var(--text,#fff) 10%,transparent);display:grid;place-items:center}
.lcb-btns button.off{opacity:.7}
.lcb-btns button.danger{background:#dc2626;color:#fff}
.lcb-btns button.primary{background:var(--accent-action,var(--accent,#2563eb));color:#fff}`;
}

function mountBar(host, room, doc) {
  if (!host) return;
  host.replaceChildren();
  const bar = (doc || document).createElement('div');
  bar.className = 'live-call-bar';
  host.append(bar);
  paintBar(bar, room, doc || document);
}

function paintBar(bar, room, doc) {
  if (!bar) return;
  const d = doc || bar.ownerDocument || document;
  const mk = (ic, tip, fn, cls) => {
    const b = d.createElement('button');
    b.type = 'button';
    b.className = cls || '';
    b.setAttribute('aria-label', tip);
    b.title = tip;
    b.innerHTML = icon(ic, { size: 16 });
    b.onclick = (e) => { e.preventDefault(); fn(); syncChrome(room); };
    return b;
  };
  const muted = !!room.callMuted;
  const who = d.createElement('div');
  who.className = 'lcb-who';
  who.innerHTML = `<b></b><span></span>`;
  who.querySelector('b').textContent = room.roomName || 'Meeting';
  const sub = who.querySelector('span');
  sub.textContent = timerText(room);
  if (muted) {
    const flag = d.createElement('em');
    flag.className = 'lcb-flag';
    flag.textContent = 'Call muted';
    sub.append(' ', flag);
  }
  const btns = d.createElement('div');
  btns.className = 'lcb-btns';
  const back = mk('pip', 'Back to tab', () => returnToMeeting(d), 'primary');
  back.innerHTML = icon('login', { size: 16 });
  back.setAttribute('aria-label', 'Back to tab');
  back.title = 'Back to tab';
  btns.append(
    back,
    mk(room.media && room.media.mic ? 'mic' : 'micOff', 'Microphone', () => room.toggleMic(), room.media && room.media.mic ? '' : 'off'),
    mk(muted ? 'volumeOff' : 'volume', muted ? 'Unmute call audio' : 'Mute call audio', () => room.toggleCallAudio(), muted ? 'off' : ''),
    mk('phoneOff', 'Leave', () => { room._leaving = true; closeAutoPip(); closeMini(); room.leave(); }, 'danger'),
  );
  const dot = d.createElement('i');
  dot.className = 'lcb-dot';
  bar.replaceChildren(dot, who, btns);
  bar._room = room;
}

export function syncChrome(room) {
  const r = room || (live && live.room);
  if (!r) return;
  const nodes = [];
  const mini = document.getElementById('live-call-mini');
  if (mini) nodes.push(mini);
  try {
    const w = window.documentPictureInPicture && window.documentPictureInPicture.window;
    if (w && w.document) w.document.querySelectorAll('.live-call-bar').forEach((el) => nodes.push(el));
  } catch { /* */ }
  for (const el of nodes) paintBar(el, r, el.ownerDocument);
}

function timerText(room) {
  const secs = Math.max(0, Math.floor((Date.now() - (room.startedAt || Date.now())) / 1000));
  const h = Math.floor(secs / 3600);
  return `${h ? h + ':' : ''}${String(Math.floor(secs / 60) % 60).padStart(2, '0')}:${String(secs % 60).padStart(2, '0')}`;
}

function showMini(room) {
  closeMini();
  const bar = h('div', { id: 'live-call-mini', class: 'live-call-mini', role: 'dialog', 'aria-label': 'Meeting in progress' });
  document.body.append(bar);
  paintBar(bar, room, document);
}

function closeMini() {
  const el = document.getElementById('live-call-mini');
  if (el) el.remove();
}

function closeAutoPip() {
  try {
    if (live && live.autoPip && !live.autoPip.closed) live.autoPip.close();
  } catch { /* */ }
  if (live) live.autoPip = null;
}

export function returnToMeeting(pipDoc) {
  const url = (live && live.url) || (live && live.room && liveUrl(live.room));
  let focused = false;
  try { window.focus(); focused = !!(document.hasFocus && document.hasFocus()); } catch { focused = false; }
  if (url && (location.pathname.replace(/\/$/, '') !== url)) {
    import('../app.js').then((m) => m.navigate(url)).catch(() => {});
  }
  if (!focused) import('../bring-main.js').then((b) => b.bringMainToFront(pipDoc && pipDoc.defaultView ? pipDoc : (pipDoc || null), { url })).catch(() => {});
}

function notifyReturn(room) {
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
  try {
    const n = new Notification('Meeting in progress', {
      body: 'Tap to return to the call',
      tag: '1venue-meeting',
      icon: '/icons/icon-192.png',
    });
    n.onclick = () => { try { window.focus(); } catch { /* */ } returnToMeeting(); n.close(); };
  } catch { /* */ }
}
