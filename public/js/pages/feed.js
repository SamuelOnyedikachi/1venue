import { icon } from '../icons.js';
import { h, api, toast, toastErr, avatar, uploadFile, fmtDate, profilePath } from '../ui.js';
import { state, requireLogin, loginUrl } from '../app.js';
import { postCard, empty, personRow } from '../components.js';
import { passageCard } from '../passage.js';
import { promoInline, promoCompact, loadPromos } from '../promo.js';

const FILTERS = [
  ['all', 'All'],
  ['following', 'Following'],
  ['events', 'Events'],
  ['verses', 'Verses'],
  ['live', 'Live'],
];
const WIDE_RAIL = '(min-width: 1024px)';

export function composer(onPost, { prefill = '', eventId, passage = null, autofocus = false } = {}) {
  const ta = h('textarea', {
    class: 'feed-compose-input',
    placeholder: 'Share a thought, a verse, or what you’re hosting next…',
    rows: 2,
    maxlength: 2000,
  });
  ta.value = prefill;
  let media = [];
  const thumbs = h('div', { class: 'row wrap feed-compose-thumbs' });
  const pBox = h('div');
  const paintPassage = () => pBox.replaceChildren(...(passage ? [passageCard(passage, { compact: true, onRemove: () => { passage = null; paintPassage(); } })] : []));
  paintPassage();
  if (autofocus) setTimeout(() => ta.focus(), 120);

  const file = h('input', { type: 'file', accept: 'image/*', class: 'hidden' });
  file.onchange = async () => {
    const f = file.files[0]; if (!f) return;
    try {
      const r = await uploadFile(f, { purpose: 'post' });
      media.push({ url: r.url, mime: r.mime });
      thumbs.append(h('img', { src: r.url, alt: '', class: 'feed-compose-thumb' }));
    } catch (e) { toastErr(e); }
  };

  const btn = h('button', { class: 'btn primary feed-post-btn', type: 'button', html: icon('send', { size: 16 }) + ' Post' });
  ta.addEventListener('input', () => {
    ta.style.height = 'auto';
    ta.style.height = Math.min(160, Math.max(44, ta.scrollHeight)) + 'px';
  });

  btn.onclick = async () => {
    if (!requireLogin('Sign in to post')) return;
    if (!ta.value.trim() && !media.length && !passage) return;
    btn.disabled = true;
    try {
      const p = await api('/api/posts', {
        method: 'POST',
        body: { body: ta.value.trim(), media: passage ? [{ type: 'passage', ...passage }, ...media] : media, eventId },
      });
      ta.value = ''; media = []; passage = null; paintPassage(); thumbs.innerHTML = '';
      onPost && onPost(p);
      toast('Posted', { icon: 'check', group: 'social' });
    } catch (e) { toastErr(e); } finally { btn.disabled = false; }
  };

  return h('div', { class: 'card feed-compose' },
    h('div', { class: 'feed-compose-top' },
      state.user ? avatar(state.user.displayName, state.user.avatarUrl) : null,
      ta),
    pBox, thumbs,
    h('div', { class: 'feed-compose-bar' },
      h('div', { class: 'feed-compose-tools' },
        h('button', { class: 'icon-btn sm', type: 'button', 'data-group': 'content', 'data-tip': 'Add photo', 'aria-label': 'Add photo', html: icon('image', { size: 18 }), onclick: () => file.click() }),
        file,
        h('span', { class: 'feed-compose-sep' }),
        h('button', { class: 'icon-btn sm', type: 'button', 'data-group': 'media', 'data-tip': 'Add video', 'aria-label': 'Add video', html: icon('video', { size: 18 }), onclick: () => toast('Video posts coming soon', { icon: 'info' }) }),
        h('span', { class: 'feed-compose-sep' }),
        h('a', { class: 'icon-btn sm', href: '/create', 'data-link': '', 'data-group': 'engage', 'data-tip': 'Schedule an event', 'aria-label': 'Schedule an event', html: icon('calendar', { size: 18 }) }),
      ),
      btn));
}

function sectionHead(label) {
  return h('div', { class: 'feed-rail-head tiny faint' }, label);
}

