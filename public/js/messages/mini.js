// Floating mini chat. Chrome / Edge: a Document Picture-in-Picture window that stays on top of other
// apps, so you can read and reply while working elsewhere. Safari / iOS / Firefox: an in-page floating
// panel that survives navigation inside 1venue (it lives on <body>, not in the page view).
import { h, api, toastErr, avatar } from '../ui.js';
import { icon } from '../icons.js';
import { bus } from './live.js';

let cur = null; // { convId, win, root, off }
const hhmm = (t) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
export const pipSupported = () => typeof window !== 'undefined' && 'documentPictureInPicture' in window && window.top === window;
export const isMiniOpen = () => !!cur;

function copyStyles(doc) {
  for (const sheet of [...document.styleSheets]) {
    try {
      if (sheet.href) { const l = doc.createElement('link'); l.rel = 'stylesheet'; l.href = sheet.href; doc.head.append(l); }
      else { const st = doc.createElement('style'); st.textContent = [...sheet.cssRules].map((r) => r.cssText).join('\n'); doc.head.append(st); }
    } catch { /* cross-origin sheet */ }
  }
  for (const a of document.documentElement.attributes) if (a.name !== 'class') doc.documentElement.setAttribute(a.name, a.value);
  doc.documentElement.className = document.documentElement.className;
  doc.body.className = 'mini-body';
}

function render(convId, { onClose, onExpand, pip }) {
  const list = h('div', { class: 'mini-msgs', 'aria-live': 'polite' }, h('div', { class: 'mini-empty' }, 'Loading…'));
  const ta = h('textarea', { class: 'mini-input', rows: 1, placeholder: 'Reply…', 'aria-label': 'Reply', enterkeyhint: 'send' });
  const send = h('button', { class: 'mini-send', type: 'button', 'aria-label': 'Send', html: icon('send', { size: 18 }) });
  const title = h('b', { class: 'ellipsis' }, 'Chat');
  const av = h('span', { class: 'mini-av' });
  const head = h('header', { class: 'mini-head' }, av, h('div', { class: 'mini-title' }, title, h('span', { class: 'mini-sub' }, pip ? 'Floating over your apps' : 'Mini chat')),
    h('button', { class: 'icon-btn sm', type: 'button', 'aria-label': 'Open full chat', 'data-tip': 'Open full chat', html: icon('maximize', { size: 16 }), onclick: onExpand }),
    h('button', { class: 'icon-btn sm', type: 'button', 'aria-label': 'Close', 'data-tip': 'Close', html: icon('x', { size: 16 }), onclick: onClose }));
  const root = h('div', { class: `mini-chat${pip ? ' in-pip' : ''}` }, head, list, h('div', { class: 'mini-compose' }, ta, send));
  let msgs = []; let me = null;
  const bubble = (m) => m.kind === 'system' || m.kind === 'call'
    ? h('div', { class: 'mini-sys' }, m.text)
    : h('div', { class: `mini-row${m.mine ? ' mine' : ''}` }, h('div', { class: 'mini-bubble' },
      m.replyTo ? h('div', { class: 'mini-quote' }, h('b', null, m.replyTo.fromName || ''), ' ', (m.replyTo.text || (m.replyTo.attachmentKind ? `[${m.replyTo.attachmentKind}]` : '')).slice(0, 80)) : null,
      m.deleted ? h('i', null, 'Message deleted') : (m.text || (m.attachment ? `📎 ${m.attachment.name || m.attachment.kind}` : '')),
      h('span', { class: 'mini-time' }, hhmm(m.createdAt))));
  const paint = () => { list.replaceChildren(...(msgs.length ? msgs.slice(-60).map(bubble) : [h('div', { class: 'mini-empty' }, 'No messages yet')])); list.scrollTop = list.scrollHeight; };
  async function load() {
    try {
      const [c, m] = await Promise.all([api(`/api/messages/conversations/${convId}`), api(`/api/messages/conversations/${convId}/messages?limit=40`)]);
      title.textContent = c.conversation.title; av.replaceChildren(avatar(c.conversation.title, c.conversation.avatarUrl, 'sm'));
      msgs = m.messages; paint();
      if (!c.conversation.canSend) { ta.disabled = true; ta.placeholder = c.conversation.reason || 'Read only'; send.disabled = true; }
      if (msgs.length) api(`/api/messages/conversations/${convId}/read`, { method: 'POST', body: { messageId: msgs[msgs.length - 1].id } }).catch(() => {});
    } catch (e) { list.replaceChildren(h('div', { class: 'mini-empty' }, e.message || 'Could not load this chat')); }
  }
  async function doSend() {
    const text = ta.value.trim(); if (!text) return;
    send.disabled = true;
    try { const r = await api(`/api/messages/conversations/${convId}/messages`, { method: 'POST', body: { text } }); ta.value = ''; if (!msgs.some((x) => x.id === r.message.id)) msgs.push(r.message); paint(); }
    catch (e) { toastErr(e); } finally { send.disabled = false; ta.focus(); }
  }
  send.onclick = doSend;
  ta.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); doSend(); } });
  ta.addEventListener('input', () => { ta.style.height = 'auto'; ta.style.height = Math.min(110, ta.scrollHeight) + 'px'; });
  const onMsg = (e) => { const d = e.detail; if (Number(d.conversationId) !== Number(convId)) return; const i = msgs.findIndex((x) => x.id === d.message.id); if (i >= 0) msgs[i] = { ...msgs[i], ...d.message }; else msgs.push({ ...d.message, mine: d.message.mine || (me && d.message.fromUserId === me) }); paint(); };
  bus.addEventListener('message', onMsg);
  import('../app.js').then((a) => { me = a.state.user?.id || null; }).catch(() => {});
  load();
  return { root, off: () => bus.removeEventListener('message', onMsg), focus: () => ta.focus() };
}

