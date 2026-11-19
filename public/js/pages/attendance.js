import { h, api, avatar, fmtDur, profilePath, toast } from '../ui.js';
import { icon } from '../icons.js';
import { state } from '../app.js';
import { panel, table, empty, pill, actionBtn } from '../host-kit.js';

function fmtTimeOnly(iso) {
  if (!iso) return '-';
  try { return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); } catch { return iso; }
}
function fmtDate(iso) {
  if (!iso) return '';
  try { return new Date(iso).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' }); } catch { return ''; }
}

export async function mount(view, params) {
  const token = params.token;
  document.body.dataset.page = 'attendance';
  view.classList.add('ht-view', 'att-view');
  view.append(h('div', { class: 'skel', style: { height: '360px' } }));
  let data;
  try {
    data = await api(`/api/attendance/${token}`);
  } catch (e) {
    view.innerHTML = '';
    view.append(empty('users', 'Attendance list unavailable', e.message || 'Not found or private', h('a', { class: 'btn', href: '/dashboard', 'data-link': '' }, 'Dashboard')));
    return;
  }
  view.innerHTML = '';

  const m = data.meeting;
  const isOwner = state.user && state.user.id === m.hostUserId;
  const hostAtt = data.attendees.find((a) => a.isHost) || { name: m.hostName, userId: m.hostUserId, signIns: [], signOut: null, durationSec: 0, interruptions: false };
  const others = data.attendees.filter((a) => !a.isHost);
  const ordered = [hostAtt, ...others];

  document.title = `Attendance · ${m.name} - 1venue`;

  const nameLink = (a) => {
    if (!a.userId) return a.name;
    return h('a', { href: profilePath({ username: a.username, id: a.userId }), 'data-link': '', class: 'ht-strong' }, a.name);
  };

  const roleOf = (a) => (a.isHost ? 'Host' : a.isCohost ? 'Co-host' : 'Participant');
  const toneOf = (a) => (a.isHost ? 'accent' : a.isCohost ? 'ok' : 'muted');

  const rows = ordered.map((a) => [
    h('div', { class: 'att-person' }, avatar(a.name, null, 'sm'), h('div', { class: 'att-person-txt' }, nameLink(a), h('div', { class: 'tiny muted no-print' }, roleOf(a)))),
    pill(roleOf(a), toneOf(a)),
    (a.signIns || []).map(fmtTimeOnly).join(', ') || '-',
    a.signOut ? fmtTimeOnly(a.signOut) : '-',
    fmtDur(a.durationSec || 0),
    a.interruptions ? pill('Yes', 'wait') : '-',
  ]);

  const dateLine = fmtDate(m.createdAt) + (m.endedAt && fmtDate(m.endedAt) !== fmtDate(m.createdAt) ? ' – ' + fmtDate(m.endedAt) : '');

  const actions = h('div', { class: 'row wrap att-actions no-print' },
    actionBtn('Export PDF', () => window.print(), { primary: true, ic: 'download' }),
    isOwner ? actionBtn(data.isPublic ? 'Make private' : 'Make public', async () => {
      await api('/api/attendance/toggle', { method: 'POST', body: { token, public: !data.isPublic } });
      location.reload();
    }, { ic: data.isPublic ? 'lock' : 'globe' }) : null,
    isOwner && data.isPublic ? actionBtn('Share to timeline', async () => {
      await api('/api/attendance/share-timeline', { method: 'POST', body: { token } });
      toast('Shared to your timeline', { icon: 'check' });
    }, { ic: 'share' }) : null,
    h('a', { class: 'btn ghost sm', href: '/dashboard', 'data-link': '' }, 'Dashboard'),
  );

  view.append(
    h('div', { class: 'att-page' },
      h('header', { class: 'att-hero card' },
        h('div', { class: 'att-brand', html: icon('stage', { size: 20 }) + '<span>1venue</span>' }),
        h('div', { class: 'tiny muted att-kicker' }, 'Attendance list'),
        h('h1', null, m.name),
        h('p', { class: 'muted small att-date' }, dateLine || 'Session'),
        h('div', { class: 'att-host' },
          avatar(hostAtt.name, null, 'md ring'),
          h('div', null, h('div', { class: 'tiny muted' }, 'Host'), nameLink(hostAtt))),
        h('div', { class: 'att-count tiny muted' }, `${ordered.length} ${ordered.length === 1 ? 'person' : 'people'}`),
      ),
      panel({ icon: 'users', title: 'Attendees', desc: 'Sign-ins are listed when someone left and rejoined. Duration is total time present.', cls: 'att-panel' },
        table(
          [{ label: 'Person' }, { label: 'Role' }, { label: 'Sign-in' }, { label: 'Sign-out' }, { label: 'Duration' }, { label: 'Left & rejoined' }],
          rows,
          { caption: 'Attendance' },
        )),
      actions,
      h('p', { class: 'tiny muted att-print-foot' }, `Generated on 1venue · ${dateLine || ''}`.trim()),
    ),
  );
  return { unmount() { if (document.body.dataset.page === 'attendance') delete document.body.dataset.page; } };
}

export const barPinned = null;
