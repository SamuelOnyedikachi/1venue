import { icon } from '../icons.js';
import { h, api, toast, toastErr, avatar, fmtNum, sheet, uploadFile, profilePath } from '../ui.js';
import { state, navigate, requireLogin, refreshSession } from '../app.js';
import { postCard, eventCard, empty, followBtn, shareLink } from '../components.js';
import { composer } from './feed.js';
import { loadPromos, promoCard } from '../promo.js';

const SOCIAL_META = [
  ['x', 'socialX', 'X'],
  ['instagram', 'instagram', 'Instagram'],
  ['linkedin', 'linkedin', 'LinkedIn'],
  ['tiktok', 'tiktok', 'TikTok'],
  ['youtube', 'youtube', 'YouTube'],
];

function safeHref(url) {
  return typeof url === 'string' && /^https:\/\//i.test(url) ? url : null;
}
function linkLabel(url) {
  try { return new URL(url).hostname.replace(/^www\./, '') + (new URL(url).pathname === '/' ? '' : new URL(url).pathname.replace(/\/$/, '')); }
  catch { return url; }
}
function joinedLabel(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return 'Joined ' + d.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
}
function initials(name) {
  return String(name || '?').split(/\s+/).slice(0, 2).map((w) => w[0]).join('').toUpperCase() || '?';
}

function addPrompt(u, label) {
  return h('a', { class: 'profile-add', href: '#', onclick: (e) => { e.preventDefault(); edit(u); } }, label);
}
function fact(icHtml, content) {
  return h('span', { class: 'profile-about-fact' }, h('span', { class: 'ic', html: icHtml }), content);
}
function aboutBlock(u) {
  const socials = u.socials || {};
  const web = safeHref(u.website);
  const joined = joinedLabel(u.createdAt);
  const facts = [
    u.location ? fact(icon('mapPin', { size: 15 }), u.location) : (u.isMe ? fact(icon('mapPin', { size: 15 }), addPrompt(u, 'Add location')) : null),
    joined ? fact(icon('calendar', { size: 15 }), joined) : null,
    web ? fact(icon('globe', { size: 15 }), h('a', { href: web, target: '_blank', rel: 'noopener noreferrer' }, linkLabel(web)))
      : (u.isMe ? fact(icon('globe', { size: 15 }), addPrompt(u, 'Add website')) : null),
  ].filter(Boolean);
  const chips = SOCIAL_META.map(([k, ic, label]) => {
    const href = safeHref(socials[k]);
    return href
      ? h('a', { class: 'profile-social', href, target: '_blank', rel: 'noopener noreferrer', title: label, 'aria-label': label, html: icon(ic, { size: 16 }) })
      : null;
  }).filter(Boolean);
  if (u.isMe && SOCIAL_META.some(([k]) => !safeHref(socials[k]))) {
    chips.push(h('a', { class: 'profile-add-links', href: '#', onclick: (e) => { e.preventDefault(); edit(u); } }, '+ Add links'));
  }
  if (!u.bio && !facts.length && !chips.length) return null;
  return h('section', { class: 'ht-panel profile-about' },
    h('div', { class: 'ht-panel-head' },
      h('span', { class: 'ht-ico', html: icon('user', { size: 16 }) }),
      h('div', { class: 'ht-panel-title' }, h('h2', null, 'About'))),
    h('div', { class: 'ht-panel-body' },
      u.bio ? h('p', { class: 'profile-bio' }, u.bio) : null,
      (facts.length || chips.length) ? h('div', { class: 'profile-about-meta' },
        facts.length ? h('div', { class: 'profile-about-facts' }, ...facts) : null,
        chips.length ? h('div', { class: 'profile-socials' }, ...chips) : null) : null));
}

