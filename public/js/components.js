// Shared building blocks: event cards, posts, comment threads, people rows.
import { icon, LOGO_ART } from './icons.js';
import { h, api, avatar, timeAgo, fmtDate, fmtNum, toast, toastErr, esc, confirmDlg, frag, profilePath } from './ui.js';
import { state, navigate, requireLogin } from './app.js';
import { pillComposer } from './composer.js';
import { passageCard } from './passage.js';

function linkify(s) {
  return String(s || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/(https?:\/\/[^\s<]+|\/a\/[a-f0-9]{32,})/g, (m) =>
      `<a class="feed-link-chip" href="${m}" data-link><span class="feed-link-ic">${icon('link', { size: 13 })}</span><span class="feed-link-url">${m}</span></a>`);
}

export const CAT = {
  talk_show: ['Talk show', 'tv', '#db2777'], presentation: ['Presentation', 'presentation', '#2563eb'], seminar: ['Seminar', 'graduation', '#7c3aed'],
  sermon: ['Sermon', 'church', '#b7791f'], webinar: ['Webinar', 'globe', '#0891b2'], workshop: ['Workshop', 'wrench', '#ea580c'],
  meeting: ['Meeting', 'users', '#475569'], concert: ['Concert', 'music', '#e11d48'], class: ['Class', 'book', '#059669'], other: ['Event', 'sparkle', '#64748b'],
};
export const catOf = (k) => CAT[k] || CAT.other;

export function eventCard(ev, { compact = false } = {}) {
  const [cl, ci] = catOf(ev.category);
  const dateLabel = ev.startsAt ? fmtDate(ev.startsAt, { weekday: undefined }) : null;
  const host = ev.host ? h('span', { class: 'ev-meta-item ev-host' },
    avatar(ev.host.name, ev.host.avatarUrl, 'sm'),
    h('span', { class: 'ev-host-name' }, ev.host.name || ''),
    ev.host.verified ? h('span', { class: 'verified-dot', title: 'Verified host', 'aria-label': 'Verified host', html: icon('check', { size: 11 }) }) : null) : null;
  const when = dateLabel ? h('span', { class: 'ev-meta-when' },
    h('span', { class: 'ev-meta-item ev-when' },
      h('span', { class: 'ic', html: icon('calendar', { size: 13 }) }), h('span', { class: 'ev-meta-txt' }, dateLabel))) : null;
  const meta = [host, when].filter(Boolean);
  return h('a', { class: 'ev-tile' + (compact ? ' compact' : ''), href: `/e/${ev.slug}`, 'data-link': '', 'aria-label': ev.title || 'Event' },
    h('div', { class: 'cover' },
      ev.coverUrl ? h('img', { src: ev.coverUrl, alt: '', loading: 'lazy' }) : h('div', { class: 'art', html: LOGO_ART }),
      h('div', { class: 'body' },
        h('span', { class: 'ev-cat', html: icon(ci, { size: 8 }) + `<span class="ev-cat-lbl">${esc(cl)}</span>` }),
        h('div', { class: 'title' }, ev.title),
        meta.length ? h('div', { class: 'ev-meta' }, ...meta) : null)));
}

