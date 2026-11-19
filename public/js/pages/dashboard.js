import { icon } from '../icons.js';
import { h, api, fmtNum, fmtDur, timeAgo, avatar } from '../ui.js';
import { state, requireLogin } from '../app.js';
import { eventCard, personRow } from '../components.js';
import { panel, table, iconBtn, stat, stats, empty, pill, rangePicker, rangeLabel } from '../host-kit.js';
import { areaChart, barChart } from '../charts.js';

function greet() {
  const hour = new Date().getHours();
  return hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
}

function listMore(items, render, { limit = 5, moreHref, moreLabel = 'See more' } = {}) {
  const shown = items.slice(0, limit);
  const rest = items.length - shown.length;
  const box = h('div', { class: 'col dash-list' }, ...shown.map(render));
  if (rest > 0) {
    if (moreHref) {
      box.append(h('a', { class: 'btn sm ghost', href: moreHref, 'data-link': '', style: { marginTop: '.2rem' } }, `${moreLabel} (${items.length})`));
    } else {
      const btn = h('button', { class: 'btn sm ghost', type: 'button', style: { marginTop: '.2rem' } }, `${moreLabel} (${rest})`);
      btn.onclick = () => { box.replaceChildren(...items.map(render)); };
      box.append(btn);
    }
  }
  return box;
}

function sessionRow(x) {
  return h('a', { class: 'list-item', href: `/session/${x.id}`, 'data-link': '' },
    h('span', { class: 'ht-stat-ic', html: icon('fileText', { size: 16 }) }),
    h('div', { class: 'grow' },
      h('div', { class: 'ellipsis', style: { fontWeight: 600 } }, x.name || x.code),
      h('div', { class: 'tiny faint' }, timeAgo(x.created_at || x.createdAt))),
    h('span', { html: icon('chevronRight', { size: 16 }) }));
}

function analyticsBlock() {
  const q = new URLSearchParams(location.search);
  const R = { days: q.get('days') || (q.get('from') ? null : '30'), from: q.get('from'), to: q.get('to') };
  const body = h('div', { class: 'dash-analytics-body' }, h('div', { class: 'ht-loading' }, h('span', { class: 'spin', html: icon('loader', { size: 18 }) }), 'Loading analytics…'));

  function qs() { return R.from ? `from=${R.from}&to=${R.to || ''}` : `days=${R.days || 30}`; }
  function syncUrl() {
    const next = '/dashboard' + (qs() ? '?' + qs() : '') + (location.hash || '');
    history.replaceState({}, '', next);
  }

  async function load() {
    syncUrl();
    body.replaceChildren(h('div', { class: 'ht-loading' }, h('span', { class: 'spin', html: icon('loader', { size: 18 }) }), 'Loading analytics…'));
    try {
      const a = await api('/api/dashboard/analytics?' + qs());
      const t = a.totals || {};
      body.replaceChildren(
        h('div', { class: 'ht-toolbar' },
          h('div', { class: 'grow' }, h('strong', null, rangeLabel(a.range)), h('span', { class: 'tiny muted' }, ` · ${a.range.days} day${a.range.days === 1 ? '' : 's'}, UTC`)),
          rangePicker(R, load)),
        stats(
          stat(fmtNum(t.hosted), 'sessions hosted', { ic: 'radio' }),
          stat(fmtNum(t.attended), 'sessions attended', { ic: 'users' }),
          stat(fmtDur(Number(t.seconds) || 0), 'live time', { ic: 'clock' }),
          stat(fmtNum(t.audience), 'audience joins', { ic: 'eye' }),
          stat(fmtNum(t.peak), 'peak concurrent', { ic: 'activity' }),
          stat(fmtNum(t.rsvps), 'RSVPs received', { ic: 'ticket' }),
        ),
        h('div', { class: 'ht-grid2' },
          panel({ icon: 'chart', title: 'Sessions', desc: 'Meetings you hosted and sessions you joined, per day.' },
            areaChart(
              [
                { name: 'Joined', values: (a.joinedByDay || []).map((d) => ({ day: d.day, value: d.joined })) },
                { name: 'Hosted', values: (a.hostedByDay || []).map((d) => ({ day: d.day, value: d.hosted })), color: 'var(--chart-2, #10b981)' },
              ],
              { label: 'Sessions hosted and joined per day', emptyText: 'No sessions in this range yet.' },
            )),
          panel({ icon: 'activity', title: 'Audience and RSVPs', desc: 'Joins to your rooms, and RSVPs to your events.' },
            barChart(
              (a.audienceByDay || []).map((d, i) => ({
                label: d.day,
                short: new Date(d.day + 'T12:00:00Z').toLocaleDateString(undefined, { day: 'numeric', month: 'short' }),
                value: d.joins,
                sub: `${d.joins} join${d.joins === 1 ? '' : 's'} · ${(a.rsvpsByDay && a.rsvpsByDay[i] && a.rsvpsByDay[i].rsvps) || 0} RSVP${((a.rsvpsByDay && a.rsvpsByDay[i] && a.rsvpsByDay[i].rsvps) === 1) ? '' : 's'}`,
              })),
              { label: 'Audience joins per day', emptyText: 'No audience or RSVPs in this range yet.', unit: ' joins' },
            )),
        ),
      );
    } catch (e) {
      body.replaceChildren(empty('alert', 'Could not load analytics', e.message || 'Try again in a moment.'));
    }
  }
  load();
  return body;
}