function rsvpBtn(ev) {
  let going = !!ev.rsvped;
  const btn = h('button', { class: 'feed-promo-rsvp', type: 'button' });
  const paint = () => { btn.textContent = going ? 'Going' : 'RSVP'; btn.classList.toggle('is-going', going); };
  paint();
  btn.onclick = async (e) => {
    e.preventDefault(); e.stopPropagation();
    if (!requireLogin('Sign in to RSVP')) return;
    btn.disabled = true;
    try {
      const r = await api(`/api/events/${ev.id}/rsvp`, { method: 'POST' });
      going = !!r.going; ev.rsvped = going; paint();
    } catch (er) { toastErr(er); } finally { btn.disabled = false; }
  };
  return btn;
}
function whenChip(ev) {
  const live = ev.status === 'live' || ev.live;
  if (live) return h('span', { class: 'rail-when soon' }, h('span', { class: 'mon' }, 'Live'), h('span', { class: 'day' }, 'Now'));
  if (!ev.startsAt) return h('span', { class: 'rail-when' }, h('span', { class: 'day' }, '—'));
  const d = new Date(ev.startsAt);
  return h('span', { class: 'rail-when' },
    h('span', { class: 'mon' }, d.toLocaleDateString(undefined, { month: 'short' })),
    h('span', { class: 'day' }, String(d.getDate())),
    h('span', { class: 'tm' }, d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })));
}
function upcomingRow(ev) {
  const live = ev.status === 'live' || ev.live;
  const bits = [];
  if (live) bits.push('Live now');
  else if (ev.startsAt) bits.push(new Date(ev.startsAt).toLocaleDateString(undefined, { weekday: 'short' }));
  if (!live && ev.rsvps) bits.push(`${fmtNum(ev.rsvps)} RSVP${ev.rsvps === 1 ? '' : 's'}`);
  const meta = bits.join(' · ');
  return h('div', { class: 'profile-soon-row' },
    whenChip(ev),
    h('a', { class: 'profile-soon-body', href: `/e/${ev.slug}`, 'data-link': '' },
      h('span', { class: 'rail-title' }, ev.title),
      meta ? h('span', { class: 'soon-meta' }, meta) : null),
    rsvpBtn(ev));
}

function statRow(ic, value, label) {
  return h('div', { class: 'pr-stat' },
    h('span', { class: 'pr-stat-ic', html: icon(ic, { size: 15 }) }),
    h('div', null, h('strong', null, fmtNum(value)), h('span', null, label)));
}

function rail(u) {
  const aside = h('aside', { class: 'profile-rail' });
  const upcoming = u.upcoming || [];
  if (upcoming.length) {
    aside.append(h('section', { class: 'ev-card' },
      h('div', { class: 'ev-rail-head tiny faint' }, 'Next up'),
      h('div', { class: 'profile-rail-body' }, ...upcoming.map(upcomingRow))));
  }
  const st = u.stats || {};
  aside.append(h('section', { class: 'ev-card' },
    h('div', { class: 'ev-rail-head tiny faint' }, 'Stats'),
    h('div', { class: 'profile-rail-body pr-stats' },
      statRow('calendar', st.eventsHosted ?? (u.events?.length || 0), 'Events hosted'),
      statRow('users', st.attendeesReached ?? 0, 'Attendees reached'),
      statRow('heart', st.followers ?? u.followers ?? 0, 'Followers'))));

  const promoBox = h('section', { class: 'profile-promoted', hidden: true },
    h('div', { class: 'ev-rail-head tiny faint' }, 'Promoted'),
    h('div', { class: 'profile-rail-body profile-promo-tiles' }));
  aside.append(promoBox);
  loadPromos('profile', { profileUserId: u.id }).then((items) => {
    if (!items.length || !promoBox.isConnected) return;
    promoBox.hidden = false;
    const body = promoBox.querySelector('.profile-rail-body');
    body.replaceChildren(...items.slice(0, 2).map((it) => promoCard(it, { compact: true, tagged: false })).filter(Boolean));
  });

  const similar = u.similarHosts || [];
  if (similar.length) {
    aside.append(h('section', { class: 'ev-card' },
      h('div', { class: 'ev-rail-head tiny faint' }, 'Similar hosts'),
      h('div', { class: 'profile-rail-body' }, ...similar.map((p) =>
        h('div', { class: 'profile-host-row' },
          h('a', { class: 'profile-host-link', href: profilePath(p), 'data-link': '' },
            avatar(p.name, p.avatarUrl, 'md'),
            h('div', { class: 'profile-host-copy' },
              h('strong', null, p.name),
              h('div', { class: 'handle' }, p.username || p.handle ? '@' + (p.username || p.handle) : ''),
              p.bio ? h('p', null, p.bio) : null)),
          state.user && state.user.id !== p.id ? followBtn(p) : null)))));
  }

  const venues = u.venues || [];
  if (venues.length) {
    aside.append(h('section', { class: 'ev-card' },
      h('div', { class: 'ev-rail-head tiny faint' }, 'Venues they use'),
      h('div', { class: 'profile-rail-body' }, ...venues.map((v) =>
        h('a', { class: 'profile-venue-row', href: `/v/${encodeURIComponent(v.slug)}`, 'data-link': '' },
          v.logoUrl ? h('img', { class: 'profile-venue-mark img', src: v.logoUrl, alt: '' })
            : h('div', { class: 'profile-venue-mark' }, initials(v.name)),
          h('div', { class: 'profile-venue-copy' }, h('strong', null, v.name), h('span', { class: 'muted' }, 'Hosted on 1venue')),
          v.role === 'owner' ? h('span', { class: 'profile-pill' }, 'Owner') : null)))));
  }

  if (u.isMe) {
    aside.append(h('section', { class: 'ev-card profile-promote' },
      h('h2', null, 'Promote your profile'),
      h('p', null, 'Reach more people on 1venue. A short boost puts you on profiles, Discover and the feed.'),
      h('a', { class: 'btn primary sm', href: '/host?tab=promote', 'data-link': '' }, 'Promote')));
  }
  return aside;
}

