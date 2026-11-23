/**
 * App-wide fullscreen and Document Picture-in-Picture. The PiP window stays on top of other
 * apps in Chrome and Edge on desktop. It shows Chats, the current Meeting, and Notifications.
 */
import { h, api, toast } from './ui.js';
import { icon } from './icons.js';
import { state, navigate } from './app.js';

export function pipSupported() {
  return typeof window !== 'undefined' && 'documentPictureInPicture' in window && window.top === window;
}

export async function toggleFullscreen() {
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else await document.documentElement.requestFullscreen({ navigationUI: 'hide' });
  } catch (e) { toast(e.message || 'Fullscreen is not available', { icon: 'alert' }); }
}

function copyStyles(dest) {
  for (const node of document.querySelectorAll('link[rel="stylesheet"], style')) {
    dest.head.append(node.cloneNode(true));
  }
}

function tabBtn(id, label, ic, tab, paint) {
  return h('button', { class: 'pip-tab' + (tab() === id ? ' on' : ''), type: 'button', onclick: () => { tab(id); paint(); } },
    h('span', { html: icon(ic, { size: 16 }) }), label);
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
    const root = h('div', { class: 'app-pip' });
    win.document.body.className = document.body.className;
    win.document.body.append(root);
    let current = 'chats';
    const tab = (id) => { if (id) current = id; return current; };
    const body = h('div', { class: 'app-pip-body' });

    async function chatsView() {
      const wrap = h('div', { class: 'app-pip-list col', style: { gap: '.4rem' } }, h('div', { class: 'tiny muted' }, 'Loading chats…'));
      try {
        const r = await api('/api/messages/conversations').catch(() => api('/api/conversations').catch(() => ({ conversations: [] })));
        const list = r.conversations || r.threads || r.items || [];
        if (!list.length) { wrap.replaceChildren(h('p', { class: 'muted' }, 'No chats yet. Open Messages in the main window to start one.')); return wrap; }
        wrap.replaceChildren(...list.slice(0, 20).map((c) => {
          const title = c.title || c.name || (c.other && c.other.displayName) || 'Chat';
          return h('button', { class: 'app-pip-row', type: 'button', onclick: () => { win.close(); navigate(c.id ? `/messages/${c.id}` : '/messages'); } },
            h('b', { class: 'ellipsis' }, title), h('div', { class: 'tiny muted ellipsis' }, c.preview || c.lastText || ''));
        }));
      } catch { wrap.replaceChildren(h('p', { class: 'muted' }, 'Could not load chats.')); }
      return wrap;
    }

    function meetingView() {
      if (!state.inRoom) return h('div', { class: 'col', style: { gap: '.5rem', padding: '.8rem' } },
        h('p', { class: 'muted' }, 'You are not in a meeting. Join one in the main window, then this tab will show who is in the room.'));
      const names = (state.roomPeople || []).map((p) => p.name).filter(Boolean);
      return h('div', { class: 'col', style: { gap: '.5rem', padding: '.8rem' } },
        h('b', null, 'In the meeting'),
        names.length ? h('ul', { class: 'app-pip-people' }, ...names.map((n) => h('li', null, n))) : h('p', { class: 'muted' }, 'The meeting is open in the main window.'),
        h('p', { class: 'tiny muted' }, 'Video stays in the main window so this pop-out can stay on top of your other work.'));
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
        wrap.replaceChildren(...msgs.slice(0, 15).map((m) => h('div', { class: 'app-pip-row' }, h('div', { class: 'tiny muted' }, m.at || ''), h('div', null, m.text || m.body || ''))));
      } catch { wrap.replaceChildren(h('p', { class: 'muted' }, 'Could not load notifications.')); }
      return wrap;
    }

    async function paint() {
      const tabs = h('div', { class: 'app-pip-tabs' },
        tabBtn('chats', 'Chats', 'messages', tab, paint),
        tabBtn('meeting', 'Meeting', 'video', tab, paint),
        tabBtn('notifications', 'Notifications', 'bell', tab, paint));
      body.replaceChildren(h('div', { class: 'tiny muted', style: { padding: '.8rem' } }, 'Loading…'));
      let view;
      if (current === 'meeting') view = meetingView();
      else if (current === 'notifications') view = await notifyView();
      else view = await chatsView();
      root.replaceChildren(tabs, body);
      body.replaceChildren(view);
    }
    await paint();
  } catch (e) {
    toast(e.message || 'Could not pop out 1venue', { icon: 'alert' });
  }
}