function isLiveEvent(ev) {
  return ev.status === 'live' || !!ev.live;
}
function startOfDay(d) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}
function railWhenParts(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const days = Math.round((startOfDay(d) - startOfDay(new Date())) / 864e5);
  const clock = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  if (days === 0) {
    const m = clock.match(/^(.*?)(\s*([AP]M))$/i);
    return { mon: 'Today', day: m ? m[1].trim() : clock, tm: m ? m[2].trim() : '', soon: true };
  }
  return {
    mon: d.toLocaleString(undefined, { weekday: 'short' }),
    day: String(d.getDate()),
    tm: clock,
    soon: false,
  };
}
function relativeSoon(iso) {
  const mins = Math.round((new Date(iso) - Date.now()) / 60000);
  if (mins < 0 || mins >= 24 * 60) return null;
  if (mins < 60) return `in ${Math.max(1, mins)} min`;
  const hrs = Math.round(mins / 60);
  return `in ${hrs} hour${hrs === 1 ? '' : 's'}`;
}
function railCat(ev) {
  const [cl, , cc] = catOf(ev.category);
  return h('span', { class: 'cat', style: { '--g': cc } }, cl);
}
function railMeta(...bits) {
  const parts = bits.filter(Boolean);
  const kids = [];
  parts.forEach((b, i) => {
    if (i) kids.push(h('span', { class: 'rail-dot' }));
    kids.push(typeof b === 'string' ? b : b);
  });
  return h('span', { class: 'rail-meta' }, ...kids);
}
function railWhenEl(ev) {
  if (isLiveEvent(ev)) {
    return h('span', { class: 'rail-when soon' }, h('span', { class: 'mon' }, 'Live'), h('span', { class: 'day' }, 'Now'));
  }
  const parts = ev.startsAt ? railWhenParts(ev.startsAt) : null;
  if (!parts) return h('span', { class: 'rail-when' }, h('span', { class: 'day' }, '-'));
  return h('span', { class: 'rail-when' + (parts.soon ? ' soon' : '') },
    h('span', { class: 'mon' }, parts.mon),
    h('span', { class: 'day' }, parts.day),
    parts.tm ? h('span', { class: 'tm' }, parts.tm) : null);
}
function railThumb(ev, size) {
  return h('span', { class: 'rail-thumb' + (size === 'sm' ? ' sm' : '') },
    ev.coverUrl ? h('img', { src: ev.coverUrl, alt: '', loading: 'lazy' }) : h('span', { class: 'rail-thumb-ph' }));
}

/** Time-first compact row for the event-page "Happening soon" / "Live now" rail. */
export function railSoonRow(ev) {
  const live = isLiveEvent(ev);
  const viewers = ev.live?.viewers ?? ev.liveViewers ?? 0;
  const rel = !live && ev.startsAt ? relativeSoon(ev.startsAt) : null;
  return h('a', { class: 'rail-row', href: `/e/${ev.slug}`, 'data-link': '' },
    railWhenEl(ev),
    h('span', { class: 'rail-body' },
      h('span', { class: 'rail-title' }, ev.title),
      railMeta(railCat(ev), rel || ev.host?.name || (live && viewers ? `${fmtNum(viewers)} watching` : null))));
}

/** Mini thumbnail row used under a featured "More from this host" card. */
export function railMiniRow(ev) {
  const date = ev.startsAt ? new Date(ev.startsAt).toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short' }) : null;
  return h('a', { class: 'rail-row', href: `/e/${ev.slug}`, 'data-link': '' },
    railThumb(ev, 'sm'),
    h('span', { class: 'rail-body' },
      h('span', { class: 'rail-title sm' }, ev.title),
      railMeta(railCat(ev), date)));
}

/** Flush 16:9 featured card with a date pill on the image. */
export function railFeatured(ev) {
  const [cl, , cc] = catOf(ev.category);
  const live = isLiveEvent(ev);
  const c1 = ev.theme?.accent || cc, c2 = ev.theme?.accent2 || 'var(--accent-2)';
  const pill = live
    ? h('span', { class: 'pill live' }, 'LIVE')
    : ev.startsAt
      ? h('span', { class: 'pill' }, new Date(ev.startsAt).toLocaleString(undefined, { day: 'numeric', month: 'short' }))
      : null;
  return h('a', { class: 'rail-feature', href: `/e/${ev.slug}`, 'data-link': '' },
    h('div', { class: 'rail-cover', style: { '--c1': c1, '--c2': c2 } },
      ev.coverUrl ? h('img', { src: ev.coverUrl, alt: '', loading: 'lazy' }) : null,
      pill),
    h('div', { class: 'rail-feature-body' },
      h('span', { class: 'cat', style: { '--g': cc } }, cl),
      h('span', { class: 'rail-title' }, ev.title)));
}

/** Featured card + up to two mini rows for "More from this host". */
export function railHostBlock(events) {
  const list = (events || []).slice(0, 3);
  if (!list.length) return [];
  const [feat, ...rest] = list;
  return [
    railFeatured(feat),
    rest.length ? h('div', { class: 'rail-mini' }, ...rest.map(railMiniRow)) : null,
  ];
}