export async function mount(view, params) {
  let id = params.id;
  if (params.me) { if (!requireLogin('Sign in to see your profile')) return; id = state.user.id; }
  let u;
  try { u = await api(`/api/users/${encodeURIComponent(id)}`); } catch (e) {
    if (e?.status !== 404) throw e;
    view.append(h('div', { class: 'empty' }, h('h1', null, '404'), h('p', { class: 'muted' }, `No one on 1venue goes by @${String(id).slice(0, 40)}.`),
      h('a', { class: 'btn primary', href: '/discover', 'data-link': '', style: { margin: '1rem auto 0', width: 'fit-content' } }, 'Discover people and events')));
    return;
  }
  if (!params.me && u.username && location.pathname !== `/u/${u.username}`) history.replaceState({}, '', `/u/${encodeURIComponent(u.username)}${location.search}`);
  document.title = `${u.name}${u.username ? ` (@${u.username})` : ''} — 1venue`;
  id = u.username || u.id;
  const tabs = h('div', { class: 'tabs profile-tabs' });
  const body = h('div', { class: 'col profile-body' });
  let tab = 'timeline';
  const paintTabs = () => { tabs.innerHTML = ''; [['timeline', 'Timeline', 'feed'], ['events', `Events · ${u.events?.length || 0}`, 'calendar']].forEach(([k, l, ic]) => tabs.append(h('button', { class: tab === k ? 'on' : '', html: icon(ic, { size: 16 }) + l, onclick: () => { tab = k; paintTabs(); load(); } }))); };
  async function load() {
    body.innerHTML = '';
    if (tab === 'events') { body.append(u.events?.length ? h('div', { class: 'grid-cards' }, u.events.map((e) => eventCard(e))) : empty('calendar', 'No public events yet')); return; }
    if (u.isMe) body.append(composer((p) => body.insertBefore(postCard(p), body.children[1] || null)));
    const r = await api(`/api/users/${id}/timeline`);
    r.posts.forEach((p) => body.append(postCard(p)));
    if (!r.posts.length) body.append(empty('feed', u.isMe ? 'Your timeline starts here' : 'Nothing posted yet', u.isMe ? 'Posts, events you host and session summaries you share appear here.' : null));
  }
  const msgBtn = h('a', { class: 'btn sm', href: `/messages/new?user=${u.id}`, 'data-link': '', style: { display: 'none' }, html: icon('chat', { size: 15 }) + 'Message' });
  if (state.user && !u.isMe && u.id) api(`/api/messages/can?userId=${u.id}`).then((r) => { msgBtn.style.display = r.ok ? '' : 'none'; }).catch(() => {});
  document.body.dataset.page = 'profile';
  view.classList.add('profile-view');
  view.append(
    h('section', { class: 'profile-hero card' },
      h('div', { class: 'profile-cover' + (u.coverUrl ? ' has-img' : '') },
        u.coverUrl ? h('img', { src: u.coverUrl, alt: '', loading: 'lazy' }) : h('div', { class: 'band' })),
      h('div', { class: 'in' }, avatar(u.name, u.avatarUrl, 'xxl ring'),
        h('div', { class: 'grow profile-copy' }, h('h1', null, u.name), u.username || u.handle ? h('div', { class: 'muted profile-handle' }, '@' + (u.username || u.handle)) : null),
        h('div', { class: 'row wrap profile-actions' },
          u.isMe ? h('button', { class: 'btn sm', html: icon('pen', { size: 15 }) + 'Edit profile', onclick: () => edit(u) }) : state.user ? followBtn(u, (on) => { u.followers += on ? 1 : -1; }) : null,
          msgBtn,
          h('button', { class: 'icon-btn', 'data-group': 'content', 'data-tip': 'Share profile', 'aria-label': 'Share', html: icon('share'), onclick: () => shareLink(`${location.origin}${profilePath(u)}`, u.name) })))),
    h('div', { class: 'profile-layout' },
      h('div', { class: 'profile-main' }, aboutBlock(u), tabs, body),
      rail(u)));
  paintTabs(); load();
  if (params.edit && u.isMe) edit(u);
}

