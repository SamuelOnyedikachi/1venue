/**
 * App-wide fullscreen and Document Picture-in-Picture. The PiP window stays on top of other
 * apps in Chrome and Edge on desktop. It follows the site theme (light/dark and accent), and
 * can start a chat, an instant meeting, or a call from a conversation.
 */
import { h, api, toast, toastErr, avatar, debounce, linkify } from './ui.js';
import { icon } from './icons.js';
import { state, navigate, openInstantOverlay } from './app.js';

export function pipSupported() {
  return typeof window !== 'undefined' && 'documentPictureInPicture' in window && window.top === window;
}

export async function toggleFullscreen() {
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else await document.documentElement.requestFullscreen({ navigationUI: 'hide' });
  } catch (e) { toast(e.message || 'Fullscreen is not available', { icon: 'alert' }); }
}

function absUrl(href) {
  try { return new URL(href, document.baseURI).href; } catch { return href; }
}

function applyTheme(doc) {
  if (!doc || !doc.documentElement) return;
  const src = document.documentElement;
  const dst = doc.documentElement;
  dst.lang = src.lang || 'en';
  dst.className = src.className;
  dst.dataset.theme = src.dataset.theme || 'light';
  dst.style.cssText = src.style.cssText;
  const scheme = dst.dataset.theme === 'dark' ? 'dark' : 'light';
  if (!dst.style.getPropertyValue('color-scheme')) dst.style.setProperty('color-scheme', scheme);
  if (doc.body) {
    doc.body.className = document.body.className;
    doc.body.style.margin = '0';
    doc.body.style.background = 'var(--bg)';
    doc.body.style.color = 'var(--text)';
  }
}

function copyStyles(doc) {
  let base = doc.querySelector('base');
  if (!base) {
    base = doc.createElement('base');
    doc.head.prepend(base);
  }
  base.href = new URL('/', location.href).href;
  doc.querySelectorAll('[data-pip-style]').forEach((n) => n.remove());
  for (const node of document.querySelectorAll('link[rel="stylesheet"], style')) {
    const clone = node.cloneNode(true);
    clone.setAttribute('data-pip-style', '1');
    if (clone.tagName === 'LINK' && clone.getAttribute('href')) clone.href = absUrl(clone.getAttribute('href'));
    doc.head.append(clone);
  }
  applyTheme(doc);
}

function watchTheme(doc, win) {
  const sync = () => { if (!win || win.closed) return; applyTheme(doc); };
  const mo = new MutationObserver(sync);
  mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'class', 'style'] });
  window.addEventListener('prefs', sync);
  const stop = () => { mo.disconnect(); window.removeEventListener('prefs', sync); };
  win.addEventListener('pagehide', stop);
}

async function startCallFor(conv, kind) {
  try {
    const cm = await import('./messages/call.js');
    await cm.startCall(conv.id, kind, conv.title);
  } catch (e) {
    if (e.data && e.data.upgrade) toast(e.message, { icon: 'zap', action: { label: 'Upgrade', run: () => navigate('/upgrade') } });
    else toastErr(e);
  }
}

function startMeetingFor(conv) {
  const name = conv.type === 'dm' && state.user
    ? `${state.user.displayName} & ${conv.title}`
    : (conv.title || 'Meeting');
  sessionStorage.setItem('venue.intent', JSON.stringify({ create: true, name, thread: conv.id }));
  navigate('/new');
}

