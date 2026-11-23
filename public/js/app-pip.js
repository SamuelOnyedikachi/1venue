/**
 * App-wide fullscreen and Document Picture-in-Picture. The PiP window stays on top of other
 * apps in Chrome and Edge on desktop. It follows the site theme (light/dark and accent), and
 * can start a chat, an instant meeting, or a call from a conversation.
 */
import { h, api, toast, toastErr, avatar, debounce, linkify, uploadFile, esc, timeAgo } from './ui.js';
import { icon } from './icons.js';
import { state, navigate, openInstantOverlay } from './app.js';
import { verifiedDot } from './components.js';
import { pillComposer } from './composer.js';
import { bus, setPipConversation, typing as sendTyping, refreshUnread } from './messages/live.js';

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
  dst.style.height = '100%';
  const scheme = dst.dataset.theme === 'dark' ? 'dark' : 'light';
  if (!dst.style.getPropertyValue('color-scheme')) dst.style.setProperty('color-scheme', scheme);
  if (doc.body) {
    doc.body.className = document.body.className;
    doc.body.style.margin = '0';
    doc.body.style.height = '100%';
    doc.body.style.overflow = 'hidden';
    doc.body.style.display = 'flex';
    doc.body.style.flexDirection = 'column';
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

async function startCallFor(conv, kind, pipDoc) {
  try {
    const cm = await import('./messages/call.js');
    await cm.startCall(conv.id, kind, conv.title);
  } catch (e) {
    if (e.data && e.data.upgrade) {
      toast(e.message, { icon: 'zap', action: { label: 'Upgrade', run: () => {
        navigate('/upgrade');
        import('./bring-main.js').then((b) => b.bringMainToFront(pipDoc)).catch(() => {});
      } } });
    } else toastErr(e);
  }
}

function startMeetingFor(conv, pipDoc) {
  const name = conv.type === 'dm' && state.user
    ? `${state.user.displayName} & ${conv.title}`
    : (conv.title || 'Meeting');
  sessionStorage.setItem('venue.intent', JSON.stringify({ create: true, name, thread: conv.id }));
  import('./instant.js').then((m) => m.openInstant({ doc: pipDoc, name, thread: conv.id }))
    .catch(() => {
      navigate('/new');
      import('./bring-main.js').then((b) => b.bringMainToFront(pipDoc)).catch(() => {});
    });
}

function isNotifyConv(c) {
  const peer = c && (c.peer || c.other);
  const user = String((peer && (peer.username || peer.handle)) || '').replace(/^@/, '').toLowerCase();
  return !!(peer && (peer.system || peer.isSystem || peer.is_system)) || user === 'notification';
}
function pinFirst(list) {
  const pinned = [], rest = [];
  for (const c of list || []) (isNotifyConv(c) ? pinned : rest).push(c);
  return [...pinned, ...rest];
}
function pinMark(c) {
  if (!isNotifyConv(c)) return null;
  return h('span', { class: 'app-pip-pin', title: 'Pinned', 'aria-label': 'Pinned', html: icon('pin', { size: 12 }) });
}

function pipAvatar(name, url, cls = 'md') {
  return avatar(name, url ? absUrl(url) : null, cls);
}

function convAvatar(c, cls = 'md') {
  if (c.type === 'dm') return pipAvatar(c.title || (c.peer && c.peer.name) || 'Chat', c.avatarUrl || (c.peer && c.peer.avatarUrl), cls);
  const ic = c.type === 'meeting' ? 'video' : 'users';
  return h('span', { class: `av ${cls} msg-av-ic ${c.type || ''}`, html: icon(ic, { size: cls === 'sm' ? 14 : 20 }) });
}

function softBtn(ic, label, onclick, { on = false, size = 18 } = {}) {
  return h('button', {
    class: 'icon-btn pip-soft' + (on ? ' on' : ''), type: 'button',
    'aria-label': label, title: label, 'data-tip': label, onclick,
    html: icon(ic, { size }),
  });
}

function memberAv(c, userId, name) {
  const u = (c.members || []).find((m) => Number(m.id) === Number(userId));
  return pipAvatar((u && u.name) || name || '?', u && u.avatarUrl, 'sm');
}

function memberVerified(c, userId) {
  if (c.peer && Number(c.peer.id) === Number(userId)) return !!(c.peer.verified);
  return !!((c.members || []).find((m) => Number(m.id) === Number(userId)) || {}).verified;
}

function tokensOf(q) {
  return [...new Set(String(q || '').toLowerCase().match(/[\p{L}\p{N}]+/gu) || [])];
}

function hilite(s, q) {
  const t = String(s || '');
  const toks = tokensOf(q);
  if (!toks.length) return esc(t);
  const re = new RegExp('(' + toks.map((x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') + ')', 'gi');
  return esc(t).replace(re, '<mark>$1</mark>');
}

function matchesQuery(c, toks) {
  if (!toks.length) return true;
  const hay = `${c.title || ''} ${c.lastPreview || ''} ${(c.peer && (c.peer.username || c.peer.name || '')) || ''}`.toLowerCase();
  return toks.some((t) => hay.includes(t));
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
    let sub = null; // { type: 'compose' } | { type: 'thread', id, messageId? }
    const tab = (id) => { if (id) { current = id; sub = null; } return current; };
    const bar = h('div', { class: 'app-pip-bar' });
    const body = h('div', { class: 'app-pip-body' });
    root.append(bar, body);

    let convList = [];
    let thread = null; // { id, conv, msgs, msgsEl, typingEl, typing: Map, composer }
    const siteBase = (state.config && state.config.publicUrl) || location.origin;
    const offs = [];
    const on = (t, f) => { const g = (e) => f(e.detail); bus.addEventListener(t, g); offs.push(() => bus.removeEventListener(t, g)); };

    function syncActive() { setPipConversation(sub && sub.type === 'thread' ? sub.id : null); }

    function plusAction() {
      current = 'chats';
      sub = { type: 'compose' };
      paint();
    }

    function tabBtn(id, label, ic) {
      return h('button', {
        class: 'pip-tab pip-soft' + (current === id && !sub ? ' on' : ''),
        type: 'button', 'aria-label': label, title: label, 'data-tip': label,
        onclick: () => { tab(id); paint(); },
        html: icon(ic, { size: 18 }),
      });
    }

    function paintBar() {
      bar.replaceChildren(
        h('div', { class: 'app-pip-tabs' },
          tabBtn('chats', 'Chats', 'messages'),
          tabBtn('meeting', 'Meeting', 'video')),
        softBtn('plus', 'New message', plusAction, { size: 18 }),
      );
    }

    async function loadList() {
      try {
        const r = await api('/api/messages/conversations').catch(() => ({ conversations: [] }));
        convList = pinFirst(r.conversations || r.threads || r.items || []);
      } catch { /* keep previous */ }
    }

    function openThread(id, messageId) {
      sub = { type: 'thread', id, messageId: messageId || undefined };
      paint();
    }

    function rowEl(c) {
      const title = c.title || c.name || (c.other && c.other.displayName) || 'Chat';
      const preview = c.lastPreview || c.preview || c.lastText || '';
      const unread = Number(c.unread) || 0;
      return h('button', { class: 'app-pip-row' + (unread ? ' unread' : ''), type: 'button', onclick: () => openThread(c.id) },
        convAvatar(c, 'md'),
        h('div', { class: 'app-pip-row-main min-w-0 grow' },
          h('div', { class: 'app-pip-row-top' },
            h('span', { class: 'who-name' },
              h('b', { class: 'ellipsis' }, title),
              verifiedDot(c.peer, { title: 'Verified' }),
              pinMark(c)),
            c.lastMessageAt ? h('span', { class: 'tiny muted app-pip-when' }, timeAgo(c.lastMessageAt)) : null),
          h('div', { class: 'app-pip-row-sub' },
            h('span', { class: 'tiny muted ellipsis' }, preview || 'No messages yet'),
            unread ? h('em', { class: 'app-pip-count', 'aria-label': `${unread} unread` }, unread > 99 ? '99+' : String(unread)) : null)));
    }

    async function runSearch(q, hitsEl, listEl) {
      const term = String(q || '').trim();
      const toks = tokensOf(term);
      if (term.length < 2) {
        hitsEl.replaceChildren();
        hitsEl.hidden = true;
        listEl.hidden = false;
        listEl.replaceChildren(...(convList.length ? convList.slice(0, 60).map(rowEl) : [h('p', { class: 'muted', style: { padding: '.8rem' } }, 'No chats yet. Tap + to start a message.')]));
        return;
      }
      listEl.hidden = true;
      hitsEl.hidden = false;
      hitsEl.replaceChildren(h('p', { class: 'tiny muted', style: { padding: '.6rem .8rem' } }, 'Searching…'));
      const people = [];
      const chats = convList.filter((c) => matchesQuery(c, toks));
      let messages = [];
      try {
        const u = await api(`/api/users/search?q=${encodeURIComponent(term)}`).catch(() => ({ users: [] }));
        people.push(...((u.users || u.results || []).filter((x) => !state.user || x.id !== state.user.id).slice(0, 8)));
      } catch { /* ignore */ }
      try {
        const r = await api(`/api/messages/search?q=${encodeURIComponent(term)}`);
        messages = r.results || [];
      } catch { /* ignore */ }
      const out = [];
      const section = (label) => h('div', { class: 'app-pip-sec tiny muted' }, label);
      if (people.length) {
        out.push(section('People'));
        for (const u of people) {
          const name = u.name || u.displayName || u.display_name || u.username;
          out.push(h('button', { class: 'app-pip-row', type: 'button', onclick: async () => {
            try {
              const r = await api('/api/messages/new', { method: 'POST', body: { handle: u.username } });
              const id = r.conversation && r.conversation.id;
              if (id) openThread(id);
            } catch (e) { toastErr(e); }
          } },
            pipAvatar(name, u.avatarUrl || u.avatar_url, 'md'),
            h('div', { class: 'grow min-w-0' },
              h('div', { class: 'app-pip-row-top' }, h('span', { class: 'who-name' }, h('b', { class: 'ellipsis', html: hilite(name, term) }), verifiedDot(u, { title: 'Verified' }))),
              h('span', { class: 'tiny muted' }, u.username ? '@' + u.username : ''))));
        }
      }
      if (chats.length) {
        out.push(section('Chats'));
        out.push(...chats.slice(0, 12).map(rowEl));
      }
      if (messages.length) {
        out.push(section('Messages'));
        for (const r of messages.slice(0, 20)) {
          const m = r.message || {};
          const conv = convList.find((x) => Number(x.id) === Number(r.conversationId));
          const who = m.fromName || r.title || 'Message';
          const avUrl = (conv && conv.type === 'dm' && (conv.avatarUrl || (conv.peer && conv.peer.avatarUrl))) || null;
          const preview = m.text || (m.attachment ? (m.attachment.name || m.attachment.kind || 'Attachment') : '');
          out.push(h('button', { class: 'app-pip-row', type: 'button', onclick: () => openThread(r.conversationId, m.id) },
            pipAvatar(who, avUrl, 'md'),
            h('div', { class: 'grow min-w-0' },
              h('div', { class: 'app-pip-row-top' }, h('b', { class: 'ellipsis' }, r.title || who), h('span', { class: 'tiny muted' }, m.fromName && r.title ? m.fromName : '')),
              h('div', { class: 'tiny muted ellipsis', html: hilite(preview, term) }))));
        }
      }
      if (!out.length) hitsEl.replaceChildren(h('p', { class: 'muted', style: { padding: '.8rem' } }, 'No people or messages match.'));
      else hitsEl.replaceChildren(...out);
    }

    function chatsView() {
      const search = h('input', { class: 'input app-pip-search-in', type: 'search', placeholder: 'Search people and messages', 'aria-label': 'Search people and messages' });
      const hits = h('div', { class: 'app-pip-scroll app-pip-hits', hidden: true });
      const listEl = h('div', { class: 'app-pip-scroll' });
      listEl.replaceChildren(...(convList.length ? convList.slice(0, 60).map(rowEl) : [h('p', { class: 'muted', style: { padding: '.8rem' } }, 'No chats yet. Tap + to start a message.')]));
      const run = debounce(() => runSearch(search.value, hits, listEl), 220);
      search.addEventListener('input', run);
      return h('div', { class: 'app-pip-list' },
        h('div', { class: 'app-pip-search' }, h('span', { class: 'i', html: icon('search', { size: 16 }) }), search),
        hits, listEl);
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
          sugg.replaceChildren(...users.map((u) => {
            const name = u.displayName || u.display_name || u.name || u.username;
            return h('button', { class: 'app-pip-row', type: 'button', onclick: () => go(u.username) },
              pipAvatar(name, u.avatarUrl || u.avatar_url, 'sm'),
              h('span', { class: 'who-name grow' },
                h('span', { class: 'ellipsis' }, name),
                verifiedDot(u, { title: 'Verified' })),
              h('span', { class: 'tiny muted' }, '@' + u.username));
          }));
        } catch { sugg.replaceChildren(); }
      }, 220));
      return h('div', { class: 'app-pip-compose' },
        h('div', { class: 'app-pip-thread-head' },
          softBtn('chevronLeft', 'Back', () => { sub = null; paint(); }, { size: 20 }),
          h('b', { class: 'ellipsis grow' }, 'New message')),
        h('div', { class: 'app-pip-scroll', style: { padding: '.8rem' } },
          h('div', { class: 'col', style: { gap: '.55rem' } },
            h('p', { class: 'small muted', style: { margin: 0 } }, 'Message anyone on 1venue, even if you haven’t met in a meeting.'),
            input, sugg, btn, status)));
    }

    function attView(a) {
      if (!a) return null;
      const url = a.url ? absUrl(a.url) : '';
      if ((a.kind === 'image' || (a.mime || '').startsWith('image/')) && url) return h('img', { class: 'app-pip-att', src: url, alt: a.name || '' });
      if ((a.kind === 'voice' || (a.mime || '').startsWith('audio/')) && url) return h('audio', { class: 'app-pip-voice', controls: true, src: url, preload: 'metadata' });
      return h('div', { class: 'tiny muted' }, a.name || a.kind || 'Attachment');
    }

    function msgNode(c, m, prev) {
      if (m.kind === 'system' || m.kind === 'call') {
        return h('div', { class: 'app-pip-sys', 'data-id': m.id }, m.text || (m.kind === 'call' ? 'Call' : ''));
      }
      const grouped = !!(prev && prev.fromUserId === m.fromUserId && prev.kind !== 'system' && prev.kind !== 'call'
        && new Date(m.createdAt) - new Date(prev.createdAt) < 5 * 60000);
      const showName = !m.mine && c.type !== 'dm' && !grouped;
      const showAv = !m.mine && c.type !== 'dm';
      const bubble = h('div', { class: 'app-pip-bubble' },
        showName ? h('b', { class: 'app-pip-who' }, m.fromName || '', memberVerified(c, m.fromUserId) ? verifiedDot(true, { title: 'Verified' }) : null) : null,
        m.text ? h('div', { html: linkify(m.text, { siteBase }) }) : null,
        attView(m.attachment),
        !m.text && !m.attachment && m.kind === 'card' ? h('div', { class: 'tiny muted' }, (m.payload && m.payload.title) || 'Card') : null);
      return h('div', { class: 'app-pip-msg' + (m.mine ? ' mine' : '') + (grouped ? ' grouped' : ''), 'data-id': m.id },
        showAv ? (grouped ? h('span', { class: 'app-pip-av-gap' }) : memberAv(c, m.fromUserId, m.fromName)) : null,
        bubble);
    }

    function paintMsgs(th, { stick, jump } = {}) {
      const el = th.msgsEl;
      const atBottom = el.scrollHeight - el.clientHeight - el.scrollTop < 80;
      const out = [];
      if (!th.msgs.length) out.push(h('p', { class: 'muted tiny', style: { padding: '.5rem' } }, th.conv.type === 'dm' ? `Say hi to ${th.conv.title}` : 'No messages yet.'));
      let prev = null;
      for (const m of th.msgs) { out.push(msgNode(th.conv, m, prev)); prev = m; }
      el.replaceChildren(...out);
      if (jump) {
        const n = el.querySelector(`[data-id="${jump}"]`);
        if (n) { n.classList.add('app-pip-jump'); n.scrollIntoView({ block: 'center' }); }
      } else if (stick || atBottom) el.scrollTop = el.scrollHeight;
    }

    function paintThreadTyping(th) {
      for (const [k, v] of th.typing) if (Date.now() - v.at > 4000) th.typing.delete(k);
      const rec = [...th.typing.values()].filter((v) => v.state === 'recording');
      const typ = [...th.typing.values()].filter((v) => v.state !== 'recording');
      const who = (arr) => arr.slice(0, 2).map((v) => v.name).join(', ');
      const dm = th.conv.type === 'dm';
      const bits = [];
      if (rec.length) bits.push(dm ? 'recording voice…' : `${who(rec)} ${rec.length > 1 ? 'are' : 'is'} recording voice…`);
      if (typ.length) bits.push(dm ? 'typing…' : `${who(typ)} ${typ.length > 1 ? 'are' : 'is'} typing…`);
      th.typingEl.hidden = !bits.length;
      th.typingEl.textContent = bits.join(' ');
    }

    function markThreadRead(th) {
      if (!th || !th.msgs.length) return;
      const last = th.msgs[th.msgs.length - 1].id;
      api(`/api/messages/conversations/${th.conv.id}/read`, { method: 'POST', body: { messageId: last } }).then(() => {
        const c = convList.find((x) => Number(x.id) === Number(th.conv.id));
        if (c) c.unread = 0;
        refreshUnread();
      }).catch(() => {});
    }

    async function threadView(id, jumpId) {
      const wrap = h('div', { class: 'app-pip-thread' }, h('p', { class: 'muted', style: { padding: '.8rem' } }, 'Loading…'));
      try {
        const detail = await api(`/api/messages/conversations/${id}`);
        const c = detail.conversation || detail;
        const msgsRes = await api(`/api/messages/conversations/${id}/messages?limit=40`).catch(() => ({ messages: [] }));
        const msgs = msgsRes.messages || [];
        const canCall = !!(c.canSend && c.type !== 'meeting');
        const canMeet = !!(c.canSend && c.editable);
        const head = h('div', { class: 'app-pip-thread-head' },
          softBtn('chevronLeft', 'Back to chats', () => { sub = null; thread = null; paint(); }, { size: 20 }),
          convAvatar(c, 'sm'),
          h('div', { class: 'app-pip-head-name grow min-w-0' },
            h('span', { class: 'who-name' },
              h('b', { class: 'ellipsis' }, c.title || 'Chat'),
              verifiedDot(c.peer, { title: 'Verified' }))),
          canCall ? softBtn('phone', 'Start a call', () => startCallFor(c, 'audio', win.document)) : null,
          canCall && c.type === 'dm' ? softBtn('video', 'Start a video call', () => startCallFor(c, 'video', win.document)) : null,
          canMeet ? softBtn('calendarPlus', 'Start a meeting', () => startMeetingFor(c, win.document)) : null,
        );
        const msgsEl = h('div', { class: 'app-pip-msgs' });
        const typingEl = h('div', { class: 'app-pip-typing', hidden: true });
        let foot;
        const th = { id: c.id, conv: c, msgs, msgsEl, typingEl, typing: new Map(), composer: null };
        thread = th;
        if (c.canSend) {
          const limits = state.config && state.config.storage && state.config.storage.limits;
          th.composer = pillComposer({
            placeholder: c.type === 'dm' ? `Message ${c.title}` : 'Message',
            maxLength: 4000,
            voice: true,
            dictate: true,
            limits,
            upload: (f, purpose) => uploadFile(f, { purpose: purpose === 'voice' ? 'voice' : 'chat' }),
            onActivity: (st) => sendTyping(c.id, st === 'recording' ? 'recording' : 'typing'),
            onSend: async (text, att) => {
              await api(`/api/messages/conversations/${c.id}/messages`, { method: 'POST', body: { text, attachment: att || undefined } });
            },
          });
          foot = h('div', { class: 'app-pip-foot' }, th.composer.el);
        } else {
          foot = h('p', { class: 'tiny muted app-pip-foot', style: { padding: '.6rem .8rem' } }, c.reason || 'You can’t send messages here');
        }
        wrap.replaceChildren(head, msgsEl, typingEl, foot || '');
        paintMsgs(th, { stick: true, jump: jumpId });
        markThreadRead(th);
      } catch (e) {
        thread = null;
        wrap.replaceChildren(
          h('div', { class: 'app-pip-thread-head' },
            softBtn('chevronLeft', 'Back', () => { sub = null; paint(); }, { size: 20 }),
            h('b', null, 'Chat')),
          h('p', { class: 'muted', style: { padding: '.8rem' } }, (e && e.message) || 'Could not open this chat.'),
        );
      }
      return wrap;
    }

    function meetingView() {
      const start = h('button', { class: 'btn primary', type: 'button', onclick: () => openInstantOverlay({ doc: win.document }) }, 'Start instant meeting');
      if (!state.inRoom) {
        return h('div', { class: 'app-pip-meeting app-pip-scroll', style: { padding: '.8rem' } },
          h('div', { class: 'col', style: { gap: '.6rem' } },
            h('p', { class: 'muted' }, 'You are not in a meeting. Start one now, or join from the main window. This tab will then show who is in the room.'),
            start));
      }
      const names = (state.roomPeople || []).map((p) => p.name).filter(Boolean);
      return h('div', { class: 'app-pip-meeting app-pip-scroll', style: { padding: '.8rem' } },
        h('div', { class: 'col', style: { gap: '.5rem' } },
          h('b', null, 'In the meeting'),
          names.length ? h('ul', { class: 'app-pip-people' }, ...names.map((n) => h('li', null, n))) : h('p', { class: 'muted' }, 'The meeting is open in the main window.'),
          h('p', { class: 'tiny muted' }, 'Video stays in the main window so this pop-out can stay on top of your other work.'),
          start));
    }

    async function paint() {
      paintBar();
      if (!(sub && sub.type === 'thread')) thread = null;
      syncActive();
      body.replaceChildren(h('div', { class: 'tiny muted', style: { padding: '.8rem' } }, 'Loading…'));
      let view;
      if (sub && sub.type === 'compose') view = composeView();
      else if (sub && sub.type === 'thread') view = await threadView(sub.id, sub.messageId);
      else if (current === 'meeting') view = meetingView();
      else view = chatsView();
      body.replaceChildren(view);
    }

    function bumpList(m) {
      const preview = (m.message && (m.message.text || (m.message.attachment && (m.message.attachment.name || m.message.attachment.kind)))) || '';
      let c = convList.find((x) => Number(x.id) === Number(m.conversationId));
      const mine = m.message && state.user && Number(m.message.fromUserId) === Number(state.user.id);
      const open = thread && Number(thread.conv.id) === Number(m.conversationId);
      if (c) {
        c.lastPreview = preview || c.lastPreview;
        c.lastMessageAt = (m.message && m.message.createdAt) || new Date().toISOString();
        if (!mine && !open) c.unread = (Number(c.unread) || 0) + 1;
        if (open) c.unread = 0;
        convList = pinFirst([c, ...convList.filter((x) => x !== c)]);
      } else {
        loadList().then(() => { if (current === 'chats' && !sub) paint(); });
        return;
      }
      if (current === 'chats' && !sub) {
        const listEl = body.querySelector('.app-pip-list .app-pip-scroll:not(.app-pip-hits)');
        if (listEl && !listEl.hidden) listEl.replaceChildren(...convList.slice(0, 60).map(rowEl));
      }
    }

    on('message', (m) => {
      bumpList(m);
      if (thread && Number(m.conversationId) === Number(thread.conv.id) && m.message) {
        const mine = !!(state.user && Number(m.message.fromUserId) === Number(state.user.id));
        const msg = { ...m.message, mine: m.message.mine || mine };
        if (!thread.msgs.some((x) => x.id === msg.id)) thread.msgs.push(msg);
        thread.typing.delete(m.message.fromUserId);
        paintThreadTyping(thread);
        paintMsgs(thread, { stick: mine });
        markThreadRead(thread);
      }
    });
    on('message-edited', (m) => {
      if (!thread || Number(m.conversationId) !== Number(thread.conv.id) || !m.message) return;
      const i = thread.msgs.findIndex((x) => x.id === m.message.id);
      if (i >= 0) { thread.msgs[i] = { ...thread.msgs[i], ...m.message }; paintMsgs(thread, {}); }
    });
    on('message-deleted', (m) => {
      if (!thread || Number(m.conversationId) !== Number(thread.conv.id)) return;
      const row = thread.msgs.find((x) => x.id === m.messageId);
      if (row) { row.deleted = true; row.text = ''; row.attachment = null; paintMsgs(thread, {}); }
    });
    on('conversation-updated', () => { loadList().then(() => { if (current === 'chats' && !sub) paint(); }); });
    on('unread', () => { /* list badges come from bumpList / loadList */ });
    on('typing', (m) => {
      if (!thread || Number(m.conversationId) !== Number(thread.conv.id)) return;
      thread.typing.set(m.userId, { name: m.name, at: Date.now(), state: m.state === 'recording' ? 'recording' : 'typing' });
      paintThreadTyping(thread);
      setTimeout(() => thread && paintThreadTyping(thread), 4200);
    });
    on('open', () => { loadList().then(() => { if (current === 'chats' && !sub) paint(); }); });

    await loadList();
    await paint();
    import('./messages/tones.js').then((tn) => {
      if (!tn.unlockTones) return;
      win.addEventListener('pointerdown', tn.unlockTones, { capture: true });
      win.addEventListener('keydown', tn.unlockTones, { capture: true });
    }).catch(() => {});
    const syncCall = () => import('./messages/call.js').then((cm) => cm.placeAllCallUi && cm.placeAllCallUi()).catch(() => {});
    syncCall();
    const leave = () => {
      offs.forEach((f) => f());
      setPipConversation(null);
      syncCall();
    };
    win.addEventListener('pagehide', leave);
  } catch (e) {
    toast(e.message || 'Could not pop out 1venue', { icon: 'alert' });
  }
}