function signInBtn(label = 'Sign in') {
  const href = loginUrl('/feed');
  const a = h('a', { class: 'btn primary sm', href }, label);
  if (!/^https?:/i.test(href)) a.setAttribute('data-link', '');
  return a;
}

function youCard() {
  const u = state.user;
  if (!u) {
    return h('div', { class: 'feed-card feed-you' },
      h('p', { class: 'small feed-you-copy' }, 'Sign in to post, follow hosts, and see your upcoming events.'),
      signInBtn());
  }
  const name = u.displayName || u.username || 'You';
  return h('div', { class: 'feed-card feed-you' },
    h('a', { class: 'feed-you-id', href: profilePath(u), 'data-link': '' },
      avatar(name, u.avatarUrl),
      h('div', { class: 'grow min0' },
        h('strong', { class: 'ellipsis' }, name),
        h('div', { class: 'tiny muted ellipsis' }, u.username ? '@' + u.username : ''))),
    h('nav', { class: 'feed-you-links', 'aria-label': 'Your pages' },
      h('a', { href: '/dashboard', 'data-link': '', html: icon('calendar', { size: 15 }) + ' My events' }),
      h('a', { href: '/venues', 'data-link': '', html: icon('door', { size: 15 }) + ' My venues' })));
}

function filterNav(current, onPick, { chips = false } = {}) {
  const nav = h('nav', {
    class: chips ? 'chips feed-chips-row' : 'feed-filters',
    'aria-label': 'Feed filters',
  });
  const paint = (value) => {
    current = value;
    for (const b of nav.querySelectorAll('button')) {
      const on = b.dataset.filter === current;
      b.classList.toggle('on', on);
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
    }
  };
  for (const [value, label] of FILTERS) {
    const b = h('button', {
      class: chips ? 'chip' : 'feed-filter',
      type: 'button',
      'data-filter': value,
      'aria-pressed': value === current ? 'true' : 'false',
    }, label);
    if (value === current) b.classList.add('on');
    b.onclick = () => { if (value === current) return; paint(value); onPick(value); };
    nav.append(b);
  }
  nav.setFilter = paint;
  return nav;
}

function upcomingList(events) {
  if (!events || !events.length) return null;
  return h('section', { class: 'feed-card feed-upcoming', 'aria-label': 'Your upcoming' },
    sectionHead('Your upcoming'),
    ...events.slice(0, 3).map((ev) => {
      const live = ev.status === 'live' || ev.live;
      return h('a', { class: 'feed-mini', href: `/e/${ev.slug}`, 'data-link': '' },
        ev.coverUrl ? h('img', { class: 'feed-mini-thumb', src: ev.coverUrl, alt: '', loading: 'lazy' })
          : h('div', { class: 'feed-mini-thumb ph', html: icon('calendar', { size: 14 }) }),
        h('div', { class: 'grow min0' },
          h('div', { class: 'feed-mini-title ellipsis' }, ev.title),
          h('div', { class: 'tiny muted ellipsis' }, live ? 'Live now' : (ev.startsAt ? fmtDate(ev.startsAt, { weekday: undefined }) : 'Scheduled'))));
    }));
}

function liveNow(events) {
  const box = h('section', { class: 'feed-card feed-live', 'aria-label': 'Live now' }, sectionHead('Live now'));
  if (!events || !events.length) {
    box.append(h('p', { class: 'small muted feed-empty-line' }, 'Nothing is live right now.'));
    return box;
  }
  for (const ev of events.slice(0, 6)) {
    const viewers = ev.live?.viewers ?? ev.liveViewers ?? 0;
    box.append(h('a', { class: 'feed-mini', href: `/e/${ev.slug}`, 'data-link': '' },
      ev.coverUrl ? h('img', { class: 'feed-mini-thumb', src: ev.coverUrl, alt: '', loading: 'lazy' })
        : h('div', { class: 'feed-mini-thumb ph live', html: icon('radio', { size: 14 }) }),
      h('div', { class: 'grow min0' },
        h('div', { class: 'feed-mini-title ellipsis' }, ev.title),
        h('div', { class: 'tiny muted row', style: { gap: '.35rem' } },
          h('span', { class: 'feed-live-dot' }, 'LIVE'),
          viewers ? h('span', {}, viewers + (viewers === 1 ? ' watching' : ' watching')) : null))));
  }
  return box;
}