function attendancePanel(lists) {
  const cols = [{ label: 'Session' }, { label: 'Visibility' }, { label: 'Actions', cls: 'ht-act' }];
  const rowOf = (l) => {
    const toggle = iconBtn(l.isPublic ? 'lock' : 'globe', l.isPublic ? 'Make private' : 'Make public', {
      onClick: async () => {
        await api('/api/attendance/toggle', { method: 'POST', body: { token: l.token, public: !l.isPublic } });
        location.reload();
      },
    });
    const share = l.isPublic ? iconBtn('share', 'Share to timeline', {
      onClick: async () => {
        await api('/api/attendance/share-timeline', { method: 'POST', body: { token: l.token } });
        const { toast } = await import('../ui.js');
        toast('Shared to timeline', { icon: 'check' });
      },
    }) : null;
    const view = iconBtn('eye', 'View list', { href: l.url });
    const pdf = iconBtn('file', 'Open and export PDF', { href: l.url });
    return [
      h('a', { href: l.url, 'data-link': '', class: 'ht-strong ellipsis' }, l.name || l.code),
      pill(l.isPublic ? 'Public' : 'Private', l.isPublic ? 'ok' : 'muted', l.isPublic ? 'globe' : 'eyeOff'),
      h('span', { class: 'ht-row-actions' }, view, pdf, toggle, share),
    ];
  };
  const shown = lists.slice(0, 8);
  return panel({ icon: 'users', title: 'Attendance lists', desc: 'Lists from sessions you hosted. Export a compact PDF from any list.', cls: 'dash-att' },
    table(cols, shown.map(rowOf), { caption: 'Attendance lists' }),
    lists.length > 8 ? h('p', { class: 'tiny muted', style: { margin: 0 } }, `Showing 8 of ${lists.length}. Open a session for its list.`) : null);
}

export async function mount(view) {
  if (!requireLogin('Sign in to see your dashboard')) return;
  document.body.dataset.page = 'dashboard';
  view.classList.add('ht-view', 'dash-view');
  view.append(h('div', { class: 'skel', style: { height: '140px', marginBottom: '1rem' } }), h('div', { class: 'skel', style: { height: '280px' } }));
  const d = await api('/api/dashboard');
  view.innerHTML = '';
  const s = d.stats || {};

  view.append(
    h('section', { class: 'dash-hero card' },
      avatar(state.user.displayName, state.user.avatarUrl, 'xl ring'),
      h('div', { class: 'grow dash-hero-copy' },
        h('div', { class: 'muted small' }, greet()),
        h('h1', null, state.user.displayName),
        h('div', { class: 'row wrap small muted dash-hero-meta' },
          h('span', null, h('strong', null, fmtNum(s.followers)), ' followers'),
          h('span', null, h('strong', null, fmtNum(s.following)), ' following'))),
      h('div', { class: 'row wrap dash-hero-actions' },
        h('a', { class: 'btn primary sm', href: '/create', 'data-link': '', html: icon('radio', { size: 16 }) + 'Go live' }),
        h('a', { class: 'btn sm', href: '/create?instant=1', 'data-link': '', 'data-group': 'media', html: icon('zap', { size: 16 }) + 'Instant' }),
        h('a', { class: 'btn sm', href: '/venues', 'data-link': '', 'data-group': 'media', html: icon('door', { size: 16 }) + 'Venue' }))),

    panel({ icon: 'chart', title: 'Analytics', desc: 'Your activity over a date range - hosted and joined sessions, audience and RSVPs.' },
      analyticsBlock()),

    d.live?.length ? panel({ icon: 'radio', title: 'Live now', actions: h('a', { class: 'btn sm ghost', href: '/discover?status=live', 'data-link': '' }, 'All') },
      h('div', { class: 'hscroll cards-row' }, d.live.map((e) => eventCard(e)))) : null,

    h('div', { class: 'dash-split' },
      h('div', { class: 'col dash-main-col' },
        h('div', { id: 'hosting' },
          panel({ icon: 'calendar', title: 'Your events', actions: h('a', { class: 'btn sm', href: '/create', 'data-link': '', html: icon('plus', { size: 15 }) + 'New' }) },
            d.hosting.length ? h('div', { class: 'grid-cards' }, d.hosting.map((e) => eventCard(e)))
              : empty('calendar', 'You haven’t hosted yet', 'Your talk shows, seminars and services will live here.', h('a', { class: 'btn sm primary', href: '/create', 'data-link': '' }, 'Create an event')))),
        panel({ icon: 'ticket', title: 'Going' },
          d.going.length ? h('div', { class: 'grid-cards' }, d.going.map((e) => eventCard(e)))
            : empty('ticket', 'No RSVPs yet', 'Tap RSVP on any event to save it here.', h('a', { class: 'btn sm', href: '/discover', 'data-link': '' }, 'Discover')))),
      h('aside', { class: 'col dash-side-col' },
        panel({ icon: 'history', title: 'Recent sessions', actions: h('a', { class: 'tiny', href: '/sessions', 'data-link': '' }, 'All') },
          d.history.length
            ? listMore(d.history, sessionRow, { limit: 5, moreHref: '/sessions' })
            : empty('history', 'No sessions yet', 'Transcripts and AI summaries of your sessions appear here.')),
        panel({ icon: 'userPlus', title: 'People to follow' },
          d.people.length
            ? listMore(d.people, (u) => personRow(u), { limit: 5, moreHref: '/discover', moreLabel: 'See more' })
            : empty('users', 'No suggestions yet')),
        panel({ icon: 'board', title: 'Personal whiteboard', actions: h('a', { class: 'btn sm', href: '/whiteboard', 'data-link': '' }, 'Open board') }))),
  );

  try {
    const att = await api('/api/attendance/list');
    if (att.lists && att.lists.length) view.append(attendancePanel(att.lists));
  } catch (_) {}

  if (location.hash === '#hosting') setTimeout(() => document.getElementById('hosting')?.scrollIntoView({ behavior: 'smooth' }), 100);
  return { unmount() { if (document.body.dataset.page === 'dashboard') delete document.body.dataset.page; } };
}