export const skeletonCards = (n = 6) => h('div', { class: 'grid-cards' }, Array.from({ length: n }, () => h('div', { class: 'skel', style: { height: '250px' } })));

export function followBtn(user, onChange) {
  const b = h('button', { class: `btn sm ${user.isFollowing ? '' : 'primary'}` });
  const paint = () => { b.innerHTML = user.isFollowing ? icon('userCheck', { size: 16 }) + 'Following' : icon('userPlus', { size: 16 }) + 'Follow'; b.className = `btn sm ${user.isFollowing ? '' : 'primary'}`; };
  paint();
  b.onclick = async (e) => {
    e.preventDefault(); e.stopPropagation();
    if (!requireLogin('Sign in to follow people')) return;
    const on = !user.isFollowing; user.isFollowing = on; paint();
    try { await api(`/api/users/${user.id}/follow`, { method: 'POST', body: { on } }); onChange && onChange(on); } catch (er) { user.isFollowing = !on; paint(); toastErr(er); }
  };
  return b;
}
export function personRow(u, { follow = true } = {}) {
  return h('a', { class: 'list-item', href: profilePath(u), 'data-link': '' }, avatar(u.name, u.avatarUrl),
    h('div', { class: 'grow' }, h('div', { style: { fontWeight: 700 }, class: 'ellipsis' }, u.name), h('div', { class: 'tiny muted ellipsis' }, u.handle ? '@' + u.handle : (u.username ? '@' + u.username : ''), u.followers != null ? ` · ${fmtNum(u.followers)} followers` : '')),
    follow && state.user && state.user.id !== u.id ? followBtn(u) : null);
}

const POST_KIND = {
  event_scheduled: ['scheduled an event', 'calendar'],
  event_live: ['is live now', 'radio'],
  event_ended: ['wrapped up', 'check'],
  summary: ['shared a session summary', 'sparkles'],
};

function feedEventBlock(ev) {
  if (!ev) return null;
  return h('div', { class: 'feed-event' }, eventCard(ev));
}