export async function popOut() {
  if (!pipSupported()) {
    toast('Picture-in-picture for the whole app needs Chrome or Edge on a computer. You can still pop out a meeting or a single chat from inside the room or Messages.', { icon: 'pip' });
    return;
  }
  try {
    if (window.documentPictureInPicture.window) {
      window.documentPictureInPicture.window.close();
    }
    const win = await window.documentPictureInPicture.requestWindow({ width: 380, height: 640, disallowReturnToOpener: false });
    copyStyles(win.document);
    win.document.title = '1venue';
    watchTheme(win.document, win);
    const root = h('div', { class: 'app-pip' });
    win.document.body.append(root);
    let current = 'chats';
    let sub = null; // { type: 'compose' } | { type: 'thread', id }
    const tab = (id) => { if (id) { current = id; sub = null; } return current; };
    const body = h('div', { class: 'app-pip-body' });

    function plusAction() {
      if (current === 'meeting') {
        openInstantOverlay();
        return;
      }
      current = 'chats';
      sub = { type: 'compose' };
      paint();
    }

    function tabBtn(id, label, ic) {
      return h('button', { class: 'pip-tab' + (current === id && !sub ? ' on' : ''), type: 'button', onclick: () => { tab(id); paint(); } },
        h('span', { html: icon(ic, { size: 16 }) }), label);
    }

    async function chatsView() {
      const wrap = h('div', { class: 'app-pip-list col' }, h('div', { class: 'tiny muted', style: { padding: '.8rem' } }, 'Loading chats…'));
      try {
        const r = await api('/api/messages/conversations').catch(() => api('/api/conversations').catch(() => ({ conversations: [] })));
        const list = r.conversations || r.threads || r.items || [];
        if (!list.length) {
          wrap.replaceChildren(
            h('p', { class: 'muted', style: { padding: '.8rem' } }, 'No chats yet. Tap + to start a message.'),
          );
          return wrap;
        }
        wrap.replaceChildren(...list.slice(0, 40).map((c) => {
          const title = c.title || c.name || (c.other && c.other.displayName) || 'Chat';
          const preview = c.lastPreview || c.preview || c.lastText || '';
          return h('button', { class: 'app-pip-row', type: 'button', onclick: () => { sub = { type: 'thread', id: c.id }; paint(); } },
            h('b', { class: 'ellipsis' }, title), h('div', { class: 'tiny muted ellipsis' }, preview));
        }));
      } catch { wrap.replaceChildren(h('p', { class: 'muted', style: { padding: '.8rem' } }, 'Could not load chats.')); }
      return wrap;
    }

    function composeView() {
      const input = h('input', { class: 'input', type: 'text', placeholder: 'Username or email', autocomplete: 'off', autocapitalize: 'none', spellcheck: 'false', 'aria-label': 'Username or email' });
      const sugg = h('div', { class: 'app-pip-sugg' });
      const status = h('p', { class: 'tiny muted', style: { margin: '0.4rem 0 0' } });
      const go = async (handle) => {
        const v = String(handle || input.value).trim();
        if (!v) return;
        btn.disabled = true;
        status.textContent = '';
        try {
          const r = await api('/api/messages/new', { method: 'POST', body: { handle: v } });
          const id = r.conversation && r.conversation.id;
          if (!id) throw new Error('Could not start that chat');
          sub = { type: 'thread', id };
          await paint();
        } catch (e) {
          btn.disabled = false;
          status.textContent = (e && e.message) || 'Could not start that chat';
        }
      };
      const btn = h('button', { class: 'btn primary', type: 'button', onclick: () => go() }, 'Start chat');
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); go(); } });
      input.addEventListener('input', debounce(async () => {
        const q = input.value.trim().replace(/^@/, '');
        if (q.length < 2 || q.includes('@')) { sugg.replaceChildren(); return; }
        try {
          const r = await api(`/api/users/search?q=${encodeURIComponent(q)}`);
          const users = (r.users || r.results || []).filter((u) => !state.user || u.id !== state.user.id).slice(0, 6);
          sugg.replaceChildren(...users.map((u) => h('button', { class: 'app-pip-row', type: 'button', onclick: () => go(u.username) },
            avatar(u.displayName || u.display_name || u.username, u.avatarUrl || u.avatar_url, 'sm'),
            h('span', { class: 'grow ellipsis' }, u.displayName || u.display_name || u.username),
            h('span', { class: 'tiny muted' }, '@' + u.username))));
        } catch { sugg.replaceChildren(); }
      }, 220));
      return h('div', { class: 'app-pip-compose col' },
        h('div', { class: 'app-pip-thread-head' },
          h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Back', onclick: () => { sub = null; paint(); }, html: icon('chevronLeft', { size: 20 }) }),
          h('b', { class: 'ellipsis' }, 'New message')),
        h('div', { class: 'col', style: { gap: '.55rem', padding: '.8rem' } },
          h('p', { class: 'small muted', style: { margin: 0 } }, 'Message anyone on 1venue, even if you haven’t met in a meeting.'),
          input, sugg, btn, status));
    }

    async function threadView(id) {
      const wrap = h('div', { class: 'app-pip-thread col' }, h('p', { class: 'muted', style: { padding: '.8rem' } }, 'Loading…'));
      try {
        const detail = await api(`/api/messages/conversations/${id}`);
        const c = detail.conversation || detail;
        const msgsRes = await api(`/api/messages/conversations/${id}/messages?limit=40`).catch(() => ({ messages: [] }));
        const messages = msgsRes.messages || [];
        const canCall = !!(c.canSend && c.type !== 'meeting');
        const canMeet = !!(c.canSend && c.editable);
        const head = h('div', { class: 'app-pip-thread-head' },
          h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Back to chats', onclick: () => { sub = null; paint(); }, html: icon('chevronLeft', { size: 20 }) }),
          h('b', { class: 'ellipsis grow' }, c.title || 'Chat'),
          canCall ? h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Start a call', 'data-tip': 'Start a call', onclick: () => startCallFor(c, 'audio'), html: icon('phone', { size: 18 }) }) : null,
          canCall && c.type === 'dm' ? h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Start a video call', 'data-tip': 'Start a video call', onclick: () => startCallFor(c, 'video'), html: icon('video', { size: 18 }) }) : null,
          canMeet ? h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Start a meeting', 'data-tip': 'Start a meeting', onclick: () => startMeetingFor(c), html: icon('calendarPlus', { size: 18 }) }) : null,
        );
        const acts = (canCall || canMeet)
          ? h('div', { class: 'app-pip-acts' },
            canCall ? h('button', { class: 'btn sm', type: 'button', onclick: () => startCallFor(c, 'audio') }, 'Call') : null,
            canCall && c.type === 'dm' ? h('button', { class: 'btn sm', type: 'button', onclick: () => startCallFor(c, 'video') }, 'Video') : null,
            canMeet ? h('button', { class: 'btn sm primary', type: 'button', onclick: () => startMeetingFor(c) }, 'Meeting') : null)
          : null;
        const list = h('div', { class: 'app-pip-msgs' },
          messages.length
            ? messages.map((m) => h('div', { class: 'app-pip-msg' + (m.mine ? ' mine' : '') },
              m.mine ? null : h('div', { class: 'tiny muted' }, m.fromName || ''),
              m.text ? h('div', { class: 'app-pip-bubble', html: linkify(m.text, { siteBase: (state.config && state.config.publicUrl) || location.origin }) }) : h('div', { class: 'tiny muted' }, m.attachment ? 'Attachment' : (m.kind === 'card' ? (m.payload && m.payload.title) || 'Card' : ''))))
            : h('p', { class: 'muted tiny', style: { padding: '.5rem' } }, 'No messages yet.'));
        let foot = null;
        if (c.canSend) {
          const ta = h('textarea', { class: 'input', rows: 2, maxlength: 4000, placeholder: 'Message', 'aria-label': 'Message' });
          const send = async () => {
            const text = ta.value.trim();
            if (!text) return;
            sendBtn.disabled = true;
            try {
              await api(`/api/messages/conversations/${c.id}/messages`, { method: 'POST', body: { text } });
              ta.value = '';
              sub = { type: 'thread', id: c.id };
              await paint();
            } catch (e) { toastErr(e); sendBtn.disabled = false; }
          };
          const sendBtn = h('button', { class: 'btn primary sm', type: 'button', onclick: send }, 'Send');
          ta.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } });
          foot = h('div', { class: 'app-pip-foot' }, ta, sendBtn);
        } else if (c.reason) {
          foot = h('p', { class: 'tiny muted', style: { padding: '.6rem .8rem' } }, c.reason);
        }
        wrap.replaceChildren(head, acts || '', list, foot || '');
        list.scrollTop = list.scrollHeight;
      } catch (e) {
        wrap.replaceChildren(
          h('div', { class: 'app-pip-thread-head' },
            h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Back', onclick: () => { sub = null; paint(); }, html: icon('chevronLeft', { size: 20 }) }),
            h('b', null, 'Chat')),
          h('p', { class: 'muted', style: { padding: '.8rem' } }, (e && e.message) || 'Could not open this chat.'),
        );
      }
      return wrap;
    }

    function meetingView() {
      const start = h('button', { class: 'btn primary', type: 'button', onclick: () => openInstantOverlay() }, 'Start instant meeting');
      if (!state.inRoom) {
        return h('div', { class: 'col', style: { gap: '.6rem', padding: '.8rem' } },
          h('p', { class: 'muted' }, 'You are not in a meeting. Start one now, or join from the main window. This tab will then show who is in the room.'),
          start);
      }
      const names = (state.roomPeople || []).map((p) => p.name).filter(Boolean);
      return h('div', { class: 'col', style: { gap: '.5rem', padding: '.8rem' } },
        h('b', null, 'In the meeting'),
        names.length ? h('ul', { class: 'app-pip-people' }, ...names.map((n) => h('li', null, n))) : h('p', { class: 'muted' }, 'The meeting is open in the main window.'),
        h('p', { class: 'tiny muted' }, 'Video stays in the main window so this pop-out can stay on top of your other work.'),
        start);
    }

    async function notifyView() {
      const wrap = h('div', { class: 'col', style: { gap: '.4rem', padding: '.8rem' } }, h('p', { class: 'muted' }, 'Loading…'));
      try {
        const r = await api('/api/messages/notification').catch(() => api('/api/notify/inbox').catch(() => null));
        const msgs = (r && (r.messages || r.items)) || [];
        if (!msgs.length) {
          wrap.replaceChildren(
            h('p', { class: 'muted' }, 'Open your chat with Notification for the latest messages.'),
            h('button', { class: 'btn sm', type: 'button', onclick: () => { win.close(); navigate('/messages'); } }, 'Open Messages')
          );
          return wrap;
        }
        wrap.replaceChildren(...msgs.slice(0, 15).map((m) => h('div', { class: 'app-pip-row' },
          h('div', { class: 'tiny muted' }, m.at || ''),
          h('div', { html: linkify(m.text || m.body || '', { siteBase: (state.config && state.config.publicUrl) || location.origin }) }))));
      } catch { wrap.replaceChildren(h('p', { class: 'muted' }, 'Could not load notifications.')); }
      return wrap;
    }

    async function paint() {
      const plusLabel = current === 'meeting' ? 'Start instant meeting' : 'New message';
      const bar = h('div', { class: 'app-pip-bar' },
        h('div', { class: 'app-pip-tabs' },
          tabBtn('chats', 'Chats', 'messages'),
          tabBtn('meeting', 'Meeting', 'video'),
          tabBtn('notifications', 'Notifications', 'bell')),
        h('button', { class: 'icon-btn pip-plus', type: 'button', 'aria-label': plusLabel, 'data-tip': plusLabel, onclick: plusAction, html: icon('plus', { size: 18 }) }));
      body.replaceChildren(h('div', { class: 'tiny muted', style: { padding: '.8rem' } }, 'Loading…'));
      root.replaceChildren(bar, body);
      let view;
      if (sub && sub.type === 'compose') view = composeView();
      else if (sub && sub.type === 'thread') view = await threadView(sub.id);
      else if (current === 'meeting') view = meetingView();
      else if (current === 'notifications') view = await notifyView();
      else view = await chatsView();
      body.replaceChildren(view);
    }
    await paint();
  } catch (e) {
    toast(e.message || 'Could not pop out 1venue', { icon: 'alert' });
  }
}