function promotedBox(items) {
  const list = (items || []).slice(0, 2).map((it) => promoCompact(it)).filter(Boolean);
  if (!list.length) return null;
  return h('section', { class: 'feed-card feed-promoted', 'aria-label': 'Promoted' },
    sectionHead('Promoted'), ...list);
}

function suggestedBox(people) {
  if (!people || !people.length) return null;
  return h('section', { class: 'feed-card feed-suggested', 'aria-label': 'Suggested hosts' },
    sectionHead('Suggested hosts'),
    ...people.slice(0, 3).map((u) => personRow(u, { follow: true })));
}

function verseBox(verse) {
  if (!verse || !verse.ref) return null;
  const text = String(verse.text || '').trim();
  return h('section', { class: 'feed-card feed-verse', 'aria-label': "Today's verse" },
    sectionHead("Today's verse"),
    h('a', { class: 'feed-verse-link', href: verse.href || ('/books?ref=' + encodeURIComponent(verse.ref)), 'data-link': '' },
      h('div', { class: 'feed-verse-ref' }, verse.ref, verse.translation ? h('span', { class: 'tiny faint' }, ' · ' + verse.translation) : null),
      text ? h('p', { class: 'feed-verse-text' }, text) : null));
}

function slimScroll(el) {
  let t = 0;
  const on = () => {
    el.classList.add('is-scrolling');
    clearTimeout(t);
    t = setTimeout(() => el.classList.remove('is-scrolling'), 700);
  };
  el.addEventListener('scroll', on, { passive: true });
  return () => { el.removeEventListener('scroll', on); clearTimeout(t); };
}

function syncCmdbar(center) {
  const apply = () => {
    const mq = window.matchMedia(WIDE_RAIL);
    if (!mq.matches || !center.isConnected) {
      document.documentElement.style.removeProperty('--feed-cmd-left');
      document.documentElement.style.removeProperty('--feed-cmd-width');
      return;
    }
    const r = center.getBoundingClientRect();
    if (r.width < 200) return;
    document.documentElement.style.setProperty('--feed-cmd-left', Math.round(r.left) + 'px');
    document.documentElement.style.setProperty('--feed-cmd-width', Math.round(r.width) + 'px');
  };
  const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(apply) : null;
  ro && ro.observe(center);
  window.addEventListener('resize', apply);
  apply();
  requestAnimationFrame(apply);
  return () => {
    ro && ro.disconnect();
    window.removeEventListener('resize', apply);
    document.documentElement.style.removeProperty('--feed-cmd-left');
    document.documentElement.style.removeProperty('--feed-cmd-width');
  };
}

function emptyCopy(filter) {
  if (filter === 'following' && !state.user) {
    return { icon: 'users', title: 'Follow hosts you like', body: 'Sign in to see posts from people you follow.', cta: true };
  }
  if (filter === 'following') return { icon: 'users', title: 'Your following feed is quiet', body: 'Follow hosts or post something to get it going.' };
  if (filter === 'events') return { icon: 'calendar', title: 'No event posts yet', body: 'When people schedule or go live, those posts show up here.' };
  if (filter === 'verses') return { icon: 'book', title: 'No verses in the feed', body: 'Share a passage from Books to start this thread.' };
  if (filter === 'live') return { icon: 'radio', title: 'Nothing is live', body: 'Live event posts will appear here when a host goes on air.' };
  return { icon: 'feed', title: 'The feed is quiet', body: 'Be the first to post, or follow a host to fill it up.' };
}