export function postCard(p, { onDelete } = {}) {
  const kind = POST_KIND[p.kind];
  const likeBtn = h('button', { class: `act${p.liked ? ' liked' : ''}`, 'data-group': 'engage', 'data-tip': 'Like', html: icon('heart', { size: 18 }) + `<span>${fmtNum(p.likeCount)}</span>` });
  likeBtn.onclick = async () => {
    if (!requireLogin('Sign in to like posts')) return;
    p.liked = !p.liked; p.likeCount += p.liked ? 1 : -1;
    likeBtn.classList.toggle('liked', p.liked);
    likeBtn.lastChild.textContent = fmtNum(p.likeCount);
    try {
      const r = await api(`/api/posts/${p.id}/like`, { method: 'POST' });
      if (r && r.likeCount != null) likeBtn.lastChild.textContent = fmtNum(r.likeCount);
    } catch (e) { toastErr(e); }
  };
  const thread = h('div', { class: 'feed-thread' });
  const cBtn = h('button', { class: 'act', 'data-group': 'social', 'data-tip': 'Comments', html: icon('chat', { size: 18 }) + `<span>${fmtNum(p.commentCount)}</span>` });
  cBtn.onclick = () => {
    if (thread.firstChild) { thread.innerHTML = ''; return; }
    thread.append(commentThread('posts', p.id, { compact: true }));
  };
  const shareBtn = h('button', { class: 'act', 'data-group': 'content', 'data-tip': 'Share', html: icon('share', { size: 18 }) });
  shareBtn.onclick = () => shareLink(
    p.event ? `${location.origin}/e/${p.event.slug}` : `${location.origin}${profilePath(p.author)}`,
    p.event?.title || '1venue',
  );
  const bookmarkBtn = h('button', { class: 'act', 'data-group': 'content', 'data-tip': 'Save', html: icon('bookmark', { size: 18 }) });
  bookmarkBtn.onclick = () => toast('Saved for later', { icon: 'bookmark', group: 'content' });

  const mine = state.user && p.author && state.user.id === p.author.id;
  const menuBtn = h('button', {
    class: 'icon-btn sm feed-more', type: 'button',
    'data-tip': 'More', 'aria-label': 'More',
    html: icon('moreHorizontal', { size: 18 }),
    onclick: async (e) => {
      e.stopPropagation();
      if (!mine) return toast('More actions coming soon', { icon: 'info' });
      if (await confirmDlg('Delete this post?', { ok: 'Delete', danger: true })) {
        await api(`/api/posts/${p.id}`, { method: 'DELETE' }).catch(toastErr);
        el.remove();
        onDelete && onDelete();
      }
    },
  });

  const isEventPost = !!(p.event && (p.kind === 'event_scheduled' || p.kind === 'event_live' || p.kind === 'event_ended' || !p.body));
  const el = h('article', { class: `card feed-post${isEventPost ? ' is-event' : ''}` },
    h('div', { class: 'feed-post-head' },
      h('a', { class: 'feed-post-av', href: profilePath(p.author), 'data-link': '' }, avatar(p.author.name, p.author.avatarUrl)),
      h('div', { class: 'feed-post-meta grow' },
        h('a', { class: 'name', href: profilePath(p.author), 'data-link': '' }, p.author.name),
        kind
          ? h('span', { class: 'feed-post-kind muted small', html: icon(kind[1], { size: 13, cls: 'inline' }) + ' ' + kind[0] })
          : null,
        h('span', { class: 'faint small' }, (kind ? ' · ' : '') + timeAgo(p.createdAt))),
      menuBtn),
    p.body && (p.kind === 'post' || !p.kind)
      ? h('div', { class: 'feed-post-text', html: linkify(p.body) })
      : p.body && p.kind === 'summary'
        ? h('div', { class: 'feed-post-text prose small' }, p.body.slice(0, 600))
        : null,
    ...(p.media || []).filter((m) => m.type === 'passage').slice(0, 1).map((m) => passageCard(m)),
    ...(p.media || []).filter((m) => m.type !== 'passage' && /^image\//.test(m.mime || 'image/')).slice(0, 4).map((m) =>
      h('img', { class: 'feed-post-img', src: m.url, alt: '', loading: 'lazy' })),
    p.event ? feedEventBlock(p.event) : null,
    h('div', { class: 'feed-post-foot' },
      h('div', { class: 'acts' }, likeBtn, cBtn, shareBtn, bookmarkBtn),
      p.event
        ? h('a', { class: 'btn sm feed-view-event', href: `/e/${p.event.slug}`, 'data-link': '', html: 'View Event ' + icon('arrowRight', { size: 14 }) })
        : null),
    thread);
  return el;
}
export async function shareLink(url, title = '1venue') {
  if (navigator.share) { try { await navigator.share({ title, url }); return; } catch { /* cancelled */ } }
  try { await navigator.clipboard.writeText(url); toast('Link copied', { icon: 'link', group: 'content' }); } catch { prompt('Copy link', url); }
}

