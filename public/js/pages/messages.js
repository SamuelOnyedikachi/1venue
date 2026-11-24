// Messages: DMs, groups and meeting chats in one inbox (/messages, /messages/:id, /messages/new?user=ID).
// Desktop: list + thread side by side. Phone: one pane at a time; the thread hides the bottom nav.
import { h, esc, api, toast, toastErr, avatar, timeAgo, fmtDate, menu, sheet, confirmDlg, promptDlg, uploadFile, copy, isMobile, debounce, linkify as linkifyText } from '../ui.js';
import { icon } from '../icons.js';
import { pillComposer } from '../composer.js';
import { isVoiceAtt, pickVoiceAtt, voicePlayer } from '../voice-player.js';
import { QUICK, emojiPopover } from '../emoji.js';
import { passageCard } from '../passage.js';
import { state, navigate } from '../app.js';
import { barVisible } from '../commands.js';
import { bus, setActiveConversation, refreshUnread, typing as sendTyping, pushState, enablePush, disablePush } from '../messages/live.js';
import { toneMuted, setToneMuted, playMessageTone } from '../messages/tones.js';
import { openMini } from '../messages/mini.js';
import { safeText, safeList, put, add } from '../safe-text.js';

const I = (n, s = 18) => h('span', { class: 'i', html: icon(n, { size: s }) });
const vMark = (on) => on ? h('span', { class: 'verified-dot', title: 'Verified', 'aria-label': 'Verified', html: icon('check', { size: 11 }) }) : null;
const ib = (ic, label, run, cls = '') => h('button', { class: `icon-btn ${cls}`, type: 'button', 'aria-label': label, 'data-tip': label, onclick: run, html: icon(ic, { size: 20 }) });
const siteBase = () => String((state.config && state.config.publicUrl) || (typeof location !== 'undefined' ? location.origin : '') || '').replace(/\/$/, '');
const siteHref = (path) => {
  if (!path) return path;
  if (/^https?:\/\//i.test(path)) return path;
  return siteBase() + (path.startsWith('/') ? path : '/' + path);
};
const linkify = (s) => linkifyText(s, { siteBase: siteBase() });
const hhmm = (t) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const dayKey = (t) => new Date(t).toDateString();
const dayLabel = (t) => { const d = new Date(t), now = new Date(); if (d.toDateString() === now.toDateString()) return 'Today'; const y = new Date(now); y.setDate(now.getDate() - 1); if (d.toDateString() === y.toDateString()) return 'Yesterday'; return d.toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' }); };
const EDIT_MS = 15 * 60000;
// Cooby-style inbox tabs, plus a type filter (All / Direct / Groups / Meetings).
const TABS = [['inbox', 'Inbox', 'inbox'], ['unread', 'Unread', 'mail'], ['starred', 'Starred', 'star'], ['followup', 'Follow up', 'flag'], ['snoozed', 'Snoozed', 'clock'], ['closed', 'Closed', 'checkCircle'], ['archived', 'Archived', 'archive']];
const TYPES = [['all', 'All chats'], ['dm', 'Direct'], ['groups', 'Groups'], ['meetings', 'Meetings']];
const LABEL_COLORS = ['#7c5cff', '#22c55e', '#f59e0b', '#ef4444', '#06b6d4', '#ec4899', '#64748b'];
const DOC_EXT = /\.(pdf|docx?|pptx?|csv|tsv|xlsx?)$/i;
const SHEET_EXT = /\.(csv|tsv|xlsx?)$/i;
const isBoardFile = (a) => !!a && (a.kind === 'board' || /\.mwb$/i.test(a.name || '') || a.mime === 'application/x-mwb');
const openBoardFile = (a) => navigate(`/whiteboard?open=${encodeURIComponent(a.url)}&name=${encodeURIComponent(a.name || 'board.mwb')}`);
/** A shared 1venue whiteboard (.mwb): page-1 preview when the sender's browser made one, opens in the whiteboard. */
function boardCard(a) {
  const title = String(a.name || 'Whiteboard').replace(/\.mwb$/i, '');
  const pages = Math.max(1, Number(a.pages) || 1);
  return h('button', { class: 'msg-board', type: 'button', 'aria-label': `Open whiteboard ${title}`, onclick: () => openBoardFile(a) },
    a.preview ? h('img', { class: 'msg-board-img', src: a.preview, alt: '', loading: 'lazy' }) : h('span', { class: 'msg-board-img empty', html: icon('board', { size: 34 }) }),
    h('span', { class: 'msg-board-meta' }, h('span', { class: 'msg-board-ic', html: icon('board', { size: 16 }) }),
      h('span', { class: 'msg-board-txt' }, h('b', { class: 'ellipsis' }, title), h('small', null, `Whiteboard · ${pages} page${pages === 1 ? '' : 's'}`)),
      h('span', { class: 'msg-board-open' }, 'Open')));
}
const dur = (sec) => (sec == null ? '-' : sec < 60 ? '<1m' : sec < 3600 ? `${Math.round(sec / 60)}m` : sec < 86400 ? `${Math.round(sec / 360) / 10}h` : `${Math.round(sec / 8640) / 10}d`);
/** The Messages mark: a theme-accent chat bubble with a small send badge (adapted from the brand reference). */
export function brandMark(size = 40) {
  return h('span', { class: 'msg-brand', style: { width: size + 'px', height: size + 'px' }, html: `<svg viewBox="0 0 48 48" width="${size}" height="${size}" aria-hidden="true"><defs><linearGradient id="mbg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="var(--accent)"/><stop offset="1" stop-color="color-mix(in srgb, var(--accent) 70%, #000)"/></linearGradient></defs><path d="M24 5c10.5 0 19 7.4 19 16.6S34.5 38.2 24 38.2c-2.2 0-4.3-.3-6.3-.9L9 41.5l2.4-7.4C7.4 31 5 26.6 5 21.6 5 12.4 13.5 5 24 5Z" fill="url(#mbg)"/><rect x="14" y="16.5" width="20" height="3.2" rx="1.6" fill="#fff"/><rect x="14" y="23" width="13" height="3.2" rx="1.6" fill="#fff" opacity=".85"/><circle cx="38" cy="36" r="8.5" fill="var(--s1, #fff)"/><path d="m34.2 36.3 7.3-3.4-2.4 7.5-1.6-2.8z" fill="var(--accent)"/></svg>` });
}

export async function mount(view, params) {
  if (!state.user) { const e = new Error('Sign in'); e.status = 401; throw e; }
  document.body.dataset.page = 'messages';
  barVisible(false);
  if (params.id === 'new') {
    try { const r = await api('/api/messages/dm', { method: 'POST', body: { userId: Number(params.user) } }); navigate(`/messages/${r.conversation.id}`, { replace: true }); }
    catch (e) { toastErr(e); navigate('/messages', { replace: true }); }
    return { unmount: () => { barVisible(true); } };
  }
  const S = { tab: 'inbox', type: 'all', q: '', list: [], conv: null, msgs: [], hasMore: false, loadingOlder: false, typing: new Map(), editing: null,
    replyTo: null, pins: [], pinIdx: 0, panel: !isMobile() && localStorage.getItem('venue.msg.panel') !== '0', quick: null, found: null, sFrom: '', sHas: '' };
  const listEl = h('div', { class: 'msg-items', role: 'list' });
  const search = h('input', { class: 'msg-search-in', type: 'search', placeholder: 'Search chats and messages', 'aria-label': 'Search chats and messages', oninput: debounce(() => { S.q = search.value.trim().toLowerCase(); paintList(); searchMessages(); }, 220) });
  const filterBtn = h('button', { class: 'msg-search-filter', type: 'button', 'aria-label': 'Search filters', 'data-tip': 'Search filters', html: icon('sliders', { size: 18 }), onclick: (e) => searchFilters(e.currentTarget) });
  const searchBox = h('label', { class: 'msg-search' }, h('span', { class: 'i', html: icon('search', { size: 18 }) }), search, filterBtn);
  const chips = h('div', { class: 'msg-tabs', role: 'tablist', 'aria-label': 'Inbox' });
  const typeSel = h('select', { class: 'msg-type', 'aria-label': 'Chat type', onchange: () => { S.type = typeSel.value; loadList(); } }, TYPES.map(([v, l]) => h('option', { value: v }, l)));
  const listPane = h('section', { class: 'msg-pane-list', 'aria-label': 'Chats' },
    h('header', { class: 'msg-list-head' }, brandMark(34), h('h1', null, 'Messages'), h('div', { class: 'grow' }),
      ib('plus', 'New chat', newChat, 'msg-new'), ib('users', 'New group', newGroup), ib('settings', 'Message settings', settings)),
    searchBox, h('div', { class: 'msg-tabs-row' }, chips, typeSel), listEl);
  const threadPane = h('section', { class: 'msg-pane-thread', 'aria-label': 'Conversation' });
  const sidePane = h('aside', { class: 'msg-pane-side', 'aria-label': 'Contact details', hidden: true });
  const root = h('div', { class: 'page-messages' }, listPane, threadPane, sidePane);
  add(view, root);

  // ------------------------------------------------------------- list
  function paintChips() {
    const counts = { unread: S.list.filter((c) => c.unread).length };
    put(chips, ...TABS.map(([k, l, ic]) => h('button', { class: `msg-tab${S.tab === k ? ' on' : ''}`, type: 'button', role: 'tab', 'aria-selected': String(S.tab === k), onclick: () => { S.tab = k; loadList(); } },
      h('span', { class: 'i', html: icon(ic, { size: 15 }) }), l, k === 'unread' && S.tab !== 'unread' && counts.unread ? h('em', null, String(counts.unread)) : null)));
  }
  async function loadList() {
    paintChips();
    const qs = S.tab === 'archived' ? `filter=all&archived=1&type=${S.type}` : `filter=${S.tab}&type=${S.type}`;
    try { S.list = (await api(`/api/messages/conversations?${qs}`)).conversations; } catch (e) { toastErr(e); }
    paintList(); paintChips();
  }
  function rowEl(c) {
    const sub = c.type === 'meeting' ? (c.live ? 'Live now' : 'Meeting') : c.type === 'group' ? `${c.memberCount} members` : '';
    const ic = c.type === 'meeting' ? 'video' : c.type === 'group' ? 'users' : null;
    const av = c.type === 'dm' ? avatar(c.title, c.avatarUrl, 'md') : h('span', { class: `av md msg-av-ic ${c.type}`, html: icon(ic, { size: 20 }) });
    return h('a', { class: `msg-item${S.conv && S.conv.id === c.id ? ' on' : ''}${c.unread ? ' unread' : ''}`, href: `/messages/${c.id}`, 'data-link': '', role: 'listitem' },
      av,
      h('span', { class: 'msg-item-main' },
        h('span', { class: 'msg-item-top' }, c.starred ? h('span', { class: 'msg-star', html: icon('star', { size: 13 }) }) : null, h('span', { class: 'msg-item-who who-name' }, h('b', { class: 'ellipsis' }, c.title), vMark(c.peer && c.peer.verified)),
          c.labels && c.labels.length ? h('span', { class: 'msg-labels' }, c.labels.slice(0, 2).map((l) => h('span', { class: 'msg-label', style: { '--lc': l.color } }, l.name)), c.labels.length > 2 ? h('span', { class: 'msg-label more' }, `+${c.labels.length - 2}`) : null) : null,
          c.pinned ? I('pin', 14) : null, c.muted ? I('volumeX', 14) : null, h('time', null, timeAgo(c.lastMessageAt))),
        h('span', { class: 'msg-item-bot' }, c.followUp ? h('span', { class: 'msg-flag', 'data-tip': 'Follow up', html: icon('flag', { size: 12 }) }) : null,
          c.snoozedUntil ? h('span', { class: 'msg-snz' }, I('clock', 12), fmtDate(c.snoozedUntil)) : null,
          h('span', { class: 'ellipsis' }, c.lastPreview || sub || 'No messages yet'), c.unread ? h('em', { class: 'msg-count' }, c.unread > 99 ? '99+' : String(c.unread)) : null)));
  }
  function highlightList() {
    const id = S.conv && S.conv.id;
    listEl.querySelectorAll('.msg-item').forEach((el) => {
      const href = el.getAttribute('href') || '';
      const mid = href.split('/').pop();
      const on = id != null && String(id) === String(mid);
      el.classList.toggle('on', on);
      if (on) el.classList.remove('unread');
    });
  }
  function paintList() {
    const rows = S.list.filter((c) => !S.q || c.title.toLowerCase().includes(S.q) || (c.lastPreview || '').toLowerCase().includes(S.q));
    const out = [];
    if (!rows.length && !(S.found && S.found.length)) out.push(listEmpty());
    else out.push(...rows.map(rowEl));
    if (S.q.length >= 2 && S.found) {
      out.push(h('div', { class: 'msg-sec' }, `Messages${S.sFrom || S.sHas ? ' · filtered' : ''}`));
      if (!S.found.length) out.push(h('p', { class: 'tiny muted msg-sec-empty' }, 'No messages match.'));
      for (const r of S.found.slice(0, 30)) out.push(h('a', { class: 'msg-hit', href: `/messages/${r.conversationId}?m=${r.message.id}`, 'data-link': '' },
        h('span', { class: 'msg-hit-top' }, h('b', { class: 'ellipsis' }, r.title), h('time', null, timeAgo(r.message.createdAt))),
        h('span', { class: 'msg-hit-txt', html: hilite(r.message.text || (r.message.attachment ? `📎 ${r.message.attachment.name || r.message.attachment.kind}` : ''), S.q) })));
    }
    put(listEl, ...out);
  }

  // ------------------------------------------------------------- thread
  const msgsEl = h('div', { class: 'msg-scroll', 'aria-live': 'polite' });
  const typingEl = h('div', { class: 'msg-typing', hidden: true });
  let composer = null;
  function empty() {
    sidePane.hidden = true; root.classList.remove('has-side');
    put(threadPane, h('div', { class: 'msg-empty' }, h('div', { class: 'msg-empty-art' }, brandMark(96)), h('h2', null, 'Your messages'),
      h('p', { class: 'muted' }, 'Pick a chat, or start one with anyone on 1venue by username or email.'),
      h('button', { class: 'btn primary', type: 'button', onclick: newChat }, I('plus', 16), 'Start a chat')));
  }
  function listEmpty() {
    const txt = S.q ? 'No chats match.' : { archived: 'Nothing archived.', starred: 'Star a chat to keep it here.', unread: 'You’re all caught up.', followup: 'Chats you mark “Follow up” show here.', snoozed: 'Snoozed chats wait here until their time.', closed: 'Closed chats show here. A new message reopens them.' }[S.tab];
    if (txt) return h('div', { class: 'msg-list-empty sm' }, I(TABS.find((t) => t[0] === S.tab)?.[2] || 'search', 26), h('p', null, txt));
    return h('div', { class: 'msg-list-empty' }, h('div', { class: 'msg-empty-art sm' }, brandMark(64)), h('b', null, 'No chats yet'), h('p', { class: 'muted small' }, 'Message someone by username or email, or chat in a meeting.'),
      h('button', { class: 'btn primary sm', type: 'button', onclick: newChat }, I('plus', 16), 'Start a chat'));
  }
  const hilite = (t, q) => { const e = esc(t || ''); if (!q) return e; const i = e.toLowerCase().indexOf(esc(q).toLowerCase()); return i < 0 ? e : `${e.slice(0, i)}<mark>${e.slice(i, i + esc(q).length)}</mark>${e.slice(i + esc(q).length)}`; };
  async function searchMessages() {
    if (S.q.length < 2) { S.found = null; return paintList(); }
    try { const r = await api(`/api/messages/search?q=${encodeURIComponent(S.q)}&from=${S.sFrom}&has=${S.sHas}`); S.found = r.results; } catch { S.found = []; }
    paintList();
  }
  function searchFilters(anchor) {
    const pick = (k, v) => { S[k] = S[k] === v ? '' : v; filterBtn.classList.toggle('on', !!(S.sFrom || S.sHas)); searchMessages(); };
    menu(anchor, [
      { label: `${S.sFrom === 'me' ? '✓ ' : ''}From me`, icon: 'user', run: () => pick('sFrom', 'me') },
      { label: `${S.sFrom === 'them' ? '✓ ' : ''}From others`, icon: 'users', run: () => pick('sFrom', 'them') },
      '-',
      { label: `${S.sHas === 'file' ? '✓ ' : ''}Has a file`, icon: 'file', run: () => pick('sHas', 'file') },
      { label: `${S.sHas === 'image' ? '✓ ' : ''}Has a photo`, icon: 'image', run: () => pick('sHas', 'image') },
      { label: `${S.sHas === 'voice' ? '✓ ' : ''}Has a voice note`, icon: 'mic', run: () => pick('sHas', 'voice') },
      { label: `${S.sHas === 'link' ? '✓ ' : ''}Has a link`, icon: 'link', run: () => pick('sHas', 'link') },
    ]);
    if (S.q.length < 2) toast('Type at least 2 characters to search messages', { icon: 'search' });
  }
  let openSeq = 0;
  async function open(id) {
    const seq = ++openSeq;
    root.classList.toggle('is-thread', !!id);
    document.querySelector('.bottomnav')?.classList.toggle('hidden', !!id && isMobile());
    if (!id) { S.conv = null; setActiveConversation(null); threadPane.classList.remove('is-loading'); empty(); highlightList(); return; }
    if (S.conv && Number(S.conv.id) === Number(id) && !new URLSearchParams(location.search).get('m') && !new URLSearchParams(location.search).get('call')) {
      highlightList();
      return;
    }
    const nextId = Number(id);
    listEl.querySelectorAll('.msg-item').forEach((el) => {
      const mid = (el.getAttribute('href') || '').split('/').pop();
      el.classList.toggle('on', String(mid) === String(nextId));
    });
    if (S.conv) threadPane.classList.add('is-loading');
    try {
      const [c, m] = await Promise.all([api(`/api/messages/conversations/${id}`), api(`/api/messages/conversations/${id}/messages?limit=50`)]);
      if (seq !== openSeq) return;
      S.conv = c.conversation; S.msgs = m.messages; S.hasMore = m.hasMore; S.hidden = m.hiddenBefore; S.typing.clear(); S.editing = null;
      S.replyTo = null; S.pins = c.conversation.pins || []; S.pinIdx = 0;
      await refreshInviteStatuses();
      if (seq !== openSeq) return;
    } catch (e) {
      if (seq !== openSeq) return;
      threadPane.classList.remove('is-loading');
      toastErr(e); navigate('/messages', { replace: true }); return;
    }
    setActiveConversation(S.conv.id);
    composer = null;
    paintThread(); highlightList(); markRead(); paintSide();
    threadPane.classList.remove('is-loading');
    const jump = Number(new URLSearchParams(location.search).get('m')); if (jump) jumpTo(jump);
    const callId = new URLSearchParams(location.search).get('call');
    if (callId) api('/api/messages/calls/current').then((r) => { const c2 = r.calls.find((x) => x.id === callId && x.state === 'ringing' && x.myState === 'invited'); if (c2) import('../messages/call.js').then((cm) => { const call = { ...c2, title: S.conv.title }; cm.incoming(call); if (new URLSearchParams(location.search).get('answer') === '1') cm.answerCall(call); }); }).catch(() => {});
  }
  function presenceText(c) {
    if (c.type !== 'dm') return c.type === 'meeting' ? (c.live ? 'Meeting chat · live' : 'Meeting chat · ended') : `${c.memberCount} members`;
    if (c.peer && c.peer.deleted) return 'Account deleted';
    if (!c.presence) return '';
    return c.presence.online ? 'Online' : c.presence.lastSeenAt ? `Last seen ${timeAgo(c.presence.lastSeenAt)}` : '';
  }
  async function maybeShowCallsOptIn(c, el) {
    if (!c || !c.peer || !c.peer.system || !el) return;
    try {
      const r = await api('/api/account/notifications');
      const calls = r.calls || {};
      if (calls.enabled) return;
      el.hidden = false;
      el.replaceChildren(
        h('div', { class: 'grow col', style: { gap: '.15rem', minWidth: 0 } },
          h('b', null, 'Allow voice calls'),
          h('span', { class: 'tiny muted' }, 'Notification can call you in the app when something needs a conversation.')),
        h('button', { class: 'btn sm primary', type: 'button', onclick: async () => {
          try {
            await api('/api/account/notifications', { method: 'PUT', body: { calls: { enabled: true, optOut: false } } });
            el.remove();
            toast('Voice calls allowed', { icon: 'phone' });
          } catch (e) { toastErr(e); }
        } }, 'Allow'));
    } catch { /* prefs unavailable */ }
  }
  function paintThread() {
    const c = S.conv;
    const back = h('a', { class: 'icon-btn msg-back', href: '/messages', 'data-link': '', 'aria-label': 'Back to chats', html: icon('chevronLeft', { size: 22 }) });
    const av = c.type === 'dm' ? avatar(c.title, c.avatarUrl, 'md') : h('span', { class: `av md msg-av-ic ${c.type}`, html: icon(c.type === 'meeting' ? 'video' : 'users', { size: 20 }) });
    const titleEl = h('span', { class: 'who-name' },
      c.type === 'dm' && c.peer && c.peer.username ? h('a', { href: `/u/${c.peer.username}`, 'data-link': '', class: 'ellipsis' }, c.title) : h('span', { class: 'ellipsis' }, c.title),
      vMark(c.peer && c.peer.verified));
    const canCall = c.canSend && c.type !== 'meeting';
    const head = h('header', { class: 'msg-thread-head' }, back, h('button', { class: 'msg-head-who', type: 'button', 'aria-label': 'Contact details', onclick: () => toggleSide() }, av,
      h('div', { class: 'msg-thread-title' }, h('b', { class: 'who-title' }, titleEl), h('span', { class: 'muted tiny msg-presence' }, presenceText(c)))),
      ib('star', c.starred ? 'Unstar' : 'Star', () => patch({ starred: !c.starred }, c.starred ? 'Unstarred' : 'Starred').then(paintThread), `msg-star-btn${c.starred ? ' on' : ''}`),
      ib('pip', 'Float this chat', () => {
        openMini(c.id).then((mode) => {
          if (mode === 'inline') toast('Always-on-top chat needs a browser with Picture-in-Picture support. This browser opened an in-page mini chat instead.', { icon: 'pip' });
        }).catch(toastErr);
      }, 'msg-pip-btn'),
      canCall ? ib('phone', 'Audio call', () => call('audio')) : null,
      canCall && c.type === 'dm' ? ib('video', 'Video call', () => call('video')) : null,
      c.canSend && c.editable ? ib('calendarPlus', 'Meet', (e) => meetMenu(e.currentTarget), 'msg-meet') : null,
      c.type === 'meeting' && c.live && c.meetingCode ? h('a', { class: 'btn sm primary', href: `/${c.meetingCode}`, 'data-link': '' }, 'Rejoin') : null,
      ib('info', 'Contact details', () => toggleSide(), 'msg-info-btn'),
      ib('moreV', 'More', (e) => moreMenu(e.currentTarget)));
    const foot = c.canSend ? h('div', { class: 'msg-foot' }, replyBar, composerEl()) : h('div', { class: 'msg-readonly' }, I(c.readOnly ? 'lock' : 'info', 16), h('span', null, c.reason || 'You can’t send messages here'));
    const callsOpt = h('div', { class: 'msg-calls-optin', hidden: true });
    put(threadPane, head, pinBar, msgsEl, typingEl, callsOpt, foot);
    paintPins(); paintReply();
    paintMsgs(true);
    maybeShowCallsOptIn(c, callsOpt);
  }
  function composerEl() {
    if (!composer) {
      composer = pillComposer({ placeholder: S.conv.type === 'dm' && !isMobile() ? `Message ${S.conv.title}` : 'Message', maxLength: 4000,
        dictate: true,
        upload: (f, purpose) => uploadFile(f, { purpose: purpose === 'voice' ? 'voice' : 'chat' }),
        suggest: quickSuggest,
        onActivity: (st) => { if (S.conv) sendTyping(S.conv.id, st === 'recording' ? 'recording' : 'typing'); },
        onSend: async (text, att) => {
          if (S.editing) { const id = S.editing; S.editing = null; await api(`/api/messages/conversations/${S.conv.id}/messages/${id}`, { method: 'PATCH', body: { text } }).then((r) => upsert(r.message)); return; }
          const r = await api(`/api/messages/conversations/${S.conv.id}/messages`, { method: 'POST', body: { text, attachment: att || undefined, replyToId: S.replyTo ? S.replyTo.id : undefined } });
          S.replyTo = null; paintReply();
          upsert(r.message, true);
        } });
      // Extra composer tools: quick replies and send-later, tucked into the pill.
      const pill = composer.el.querySelector('.wa-pill');
      if (pill) add(pill, h('button', { class: 'wa-ib msg-quick-btn', type: 'button', 'aria-label': 'Quick replies', 'data-tip': 'Quick replies (type /)', html: icon('quick', { size: 19 }), onclick: (e) => quickMenu(e.currentTarget) }),
        h('button', { class: 'wa-ib', type: 'button', 'aria-label': 'Send later', 'data-tip': 'Send later', html: icon('clock', { size: 19 }), onclick: () => sendLaterSheet() }));
    }
    return composer.el;
  }
  function upsert(m, scroll = false) {
    const i = S.msgs.findIndex((x) => x.id === m.id);
    if (i >= 0) S.msgs[i] = { ...S.msgs[i], ...m }; else S.msgs.push(m);
    paintMsgs(scroll);
  }
  const transcripts = new Map();
  const analyses = new Map(); // message id -> one-line summary, shown under the file once analysed
  function attEl(a, m) {
    if (!a) return null;
    if (a.kind === 'passage') return passageCard(a, { compact: true });
    const voice = pickVoiceAtt(a) || (isVoiceAtt(a) ? a : null);
    const src = (voice && (voice.url || voice.dataUrl || voice.href || voice.src)) || a.url || a.dataUrl;
    if (a.kind === 'image' || (a.mime || '').startsWith('image/')) return h('img', { class: 'msg-img', src: src || a.url || a.dataUrl, alt: a.name || 'image', loading: 'lazy', tabindex: '0' });
    if (voice) {
      const out = h('div', { class: 'msg-voice-wrap' }, voicePlayer({ ...voice, url: src || '' }, { doc: document, onAccent: !!(m && m.mine) }));
      const tx = transcripts.get(m && m.id);
      if (tx) add(out, h('div', { class: 'msg-transcript' }, I('fileText', 14), h('span', null, tx)));
      return out;
    }
    if (isBoardFile(a)) return boardCard(a);
    const card = h('a', { class: 'msg-file', href: src, target: '_blank', rel: 'noopener', download: a.name || 'file', html: icon(SHEET_EXT.test(a.name || '') ? 'grid' : 'file', { size: 18 }) + `<span>${esc(a.name || 'file')}</span>` });
    const done = m && analyses.get(m.id);
    if (!done) return card;
    // An analysis that was run from the ⋯ menu stays visible under the file (tap to open it again).
    return h('div', { class: 'msg-file-wrap' }, card, h('button', { class: 'msg-transcript msg-ai-inline', type: 'button', onclick: () => analyseFile(m) }, I('sparkles', 14), h('span', null, done)));
  }
  async function refreshInviteStatuses() {
    const ids = [...new Set((S.msgs || []).filter((m) => m.payload && m.payload.type === 'speaker_invite' && m.payload.inviteId).map((m) => m.payload.inviteId))];
    if (!ids.length) return false;
    try {
      const r = await api('/api/events/invites/mine');
      const map = Object.fromEntries((r.invites || []).map((i) => [Number(i.id), i.status]));
      let changed = false;
      for (const m of S.msgs) {
        if (m.payload && m.payload.type === 'speaker_invite') {
          const st = map[Number(m.payload.inviteId)];
          if (st && m.payload.status !== st) { m.payload = { ...m.payload, status: st }; changed = true; }
        }
      }
      return changed;
    } catch { return false; }
  }
  function markInviteStatus(inviteId, status) {
    for (const m of S.msgs || []) {
      if (m.payload && m.payload.type === 'speaker_invite' && Number(m.payload.inviteId) === Number(inviteId)) {
        m.payload = { ...m.payload, status };
      }
    }
    paintMsgs(false);
  }
  function cardEl(p) {
    if (!p) return null;
    if (p.type === 'speaker_invite') {
      const resolved = p.status === 'active' || p.status === 'accepted' || p.status === 'declined' || p.status === 'superseded';
      const comment = h('input', { class: 'input sm', placeholder: 'Comment to decline (required)', hidden: true });
      const act = async (action) => {
        try {
          if (action === 'decline' && !comment.value.trim()) { comment.hidden = false; comment.focus(); return toast('Add a short comment to decline', { icon: 'info' }); }
          await api(`/api/events/invites/${p.inviteId}/${action}`, { method: 'POST', body: action === 'decline' ? { comment: comment.value } : {} });
          toast(action === 'accept' ? 'Invite accepted' : action === 'report' ? 'Report sent' : 'Invite declined', { icon: 'check' });
          if (action === 'accept') markInviteStatus(p.inviteId, 'active');
          else if (action === 'decline') markInviteStatus(p.inviteId, 'declined');
        } catch (e) { toastErr(e); }
      };
      return h('div', { class: 'msg-card' }, h('span', { class: 'msg-card-ic', html: icon('stage', { size: 20 }) }),
        h('div', { class: 'msg-card-main' }, h('b', null, p.title || 'Speaker invite'), h('span', { class: 'tiny muted' }, [p.inviter, p.when && fmtDate(p.when)].filter(Boolean).join(' · ') || 'You’re invited to speak')),
        h('div', { class: 'col', style: { gap: '.35rem' } },
          p.slug ? h('a', { class: 'btn sm', href: `/e/${p.slug}`, 'data-link': '' }, 'Event') : null,
          resolved
            ? h('span', { class: 'chip tiny' }, p.status === 'declined' ? 'Declined' : p.status === 'superseded' ? 'Updated' : 'Accepted')
            : h('div', { class: 'row wrap', style: { gap: '.35rem' } },
              h('button', { class: 'btn sm primary', type: 'button', onclick: () => act('accept') }, 'Accept'),
              h('button', { class: 'btn sm', type: 'button', onclick: () => act('decline') }, 'Decline'),
              h('button', { class: 'btn sm ghost', type: 'button', onclick: () => act('report') }, 'Report')),
          resolved ? null : comment));
    }
    if (p.type === 'confirm') {
      const comment = h('input', { class: 'input sm', placeholder: 'Comment (required to decline)', hidden: !(p.action && p.action.action === 'decline_invite') });
      return h('div', { class: 'msg-card' }, h('span', { class: 'msg-card-ic', html: icon('check', { size: 20 }) }),
        h('div', { class: 'msg-card-main' }, h('b', null, p.title || 'Confirm'), h('span', { class: 'tiny muted' }, 'Notification wants your go-ahead')),
        h('div', { class: 'row wrap', style: { gap: '.35rem' } },
          h('button', { class: 'btn sm primary', type: 'button', onclick: async () => { try { await api('/api/notify/actions', { method: 'POST', body: { action: p.action, confirmed: true, comment: comment.value } }); toast('Done', { icon: 'check' }); } catch (e) { toastErr(e); } } }, 'Confirm'),
          h('button', { class: 'btn sm', type: 'button', onclick: () => toast('Okay, I won’t do that', { icon: 'info' }) }, 'Not now')),
        comment);
    }
    const ic = { meeting: 'video', schedule: 'calendar', venue: 'door', event: 'calendar', event_live: 'radio' }[p.type] || 'link';
    const when = p.type === 'schedule' ? `${fmtDate(p.startsAt)} · ${p.durationMin} min${p.pattern ? ` · repeats ${p.pattern === 'biweekly' ? 'every 2 weeks' : p.pattern}` : ''}` : p.type === 'meeting' ? 'Live meeting' : p.type === 'event_live' ? 'Live now' : p.type === 'event' ? (p.when ? fmtDate(p.when) : 'Event') : p.type === 'venue' ? 'Venue' : '';
    const href = p.link || (p.slug ? `/e/${p.slug}` : '');
    return h('div', { class: 'msg-card' }, h('span', { class: 'msg-card-ic', html: icon(ic, { size: 20 }) }),
      h('div', { class: 'msg-card-main' }, h('b', null, p.title || 'Meeting'), h('span', { class: 'tiny muted' }, when), p.type === 'schedule' && p.reminders ? h('span', { class: 'tiny muted' }, 'Email reminders are on') : null),
      href ? h('a', { class: 'btn sm primary', href, 'data-link': '' }, p.type === 'schedule' || p.type === 'event' ? 'Open' : 'Join') : null);
  }
  function msgEl(m, prev) {
    const c = S.conv;
    if (m.kind === 'system' || m.kind === 'call') return h('div', { class: `msg-sys${m.kind === 'call' ? ' call' : ''}` }, m.kind === 'call' ? I('phone', 14) : null, h('span', null, m.text), h('time', null, hhmm(m.createdAt)));
    const mine = m.mine;
    const grouped = prev && prev.fromUserId === m.fromUserId && prev.kind !== 'system' && prev.kind !== 'call' && new Date(m.createdAt) - new Date(prev.createdAt) < 5 * 60000;
    const showName = !mine && c.type !== 'dm' && !grouped;
    const body = m.deleted ? h('div', { class: 'msg-txt deleted' }, I('trash', 14), 'Message deleted')
      : h('div', null, m.payload && m.payload.forwarded ? h('span', { class: 'msg-fwd' }, I('forward', 12), 'Forwarded') : null,
        m.replyTo ? quoteEl(m.replyTo) : null,
        m.text ? h('div', { class: 'msg-txt', html: linkify(m.text) }) : null, attEl(m.attachment, m), m.kind === 'card' ? cardEl(m.payload) : null);
    const reacts = m.reactions && m.reactions.length ? h('div', { class: 'msg-reacts' }, m.reactions.map((r) => h('button', { type: 'button', class: `msg-react${r.mine ? ' on' : ''}`, 'aria-label': `${r.emoji} ${r.count}`, onclick: () => react(m, r.emoji), disabled: !c.canSend }, `${r.emoji} ${r.count}`))) : null;
    // Ticks: delivered (grey) until the other person has replied in this chat AND read it (accent).
    const read = mine && c.type === 'dm' && c.peerReplied && c.peerReadId >= m.id;
    const ticks = mine && !m.deleted ? h('span', { class: `msg-ticks${read ? ' read' : ''}`, 'aria-label': read ? 'Read' : c.type === 'dm' ? 'Delivered' : 'Sent', html: icon(c.type === 'dm' ? 'checkCheck' : 'check', { size: 15 }) }) : null;
    const seen = null;
    const pinned = S.pins.some((p) => p.id === m.id);
    const fromVerified = !!(c.peer && Number(c.peer.id) === Number(m.fromUserId) && c.peer.verified) || !!(c.members || []).find((u) => Number(u.id) === Number(m.fromUserId))?.verified;
    const bubble = h('div', { class: 'msg-bubble' }, showName ? h('b', { class: 'msg-who row', style: { alignItems: 'center', gap: '.2rem' } }, m.fromName, vMark(fromVerified)) : null, body,
      h('span', { class: 'msg-meta' }, pinned ? I('pin', 11) : null, m.payload && m.payload.scheduled ? I('clock', 11) : null, m.editedAt && !m.deleted ? 'edited · ' : '', hhmm(m.createdAt), ticks));
    const row = h('div', { class: `msg-row${mine ? ' mine' : ''}${grouped ? ' grouped' : ''}`, 'data-id': m.id },
      !mine && c.type !== 'dm' ? (grouped ? h('span', { class: 'msg-av-gap' }) : avatar(m.fromName, null, 'sm')) : null,
      h('div', { class: 'msg-col' }, bubble, reacts, seen),
      m.deleted ? null : h('div', { class: 'msg-hover' },
        c.canSend ? h('button', { class: 'icon-btn msg-hb', type: 'button', 'aria-label': 'Reply', 'data-tip': 'Reply', html: icon('reply', { size: 16 }), onclick: () => startReply(m) }) : null,
        c.canSend ? h('button', { class: 'icon-btn msg-hb', type: 'button', 'aria-label': 'React', 'data-tip': 'React', html: icon('smile', { size: 16 }), onclick: (e) => emojiPopover(e.currentTarget, (x) => react(m, x)) }) : null,
        h('button', { class: 'icon-btn msg-hb msg-more', type: 'button', 'aria-label': 'Message actions', 'data-tip': 'More', html: icon('moreHorizontal', { size: 16 }), onclick: (e) => msgMenu(e.currentTarget, m) })));
    // Phone: long-press for the menu, swipe right to reply (WhatsApp).
    let pressT = null, sx = 0, sy = 0, dx = 0, swiping = false;
    const bub = () => row.querySelector('.msg-col');
    row.addEventListener('touchstart', (e) => { sx = e.touches[0].clientX; sy = e.touches[0].clientY; dx = 0; swiping = false; pressT = setTimeout(() => !m.deleted && msgMenu(row.querySelector('.msg-bubble'), m), 450); }, { passive: true });
    row.addEventListener('touchmove', (e) => {
      clearTimeout(pressT);
      const x = e.touches[0].clientX - sx, y = e.touches[0].clientY - sy;
      if (!swiping && Math.abs(x) > 12 && Math.abs(x) > Math.abs(y) * 1.5 && x > 0 && c.canSend && !m.deleted) swiping = true;
      if (swiping) { dx = Math.min(80, Math.max(0, x)); bub().style.transform = `translateX(${dx}px)`; row.classList.toggle('swipe-ready', dx > 56); }
    }, { passive: true });
    row.addEventListener('touchend', () => {
      clearTimeout(pressT);
      if (swiping) { bub().style.transition = 'transform .18s'; bub().style.transform = ''; setTimeout(() => { if (bub()) bub().style.transition = ''; }, 200); row.classList.remove('swipe-ready'); if (dx > 56) { try { navigator.vibrate && navigator.vibrate(15); } catch { /* ignore */ } startReply(m); } }
      swiping = false;
    });
    return row;
  }
  const lastMineId = () => { for (let i = S.msgs.length - 1; i >= 0; i--) if (S.msgs[i].mine) return S.msgs[i].id; return 0; };
  function paintMsgs(scroll) {
    const stick = scroll || msgsEl.scrollHeight - msgsEl.clientHeight - msgsEl.scrollTop < 80;
    const out = [];
    if (S.hasMore) out.push(h('button', { class: 'btn sm ghost msg-older', type: 'button', onclick: older }, 'Load earlier messages'));
    else if (S.hidden) out.push(h('div', { class: 'msg-sys' }, h('span', null, 'Older messages are hidden on the Free plan. '), h('a', { href: '/upgrade', 'data-link': '' }, 'Upgrade to keep them')));
    if (!S.msgs.length) out.push(h('div', { class: 'msg-empty sm' }, h('p', { class: 'muted' }, S.conv.type === 'dm' ? `Say hi to ${S.conv.title} 👋` : 'No messages yet.')));
    let prev = null;
    for (const m of S.msgs) {
      if (!prev || dayKey(prev.createdAt) !== dayKey(m.createdAt)) { out.push(h('div', { class: 'msg-day' }, h('span', null, dayLabel(m.createdAt)))); prev = null; }
      out.push(msgEl(m, prev)); prev = m;
    }
    put(msgsEl, ...out);
    if (stick) {
      const go = () => { msgsEl.scrollTop = msgsEl.scrollHeight; };
      go();
      requestAnimationFrame(() => { go(); requestAnimationFrame(go); });
      msgsEl.querySelectorAll('img, audio, video').forEach((n) => {
        n.addEventListener('load', go, { once: true });
        n.addEventListener('loadedmetadata', go, { once: true });
      });
    }
  }
  async function older() {
    if (S.loadingOlder || !S.msgs.length) return;
    S.loadingOlder = true;
    try {
      const r = await api(`/api/messages/conversations/${S.conv.id}/messages?before=${S.msgs[0].id}&limit=50`);
      const h0 = msgsEl.scrollHeight;
      S.msgs = [...r.messages, ...S.msgs]; S.hasMore = r.hasMore; S.hidden = r.hiddenBefore;
      await refreshInviteStatuses();
      paintMsgs(false); msgsEl.scrollTop = msgsEl.scrollHeight - h0;
    } catch (e) { toastErr(e); } finally { S.loadingOlder = false; }
  }
  msgsEl.addEventListener('scroll', () => { if (msgsEl.scrollTop < 60 && S.hasMore) older(); }, { passive: true });
  let readT = null;
  function markRead() {
    clearTimeout(readT);
    readT = setTimeout(() => {
      if (!S.conv || document.visibilityState !== 'visible' || !S.msgs.length) return;
      const last = S.msgs[S.msgs.length - 1].id;
      api(`/api/messages/conversations/${S.conv.id}/read`, { method: 'POST', body: { messageId: last } }).then(() => { const c = S.list.find((x) => x.id === S.conv.id); if (c) { c.unread = 0; paintList(); } refreshUnread(); }).catch(() => {});
    }, 300);
  }
  async function react(m, emoji) {
    try { const r = await api(`/api/messages/conversations/${S.conv.id}/messages/${m.id}/reactions`, { method: 'POST', body: { emoji } }); if (r && r.reactions) upsert({ id: m.id, reactions: r.reactions }); } catch (e) { toastErr(e); }
  }
  function msgMenu(anchor, m) {
    const c = S.conv;
    const canEdit = m.mine && c.editable && m.kind === 'text' && m.text && Date.now() - new Date(m.createdAt) < EDIT_MS;
    const pinned = S.pins.some((p) => p.id === m.id);
    const a = m.attachment;
    const quick = c.canSend ? h('div', { class: 'msg-quick' }, QUICK.slice(0, 6).map((e) => h('button', { type: 'button', 'aria-label': `React ${e}`, onclick: () => { mm.remove(); react(m, e); } }, e))) : null;
    let mm = null;
    mm = menu(anchor, [
      c.canSend ? { label: 'Reply', icon: 'reply', run: () => startReply(m) } : null,
      c.canSend ? { label: 'React', icon: 'smile', run: () => emojiPopover(anchor, (e) => react(m, e)) } : null,
      c.canSend && c.editable && m.kind === 'text' ? { label: pinned ? 'Unpin' : 'Pin', icon: 'pin', run: () => togglePin(m, pinned) } : null,
      m.kind === 'text' ? { label: 'Forward', icon: 'forward', run: () => forwardSheet(m) } : null,
      a && a.url && DOC_EXT.test(a.name || '') ? { label: analyses.has(m.id) ? 'Show analysis' : 'Analyse with AI', icon: 'sparkles', group: 'ai', run: () => analyseFile(m) } : null,
      a && a.url && SHEET_EXT.test(a.name || '') ? { label: 'Make a chart', icon: 'chart', group: 'ai', run: () => chartFile(m) } : null,
      a && a.url && isBoardFile(a) ? { label: 'Open in whiteboard', icon: 'pen', group: 'content', run: () => openBoardFile(a) } : null,
      a && a.url && (a.kind === 'voice' || /^audio\//.test(a.mime || '')) && !transcripts.has(m.id) ? { label: 'Transcribe', icon: 'captions', group: 'ai', run: () => transcribe(m) } : null,
      m.text ? { label: 'Copy text', icon: 'copy', run: () => copy(m.text) } : null,
      canEdit && c.canSend ? { label: 'Edit', icon: 'pen', run: () => { S.editing = m.id; composer.setText(m.text); composer.focus(); toast('Editing - press Enter to save', { icon: 'pen' }); } } : null,
      m.mine && c.editable ? { label: 'Delete', icon: 'trash', group: 'admin', run: async () => { if (await confirmDlg('Delete this message for everyone?', { ok: 'Delete', danger: true })) api(`/api/messages/conversations/${c.id}/messages/${m.id}`, { method: 'DELETE' }).then(() => upsert({ id: m.id, deleted: true, text: '', attachment: null, payload: null })).catch(toastErr); } } : null,
      !m.mine && m.fromUserId ? { label: 'Report', icon: 'alert', group: 'admin', run: () => report(m) } : null,
    ], { header: quick });
  }
  async function report(m) {
    const reason = await promptDlg('Report this message', { placeholder: 'What’s wrong? (optional)', ok: 'Report', multiline: true });
    if (reason === null) return;
    try { await api('/api/messages/reports', { method: 'POST', body: { conversationId: S.conv.id, messageId: m ? m.id : undefined, reason } }); toast('Thanks. Our team will review it.', { icon: 'check' }); } catch (e) { toastErr(e); }
  }

  // ------------------------------------------------------------- thread actions
  async function call(kind) {
    try { const cm = await import('../messages/call.js'); await cm.startCall(S.conv.id, kind, S.conv.title); }
    catch (e) { if (e.data && e.data.upgrade) toast(e.message, { icon: 'zap', action: { label: 'Upgrade', run: () => navigate('/upgrade') } }); else toastErr(e); }
  }
  function meetMenu(anchor) {
    menu(anchor, [
      { label: 'Start a meeting now', icon: 'video', run: () => { sessionStorage.setItem('venue.intent', JSON.stringify({ create: true, name: S.conv.type === 'dm' ? `${state.user.displayName} & ${S.conv.title}` : S.conv.title, thread: S.conv.id })); navigate('/new'); } },
      { label: 'Schedule a meeting', icon: 'calendarPlus', run: scheduleSheet },
      { label: 'Share one of my venues', icon: 'door', run: venueSheet },
    ]);
  }
  function scheduleSheet() {
    const s = sheet({ title: 'Schedule a meeting', icon: 'calendarPlus' });
    const t = new Date(Date.now() + 3600000); t.setMinutes(0, 0, 0);
    const local = new Date(t.getTime() - t.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
    const title = h('input', { class: 'input', value: S.conv.type === 'dm' ? `Meeting with ${S.conv.title}` : `${S.conv.title} meeting` });
    const when = h('input', { class: 'input', type: 'datetime-local', value: local });
    const dur = h('select', { class: 'input' }, [15, 30, 45, 60, 90, 120].map((n) => h('option', { value: n, selected: n === 60 }, `${n} min`)));
    const rep = h('select', { class: 'input' }, h('option', { value: '' }, 'Does not repeat'), h('option', { value: 'weekly' }, 'Weekly'), h('option', { value: 'biweekly' }, 'Every 2 weeks'), h('option', { value: 'monthly' }, 'Monthly'));
    const go = h('button', { class: 'btn primary', type: 'button', onclick: async () => {
      go.disabled = true;
      try {
        const r = await api(`/api/messages/conversations/${S.conv.id}/schedule`, { method: 'POST', body: { title: title.value, startsAt: new Date(when.value).toISOString(), durationMin: Number(dur.value), pattern: rep.value || undefined, count: rep.value ? 8 : undefined } });
        s.close(); upsert(r.message, true); toast(r.reminders ? 'Scheduled. Everyone in this chat gets an email invite and reminders.' : 'Scheduled. Everyone in this chat gets an email invite.', { icon: 'calendar' });
      } catch (e) { go.disabled = false; if (e.data && e.data.upgrade) toast(e.message, { icon: 'zap', action: { label: 'Upgrade', run: () => navigate('/upgrade') } }); else toastErr(e); }
    } }, 'Schedule and post');
    const f = (l, el) => h('label', { class: 'field' }, h('span', { class: 'lbl' }, l), el);
    add(s.body, h('div', { class: 'stack' }, f('Title', title), f('Starts', when), f('Length', dur), f('Repeat', rep),
      h('p', { class: 'tiny muted' }, 'Members get the invite at the email on their account. Repeating meetings need Premium or Organisation.'), go));
  }
  async function venueSheet() {
    const s = sheet({ title: 'Share a venue', icon: 'door' });
    let vs = [];
    try { vs = (await api('/api/venues')).venues.filter((v) => !v.archived); } catch (e) { toastErr(e); }
    if (!vs.length) { add(s.body, h('p', { class: 'muted' }, 'You don’t have a venue yet. '), h('a', { class: 'btn', href: '/venues', 'data-link': '', onclick: () => s.close() }, 'Create a venue')); return; }
    add(s.body, h('div', { class: 'msg-pick' }, vs.map((v) => h('button', { class: 'msg-pick-row', type: 'button', onclick: async () => {
      try { const r = await api(`/api/messages/conversations/${S.conv.id}/cards`, { method: 'POST', body: { type: 'venue', venueId: v.id } }); s.close(); upsert(r.message, true); } catch (e) { toastErr(e); }
    } }, I('door', 18), h('span', { class: 'grow ellipsis' }, v.name), h('span', { class: 'tiny muted' }, `/v/${v.slug}`)))));
  }
  async function patch(body, msg) {
    try { const r = await api(`/api/messages/conversations/${S.conv.id}`, { method: 'PATCH', body }); Object.assign(S.conv, body, r && r.conversation ? { starred: r.conversation.starred, followUp: r.conversation.followUp, closed: r.conversation.closed, snoozedUntil: r.conversation.snoozedUntil, labels: r.conversation.labels } : {}); if (msg) toast(msg, { icon: 'check' }); loadList(); refreshUnread(); } catch (e) { toastErr(e); }
  }
  function moreMenu(anchor) {
    const c = S.conv; const group = c.type === 'group'; const admin = c.role === 'admin' || c.role === 'owner';
    menu(anchor, [
      c.canSend && c.editable && isMobile() ? { label: 'Meet', icon: 'calendarPlus', run: () => meetMenu(anchor) } : null,
      group ? { label: 'Members', icon: 'users', run: membersSheet } : null,
      group && admin && c.editable ? { label: 'Rename group', icon: 'pen', run: async () => { const t = await promptDlg('Group name', { value: c.title }); if (t) { await patch({ title: t }); S.conv.title = t; paintThread(); } } } : null,
      { label: c.pinned ? 'Unpin chat' : 'Pin chat to top', icon: 'pin', run: () => patch({ pinned: !c.pinned }) },
      { label: c.followUp ? 'Clear follow up' : 'Follow up', icon: 'flag', run: () => patch({ followUp: !c.followUp }, c.followUp ? 'Follow up cleared' : 'Marked for follow up') },
      { label: c.snoozedUntil ? 'Unsnooze' : 'Snooze…', icon: 'clock', run: () => (c.snoozedUntil ? patch({ snoozedUntil: null }, 'Back in your inbox') : snoozeMenu(anchor)) },
      { label: c.closed ? 'Reopen chat' : 'Close chat', icon: 'checkCircle', run: () => patch({ closed: !c.closed }, c.closed ? 'Reopened' : 'Closed. A new message reopens it.') },
      { label: 'Labels…', icon: 'tag', run: labelSheet },
      '-',
      { label: 'Summarise chat', icon: 'sparkles', run: summarise },
      c.canSend && c.editable ? { label: 'Scheduled messages', icon: 'calendar', run: scheduledSheet } : null,
      c.type === 'dm' ? { label: 'Contact details', icon: 'info', run: () => toggleSide(true) } : null,
      '-',
      { label: c.muted ? 'Unmute' : 'Mute notifications', icon: c.muted ? 'bell' : 'volumeX', run: () => patch({ muted: !c.muted }, c.muted ? 'Unmuted' : 'Muted') },
      { label: c.archived ? 'Unarchive' : 'Archive', icon: 'folder', run: () => patch({ archived: !c.archived }, c.archived ? 'Moved back to chats' : 'Archived') },
      { label: 'Clear history for me', icon: 'trash', run: async () => { if (!(await confirmDlg('Clear this chat for you? Others keep their copy.', { ok: 'Clear', danger: true }))) return; await api(`/api/messages/conversations/${c.id}/clear`, { method: 'POST' }).catch(toastErr); S.msgs = []; paintMsgs(true); } },
      '-',
      c.type === 'dm' && c.peer && c.peer.id ? { label: `Block ${c.title}`, icon: 'userX', group: 'admin', run: () => toggleBlock() } : null,
      { label: 'Report chat', icon: 'alert', group: 'admin', run: () => report(null) },
      group && !c.subtype?.startsWith('org') ? { label: 'Leave group', icon: 'logout', group: 'admin', run: async () => { if (!(await confirmDlg('Leave this group?', { ok: 'Leave', danger: true }))) return; try { await api(`/api/messages/conversations/${c.id}/members/${state.user.id}`, { method: 'DELETE' }); navigate('/messages'); } catch (e) { toastErr(e); } } } : null,
    ]);
  }
  async function toggleBlock() {
    const c = S.conv;
    if (!(await confirmDlg(`Block ${c.title}? They won’t be able to message or call you, and this chat is hidden. They are not told.`, { ok: 'Block', danger: true }))) return;
    try { await api('/api/messages/blocks', { method: 'POST', body: { userId: c.peer.id } }); toast('Blocked', { icon: 'userX' }); navigate('/messages'); } catch (e) { toastErr(e); }
  }
  async function peopleICanAdd(exclude) {
    const all = (await api('/api/messages/conversations?filter=dm')).conversations;
    return all.filter((c) => c.peer && c.peer.id && !exclude.has(c.peer.id)).map((c) => c.peer);
  }
  function pickList(people, picked) {
    if (!people.length) return h('p', { class: 'muted small' }, 'People you have a direct chat with appear here.');
    return h('div', { class: 'msg-pick' }, people.map((p) => {
      const cb = h('input', { type: 'checkbox', onchange: () => (cb.checked ? picked.add(p.id) : picked.delete(p.id)) });
      return h('label', { class: 'msg-pick-row' }, cb, avatar(p.name, p.avatarUrl, 'sm'), h('span', { class: 'grow ellipsis' }, p.name));
    }));
  }
  async function membersSheet() {
    const c = S.conv; const s = sheet({ title: `${c.title} · members`, icon: 'users' });
    const admin = c.role === 'admin' || c.role === 'owner';
    add(s.body, h('div', { class: 'msg-pick' }, (c.members || []).map((u) => h('div', { class: 'msg-pick-row' }, avatar(u.name, u.avatarUrl, 'sm'), h('span', { class: 'grow ellipsis' }, u.name), u.role !== 'member' ? h('span', { class: 'tiny muted' }, u.role) : null,
      admin && c.editable && u.id !== state.user.id && !c.subtype?.startsWith('org') ? h('button', { class: 'btn sm ghost', type: 'button', onclick: async () => { try { await api(`/api/messages/conversations/${c.id}/members/${u.id}`, { method: 'DELETE' }); s.close(); open(c.id); } catch (e) { toastErr(e); } } }, 'Remove') : null))));
    if (admin && c.editable && !c.subtype?.startsWith('org')) {
      const picked = new Set();
      const ppl = await peopleICanAdd(new Set((c.members || []).map((u) => u.id)));
      add(s.body, h('h4', { class: 'msg-sub' }, 'Add people'), pickList(ppl, picked), ppl.length ? h('button', { class: 'btn primary', type: 'button', onclick: async () => {
        try { for (const id of picked) await api(`/api/messages/conversations/${c.id}/members`, { method: 'POST', body: { userId: id } }); s.close(); open(c.id); } catch (e) { if (e.data && e.data.upgrade) toast(e.message, { icon: 'zap', action: { label: 'Upgrade', run: () => navigate('/upgrade') } }); else toastErr(e); }
      } }, 'Add') : null);
    }
  }
  async function newGroup() {
    const s = sheet({ title: 'New group', icon: 'users' });
    const title = h('input', { class: 'input', placeholder: 'Group name', maxlength: 80 });
    const picked = new Set();
    add(s.body, h('label', { class: 'field' }, h('span', { class: 'lbl' }, 'Name'), title), h('h4', { class: 'msg-sub' }, 'Members'), pickList(await peopleICanAdd(new Set()), picked),
      h('button', { class: 'btn primary', type: 'button', onclick: async () => {
        try { const r = await api('/api/messages/groups', { method: 'POST', body: { title: title.value, memberIds: [...picked] } }); s.close(); navigate(`/messages/${r.conversation.id}`); }
        catch (e) { if (e.data && e.data.upgrade) toast(e.message, { icon: 'zap', action: { label: 'Upgrade', run: () => navigate('/upgrade') } }); else toastErr(e); }
      } }, 'Create group'));
  }
  async function settings() {
    const s = sheet({ title: 'Message settings', icon: 'settings' });
    let cfg; try { cfg = await api('/api/messages/settings'); } catch (e) { toastErr(e); return; }
    const save = (b) => api('/api/messages/settings', { method: 'PUT', body: b }).then(() => toast('Saved', { icon: 'check' })).catch(toastErr);
    const pol = h('select', { class: 'input', onchange: () => save({ dmPolicy: pol.value }) },
      [['everyone', 'Anyone on 1venue (by username or email)'], ['contacts', 'Only people I share a meeting, group or organisation with, or follow back'], ['nobody', 'Nobody new']].map(([v, l]) => h('option', { value: v, selected: cfg.dmPolicy === v }, l)));
    const sw = (on, run) => { const i = h('input', { type: 'checkbox', checked: !!on, onchange: () => run(i.checked) }); return h('label', { class: 'switch' }, i, h('span')); };
    const pushRow = h('div', { class: 'msg-set-row' }, h('div', { class: 'grow' }, h('b', null, 'Notifications on this device'), h('p', { class: 'tiny muted' }, 'Checking…')));
    add(s.body, h('div', { class: 'stack' },
      h('label', { class: 'field' }, h('span', { class: 'lbl' }, 'Who can start a new chat with me'), pol),
      h('div', { class: 'msg-set-row' }, h('div', { class: 'grow' }, h('b', null, 'Hide when I’m online'), h('p', { class: 'tiny muted' }, 'You won’t see others’ status either.')), sw(cfg.hidePresence, (v) => save({ hidePresence: v }))),
      pushRow,
      h('div', { class: 'msg-set-row' }, h('div', { class: 'grow' }, h('b', null, 'Message tone'), h('p', { class: 'tiny muted' }, 'A short chime for new messages.')), h('button', { class: 'btn sm ghost', type: 'button', onclick: () => { const was = toneMuted('message'); setToneMuted('message', false); playMessageTone(); setToneMuted('message', was); } }, 'Play'), sw(!toneMuted('message'), (v) => setToneMuted('message', !v))),
      h('div', { class: 'msg-set-row' }, h('div', { class: 'grow' }, h('b', null, 'Call ringtone'), h('p', { class: 'tiny muted' }, 'Rings until you answer or decline.')), sw(!toneMuted('ring'), (v) => setToneMuted('ring', !v))),
      h('h4', { class: 'msg-sub' }, 'Quick replies'), quickEditor(),
      h('h4', { class: 'msg-sub' }, 'Blocked people'), blockedList()));
    const st = await pushState();
    const p = pushRow.querySelector('p');
    if (!st.supported) p.textContent = 'This browser can’t show notifications.';
    else if (!st.enabled) {
      // No server push keys: the browser still shows notifications while 1venue is open in a tab.
      const perm = Notification.permission;
      p.textContent = perm === 'granted' ? 'On while 1venue is open in a tab.' : perm === 'denied' ? 'Blocked in browser settings.' : 'Get alerts for new messages and calls.';
      if (perm === 'default') add(pushRow, h('button', { class: 'btn sm primary', type: 'button', onclick: async (e) => { const n = await import('../messages/notify.js'); const r = await n.askNow(); p.textContent = r === 'granted' ? 'On while 1venue is open in a tab.' : 'Not allowed'; e.target.remove(); } }, 'Turn on'));
    }
    else { p.textContent = st.on ? 'On for messages and calls.' : st.permission === 'denied' ? 'Blocked in browser settings.' : 'Get alerts when you’re away.'; add(pushRow, sw(st.on, async (v) => { try { v ? await enablePush() : await disablePush(); p.textContent = v ? 'On for messages and calls.' : 'Off'; } catch (e) { toastErr(e); } })); }
  }
  function blockedList() {
    const box = h('div', { class: 'msg-pick' }, h('p', { class: 'tiny muted' }, 'Loading…'));
    api('/api/messages/blocks').then((r) => {
      if (!r.blocked.length) return put(box, h('p', { class: 'tiny muted' }, 'Nobody.'));
      put(box, ...r.blocked.map((u) => h('div', { class: 'msg-pick-row' }, avatar(u.name, u.avatarUrl, 'sm'), h('span', { class: 'grow ellipsis' }, u.name),
        h('button', { class: 'btn sm ghost', type: 'button', onclick: async (e) => { await api(`/api/messages/blocks/${u.id}`, { method: 'DELETE' }).catch(toastErr); e.target.closest('.msg-pick-row').remove(); loadList(); } }, 'Unblock'))));
    }).catch(() => {});
    return box;
  }

  // ------------------------------------------------------------- replies (quoted bubbles)
  const replyBar = h('div', { class: 'msg-replybar', hidden: true });
  function paintReply() {
    const r = S.replyTo; replyBar.hidden = !r;
    if (!r) return put(replyBar);
    put(replyBar, h('div', { class: 'msg-quote in-bar' }, h('b', null, r.mine ? 'You' : r.fromName), h('span', { class: 'ellipsis' }, r.text || (r.attachment ? `📎 ${r.attachment.name || r.attachment.kind}` : ''))),
      h('button', { class: 'icon-btn sm', type: 'button', 'aria-label': 'Cancel reply', html: icon('x', { size: 16 }), onclick: () => { S.replyTo = null; paintReply(); } }));
  }
  function startReply(m) { S.replyTo = m; paintReply(); composer && composer.focus(); }
  function quoteEl(q) {
    return h('button', { class: `msg-quote${q.fromUserId === state.user.id ? ' me' : ''}`, type: 'button', onclick: (e) => { e.stopPropagation(); if (!q.missing) jumpTo(q.id); } },
      h('b', null, q.missing ? 'Message' : q.fromUserId === state.user.id ? 'You' : q.fromName),
      h('span', { class: 'ellipsis' }, q.missing || q.deleted ? 'Message unavailable' : q.text || (q.attachmentKind === 'voice' ? '🎤 Voice note' : q.attachmentKind === 'image' ? '📷 Photo' : q.attachmentKind ? '📎 File' : '')));
  }
  /** Scroll to a message (loading older pages if needed) and flash it. */
  async function jumpTo(id) {
    for (let i = 0; i < 8 && !S.msgs.some((m) => m.id === id) && S.hasMore; i++) await older();
    const el = msgsEl.querySelector(`.msg-row[data-id="${id}"]`);
    if (!el) return toast('That message is no longer here', { icon: 'info' });
    el.scrollIntoView({ block: 'center', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
    el.classList.remove('flash'); void el.offsetWidth; el.classList.add('flash');
  }

  // ------------------------------------------------------------- pinned bar (cycles like WhatsApp)
  const pinBar = h('div', { class: 'msg-pinbar', hidden: true });
  let pinTimer = null;
  function paintPins() {
    clearInterval(pinTimer);
    const n = S.pins.length; pinBar.hidden = !n;
    if (!n) return put(pinBar);
    S.pinIdx = S.pinIdx % n;
    const p = S.pins[S.pinIdx];
    const dots = h('span', { class: 'msg-pin-dots', 'aria-hidden': 'true' }, S.pins.slice(0, 6).map((_, i) => h('i', { class: i === S.pinIdx % 6 ? 'on' : '' })));
    put(pinBar, dots,
      h('button', { class: 'msg-pin-main', type: 'button', 'aria-label': `Pinned message ${S.pinIdx + 1} of ${n}. Show it`, onclick: () => { jumpTo(p.id); S.pinIdx = (S.pinIdx + 1) % n; paintPins(); } },
        I('pin', 15), h('span', { class: 'msg-pin-txt' }, h('b', null, n > 1 ? `Pinned ${S.pinIdx + 1} of ${n}` : 'Pinned message'), h('span', { class: 'ellipsis' }, p.text || (p.attachmentKind ? `📎 ${p.attachmentKind}` : '')))),
      n > 1 ? h('button', { class: 'icon-btn sm', type: 'button', 'aria-label': 'All pinned messages', 'data-tip': 'All pins', html: icon('listChecks', { size: 16 }), onclick: allPins }) : null,
      S.conv.canSend ? h('button', { class: 'icon-btn sm', type: 'button', 'aria-label': 'Unpin', 'data-tip': 'Unpin', html: icon('x', { size: 16 }), onclick: () => togglePin(p, true) }) : null);
    if (n > 1 && !matchMedia('(prefers-reduced-motion: reduce)').matches) pinTimer = setInterval(() => { if (!pinBar.matches(':hover')) { S.pinIdx = (S.pinIdx + 1) % S.pins.length; paintPins(); } }, 5000);
  }
  function allPins() {
    const s = sheet({ title: `Pinned messages (${S.pins.length})`, icon: 'pin' });
    add(s.body, h('div', { class: 'msg-pick' }, S.pins.map((p) => h('div', { class: 'msg-pick-row' }, I('pin', 16),
      h('button', { class: 'grow msg-pin-row', type: 'button', onclick: () => { s.close(); jumpTo(p.id); } }, h('b', { class: 'tiny' }, p.fromName), h('span', { class: 'ellipsis' }, p.text || `📎 ${p.attachmentKind || 'file'}`)),
      S.conv.canSend ? h('button', { class: 'btn sm ghost', type: 'button', onclick: async (e) => { await togglePin(p, true); e.target.closest('.msg-pick-row').remove(); } }, 'Unpin') : null))));
  }
  async function togglePin(m, pinned) {
    try { const r = await api(`/api/messages/conversations/${S.conv.id}/messages/${m.id}/pin`, { method: pinned ? 'DELETE' : 'POST' }); S.pins = r.pins; if (!pinned) S.pinIdx = 0; paintPins(); paintMsgs(false); toast(pinned ? 'Unpinned' : 'Pinned', { icon: 'pin' }); } catch (e) { toastErr(e); }
  }

  // ------------------------------------------------------------- AI on files and voice notes
  async function transcribe(m, btn) {
    if (!btn) toast('Transcribing the voice note…', { icon: 'captions' });
    if (btn) { btn.disabled = true; btn.lastChild.textContent = 'Transcribing…'; }
    try { const r = await api(`/api/messages/conversations/${S.conv.id}/messages/${m.id}/transcribe`, { method: 'POST' }); transcripts.set(m.id, safeText(r.text) || '(No speech detected)'); paintMsgs(false); if (r.cost) toast(`Transcribed · ${r.cost} AI point${r.cost === 1 ? '' : 's'}`, { icon: 'captions' }); }
    catch (e) { if (btn) { btn.disabled = false; btn.lastChild.textContent = 'Transcribe'; } upgradeOrErr(e); }
  }
  const upgradeOrErr = (e) => (e.data && e.data.upgrade ? toast(e.message, { icon: 'zap', action: { label: 'Upgrade', run: () => navigate('/upgrade') } }) : toastErr(e));
  async function analyseFile(m, force = false) {
    const s = sheet({ title: m.attachment.name || 'File', icon: 'sparkles', wide: true });
    const box = h('div', { class: 'msg-ai' }, h('div', { class: 'msg-ai-loading' }, h('span', { class: 'spinner' }), 'Reading the file…'));
    add(s.body, box);
    try {
      const { analysis: a } = await api(`/api/messages/conversations/${S.conv.id}/messages/${m.id}/analyse`, { method: 'POST', body: { force } });
      const sum = safeText(a.summary), pts = safeList(a.keyPoints), note = safeText(a.dataCommentary);
      if (sum && analyses.get(m.id) !== sum) { analyses.set(m.id, sum); paintMsgs(false); }
      put(box, sum ? h('p', { class: 'msg-ai-sum' }, sum) : h('p', { class: 'muted' }, 'No summary came back for this file.'),
        pts.length ? h('ul', { class: 'msg-ai-pts' }, pts.map((k) => h('li', null, k))) : null,
        note ? h('p', { class: 'small muted' }, note) : null,
        h('div', { class: 'row gap msg-ai-foot' }, h('span', { class: 'tiny muted grow' }, a.cached ? 'Saved analysis · no points used' : `${a.cost || 0} AI point${a.cost === 1 ? '' : 's'}${a.mock ? ' · preview mode' : ''}`),
          a.chartable ? h('button', { class: 'btn sm', type: 'button', onclick: () => { s.close(); chartFile(m); } }, I('chart', 14), 'Chart it') : null,
          h('button', { class: 'btn sm primary', type: 'button', onclick: () => { s.close(); S.replyTo = m; paintReply(); composer && composer.setText(`Summary of ${safeText(m.attachment.name) || 'the file'}: ${sum}`); composer && composer.focus(); } }, 'Share summary')));
    } catch (e) { s.close(); upgradeOrErr(e); }
  }
  async function chartFile(m) {
    try { const data = await api(`/api/messages/conversations/${S.conv.id}/messages/${m.id}/table`); const cm = await import('../messages/chart.js'); cm.chartSheet(data, (m.attachment.name || 'Chart').replace(/\.[^.]+$/, '')); }
    catch (e) { toastErr(e); }
  }
  async function summarise() {
    const s = sheet({ title: `Summary · ${S.conv.title}`, icon: 'sparkles' });
    const box = h('div', { class: 'msg-ai' }, h('div', { class: 'msg-ai-loading' }, h('span', { class: 'spinner' }), 'Catching up on the chat…'));
    add(s.body, box);
    try {
      const r = await api(`/api/messages/conversations/${S.conv.id}/summary`, { method: 'POST' });
      const kp = safeList(r.keyPoints), ai = safeList(r.actionItems);
      put(box, h('p', { class: 'msg-ai-sum' }, safeText(r.summary) || 'Nothing to summarise yet.'),
        kp.length ? h('div', null, h('h4', { class: 'msg-sub' }, 'Key points'), h('ul', { class: 'msg-ai-pts' }, kp.map((k) => h('li', null, k)))) : null,
        ai.length ? h('div', null, h('h4', { class: 'msg-sub' }, 'Action items'), h('ul', { class: 'msg-ai-pts todo' }, ai.map((k) => h('li', null, k)))) : null,
        h('p', { class: 'tiny muted' }, `Last ${r.count} messages · ${r.cached ? 'no new points used' : `${r.cost || 0} AI point${r.cost === 1 ? '' : 's'}`}${r.mock ? ' · preview mode' : ''}`));
    } catch (e) { s.close(); upgradeOrErr(e); }
  }

  // ------------------------------------------------------------- forward, snooze, labels
  async function forwardSheet(m) {
    const s = sheet({ title: 'Forward to…', icon: 'forward' });
    let all = [];
    try { all = (await api('/api/messages/conversations?filter=all')).conversations.filter((c) => c.canSend && c.id !== S.conv.id); } catch (e) { toastErr(e); }
    const live = all.filter((c) => c.type === 'meeting' && c.live);
    const rest = all.filter((c) => !(c.type === 'meeting' && c.live));
    const row = (c) => h('button', { class: 'msg-pick-row', type: 'button', onclick: async () => {
      try { await api(`/api/messages/conversations/${S.conv.id}/messages/${m.id}/forward`, { method: 'POST', body: { conversationId: c.id } }); s.close(); toast(`Forwarded to ${c.title}`, { icon: 'forward', action: { label: 'Open', run: () => navigate(`/messages/${c.id}`) } }); } catch (e) { toastErr(e); }
    } }, c.type === 'dm' ? avatar(c.title, c.avatarUrl, 'sm') : h('span', { class: `av sm msg-av-ic ${c.type}`, html: icon(c.type === 'meeting' ? 'video' : 'users', { size: 16 }) }), h('span', { class: 'grow ellipsis' }, c.title), c.live ? h('span', { class: 'msg-live' }, 'Live') : null);
    add(s.body, live.length ? h('h4', { class: 'msg-sub' }, 'Live meetings') : null, live.length ? h('div', { class: 'msg-pick' }, live.map(row)) : null,
      h('h4', { class: 'msg-sub' }, 'Chats'), rest.length ? h('div', { class: 'msg-pick' }, rest.map(row)) : h('p', { class: 'muted small' }, 'No other chats yet.'));
  }
  function snoozeMenu(anchor) {
    const at = (fn) => { const d = new Date(); fn(d); return d.toISOString(); };
    const go = (iso, label) => patch({ snoozedUntil: iso }, `Snoozed until ${label}`).then(() => { if (S.tab === 'inbox') navigate('/messages'); });
    menu(anchor, [
      { label: 'In 1 hour', icon: 'clock', run: () => go(at((d) => d.setHours(d.getHours() + 1)), 'in an hour') },
      { label: 'In 3 hours', icon: 'clock', run: () => go(at((d) => d.setHours(d.getHours() + 3)), 'in 3 hours') },
      { label: 'Tomorrow morning', icon: 'sun', run: () => go(at((d) => { d.setDate(d.getDate() + 1); d.setHours(9, 0, 0, 0); }), 'tomorrow 9:00') },
      { label: 'Next week', icon: 'calendar', run: () => go(at((d) => { d.setDate(d.getDate() + ((8 - d.getDay()) % 7 || 7)); d.setHours(9, 0, 0, 0); }), 'Monday 9:00') },
      { label: 'Pick a time…', icon: 'calendarPlus', run: async () => { const v = await promptDlg('Snooze until', { placeholder: 'YYYY-MM-DD HH:MM', value: new Date(Date.now() + 86400000).toISOString().slice(0, 16).replace('T', ' ') }); if (v) { const d = new Date(v.replace(' ', 'T')); if (Number.isNaN(d.getTime())) return toast('That date didn’t look right', { icon: 'alert' }); go(d.toISOString(), fmtDate(d)); } } },
    ]);
  }
  function labelSheet() {
    const s = sheet({ title: 'Labels', icon: 'tag' });
    let labels = [...(S.conv.labels || [])];
    let color = LABEL_COLORS[0];
    const known = [...new Map(S.list.flatMap((c) => c.labels || []).map((l) => [l.name.toLowerCase(), l])).values()];
    const cur = h('div', { class: 'msg-label-edit' });
    const save = () => patch({ labels }).then(() => { S.conv.labels = labels; paintCur(); paintSide(); });
    const paintCur = () => put(cur, ...(labels.length ? labels.map((l) => h('span', { class: 'msg-label lg', style: { '--lc': l.color } }, l.name, h('button', { type: 'button', 'aria-label': `Remove ${l.name}`, html: icon('x', { size: 12 }), onclick: () => { labels = labels.filter((x) => x !== l); save(); } }))) : [h('span', { class: 'tiny muted' }, 'No labels on this chat yet.')]));
    const name = h('input', { class: 'input', placeholder: 'New label, e.g. Lead or VIP', maxlength: 24 });
    const sw = h('div', { class: 'msg-swatches' }, LABEL_COLORS.map((c) => h('button', { type: 'button', class: `msg-swatch${c === color ? ' on' : ''}`, style: { '--lc': c }, 'aria-label': `Colour ${c}`, onclick: (e) => { color = c; sw.querySelectorAll('.msg-swatch').forEach((b) => b.classList.toggle('on', b === e.currentTarget)); } })));
    const addLabel = (l) => { if (!l.name || labels.some((x) => x.name.toLowerCase() === l.name.toLowerCase())) return; if (labels.length >= 8) return toast('Up to 8 labels per chat', { icon: 'alert' }); labels = [...labels, l]; save(); };
    add(s.body, h('div', { class: 'stack' }, cur,
      known.length ? h('div', null, h('span', { class: 'lbl' }, 'Your labels'), h('div', { class: 'msg-label-edit' }, known.map((l) => h('button', { type: 'button', class: 'msg-label lg pick', style: { '--lc': l.color }, onclick: () => addLabel(l) }, '+ ', l.name)))) : null,
      h('div', { class: 'field' }, h('span', { class: 'lbl' }, 'New label'), name, sw),
      h('button', { class: 'btn primary', type: 'button', onclick: () => { addLabel({ name: name.value.trim(), color }); name.value = ''; } }, 'Add label')));
    paintCur();
  }

  // ------------------------------------------------------------- scheduled messages
  function localInput(d) { return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16); }
  function sendLaterSheet() {
    const s = sheet({ title: 'Send later', icon: 'clock' });
    const text = h('textarea', { class: 'input', rows: 3, maxlength: 4000, placeholder: 'Message' }); text.value = composer ? composer.ta.value : '';
    const t = new Date(Date.now() + 3600000); t.setMinutes(0, 0, 0);
    const when = h('input', { class: 'input', type: 'datetime-local', value: localInput(t), min: localInput(new Date()) });
    const presets = h('div', { class: 'chips' }, [['In 1 hour', 1], ['Tonight 8pm', 'night'], ['Tomorrow 9am', 'am']].map(([l, v]) => h('button', { class: 'chip', type: 'button', onclick: () => { const d = new Date(); if (v === 1) d.setHours(d.getHours() + 1); else if (v === 'night') { d.setHours(20, 0, 0, 0); if (d < new Date()) d.setDate(d.getDate() + 1); } else { d.setDate(d.getDate() + 1); d.setHours(9, 0, 0, 0); } when.value = localInput(d); } }, l)));
    const go = h('button', { class: 'btn primary', type: 'button', onclick: async () => {
      go.disabled = true;
      try { await api(`/api/messages/conversations/${S.conv.id}/scheduled`, { method: 'POST', body: { text: text.value, sendAt: new Date(when.value).toISOString(), replyToId: S.replyTo ? S.replyTo.id : undefined } }); s.close(); composer && composer.clear(); S.replyTo = null; paintReply(); toast(`Scheduled for ${fmtDate(new Date(when.value))}`, { icon: 'clock', action: { label: 'View', run: scheduledSheet } }); }
      catch (e) { go.disabled = false; toastErr(e); }
    } }, 'Schedule');
    add(s.body, h('div', { class: 'stack' }, text, presets, h('label', { class: 'field' }, h('span', { class: 'lbl' }, 'Send at'), when), go));
  }
  async function scheduledSheet() {
    const s = sheet({ title: 'Scheduled messages', icon: 'calendar' });
    const box = h('div', { class: 'msg-pick' }, h('p', { class: 'tiny muted' }, 'Loading…'));
    add(s.body, box, h('button', { class: 'btn', type: 'button', onclick: () => { s.close(); sendLaterSheet(); } }, I('plus', 16), 'Schedule a message'));
    try {
      const r = await api(`/api/messages/conversations/${S.conv.id}/scheduled`);
      if (!r.scheduled.length) return put(box, h('p', { class: 'muted small' }, 'Nothing scheduled in this chat.'));
      put(box, ...r.scheduled.map((x) => h('div', { class: 'msg-pick-row' }, I('clock', 16), h('div', { class: 'grow' }, h('b', { class: 'tiny' }, fmtDate(x.sendAt)), h('div', { class: 'ellipsis small' }, x.text || '📎 Attachment')),
        h('button', { class: 'btn sm ghost', type: 'button', onclick: async (e) => { try { await api(`/api/messages/scheduled/${x.id}`, { method: 'DELETE' }); e.target.closest('.msg-pick-row').remove(); } catch (er) { toastErr(er); } } }, 'Cancel'))));
    } catch (e) { put(box, h('p', { class: 'muted small' }, e.message)); }
  }

  // ------------------------------------------------------------- quick replies
  async function loadQuick(force = false) { if (!S.quick || force) { try { S.quick = (await api('/api/messages/quick-replies')).replies; } catch { S.quick = []; } } return S.quick; }
  loadQuick();
  function quickSuggest(t) {
    if (!t.startsWith('/') || !S.quick) return [];
    const q = t.slice(1).toLowerCase();
    return S.quick.filter((r) => r.shortcut.toLowerCase().startsWith(q)).slice(0, 6).map((r) => ({ label: `/${r.shortcut}`, tip: r.body.slice(0, 80), run: () => { composer.setText(r.body); composer.focus(); } }));
  }
  async function quickMenu(anchor) {
    const list = await loadQuick();
    menu(anchor, [...list.slice(0, 12).map((r) => ({ label: `/${r.shortcut} · ${r.body.slice(0, 40)}`, icon: 'quick', run: () => { composer.setText(r.body); composer.focus(); } })),
      list.length ? '-' : null, { label: 'Manage quick replies', icon: 'settings', run: settings }]);
  }
  function quickEditor() {
    const box = h('div', { class: 'stack' });
    const paint = (list) => {
      const sc = h('input', { class: 'input sm', placeholder: 'shortcut', maxlength: 24 });
      const body = h('input', { class: 'input sm grow', placeholder: 'Text to insert', maxlength: 1000 });
      put(box, h('div', { class: 'msg-pick' }, list.length ? list.map((r) => h('div', { class: 'msg-pick-row' }, h('code', null, `/${r.shortcut}`), h('span', { class: 'grow ellipsis small' }, r.body),
        h('button', { class: 'icon-btn sm', type: 'button', 'aria-label': 'Delete', html: icon('trash', { size: 14 }), onclick: async () => { try { const x = await api(`/api/messages/quick-replies/${r.id}`, { method: 'DELETE' }); S.quick = x.replies; paint(x.replies); } catch (e) { toastErr(e); } } }))) : h('p', { class: 'tiny muted' }, 'Save answers you send often, then type / in a chat.')),
      h('div', { class: 'row gap msg-quick-add' }, sc, body, h('button', { class: 'btn sm', type: 'button', onclick: async () => { try { const x = await api('/api/messages/quick-replies', { method: 'POST', body: { shortcut: sc.value, body: body.value } }); S.quick = x.replies; paint(x.replies); } catch (e) { toastErr(e); } } }, 'Save')));
    };
    loadQuick(true).then(paint);
    return box;
  }

  // ------------------------------------------------------------- new chat by username or email
  function newChat() {
    const s = sheet({ title: 'New chat', icon: 'messages' });
    const input = h('input', { class: 'input', placeholder: 'Username or email', autocomplete: 'off', autocapitalize: 'none', spellcheck: 'false', 'aria-label': 'Username or email' });
    const sugg = h('div', { class: 'msg-pick' });
    const go = async (handle) => {
      const v = String(handle || input.value).trim(); if (!v) return;
      btn.disabled = true;
      try { const r = await api('/api/messages/new', { method: 'POST', body: { handle: v } }); s.close(); navigate(`/messages/${r.conversation.id}`); }
      catch (e) { btn.disabled = false; toastErr(e); }
    };
    const btn = h('button', { class: 'btn primary', type: 'button', onclick: () => go() }, 'Start chat');
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); go(); } });
    input.addEventListener('input', debounce(async () => {
      const q = input.value.trim().replace(/^@/, '');
      if (q.length < 2 || q.includes('@')) return put(sugg);
      try {
        const r = await api(`/api/users/search?q=${encodeURIComponent(q)}`);
        const users = (r.users || r.results || []).filter((u) => u.id !== state.user.id).slice(0, 6);
        put(sugg, ...users.map((u) => h('button', { class: 'msg-pick-row', type: 'button', onclick: () => go(u.username) }, avatar(u.displayName || u.display_name || u.username, u.avatarUrl || u.avatar_url, 'sm'), h('span', { class: 'grow ellipsis' }, u.displayName || u.display_name || u.username), h('span', { class: 'tiny muted' }, `@${u.username}`))));
      } catch { put(sugg); }
    }, 220));
    add(s.body, h('div', { class: 'stack' }, h('p', { class: 'small muted' }, 'Message anyone on 1venue, even if you haven’t met in a meeting. People can limit this in their Message settings.'), input, sugg, btn));
  }

  // ------------------------------------------------------------- contact side panel (Cooby-style)
  function toggleSide(force) {
    S.panel = force === undefined ? !(S.panel && !sidePane.hidden) : !!force;
    localStorage.setItem('venue.msg.panel', S.panel ? '1' : '0');
    paintSide();
  }
  let noteT = null;
  async function paintSide() {
    const c = S.conv;
    sidePane.hidden = !(c && S.panel);
    root.classList.toggle('has-side', !sidePane.hidden);
    if (!c || sidePane.hidden) return;
    const close = h('button', { class: 'icon-btn sm msg-side-close', type: 'button', 'aria-label': 'Close details', html: icon('x', { size: 18 }), onclick: () => toggleSide(false) });
    if (c.type !== 'dm') {
      put(sidePane, close, h('div', { class: 'msg-side-hero' }, h('span', { class: `av xl msg-av-ic ${c.type}`, html: icon(c.type === 'meeting' ? 'video' : 'users', { size: 32 }) }), h('h3', null, c.title), h('span', { class: 'muted small' }, presenceText(c))),
        labelsBlock(c),
        c.members && c.members.length ? h('section', { class: 'msg-side-sec' }, h('h4', null, `Members · ${c.members.length}`), h('div', { class: 'msg-side-list' }, c.members.slice(0, 30).map((u) => h('a', { class: 'msg-side-item', href: `/u/${u.username}`, 'data-link': '' }, avatar(u.name, u.avatarUrl, 'sm'), h('span', { class: 'grow ellipsis' }, u.name), u.role !== 'member' ? h('span', { class: 'tiny muted' }, u.role) : null)))) : null);
      return;
    }
    put(sidePane, close, h('div', { class: 'msg-side-loading' }, h('span', { class: 'spinner' })));
    let d;
    try { d = await api(`/api/messages/conversations/${c.id}/contact`); } catch (e) { put(sidePane, close, h('p', { class: 'muted small pad' }, e.message)); return; }
    if (S.conv !== c) return;
    const u = d.user; const st = d.stats;
    const note = h('textarea', { class: 'input msg-note', rows: 4, maxlength: 4000, placeholder: 'Private notes about this contact. Only you can see them.' }); note.value = d.note.body || '';
    const noteSt = h('span', { class: 'tiny muted' }, d.note.updatedAt ? `Saved ${timeAgo(d.note.updatedAt)}` : 'Only visible to you');
    note.addEventListener('input', () => { clearTimeout(noteT); noteSt.textContent = 'Saving…'; noteT = setTimeout(() => api(`/api/messages/conversations/${c.id}/note`, { method: 'PUT', body: { body: note.value } }).then(() => { noteSt.textContent = 'Saved'; }).catch(() => { noteSt.textContent = 'Not saved'; }), 600); });
    const stat = (v, l) => h('div', { class: 'msg-stat' }, h('b', null, v), h('span', null, l));
    put(sidePane, close,
      h('div', { class: 'msg-side-hero' }, avatar(u.name, u.avatarUrl, 'xl'), h('h3', null, u.name), h('a', { class: 'muted small', href: `/u/${u.username}`, 'data-link': '' }, `@${u.username}`), u.bio ? h('p', { class: 'small msg-side-bio' }, u.bio) : null,
        h('div', { class: 'msg-side-acts' }, c.canSend ? h('button', { class: 'btn sm', type: 'button', onclick: () => call('audio') }, I('phone', 14), 'Call') : null, h('a', { class: 'btn sm ghost', href: `/u/${u.username}`, 'data-link': '' }, 'Profile'))),
      h('section', { class: 'msg-side-sec' }, h('h4', null, 'Activity'), h('div', { class: 'msg-stats' },
        stat(st.total.toLocaleString(), 'messages'), stat(`${st.mine}/${st.theirs}`, 'you / them'), stat(dur(st.myAvgReplySec), 'your avg reply'), stat(dur(st.theirAvgReplySec), 'their avg reply')),
      st.firstAt ? h('p', { class: 'tiny muted' }, `Chatting since ${fmtDate(st.firstAt)}`) : null),
      labelsBlock(c),
      h('section', { class: 'msg-side-sec' }, h('h4', null, I('notes', 14), 'Notes'), note, noteSt),
      h('section', { class: 'msg-side-sec' }, h('h4', null, `Shared meetings · ${d.sharedMeetings.length}`), d.sharedMeetings.length ? h('div', { class: 'msg-side-list' }, d.sharedMeetings.map((m) => h('div', { class: 'msg-side-item' }, h('span', { class: 'ico-tile sm', html: icon('video', { size: 14 }) }), h('span', { class: 'grow ellipsis' }, m.name), h('span', { class: 'tiny muted' }, fmtDate(m.at))))) : h('p', { class: 'tiny muted' }, 'No meetings together yet.')),
      h('section', { class: 'msg-side-sec' }, h('h4', null, `Files & materials · ${d.files.length + d.materials.length}`), (d.files.length || d.materials.length) ? h('div', { class: 'msg-side-list' },
        d.materials.map((m) => h('a', { class: 'msg-side-item', href: `/materials/${m.id}`, 'data-link': '' }, h('span', { class: 'ico-tile sm', html: icon(m.kind === 'sheet' ? 'grid' : 'presentation', { size: 14 }) }), h('span', { class: 'grow ellipsis' }, m.title))),
        d.files.map((f) => h('button', { class: 'msg-side-item', type: 'button', onclick: () => jumpTo(f.messageId) }, h('span', { class: 'ico-tile sm', html: icon(f.kind === 'image' ? 'image' : f.kind === 'voice' ? 'mic' : 'file', { size: 14 }) }), h('span', { class: 'grow ellipsis' }, f.name), h('span', { class: 'tiny muted' }, timeAgo(f.at))))) : h('p', { class: 'tiny muted' }, 'Files you share here appear in this list.')));
  }
  function labelsBlock(c) {
    return h('section', { class: 'msg-side-sec' }, h('h4', null, I('tag', 14), 'Labels', h('button', { class: 'msg-side-edit', type: 'button', onclick: labelSheet }, 'Edit')),
      h('div', { class: 'msg-label-edit' }, (c.labels || []).length ? c.labels.map((l) => h('span', { class: 'msg-label lg', style: { '--lc': l.color } }, l.name)) : h('span', { class: 'tiny muted' }, 'None')),
      h('div', { class: 'msg-side-flags' }, c.starred ? h('span', { class: 'msg-flagchip' }, I('star', 12), 'Starred') : null, c.followUp ? h('span', { class: 'msg-flagchip' }, I('flag', 12), 'Follow up') : null, c.snoozedUntil ? h('span', { class: 'msg-flagchip' }, I('clock', 12), `Snoozed · ${fmtDate(c.snoozedUntil)}`) : null, c.closed ? h('span', { class: 'msg-flagchip' }, I('checkCircle', 12), 'Closed') : null));
  }

  // ------------------------------------------------------------- live events
  const on = (t, f) => { const g = (e) => f(e.detail); bus.addEventListener(t, g); offs.push(() => bus.removeEventListener(t, g)); };
  const offs = [];
  const reloadList = debounce(loadList, 400);
  on('message', (m) => {
    reloadList();
    if (S.conv && Number(m.conversationId) === S.conv.id) {
      const mine = m.message.fromUserId === state.user.id;
      if (!mine && S.conv.type === 'dm' && m.message.kind === 'text') S.conv.peerReplied = true;
      S.typing.delete(m.message.fromUserId); paintTyping(); upsert({ ...m.message, mine: m.message.mine || mine }, m.message.mine || mine); markRead();
    }
  });
  on('message-edited', (m) => { if (S.conv && m.conversationId === S.conv.id) upsert(m.message); });
  on('message-deleted', (m) => { if (S.conv && m.conversationId === S.conv.id) upsert({ id: m.messageId, deleted: true, text: '', attachment: null, payload: null }); reloadList(); });
  on('reaction', (m) => { if (S.conv && m.conversationId === S.conv.id && S.msgs.some((x) => x.id === m.messageId)) upsert({ id: m.messageId, reactions: m.reactions }); });
  on('read', (m) => { if (S.conv && m.conversationId === S.conv.id && m.userId !== state.user.id) { S.conv.peerReplied = true; S.conv.peerReadId = Math.max(S.conv.peerReadId || 0, m.messageId); paintMsgs(false); } });
  on('conversation-updated', () => reloadList());
  on('pins', (m) => { if (S.conv && m.conversationId === S.conv.id) { S.pins = m.pins || []; S.pinIdx = Math.min(S.pinIdx, Math.max(0, S.pins.length - 1)); paintPins(); paintMsgs(false); } });
  on('scheduled-sent', (m) => { if (S.conv && m.conversationId === S.conv.id) toast('Scheduled message sent', { icon: 'clock' }); });
  on('open', () => { if (S.conv) open(S.conv.id); else loadList(); });
  on('typing', (m) => {
    if (!S.conv || m.conversationId !== S.conv.id) return;
    S.typing.set(m.userId, { name: m.name, at: Date.now(), state: m.state === 'recording' ? 'recording' : 'typing' }); paintTyping();
    setTimeout(paintTyping, 4200);
  });
  function paintTyping() {
    for (const [k, v] of S.typing) if (Date.now() - v.at > 4000) S.typing.delete(k);
    const rec = [...S.typing.values()].filter((v) => v.state === 'recording');
    const typ = [...S.typing.values()].filter((v) => v.state !== 'recording');
    const who = (arr) => arr.slice(0, 2).map((v) => v.name).join(', ');
    const dm = S.conv.type === 'dm';
    const bits = [];
    if (rec.length) bits.push(dm ? 'recording voice…' : `${who(rec)} ${rec.length > 1 ? 'are' : 'is'} recording voice…`);
    if (typ.length) bits.push(dm ? 'typing…' : `${who(typ)} ${typ.length > 1 ? 'are' : 'is'} typing…`);
    typingEl.hidden = !bits.length;
    typingEl.textContent = bits.join(' ');
  }
  const onVis = () => { if (document.visibilityState === 'visible' && S.conv) markRead(); };
  document.addEventListener('visibilitychange', onVis);
  const onResize = debounce(() => document.querySelector('.bottomnav')?.classList.toggle('hidden', !!S.conv && isMobile()), 150);
  window.addEventListener('resize', onResize);

  paintChips();
  await loadList();
  await open(params.id ? Number(params.id) : null);
  return {
    holds(path, params) {
      return /^\/messages\/?$/.test(path) || (/^\/messages\/(\w+)\/?$/.test(path) && params.id !== 'new');
    },
    async update(params) {
      const id = params.id ? Number(params.id) : null;
      await open(Number.isFinite(id) ? id : null);
    },
    unmount() {
      offs.forEach((f) => f()); setActiveConversation(null); barVisible(true); clearInterval(pinTimer);
      document.removeEventListener('visibilitychange', onVis); window.removeEventListener('resize', onResize);
      document.querySelector('.bottomnav')?.classList.remove('hidden');
    },
  };
}
