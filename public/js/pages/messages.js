// Messages: DMs, groups and meeting chats in one inbox (/messages, /messages/:id, /messages/new?user=ID).
// Desktop: list + thread side by side. Phone: one pane at a time; the thread hides the bottom nav.
import { h, esc, api, toast, toastErr, avatar, timeAgo, fmtDate, menu, sheet, confirmDlg, promptDlg, uploadFile, copy, isMobile, debounce } from '../ui.js';
import { icon } from '../icons.js';
import { pillComposer } from '../composer.js';
import { QUICK, emojiPopover } from '../emoji.js';
import { passageCard } from '../passage.js';
import { state, navigate } from '../app.js';
import { barVisible } from '../commands.js';
import { bus, setActiveConversation, refreshUnread, typing as sendTyping, pushState, enablePush, disablePush } from '../messages/live.js';

const I = (n, s = 18) => h('span', { class: 'i', html: icon(n, { size: s }) });
const ib = (ic, label, run, cls = '') => h('button', { class: `icon-btn ${cls}`, type: 'button', 'aria-label': label, 'data-tip': label, onclick: run, html: icon(ic, { size: 20 }) });
const linkify = (s) => esc(s).replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noopener">$1</a>');
const hhmm = (t) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const dayKey = (t) => new Date(t).toDateString();
const dayLabel = (t) => { const d = new Date(t), now = new Date(); if (d.toDateString() === now.toDateString()) return 'Today'; const y = new Date(now); y.setDate(now.getDate() - 1); if (d.toDateString() === y.toDateString()) return 'Yesterday'; return d.toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' }); };
const EDIT_MS = 15 * 60000;
const FILTERS = [['all', 'All'], ['dm', 'Direct'], ['groups', 'Groups'], ['meetings', 'Meetings'], ['archived', 'Archived']];

export async function mount(view, params) {
  if (!state.user) { const e = new Error('Sign in'); e.status = 401; throw e; }
  document.body.dataset.page = 'messages';
  barVisible(false);
  if (params.id === 'new') {
    try { const r = await api('/api/messages/dm', { method: 'POST', body: { userId: Number(params.user) } }); navigate(`/messages/${r.conversation.id}`, { replace: true }); }
    catch (e) { toastErr(e); navigate('/messages', { replace: true }); }
    return { unmount: () => { barVisible(true); } };
  }
  const S = { filter: 'all', q: '', list: [], conv: null, msgs: [], hasMore: false, loadingOlder: false, typing: new Map(), editing: null };
  const listEl = h('div', { class: 'msg-items', role: 'list' });
  const search = h('input', { class: 'input msg-search', type: 'search', placeholder: 'Search chats', 'aria-label': 'Search chats', oninput: debounce(() => { S.q = search.value.trim().toLowerCase(); paintList(); }, 120) });
  const chips = h('div', { class: 'chips msg-filters' });
  const listPane = h('section', { class: 'msg-pane-list', 'aria-label': 'Chats' },
    h('header', { class: 'msg-list-head' }, h('h1', null, 'Messages'), h('div', { class: 'grow' }),
      ib('users', 'New group', newGroup), ib('settings', 'Message settings', settings)),
    search, chips, listEl);
  const threadPane = h('section', { class: 'msg-pane-thread', 'aria-label': 'Conversation' });
  const root = h('div', { class: 'page-messages' }, listPane, threadPane);
  view.append(root);

  // ------------------------------------------------------------- list
  function paintChips() {
    chips.replaceChildren(...FILTERS.map(([k, l]) => h('button', { class: `chip${S.filter === k ? ' on' : ''}`, type: 'button', onclick: () => { S.filter = k; loadList(); } }, l)));
  }
  async function loadList() {
    paintChips();
    const qs = S.filter === 'archived' ? 'filter=all&archived=1' : `filter=${S.filter}`;
    try { S.list = (await api(`/api/messages/conversations?${qs}`)).conversations; } catch (e) { toastErr(e); }
    paintList();
  }
  function rowEl(c) {
    const sub = c.type === 'meeting' ? (c.live ? 'Live now' : 'Meeting') : c.type === 'group' ? `${c.memberCount} members` : '';
    const ic = c.type === 'meeting' ? 'video' : c.type === 'group' ? 'users' : null;
    const av = c.type === 'dm' ? avatar(c.title, c.avatarUrl, 'md') : h('span', { class: `av md msg-av-ic ${c.type}`, html: icon(ic, { size: 20 }) });
    return h('a', { class: `msg-item${S.conv && S.conv.id === c.id ? ' on' : ''}${c.unread ? ' unread' : ''}`, href: `/messages/${c.id}`, 'data-link': '', role: 'listitem' },
      av,
      h('span', { class: 'msg-item-main' },
        h('span', { class: 'msg-item-top' }, h('b', { class: 'ellipsis' }, c.title), c.pinned ? I('pin', 14) : null, c.muted ? I('volumeX', 14) : null, h('time', null, timeAgo(c.lastMessageAt))),
        h('span', { class: 'msg-item-bot' }, h('span', { class: 'ellipsis' }, c.lastPreview || sub || 'No messages yet'), c.unread ? h('em', { class: 'msg-count' }, c.unread > 99 ? '99+' : String(c.unread)) : null)));
  }
  function paintList() {
    const rows = S.list.filter((c) => !S.q || c.title.toLowerCase().includes(S.q) || (c.lastPreview || '').toLowerCase().includes(S.q));
    if (!rows.length) listEl.replaceChildren(h('div', { class: 'empty sm' }, I('chats', 28), h('p', null, S.q ? 'No chats match.' : S.filter === 'archived' ? 'Nothing archived.' : 'No chats yet. Message someone from their profile, or chat in a meeting.')));
    else listEl.replaceChildren(...rows.map(rowEl));
  }

  // ------------------------------------------------------------- thread
  const msgsEl = h('div', { class: 'msg-scroll', 'aria-live': 'polite' });
  const typingEl = h('div', { class: 'msg-typing', hidden: true });
  let composer = null;
  function empty() {
    threadPane.replaceChildren(h('div', { class: 'msg-empty' }, I('chats', 40), h('h2', null, 'Your messages'), h('p', { class: 'muted' }, 'Pick a chat, or start one from someone’s profile.')));
  }
  async function open(id) {
    root.classList.toggle('is-thread', !!id);
    document.querySelector('.bottomnav')?.classList.toggle('hidden', !!id && isMobile());
    if (!id) { S.conv = null; setActiveConversation(null); empty(); paintList(); return; }
    try {
      const [c, m] = await Promise.all([api(`/api/messages/conversations/${id}`), api(`/api/messages/conversations/${id}/messages?limit=50`)]);
      S.conv = c.conversation; S.msgs = m.messages; S.hasMore = m.hasMore; S.hidden = m.hiddenBefore; S.typing.clear(); S.editing = null;
    } catch (e) { toastErr(e); navigate('/messages', { replace: true }); return; }
    setActiveConversation(S.conv.id);
    composer = null;
    paintThread(); paintList(); markRead();
    const callId = new URLSearchParams(location.search).get('call');
    if (callId) api('/api/messages/calls/current').then((r) => { const c2 = r.calls.find((x) => x.id === callId && x.state === 'ringing' && x.myState === 'invited'); if (c2) import('../messages/call.js').then((cm) => cm.incoming({ ...c2, title: S.conv.title })); }).catch(() => {});
  }
  function presenceText(c) {
    if (c.type !== 'dm') return c.type === 'meeting' ? (c.live ? 'Meeting chat · live' : 'Meeting chat · ended') : `${c.memberCount} members`;
    if (c.peer && c.peer.deleted) return 'Account deleted';
    if (!c.presence) return '';
    return c.presence.online ? 'Online' : c.presence.lastSeenAt ? `Last seen ${timeAgo(c.presence.lastSeenAt)}` : '';
  }
  function paintThread() {
    const c = S.conv;
    const back = h('a', { class: 'icon-btn msg-back', href: '/messages', 'data-link': '', 'aria-label': 'Back to chats', html: icon('chevronLeft', { size: 22 }) });
    const av = c.type === 'dm' ? avatar(c.title, c.avatarUrl, 'md') : h('span', { class: `av md msg-av-ic ${c.type}`, html: icon(c.type === 'meeting' ? 'video' : 'users', { size: 20 }) });
    const titleEl = c.type === 'dm' && c.peer && c.peer.username ? h('a', { href: `/u/${c.peer.username}`, 'data-link': '', class: 'ellipsis' }, c.title) : h('span', { class: 'ellipsis' }, c.title);
    const canCall = c.canSend && c.type !== 'meeting';
    const head = h('header', { class: 'msg-thread-head' }, back, av,
      h('div', { class: 'msg-thread-title' }, h('b', null, titleEl), h('span', { class: 'muted tiny msg-presence' }, presenceText(c))),
      canCall ? ib('phone', 'Audio call', () => call('audio')) : null,
      canCall && c.type === 'dm' ? ib('video', 'Video call', () => call('video')) : null,
      c.canSend && c.editable ? ib('calendarPlus', 'Meet', (e) => meetMenu(e.currentTarget), 'msg-meet') : null,
      c.type === 'meeting' && c.live && c.meetingCode ? h('a', { class: 'btn sm primary', href: `/${c.meetingCode}`, 'data-link': '' }, 'Rejoin') : null,
      ib('moreV', 'More', (e) => moreMenu(e.currentTarget)));
    const foot = c.canSend ? composerEl() : h('div', { class: 'msg-readonly' }, I(c.readOnly ? 'lock' : 'info', 16), h('span', null, c.reason || 'You can’t send messages here'));
    threadPane.replaceChildren(head, msgsEl, typingEl, foot);
    paintMsgs(true);
  }
  function composerEl() {
    if (!composer) {
      composer = pillComposer({ placeholder: S.conv.type === 'dm' ? `Message ${S.conv.title}` : 'Message', maxLength: 4000,
        upload: (f, purpose) => uploadFile(f, { purpose: purpose === 'voice' ? 'voice' : 'chat' }),
        onSend: async (text, att) => {
          if (S.editing) { const id = S.editing; S.editing = null; await api(`/api/messages/conversations/${S.conv.id}/messages/${id}`, { method: 'PATCH', body: { text } }).then((r) => upsert(r.message)); return; }
          const r = await api(`/api/messages/conversations/${S.conv.id}/messages`, { method: 'POST', body: { text, attachment: att || undefined } });
          upsert(r.message, true);
        } });
      let last = 0;
      composer.ta.addEventListener('input', () => { if (Date.now() - last > 2500 && composer.ta.value) { last = Date.now(); sendTyping(S.conv.id); } });
    }
    return composer.el;
  }
  function upsert(m, scroll = false) {
    const i = S.msgs.findIndex((x) => x.id === m.id);
    if (i >= 0) S.msgs[i] = { ...S.msgs[i], ...m }; else S.msgs.push(m);
    paintMsgs(scroll);
  }
  function attEl(a) {
    if (!a) return null;
    if (a.kind === 'passage') return passageCard(a, { compact: true });
    const src = a.url || a.dataUrl; if (!src) return null;
    if (a.kind === 'image') return h('img', { class: 'msg-img', src, alt: a.name || 'image', loading: 'lazy', onclick: () => { const s = sheet({ title: a.name || 'Photo', icon: 'image', wide: true }); s.body.append(h('img', { src, alt: '', class: 'msg-img-full' })); } });
    if (a.kind === 'voice') return h('audio', { class: 'msg-voice', controls: true, src, preload: 'metadata' });
    return h('a', { class: 'msg-file', href: src, target: '_blank', rel: 'noopener', download: a.name || 'file', html: icon('file', { size: 18 }) + `<span>${esc(a.name || 'file')}</span>` });
  }
  function cardEl(p) {
    if (!p) return null;
    const ic = { meeting: 'video', schedule: 'calendar', venue: 'door' }[p.type] || 'link';
    const when = p.type === 'schedule' ? `${fmtDate(p.startsAt)} · ${p.durationMin} min${p.pattern ? ` · repeats ${p.pattern === 'biweekly' ? 'every 2 weeks' : p.pattern}` : ''}` : p.type === 'meeting' ? 'Live meeting' : 'Venue';
    return h('div', { class: 'msg-card' }, h('span', { class: 'msg-card-ic', html: icon(ic, { size: 20 }) }),
      h('div', { class: 'msg-card-main' }, h('b', null, p.title || 'Meeting'), h('span', { class: 'tiny muted' }, when), p.type === 'schedule' && p.reminders ? h('span', { class: 'tiny muted' }, 'Email reminders are on') : null),
      p.link ? h('a', { class: 'btn sm primary', href: p.link, 'data-link': '' }, p.type === 'schedule' ? 'Open' : 'Join') : null);
  }
  function msgEl(m, prev) {
    const c = S.conv;
    if (m.kind === 'system' || m.kind === 'call') return h('div', { class: `msg-sys${m.kind === 'call' ? ' call' : ''}` }, m.kind === 'call' ? I('phone', 14) : null, h('span', null, m.text), h('time', null, hhmm(m.createdAt)));
    const mine = m.mine;
    const grouped = prev && prev.fromUserId === m.fromUserId && prev.kind !== 'system' && prev.kind !== 'call' && new Date(m.createdAt) - new Date(prev.createdAt) < 5 * 60000;
    const showName = !mine && c.type !== 'dm' && !grouped;
    const body = m.deleted ? h('div', { class: 'msg-txt deleted' }, I('trash', 14), 'Message deleted')
      : h('div', null, m.text ? h('div', { class: 'msg-txt', html: linkify(m.text) }) : null, attEl(m.attachment), m.kind === 'card' ? cardEl(m.payload) : null);
    const reacts = m.reactions && m.reactions.length ? h('div', { class: 'msg-reacts' }, m.reactions.map((r) => h('button', { type: 'button', class: `msg-react${r.mine ? ' on' : ''}`, 'aria-label': `${r.emoji} ${r.count}`, onclick: () => react(m, r.emoji), disabled: !c.canSend }, `${r.emoji} ${r.count}`))) : null;
    const seen = mine && c.type === 'dm' && c.peerReadId >= m.id && m.id === lastMineId() ? h('span', { class: 'msg-seen' }, 'Seen') : null;
    const bubble = h('div', { class: 'msg-bubble' }, showName ? h('b', { class: 'msg-who' }, m.fromName) : null, body,
      h('span', { class: 'msg-meta' }, m.editedAt && !m.deleted ? 'edited · ' : '', hhmm(m.createdAt)));
    const row = h('div', { class: `msg-row${mine ? ' mine' : ''}${grouped ? ' grouped' : ''}`, 'data-id': m.id },
      !mine && c.type !== 'dm' ? (grouped ? h('span', { class: 'msg-av-gap' }) : avatar(m.fromName, null, 'sm')) : null,
      h('div', { class: 'msg-col' }, bubble, reacts, seen),
      m.deleted ? null : h('button', { class: 'icon-btn msg-more', type: 'button', 'aria-label': 'Message actions', html: icon('moreHorizontal', { size: 16 }), onclick: (e) => msgMenu(e.currentTarget, m) }));
    let pressT = null;
    row.addEventListener('touchstart', () => { pressT = setTimeout(() => !m.deleted && msgMenu(row.querySelector('.msg-bubble'), m), 450); }, { passive: true });
    row.addEventListener('touchend', () => clearTimeout(pressT)); row.addEventListener('touchmove', () => clearTimeout(pressT), { passive: true });
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
    msgsEl.replaceChildren(...out);
    if (stick) msgsEl.scrollTop = msgsEl.scrollHeight;
  }
  async function older() {
    if (S.loadingOlder || !S.msgs.length) return;
    S.loadingOlder = true;
    try {
      const r = await api(`/api/messages/conversations/${S.conv.id}/messages?before=${S.msgs[0].id}&limit=50`);
      const h0 = msgsEl.scrollHeight;
      S.msgs = [...r.messages, ...S.msgs]; S.hasMore = r.hasMore; S.hidden = r.hiddenBefore;
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
    const mm = menu(anchor, [
      c.canSend ? { label: 'React', icon: 'smile', run: () => emojiPopover(anchor, (e) => react(m, e)) } : null,
      m.text ? { label: 'Copy text', icon: 'copy', run: () => copy(m.text) } : null,
      canEdit && c.canSend ? { label: 'Edit', icon: 'pen', run: () => { S.editing = m.id; composer.setText(m.text); composer.focus(); toast('Editing — press Enter to save', { icon: 'pen' }); } } : null,
      m.mine && c.editable ? { label: 'Delete', icon: 'trash', group: 'admin', run: async () => { if (await confirmDlg('Delete this message for everyone?', { ok: 'Delete', danger: true })) api(`/api/messages/conversations/${c.id}/messages/${m.id}`, { method: 'DELETE' }).then(() => upsert({ id: m.id, deleted: true, text: '', attachment: null, payload: null })).catch(toastErr); } } : null,
      !m.mine && m.fromUserId ? { label: 'Report', icon: 'alert', group: 'admin', run: () => report(m) } : null,
    ]);
    if (c.canSend) mm.prepend(h('div', { class: 'msg-quick' }, QUICK.slice(0, 6).map((e) => h('button', { type: 'button', 'aria-label': `React ${e}`, onclick: () => { mm.remove(); react(m, e); } }, e))));
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
    s.body.append(h('div', { class: 'stack' }, f('Title', title), f('Starts', when), f('Length', dur), f('Repeat', rep),
      h('p', { class: 'tiny muted' }, 'Members get the invite at the email on their account. Repeating meetings need Premium or Organisation.'), go));
  }
  async function venueSheet() {
    const s = sheet({ title: 'Share a venue', icon: 'door' });
    let vs = [];
    try { vs = (await api('/api/venues')).venues.filter((v) => !v.archived); } catch (e) { toastErr(e); }
    if (!vs.length) { s.body.append(h('p', { class: 'muted' }, 'You don’t have a venue yet. '), h('a', { class: 'btn', href: '/venues', 'data-link': '', onclick: () => s.close() }, 'Create a venue')); return; }
    s.body.append(h('div', { class: 'msg-pick' }, vs.map((v) => h('button', { class: 'msg-pick-row', type: 'button', onclick: async () => {
      try { const r = await api(`/api/messages/conversations/${S.conv.id}/cards`, { method: 'POST', body: { type: 'venue', venueId: v.id } }); s.close(); upsert(r.message, true); } catch (e) { toastErr(e); }
    } }, I('door', 18), h('span', { class: 'grow ellipsis' }, v.name), h('span', { class: 'tiny muted' }, `/v/${v.slug}`)))));
  }
  async function patch(body, msg) {
    try { await api(`/api/messages/conversations/${S.conv.id}`, { method: 'PATCH', body }); Object.assign(S.conv, body); if (msg) toast(msg, { icon: 'check' }); loadList(); refreshUnread(); } catch (e) { toastErr(e); }
  }
  function moreMenu(anchor) {
    const c = S.conv; const group = c.type === 'group'; const admin = c.role === 'admin' || c.role === 'owner';
    menu(anchor, [
      c.canSend && c.editable && isMobile() ? { label: 'Meet', icon: 'calendarPlus', run: () => meetMenu(anchor) } : null,
      group ? { label: 'Members', icon: 'users', run: membersSheet } : null,
      group && admin && c.editable ? { label: 'Rename group', icon: 'pen', run: async () => { const t = await promptDlg('Group name', { value: c.title }); if (t) { await patch({ title: t }); S.conv.title = t; paintThread(); } } } : null,
      { label: c.pinned ? 'Unpin' : 'Pin to top', icon: 'pin', run: () => patch({ pinned: !c.pinned }) },
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
    s.body.append(h('div', { class: 'msg-pick' }, (c.members || []).map((u) => h('div', { class: 'msg-pick-row' }, avatar(u.name, u.avatarUrl, 'sm'), h('span', { class: 'grow ellipsis' }, u.name), u.role !== 'member' ? h('span', { class: 'tiny muted' }, u.role) : null,
      admin && c.editable && u.id !== state.user.id && !c.subtype?.startsWith('org') ? h('button', { class: 'btn sm ghost', type: 'button', onclick: async () => { try { await api(`/api/messages/conversations/${c.id}/members/${u.id}`, { method: 'DELETE' }); s.close(); open(c.id); } catch (e) { toastErr(e); } } }, 'Remove') : null))));
    if (admin && c.editable && !c.subtype?.startsWith('org')) {
      const picked = new Set();
      const ppl = await peopleICanAdd(new Set((c.members || []).map((u) => u.id)));
      s.body.append(h('h4', { class: 'msg-sub' }, 'Add people'), pickList(ppl, picked), ppl.length ? h('button', { class: 'btn primary', type: 'button', onclick: async () => {
        try { for (const id of picked) await api(`/api/messages/conversations/${c.id}/members`, { method: 'POST', body: { userId: id } }); s.close(); open(c.id); } catch (e) { if (e.data && e.data.upgrade) toast(e.message, { icon: 'zap', action: { label: 'Upgrade', run: () => navigate('/upgrade') } }); else toastErr(e); }
      } }, 'Add') : null);
    }
  }
  async function newGroup() {
    const s = sheet({ title: 'New group', icon: 'users' });
    const title = h('input', { class: 'input', placeholder: 'Group name', maxlength: 80 });
    const picked = new Set();
    s.body.append(h('label', { class: 'field' }, h('span', { class: 'lbl' }, 'Name'), title), h('h4', { class: 'msg-sub' }, 'Members'), pickList(await peopleICanAdd(new Set()), picked),
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
      [['everyone', 'Anyone I share a meeting, group or organisation with'], ['contacts', 'People I follow back (and my organisation)'], ['nobody', 'Nobody new']].map(([v, l]) => h('option', { value: v, selected: cfg.dmPolicy === v }, l)));
    const sw = (on, run) => { const i = h('input', { type: 'checkbox', checked: !!on, onchange: () => run(i.checked) }); return h('label', { class: 'switch' }, i, h('span')); };
    const pushRow = h('div', { class: 'msg-set-row' }, h('div', { class: 'grow' }, h('b', null, 'Notifications on this device'), h('p', { class: 'tiny muted' }, 'Checking…')));
    s.body.append(h('div', { class: 'stack' },
      h('label', { class: 'field' }, h('span', { class: 'lbl' }, 'Who can start a new chat with me'), pol),
      h('div', { class: 'msg-set-row' }, h('div', { class: 'grow' }, h('b', null, 'Hide when I’m online'), h('p', { class: 'tiny muted' }, 'You won’t see others’ status either.')), sw(cfg.hidePresence, (v) => save({ hidePresence: v }))),
      pushRow, h('h4', { class: 'msg-sub' }, 'Blocked people'), blockedList()));
    const st = await pushState();
    const p = pushRow.querySelector('p');
    if (!st.supported) p.textContent = 'This browser can’t show notifications.';
    else if (!st.enabled) p.textContent = 'Not set up on this server yet.';
    else { p.textContent = st.on ? 'On for messages and calls.' : st.permission === 'denied' ? 'Blocked in browser settings.' : 'Get alerts when you’re away.'; pushRow.append(sw(st.on, async (v) => { try { v ? await enablePush() : await disablePush(); p.textContent = v ? 'On for messages and calls.' : 'Off'; } catch (e) { toastErr(e); } })); }
  }
  function blockedList() {
    const box = h('div', { class: 'msg-pick' }, h('p', { class: 'tiny muted' }, 'Loading…'));
    api('/api/messages/blocks').then((r) => {
      if (!r.blocked.length) return box.replaceChildren(h('p', { class: 'tiny muted' }, 'Nobody.'));
      box.replaceChildren(...r.blocked.map((u) => h('div', { class: 'msg-pick-row' }, avatar(u.name, u.avatarUrl, 'sm'), h('span', { class: 'grow ellipsis' }, u.name),
        h('button', { class: 'btn sm ghost', type: 'button', onclick: async (e) => { await api(`/api/messages/blocks/${u.id}`, { method: 'DELETE' }).catch(toastErr); e.target.closest('.msg-pick-row').remove(); loadList(); } }, 'Unblock'))));
    }).catch(() => {});
    return box;
  }

  // ------------------------------------------------------------- live events
  const on = (t, f) => { const g = (e) => f(e.detail); bus.addEventListener(t, g); offs.push(() => bus.removeEventListener(t, g)); };
  const offs = [];
  const reloadList = debounce(loadList, 400);
  on('message', (m) => {
    reloadList();
    if (S.conv && Number(m.conversationId) === S.conv.id) { S.typing.delete(m.message.fromUserId); paintTyping(); upsert(m.message, m.message.mine || m.message.fromUserId === state.user.id); markRead(); }
  });
  on('message-edited', (m) => { if (S.conv && m.conversationId === S.conv.id) upsert(m.message); });
  on('message-deleted', (m) => { if (S.conv && m.conversationId === S.conv.id) upsert({ id: m.messageId, deleted: true, text: '', attachment: null, payload: null }); reloadList(); });
  on('reaction', (m) => { if (S.conv && m.conversationId === S.conv.id && S.msgs.some((x) => x.id === m.messageId)) upsert({ id: m.messageId, reactions: m.reactions }); });
  on('read', (m) => { if (S.conv && m.conversationId === S.conv.id && m.userId !== state.user.id) { S.conv.peerReadId = Math.max(S.conv.peerReadId || 0, m.messageId); paintMsgs(false); } });
  on('conversation-updated', () => reloadList());
  on('open', () => { if (S.conv) open(S.conv.id); else loadList(); });
  on('typing', (m) => {
    if (!S.conv || m.conversationId !== S.conv.id) return;
    S.typing.set(m.userId, { name: m.name, at: Date.now() }); paintTyping();
    setTimeout(paintTyping, 4200);
  });
  function paintTyping() {
    for (const [k, v] of S.typing) if (Date.now() - v.at > 4000) S.typing.delete(k);
    const names = [...S.typing.values()].map((v) => v.name);
    typingEl.hidden = !names.length;
    typingEl.textContent = names.length ? (S.conv.type === 'dm' ? 'typing…' : `${names.slice(0, 2).join(', ')} ${names.length > 1 ? 'are' : 'is'} typing…`) : '';
  }
  const onVis = () => { if (document.visibilityState === 'visible' && S.conv) markRead(); };
  document.addEventListener('visibilitychange', onVis);
  const onResize = debounce(() => document.querySelector('.bottomnav')?.classList.toggle('hidden', !!S.conv && isMobile()), 150);
  window.addEventListener('resize', onResize);

  paintChips();
  await loadList();
  await open(params.id ? Number(params.id) : null);
  return {
    unmount() {
      offs.forEach((f) => f()); setActiveConversation(null); barVisible(true);
      document.removeEventListener('visibilitychange', onVis); window.removeEventListener('resize', onResize);
      document.querySelector('.bottomnav')?.classList.remove('hidden');
    },
  };
}