/* Social comment section (REST: events/posts). Likes, replies, owner/host hide. */
export function commentThread(kind, id, { compact = false, isHost = false } = {}) {
  const wrap = h('div', { class: 'col', style: { gap: '.2rem', marginTop: compact ? '.5rem' : 0 } });
  const list = h('div', { class: 'col', style: { gap: '.1rem' } });
  let replyTo = null;
  const replyChip = h('div', { class: 'tiny muted hidden', style: { padding: '.15rem .9rem 0' } });
  const pc = pillComposer({ placeholder: state.user ? 'Add to the conversation…' : 'Sign in to comment', voice: false, onSend: async (body) => {
    if (!requireLogin('Sign in to join the conversation')) return false;
    if (!body) return false;
    const c = await api(`/api/${kind}/${id}/comments`, { method: 'POST', body: { body, parentId: replyTo?.c.id || null } });
    list.querySelector('.no-comments')?.remove();
    if (replyTo) { replyTo.addReply(c); setReply(null); } else list.prepend(commentEl(c));
  } });
  const ta = pc.ta;
  function setReply(r) { replyTo = r; replyChip.classList.toggle('hidden', !r); replyChip.innerHTML = r ? `Replying to <strong>${esc(r.c.authorName)}</strong> · <a href="#" class="cancel">cancel</a>` : ''; if (r) { replyChip.querySelector('.cancel').onclick = (e) => { e.preventDefault(); setReply(null); }; ta.focus(); } }
  function commentEl(c, depth = 0) {
    const replies = h('div', { class: 'replies col', style: { gap: 0 } });
    const like = h('button', { class: `act${c.liked ? ' liked' : ''}`, 'data-group': 'engage', html: icon('heart', { size: 15 }) + `<span>${c.likeCount || ''}</span>` });
    like.onclick = async () => {
      if (!requireLogin('Sign in to like comments')) return;
      try { const r = await api(`/api/comments/${c.id}/like`, { method: 'POST' }); c.liked = r.liked; like.classList.toggle('liked', r.liked); like.lastChild.textContent = r.likeCount || ''; } catch (e) { toastErr(e); }
    };
    const addReply = (r) => { replies.append(commentEl(r, depth + 1)); c.replyCount = (c.replyCount || 0) + 1; };
    const replyBtn = depth === 0 ? h('button', { class: 'act', 'data-group': 'social', html: icon('reply', { size: 15 }) + 'Reply', onclick: () => setReply({ c, addReply }) }) : null;
    const more = c.replyCount && depth === 0 ? h('button', { class: 'act', html: icon('chevronDown', { size: 15 }) + `${c.replyCount} ${c.replyCount === 1 ? 'reply' : 'replies'}` }) : null;
    if (more) more.onclick = async () => { more.remove(); try { const r = await api(`/api/comments/${c.id}/replies`); r.replies.forEach((x) => replies.append(commentEl(x, 1))); } catch (e) { toastErr(e); } };
    const canHide = c.mine || isHost;
    const el = h('div', { class: 'post', style: { padding: '.55rem .3rem' } },
      c.userId ? h('a', { href: profilePath({ username: c.username, id: c.userId }), 'data-link': '' }, avatar(c.authorName, c.avatarUrl, depth ? 'sm' : '')) : avatar(c.authorName, c.avatarUrl, depth ? 'sm' : ''),
      h('div', { class: 'grow', style: { minWidth: 0 } },
        h('div', { class: 'head' }, h('span', { class: 'name small' }, c.authorName), h('span', { class: 'faint tiny' }, timeAgo(c.createdAt))),
        h('div', { class: 'text small' }, c.body),
        h('div', { class: 'acts' }, like, replyBtn, more,
          canHide ? h('button', { class: 'act', 'data-group': 'admin', 'data-tip': c.mine ? 'Delete' : 'Hide (host)', html: icon('trash', { size: 14 }), onclick: async () => { try { await api(`/api/comments/${c.id}`, { method: 'DELETE' }); el.remove(); } catch (e) { toastErr(e); } } }) : null),
        replies));
    return el;
  }
  wrap.append(h('div', { class: 'comment-compose' }, replyChip, pc.el), list);
  api(`/api/${kind}/${id}/comments`).then((r) => {
    if (!r.comments.length) list.append(h('div', { class: 'faint small no-comments', style: { padding: '.8rem .4rem' } }, 'No comments yet - start the conversation.'));
    r.comments.forEach((c) => list.append(commentEl(c)));
  }).catch(() => list.append(h('div', { class: 'faint small' }, 'Comments unavailable.')));
  return wrap;
}
export function sectionHead(title, ic, action) {
  return h('div', { class: 'section-h' }, h('h2', { html: (ic ? icon(ic, { size: 22 }) : '') + esc(title) }), action || null);
}
export function empty(ic, title, sub, action) {
  return h('div', { class: 'empty' }, frag(icon(ic, { size: 40 })), h('h3', null, title), sub ? h('p', { class: 'small', style: { marginTop: '.3rem' } }, sub) : null, action ? h('div', { style: { marginTop: '1rem' } }, action) : null);
}