export function closeMini() {
  if (!cur) return;
  const c = cur; cur = null;
  c.off();
  if (c.win) { try { c.win.close(); } catch { /* closed */ } } else c.root.remove();
}
/** Open the floating chat for a conversation. Prefers Picture-in-Picture; falls back to in-page. */
export async function openMini(convId, { preferPip = true } = {}) {
  closeMini();
  const expand = () => { closeMini(); import('../app.js').then((a) => { window.focus(); a.navigate(`/messages/${convId}`); }); };
  if (preferPip && pipSupported()) {
    try {
      const win = await window.documentPictureInPicture.requestWindow({ width: 360, height: 540 });
      copyStyles(win.document);
      const r = render(convId, { pip: true, onClose: () => closeMini(), onExpand: expand });
      win.document.body.append(r.root);
      cur = { convId, win, root: r.root, off: r.off };
      win.addEventListener('pagehide', () => { if (cur && cur.win === win) { cur.off(); cur = null; } });
      setTimeout(r.focus, 50);
      return 'pip';
    } catch { /* blocked (needs a click) or unsupported: fall back */ }
  }
  const r = render(convId, { pip: false, onClose: () => closeMini(), onExpand: expand });
  const wrap = h('div', { class: 'mini-float', role: 'dialog', 'aria-label': 'Mini chat' }, r.root);
  // Drag by the header (pointer events work for mouse and touch).
  const head = r.root.querySelector('.mini-head'); let sx = 0, sy = 0, ox = 0, oy = 0, drag = false;
  head.addEventListener('pointerdown', (e) => { if (e.target.closest('button')) return; drag = true; sx = e.clientX; sy = e.clientY; const b = wrap.getBoundingClientRect(); ox = b.left; oy = b.top; head.setPointerCapture(e.pointerId); });
  head.addEventListener('pointermove', (e) => { if (!drag) return; const x = Math.max(4, Math.min(innerWidth - wrap.offsetWidth - 4, ox + e.clientX - sx)); const y = Math.max(4, Math.min(innerHeight - 80, oy + e.clientY - sy)); Object.assign(wrap.style, { left: x + 'px', top: y + 'px', right: 'auto', bottom: 'auto' }); });
  head.addEventListener('pointerup', () => { drag = false; });
  document.body.append(wrap);
  cur = { convId, win: null, root: wrap, off: r.off };
  setTimeout(r.focus, 50);
  return 'inline';
}