export async function mount(view, params) {
  document.body.dataset.page = 'feed';

  let filter = FILTERS.some(([v]) => v === params.filter) ? params.filter : 'all';
  const prefill = sessionStorage.getItem('venue.compose') || '';
  sessionStorage.removeItem('venue.compose');
  let passage = null;
  try { passage = JSON.parse(sessionStorage.getItem('venue.compose.passage') || 'null'); } catch { /* */ }
  sessionStorage.removeItem('venue.compose.passage');

  const list = h('div', { class: 'feed-stream', 'data-promo-slot': '5' },
    h('div', { class: 'skel', style: { height: '140px' } }),
    h('div', { class: 'skel', style: { height: '180px' } }));

  let comp;
  if (state.user) {
    comp = composer((p) => {
      list.querySelector('.empty')?.remove();
      list.prepend(postCard(p));
    }, { prefill, passage });
  } else {
    comp = h('div', { class: 'card feed-compose feed-compose-guest row between', style: { padding: '1rem 1.1rem' } },
      h('span', { class: 'muted' }, 'Sign in to post, like and comment.'), signInBtn());
  }

  const head = h('div', { class: 'feed-head' },
    h('h1', { class: 'feed-title', html: icon('feed', { size: 24 }) + ' Feed' }),
    comp);

  const onFilter = (value) => { filter = value; reload(); };
  const leftFilters = filterNav(filter, onFilter);
  const chipFilters = filterNav(filter, (value) => { leftFilters.setFilter(value); onFilter(value); }, { chips: true });
  const origLeft = leftFilters.setFilter;
  leftFilters.setFilter = (v) => { origLeft(v); chipFilters.setFilter(v); };

  const upcomingSlot = h('div');
  const left = h('aside', { class: 'feed-rail feed-left', 'aria-label': 'Your feed' },
    youCard(),
    h('div', { class: 'feed-card' }, sectionHead('Feed'), leftFilters),
    upcomingSlot);

  const liveSlot = h('div');
  const promoSlot = h('div');
  const verseSlot = h('div');
  const suggestSlot = h('div');
  const right = h('aside', { class: 'feed-rail feed-right', 'aria-label': 'Feed highlights' },
    liveSlot, promoSlot, verseSlot, suggestSlot);

  const center = h('div', { class: 'feed-center' }, head, chipFilters, list);
  const shell = h('div', { class: 'feed-shell' }, left, center, right);
  view.append(shell);

  if (params.compose && state.user) setTimeout(() => comp.querySelector('textarea')?.focus(), 100);

  const stopScroll = [slimScroll(left), slimScroll(right)];
  const stopCmd = syncCmdbar(center);

  let before = null, loading = false, done = false;
  const more = h('div', { class: 'feed-sentinel' });
  async function page() {
    if (loading || done) return;
    loading = true;
    try {
      const q = new URLSearchParams({ filter });
      if (before) q.set('before', before);
      const r = await api('/api/feed?' + q.toString());
      if (!before) list.innerHTML = '';
      (r.posts || []).forEach((p) => list.append(postCard(p)));
      if (!(r.posts || []).length && !before) {
        const c = emptyCopy(filter);
        const node = empty(c.icon, c.title, c.body);
        if (c.cta) node.append(h('div', { style: { marginTop: '.75rem' } }, signInBtn()));
        list.append(node);
      }
      if (!before && (r.posts || []).length) promoInline(list, 'feed', { wide: WIDE_RAIL });
      if ((r.posts || []).length < 20) done = true;
      else before = r.posts[r.posts.length - 1].createdAt;
      list.append(more);
    } catch (e) { toastErr(e); } finally { loading = false; }
  }
  function reload() {
    before = null; done = false;
    list.replaceChildren(h('div', { class: 'skel', style: { height: '140px' } }), h('div', { class: 'skel', style: { height: '180px' } }));
    page();
  }
  const io = new IntersectionObserver((es) => es[0].isIntersecting && page());
  io.observe(more);

  async function loadRails() {
    const [rails, promos] = await Promise.all([
      api('/api/feed/rails').catch(() => ({ upcoming: [], live: [], suggested: [], verse: null })),
      loadPromos('feed'),
    ]);
    if (!view.isConnected) return;
    upcomingSlot.replaceChildren(...(upcomingList(rails.upcoming) ? [upcomingList(rails.upcoming)] : []));
    liveSlot.replaceChildren(liveNow(rails.live));
    const promo = promotedBox(promos);
    promoSlot.replaceChildren(...(promo ? [promo] : []));
    const suggested = suggestedBox(rails.suggested);
    const verse = verseBox(rails.verse);
    verseSlot.replaceChildren(...(verse ? [verse] : []));
    suggestSlot.replaceChildren(...(suggested ? [suggested] : []));
  }

  await Promise.all([page(), loadRails()]);
  return {
    unmount: () => {
      io.disconnect();
      stopScroll.forEach((fn) => fn());
      stopCmd();
      if (document.body.dataset.page === 'feed') delete document.body.dataset.page;
    },
  };
}
