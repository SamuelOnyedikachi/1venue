import { icon } from '../icons.js';
import { h, api, fmtNum, fmtDur, timeAgo, avatar } from '../ui.js';
import { state, requireLogin } from '../app.js';
import { eventCard, empty, personRow } from '../components.js';

function listMore(items, render, { limit = 5, moreHref, moreLabel = 'See more' } = {}) {
  const shown = items.slice(0, limit);
  const rest = items.length - shown.length;
  const box = h('div', { class: 'col', style: { gap: '.15rem' } }, ...shown.map(render));
  if (rest > 0) {
    if (moreHref) {
      box.append(h('a', { class: 'btn sm ghost', href: moreHref, 'data-link': '', style: { marginTop: '.35rem' } }, `${moreLabel} (${items.length})`));
    } else {
      const btn = h('button', { class: 'btn sm ghost', type: 'button', style: { marginTop: '.35rem' } }, `${moreLabel} (${rest})`);
      btn.onclick = () => { box.replaceChildren(...items.map(render)); };
      box.append(btn);
    }
  }
  return box;
}

export async function mount(view) {
  if (!requireLogin('Sign in to see your dashboard')) return;
  view.append(h('div', { class: 'skel', style: { height: '160px', marginBottom: '1rem' } }), h('div', { class: 'skel', style: { height: '320px' } }));
  const d = await api('/api/dashboard');
  view.innerHTML = '';
  const s = d.stats || {};
  const max = Math.max(1, ...(d.activity || []).map((a) => a.n));
  const spark = h('div', { class: 'spark', 'aria-label': 'Sessions joined, last 14 days' }, (d.activity || []).map((a) => h('i', { style: { height: `${8 + (a.n / max) * 92}%` }, 'data-tip': `${a.day}: ${a.n} session${a.n === 1 ? '' : 's'}` })));
  const hour = new Date().getHours();
  const heroLabel = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
  const dashboardStats = [
    { icon: 'radio', label: 'Hosted', value: fmtNum(s.hosted), tone: 'violet' },
    { icon: 'users', label: 'Attended', value: fmtNum(s.attended), tone: 'cyan' },
    { icon: 'clock', label: 'Live time · 30 days', value: fmtDur(Number(s.seconds30)), tone: 'amber' },
    { icon: 'eye', label: 'Total audience', value: fmtNum(s.audience), sub: `Peak ${fmtNum(s.peak)} live`, tone: 'green' },
    { icon: 'captions', label: 'Transcript lines', value: fmtNum(s.transcriptLines || s.captions || 0), tone: 'blue' },
  ];
  const metricCards = dashboardStats.map((m) => h('div', { class: `mini-stat mini-stat--${m.tone}` },
    h('span', { class: 'mini-stat__icon', html: icon(m.icon, { size: 18 }) }),
    h('div', { class: 'mini-stat__content' },
      h('div', { class: 'mini-stat__label' }, m.label),
      h('div', { class: 'mini-stat__value' }, m.value),
      m.sub ? h('div', { class: 'mini-stat__sub' }, m.sub) : null)));
  const shell = h('div', { class: 'dashboard-shell' });
  view.append(shell);
  shell.append(
    h('header', { class: 'dashboard-topbar' },
      h('div', { class: 'dashboard-page-heading' },
        h('div', { class: 'tiny uppercase muted' }, 'Your space'),
        h('h1', null, 'Dashboard')),
        h('div', { class: 'dashboard-topbar__actions' },
          h('a', { class: 'btn ghost', href: '/discover', 'data-link': '', html: icon('compass', { size: 16 }) + 'Browse' }))),
    h('section', { class: 'dashboard-hero card' },
      h('div', { class: 'dashboard-hero__profile' },
        avatar(state.user.displayName, state.user.avatarUrl, 'xl ring'),
        h('div', { class: 'dashboard-hero__meta' },
          h('div', { class: 'tiny uppercase muted' }, heroLabel),
          h('h2', null, state.user.displayName),
          h('div', { class: 'row wrap small dashboard-hero__social' },
            h('span', null, h('strong', null, fmtNum(s.followers)), ' followers'),
            h('span', null, h('strong', null, fmtNum(s.following)), ' following')))),
      h('div', { class: 'dashboard-hero__actions' },
        h('a', { class: 'btn primary', href: '/create', 'data-link': '', html: icon('radio', { size: 17 }) + 'Go live' }),
        h('a', { class: 'btn', href: '/create?instant=1', 'data-link': '', 'data-group': 'media', html: icon('zap', { size: 17 }) + 'Instant room' }),
        h('a', { class: 'btn ghost', href: '/venues', 'data-link': '', 'data-group': 'media', html: icon('door', { size: 17 }) + 'Venue' }))),
    h('section', { class: 'dashboard-stat-grid' }, ...metricCards),
    h('section', { class: 'dashboard-panel dashboard-activity' },
      h('div', { class: 'panel-head' },
        h('div', null,
          h('div', { class: 'tiny uppercase muted' }, 'Engagement pulse'),
          h('h3', null, 'Activity · last 14 days')),
        h('a', { class: 'tiny', href: '/sessions', 'data-link': '' }, 'View sessions')),
      d.activity?.length ? spark : h('div', { class: 'empty-card' }, 'No recent sessions yet.')),
    d.live?.length ? h('section', { class: 'dashboard-panel dashboard-live' },
      h('div', { class: 'panel-head' },
        h('div', null,
          h('div', { class: 'tiny uppercase muted' }, 'Happening now'),
          h('h3', null, 'Live events')),
        h('a', { class: 'tiny', href: '/discover?status=live', 'data-link': '' }, 'Discover more')),
      h('div', { class: 'dashboard-live__cards' }, ...d.live.map((e) => eventCard({ ...e, title: e.title || e.name || 'Live event' }, { compact: true })))) : '',
    h('div', { class: 'dashboard-columns' },
      h('div', { class: 'dashboard-column dashboard-column--main' },
        h('section', { id: 'hosting', class: 'dashboard-panel' },
          h('div', { class: 'panel-head' },
            h('div', null,
              h('div', { class: 'tiny uppercase muted' }, 'Hosting'),
              h('h3', null, 'Your events')),
            h('a', { class: 'btn sm', href: '/create', 'data-link': '', html: icon('plus', { size: 15 }) + 'New' })),
          d.hosting.length ? h('div', { class: 'grid-cards' }, d.hosting.map((e) => eventCard(e))) : empty('calendar', 'You haven’t hosted yet', 'Your talk shows, seminars and services will live here.')),
        h('section', { class: 'dashboard-panel' },
          h('div', { class: 'panel-head' },
            h('div', null,
              h('div', { class: 'tiny uppercase muted' }, 'RSVPs'),
              h('h3', null, 'Going')),
            h('a', { class: 'tiny', href: '/discover', 'data-link': '' }, 'Browse events')),
          d.going.length ? h('div', { class: 'grid-cards' }, d.going.map((e) => eventCard(e))) : empty('ticket', 'No RSVPs yet', 'Tap RSVP on any event to save it here.', h('a', { class: 'btn', href: '/discover', 'data-link': '' }, 'Discover')))),
      h('aside', { class: 'dashboard-column dashboard-column--side' },
        h('section', { class: 'dashboard-panel' },
          h('div', { class: 'panel-head' },
            h('div', null,
              h('div', { class: 'tiny uppercase muted' }, 'Recent'),
              h('h3', null, 'Sessions')),
            h('a', { class: 'tiny', href: '/sessions', 'data-link': '' }, 'All')),
          d.history.length
            ? listMore(d.history, (x) => h('a', { class: 'list-item', href: `/session/${x.id}`, 'data-link': '' },
                h('span', { class: 'list-item__icon', html: icon('fileText', { size: 16 }) }),
                h('div', { class: 'grow' },
                  h('div', { class: 'ellipsis', style: { fontWeight: 600 } }, x.name || x.code),
                  h('div', { class: 'tiny faint' }, timeAgo(x.created_at || x.createdAt))),
                h('span', { html: icon('chevronRight', { size: 16 }) })),
              { limit: 5, moreHref: '/sessions' })
            : h('p', { class: 'tiny faint' }, 'Transcripts and AI summaries of your sessions appear here.')),
        h('section', { class: 'dashboard-panel' },
          h('div', { class: 'panel-head' },
            h('div', null,
              h('div', { class: 'tiny uppercase muted' }, 'Network'),
              h('h3', null, 'People to follow')),
            h('a', { class: 'tiny', href: '/discover', 'data-link': '' }, 'More')),
          d.people.length
            ? listMore(d.people, (u) => personRow(u), { limit: 5, moreHref: '/discover', moreLabel: 'See more' })
            : h('p', { class: 'tiny faint' }, 'No suggestions yet.')),
        h('section', { class: 'dashboard-panel' },
          h('div', { class: 'panel-head' },
            h('div', null,
              h('div', { class: 'tiny uppercase muted' }, 'Workspace'),
              h('h3', null, 'Personal whiteboard')),
            h('a', { class: 'tiny', href: '/whiteboard', 'data-link': '' }, 'Open')),
          h('a', { class: 'btn sm', href: '/whiteboard', 'data-link': '', style: { marginTop: '.35rem' }, html: icon('board', { size: 15 }) + 'Open board' })))));

  try {
    const att = await api('/api/attendance/list');
    if (att.lists && att.lists.length) {
      const lists = att.lists;
      const renderRow = (l) => {
        const toggle = h('button', {
          class: 'icon-btn sm', type: 'button',
          'data-tip': l.isPublic ? 'Make private' : 'Make public',
          'aria-label': l.isPublic ? 'Make private' : 'Make public',
          'data-group': 'admin',
          html: icon(l.isPublic ? 'lock' : 'globe', { size: 16 }),
          onclick: async () => {
            try {
              await api('/api/attendance/toggle', { method: 'POST', body: { token: l.token, public: !l.isPublic } });
              location.reload();
            } catch (e) { alert(e.message); }
          },
        });
        const share = l.isPublic ? h('button', {
          class: 'icon-btn sm', type: 'button',
          'data-tip': 'Share to timeline', 'aria-label': 'Share to timeline',
          'data-group': 'social',
          html: icon('share', { size: 16 }),
          onclick: async () => {
            try { await api('/api/attendance/share-timeline', { method: 'POST', body: { token: l.token } }); alert('Shared to timeline'); } catch (e) { alert(e.message); }
          },
        }) : null;
        const pdf = h('a', {
          class: 'icon-btn sm', href: l.url, 'data-link': '', target: '_blank',
          'data-tip': 'View PDF', 'aria-label': 'View PDF',
          html: icon('file', { size: 16 }),
        });
        const view = h('a', {
          class: 'icon-btn sm', href: l.url, 'data-link': '',
          'data-tip': 'View list', 'aria-label': 'View list',
          html: icon('eye', { size: 16 }),
        });
        return h('div', { class: 'row between wrap', style: { gap: '.5rem', alignItems: 'center' } },
          h('div', { class: 'grow row', style: { gap: '.55rem', alignItems: 'center', minWidth: 0 } },
            h('span', { class: 'ellipsis', style: { fontWeight: 600 } }, l.name || l.code),
            h('span', {
              class: 'att-vis',
              'data-tip': l.isPublic ? 'Public' : 'Private · host & co-host',
              html: icon(l.isPublic ? 'globe' : 'eyeOff', { size: 14 }),
              style: { color: 'var(--muted)', display: 'inline-flex', flex: 'none' },
            })),
          h('div', { class: 'row gap-xs wrap' }, view, pdf, toggle, share));
      };
      const stack = h('div', { class: 'stack', style: { marginTop: '.8rem', gap: '.6rem' } }, ...lists.slice(0, 5).map(renderRow));
      if (lists.length > 5) {
        const more = h('button', { class: 'btn sm ghost', type: 'button' }, `See more (${lists.length})`);
        more.onclick = () => { stack.replaceChildren(...lists.map(renderRow)); more.remove(); };
        stack.append(more);
      }
      shell.append(h('section', { class: 'dashboard-panel dashboard-attendance' },
        h('div', { class: 'panel-head' },
          h('div', null,
            h('div', { class: 'tiny uppercase muted' }, 'Attendance'),
            h('h3', null, 'Your lists'))),
        stack));
    }
  } catch (_) {}

  if (location.hash === '#hosting') setTimeout(() => document.getElementById('hosting')?.scrollIntoView({ behavior: 'smooth' }), 100);
}