function edit(u) {
  const s = sheet({ title: 'Edit profile', icon: 'user', group: 'people' });
  const name = h('input', { class: 'input', value: u.name || '', placeholder: 'Display name', maxlength: 60 });
  const bio = h('textarea', { class: 'textarea', rows: 3, placeholder: 'Short bio', maxlength: 400 }); bio.value = u.bio || '';
  const loc = h('input', { class: 'input', value: u.location || '', placeholder: 'City, country', maxlength: 80 });
  const website = h('input', { class: 'input', type: 'url', value: u.website || '', placeholder: 'https://', maxlength: 200 });
  const socials = u.socials || {};
  const socialInputs = Object.fromEntries(SOCIAL_META.map(([k, , label]) => {
    const inp = h('input', { class: 'input', value: socials[k] || '', placeholder: `${label} handle or URL`, maxlength: 200, autocomplete: 'off' });
    return [k, inp];
  }));
  let avatarUrl = u.avatarUrl;
  let coverUrl = u.coverUrl || null;
  const av = h('div', { class: 'row' }, avatar(u.name, avatarUrl, 'lg'));
  const f = h('input', { type: 'file', accept: 'image/*', class: 'hidden' });
  f.onchange = async () => { try { const r = await uploadFile(f.files[0], { purpose: 'avatar' }); avatarUrl = r.url; av.firstChild.replaceWith(avatar(u.name, avatarUrl, 'lg')); } catch (e) { toastErr(e); } };
  const coverPrev = h('div', { class: 'profile-cover-prev' + (coverUrl ? ' has-img' : '') },
    coverUrl ? h('img', { src: coverUrl, alt: '' }) : h('div', { class: 'band' }));
  const paintCover = () => {
    coverPrev.classList.toggle('has-img', !!coverUrl);
    coverPrev.replaceChildren(coverUrl ? h('img', { src: coverUrl, alt: '' }) : h('div', { class: 'band' }));
  };
  const cf = h('input', { type: 'file', accept: 'image/*', class: 'hidden' });
  cf.onchange = async () => { try { const r = await uploadFile(cf.files[0], { purpose: 'cover' }); coverUrl = r.url; paintCover(); } catch (e) { toastErr(e); } };
  const field = (lbl, el) => h('label', { class: 'field' }, h('span', { class: 'lbl' }, lbl), el);
  s.body.append(h('div', { class: 'col' },
    h('div', { class: 'row' }, av, h('button', { class: 'btn sm', html: icon('image', { size: 15 }) + 'Change photo', onclick: () => f.click() }), f),
    h('div', { class: 'field' }, h('span', { class: 'lbl' }, 'Cover image'),
      coverPrev,
      h('p', { class: 'tiny muted' }, 'JPG, PNG or WebP, up to 8 MB. The theme gradient shows when there is no cover.'),
      (() => {
        const upBtn = h('button', { class: 'btn sm', type: 'button', html: icon('image', { size: 15 }) + (coverUrl ? 'Replace cover' : 'Upload cover') });
        const remBtn = h('button', { class: 'btn sm', type: 'button', hidden: !coverUrl, html: icon('x', { size: 14 }) + 'Remove' });
        const sync = () => { upBtn.innerHTML = icon('image', { size: 15 }) + (coverUrl ? 'Replace cover' : 'Upload cover'); remBtn.hidden = !coverUrl; };
        upBtn.onclick = () => cf.click();
        remBtn.onclick = () => { coverUrl = null; paintCover(); sync(); };
        const prevOn = cf.onchange;
        cf.onchange = async (ev) => { if (prevOn) await prevOn(ev); sync(); };
        return h('div', { class: 'row wrap', style: { gap: '.4rem' } }, upBtn, remBtn, cf);
      })()),
    field('Display name', name),
    h('div', { class: 'field' }, h('span', { class: 'lbl' }, 'Public link'), h('div', { class: 'row small', style: { gap: '.5rem' } }, h('code', null, `${location.host}/u/${u.username}`), h('a', { href: '/settings#account', 'data-link': '', onclick: () => s.close() }, 'Change username'))),
    field('Bio', bio),
    field('Location', loc),
    field('Website', website),
    h('p', { class: 'lbl' }, 'Socials'),
    field('X', socialInputs.x),
    field('Instagram', socialInputs.instagram),
    field('LinkedIn', socialInputs.linkedin),
    field('TikTok', socialInputs.tiktok),
    field('YouTube', socialInputs.youtube),
    h('button', { class: 'btn primary', onclick: async () => {
      try {
        await api('/api/profile', { method: 'PATCH', body: {
          displayName: name.value.trim(), bio: bio.value.trim(), avatarUrl, coverUrl,
          location: loc.value.trim(), website: website.value.trim(),
          socials: Object.fromEntries(SOCIAL_META.map(([k]) => [k, socialInputs[k].value.trim()])),
        } });
        toast('Profile saved', { icon: 'check' }); s.close(); await refreshSession(); navigate('/me', { replace: true });
      } catch (e) { toastErr(e); }
    } }, 'Save')));
}
