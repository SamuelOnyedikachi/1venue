// /host: host tools. Analytics (date range, charts, exports), branding, recurring series, promotions,
// tickets, earnings, organisation and replays. Every section asks the server; plan gating is enforced there
// and mirrored here from /api/billing features so locked tools show an upgrade card instead.
import { h, api, toast, toastErr, confirmDlg, uploadFile, sheet, debounce } from '../ui.js';
import { icon } from '../icons.js';
import { state, requireLogin } from '../app.js';
import { loadMoney, fmtMoney, checkoutSheet, moneyConfig, format as fmtIn } from '../money.js';
import { panel, table, iconBtn, downloads, chips, stat, stats, empty, pill, field, actionBtn, dayFmt, whenFmt } from '../host-kit.js';
import { areaChart, barChart, donutChart } from '../charts.js';

const naira = (k) => fmtMoney(k);
const TABS = [['analytics', 'Analytics', 'chart'], ['branding', 'Branding', 'palette'], ['recurring', 'Recurring', 'calendar'], ['promote', 'Promote', 'megaphone'],
  ['tickets', 'Tickets', 'ticket'], ['earnings', 'Earnings', 'wallet'], ['org', 'Organisation', 'users'], ['replays', 'Replays', 'play']];
const NEEDS = { analytics: 'analytics', branding: 'branding', recurring: 'recurring', promote: 'selfPromo', tickets: 'ticketing', replays: 'replays' };
const BLURB = { analytics: 'See who came, when, and how they took part.', branding: 'Logo, colours, cover and about for your venues.', recurring: 'Weekly, fortnightly or monthly events and meetings.',
  promote: 'Put your event in front of more people.', tickets: 'Free and paid tiers for your events.', replays: 'Recordings people can watch later.', org: 'Members, roles, venues and a shared library.' };
const inp = (attrs = {}) => h('input', { class: 'input', ...attrs });
const sel = (opts, value) => h('select', { class: 'input' }, ...opts.map(([v, l]) => h('option', { value: v, selected: v === value }, l)));
const locked = (id) => {
  const [, label, ic] = TABS.find((t) => t[0] === id);
  return panel({ icon: ic, title: label }, empty('lock', `${label} is not on your plan`, BLURB[id] || '', h('a', { class: 'btn primary sm', href: '/upgrade', 'data-link': '' }, 'See plans')));
};

export async function mount(view) {
  if (!state.user) { requireLogin(); return; }
  const q = new URLSearchParams(location.search);
  const [me] = await Promise.all([api('/api/billing'), loadMoney()]);
  const f = me.features || {};
  let tab = q.get('tab') || 'analytics';
  const body = h('div', { class: 'ht-body' });
  const nav = h('nav', { class: 'chips ht-tabs', role: 'tablist', 'aria-label': 'Host tools' });
  view.classList.add('ht-view');
  view.append(h('div', { class: 'page-head ht-head' }, h('h1', { html: icon('stage', { size: 26 }) + 'Host tools' }),
    h('p', { class: 'muted' }, 'Your plan: ', h('strong', null, me.plan[0].toUpperCase() + me.plan.slice(1)), me.orgPlan ? ` (organisation features from ${me.orgPlan})` : '', '. ', h('a', { href: '/billing', 'data-link': '' }, 'Billing'))), nav, body);

  const ref = q.get('reference') || q.get('trxref');
  if (ref && ref.startsWith('1vc-')) api(`/api/commerce/payments/${encodeURIComponent(ref)}/verify`, { method: 'POST', body: {} }).then((p) => { toast(p.status === 'paid' ? 'Payment confirmed' : `Payment ${p.status}`, { icon: 'check' }); if (tab === 'promote') show('promote'); }).catch(toastErr);
  if (q.get('invite')) {
    try { const r = await api('/api/orgs/invites/accept', { method: 'POST', body: { token: q.get('invite') } }); toast(`You joined ${(r && (r.name || (r.org && r.org.name))) || 'the organisation'}`, { icon: 'check' }); tab = 'org'; }
    catch (e) { toastErr(e); }
  }
  let seq = 0;
  async function show(id, { keepQuery = false } = {}) {
    tab = id; const my = ++seq;
    if (!keepQuery) history.replaceState(null, '', '/host?tab=' + id + (id === 'analytics' && rangeQs() ? '&' + rangeQs() : ''));
    nav.replaceChildren(...TABS.map(([t, l, ic]) => h('button', { type: 'button', role: 'tab', class: 'chip' + (t === tab ? ' on' : ''), 'aria-selected': String(t === tab), html: icon(ic, { size: 15 }) + `<span>${l}</span>`, onclick: () => show(t) })));
    const on = nav.querySelector('.on');
    if (on) {
      const navRect = nav.getBoundingClientRect();
      const tabRect = on.getBoundingClientRect();
      if (tabRect.left < navRect.left) nav.scrollLeft -= navRect.left - tabRect.left;
      else if (tabRect.right > navRect.right) nav.scrollLeft += tabRect.right - navRect.right;
    }
    body.replaceChildren(h('div', { class: 'ht-loading' }, h('span', { class: 'spinner' }), 'Loading…'));
    try {
      if (NEEDS[id] && !f[NEEDS[id]] && !(id === 'analytics' && f.exports)) { body.replaceChildren(locked(id)); return; }
      const out = await SECTIONS[id]({ me, f, show });
      if (my === seq) body.replaceChildren(...out.filter(Boolean));
    } catch (e) { if (my === seq) body.replaceChildren(panel({ icon: 'alert', title: 'Could not load' }, h('p', { class: 'small' }, e.message || 'Please try again.'))); }
  }
  // analytics/exports range, kept in the URL so a reload or a shared link shows the same window
  const R = { days: q.get('days') || (q.get('from') ? null : '30'), from: q.get('from'), to: q.get('to') };
  function rangeQs() { return R.from ? `from=${R.from}&to=${R.to || ''}` : `days=${R.days || 30}`; }
  SECTIONS.__range = R; SECTIONS.__rangeQs = rangeQs;
  show(TABS.some((t) => t[0] === tab) ? tab : 'analytics', { keepQuery: tab === 'analytics' });
  return { unmount() { seq++; } };
}

// ---------------------------------------------------------------- analytics + exports
const EXPORTS = [
  ['sessions', 'Sessions', 'calendar', 'One line per session: start, end, people and peak.'],
  ['attendance', 'Attendance', 'userCheck', 'Everyone who joined, with minutes and visits.'],
  ['registrations', 'Registrations', 'ticket', 'RSVPs for your events, with name and email.'],
  ['chat', 'Chat', 'chat', 'Room chat from every session.'],
  ['transcripts', 'Transcripts', 'captions', 'Captions and transcripts by speaker.'],
];
const isoDay = (d) => d.toISOString().slice(0, 10);
function rangePicker(R, onChange) {
  const preset = R.from ? 'custom' : String(R.days || 30);
  const from = inp({ type: 'date', value: R.from || isoDay(new Date(Date.now() - 29 * 864e5)), max: isoDay(new Date()), 'aria-label': 'From' });
  const to = inp({ type: 'date', value: R.to || isoDay(new Date()), max: isoDay(new Date()), 'aria-label': 'To' });
  const err = h('span', { class: 'tiny ht-err', role: 'alert' });
  const apply = h('button', { class: 'btn primary sm', type: 'button' }, 'Apply');
  const custom = h('div', { class: 'ht-custom', hidden: preset !== 'custom' }, field('From', from), field('To', to), apply, err);
  apply.onclick = () => {
    err.textContent = '';
    if (!from.value || !to.value) { err.textContent = 'Pick both dates.'; return; }
    if (from.value > to.value) { err.textContent = 'The start date must be before the end date.'; return; }
    if ((Date.parse(to.value) - Date.parse(from.value)) / 864e5 > 365) { err.textContent = 'Choose at most 366 days.'; return; }
    Object.assign(R, { days: null, from: from.value, to: to.value }); onChange();
  };
  const c = chips([['7', '7 days'], ['30', '30 days'], ['90', '90 days'], ['custom', 'Custom', 'calendar']], preset, (id) => {
    if (id === 'custom') { custom.hidden = false; from.focus(); return; }
    custom.hidden = true; Object.assign(R, { days: id, from: null, to: null }); onChange();
  }, { label: 'Date range' });
  return h('div', { class: 'ht-range' }, c, custom);
}
const rangeLabel = (r) => (r.preset ? `Last ${r.days} days` : `${dayFmt(r.from + 'T00:00:00Z')} – ${dayFmt(r.to + 'T00:00:00Z')}`);
/** Weekly buckets when the range is long, so bars stay readable. */
function weekly(points, key) {
  if (points.length <= 31) return points.map((p) => ({ label: dayFmt(p.day + 'T12:00:00Z'), short: new Date(p.day + 'T12:00:00Z').toLocaleDateString(undefined, { day: 'numeric', month: 'short' }), value: p[key] }));
  const out = [];
  for (let i = 0; i < points.length; i += 7) { const chunk = points.slice(i, i + 7); out.push({ label: `Week of ${dayFmt(chunk[0].day + 'T12:00:00Z')}`, short: new Date(chunk[0].day + 'T12:00:00Z').toLocaleDateString(undefined, { day: 'numeric', month: 'short' }), value: Math.max(...chunk.map((p) => p[key])) }); }
  return out;
}

const SECTIONS = {
  async analytics({ f, show }) {
    const R = SECTIONS.__range; const qs = SECTIONS.__rangeQs();
    const reload = () => show('analytics');
    const [a, ex] = await Promise.all([f.analytics ? api('/api/host/analytics?' + qs) : null, f.exports ? api('/api/host/exports?' + qs) : null]);
    const range = (a || ex).range;
    const out = [h('div', { class: 'ht-toolbar' }, h('div', { class: 'grow' }, h('strong', null, rangeLabel(range)), h('span', { class: 'tiny muted' }, ` · ${range.days} day${range.days === 1 ? '' : 's'}, UTC`)), rangePicker(R, reload))];
    if (a) {
      const t = a.totals;
      out.push(stats(stat(t.sessions, 'sessions', { ic: 'calendar' }), stat(t.people, 'people joined', { ic: 'users' }), stat(t.registrations, 'registrations', { ic: 'ticket' }),
        stat(t.peak, 'peak concurrent', { ic: 'activity' }), stat(naira(t.grossInRangeKobo), 'ticket & gift sales', { ic: 'wallet' }), stat(naira(t.balanceKobo), 'balance now', { ic: 'coin' })));
      out.push(panel({ icon: 'chart', title: 'Attendance and registrations', desc: 'Joins to your rooms and RSVPs to your events, per day.' },
        areaChart([{ name: 'Joins', values: a.audienceByDay.map((d) => ({ day: d.day, value: d.joins })) }, { name: 'Registrations', values: a.registrationsByDay.map((d) => ({ day: d.day, value: d.registrations })), color: 'var(--chart-2, #10b981)' }],
          { label: 'Joins and registrations per day', emptyText: 'No joins or registrations in this range yet.' })));
      const e = a.engagement;
      out.push(h('div', { class: 'ht-grid2' },
        panel({ icon: 'activity', title: 'Peak concurrent viewers', desc: range.days > 31 ? 'Highest in one room, per week.' : 'Highest in one room, per day.' },
          barChart(weekly(a.peakByDay, 'peak'), { label: 'Peak concurrent viewers', emptyText: 'No sessions in this range yet.', unit: ' viewers' })),
        panel({ icon: 'chats', title: 'Engagement', desc: 'How people took part in your sessions.' },
          donutChart([{ name: 'Chat messages', value: e.chat }, { name: 'Questions', value: e.questions }, { name: 'Poll votes', value: e.pollVotes }, { name: 'Transcript lines', value: e.transcriptLines }], { label: 'Engagement', center: 'actions' }))));
      out.push(panel({ icon: 'calendar', title: 'Events in this range' },
        table([{ label: 'Event' }, { label: 'Starts' }, { label: 'RSVPs', num: true }, { label: 'Joins', num: true }, { label: 'Peak', num: true }],
          a.events.slice(0, 20).map((ev) => [h('a', { href: '/e/' + ev.slug, 'data-link': '', class: 'ht-strong' }, ev.title), dayFmt(ev.startsAt), String(ev.rsvps), String(ev.joins), String(ev.peak)]),
          { empty: empty('calendar', 'No events in this range', 'Events you host that start in this window show here.', h('a', { class: 'btn sm', href: '/create', 'data-link': '' }, 'Create an event')) })));
    } else out.push(locked('analytics'));
    out.push(exportsPanel(f, ex, qs));
    return out;
  },

  // ---------------------------------------------------------------- branding
  async branding() {
    const { venues } = await api('/api/venues');
    if (!venues.length) return [panel({ icon: 'palette', title: 'Branding' }, empty('home', 'No venues yet', 'Create a venue first, then brand it here.', h('a', { class: 'btn primary sm', href: '/venues', 'data-link': '' }, 'Venues')))];
    return venues.map((v) => {
      const b = v.brand || {};
      const logo = inp({ value: b.logoUrl || '', placeholder: 'Logo image link' }), cover = inp({ value: b.coverUrl || '', placeholder: 'Cover image link' });
      const acc = inp({ type: 'color', value: b.accent || '#2563eb', class: 'input ht-color' }), acc2 = inp({ type: 'color', value: b.accent2 || '#db2777', class: 'input ht-color' });
      const about = h('textarea', { class: 'input', rows: 4, maxlength: 2000, placeholder: 'About this venue' }, b.about || '');
      const prevCover = h('div', { class: 'ht-brand-cover' }); const prevLogo = h('div', { class: 'ht-brand-logo' }, v.name.slice(0, 1).toUpperCase());
      const prevName = h('strong', null, v.name); const prevAbout = h('p', { class: 'tiny muted' });
      const preview = h('div', { class: 'ht-brand-prev', 'aria-label': 'Preview' }, prevCover, h('div', { class: 'ht-brand-row' }, prevLogo, h('div', { class: 'grow' }, prevName, prevAbout)), h('span', { class: 'ht-brand-btn' }, 'Join'));
      const safeUrl = (u) => (/^(\/files\/|https:\/\/)/.test(u) ? u.replace(/["()\\]/g, '') : '');
      const paint = () => {
        preview.style.setProperty('--b1', acc.value); preview.style.setProperty('--b2', acc2.value);
        prevCover.style.backgroundImage = safeUrl(cover.value) ? `url("${safeUrl(cover.value)}")` : '';
        prevLogo.style.backgroundImage = safeUrl(logo.value) ? `url("${safeUrl(logo.value)}")` : ''; prevLogo.textContent = safeUrl(logo.value) ? '' : v.name.slice(0, 1).toUpperCase();
        prevAbout.textContent = (about.value || 'Your about text shows here.').slice(0, 120);
      };
      [logo, cover, acc, acc2, about].forEach((x) => x.addEventListener('input', paint)); paint();
      const up = (target, label) => { const i = h('input', { type: 'file', accept: 'image/*', hidden: true }); i.onchange = async () => { try { const r = await uploadFile(i.files[0], { purpose: 'cover' }); target.value = r.url; paint(); toast('Uploaded', { icon: 'check' }); } catch (e) { toastErr(e); } }; return h('span', { class: 'ht-up' }, i, iconBtn('upload', `Upload ${label}`, { onClick: () => i.click() })); };
      return panel({ icon: 'palette', title: v.name, desc: `1venue.live/v/${v.slug}`, actions: iconBtn('eye', 'View venue', { href: '/v/' + v.slug }) },
        h('div', { class: 'ht-brand' },
          h('div', { class: 'ht-form' },
            field('Logo', h('div', { class: 'ht-inline' }, logo, up(logo, 'logo'))),
            field('Cover', h('div', { class: 'ht-inline' }, cover, up(cover, 'cover'))),
            h('div', { class: 'ht-inline' }, field('Main colour', acc), field('Second colour', acc2)),
            field('About', about),
            h('div', { class: 'ht-actions' }, actionBtn('Save branding', async () => {
              await api('/api/branding/venues/' + v.slug, { method: 'PUT', body: { logoUrl: logo.value || null, coverUrl: cover.value || null, accent: acc.value, accent2: acc2.value, about: about.value } });
              toast('Branding saved', { icon: 'check' });
            }, { primary: true, ic: 'check' }))),
          preview));
    });
  },

  // ---------------------------------------------------------------- recurring
  async recurring({ f, show }) {
    const { series } = await api('/api/series');
    const kind = sel([['event', 'Public event'], ['meeting', 'Meeting']], 'event');
    const title = inp({ placeholder: 'e.g. Sunday service', maxlength: 120 });
    const start = inp({ type: 'datetime-local' });
    const dur = inp({ type: 'number', min: 15, max: 720, step: 15, value: 60 });
    const endBy = sel([['count', 'After a number of times'], ['until', 'On a date']], 'count');
    const count = inp({ type: 'number', min: 2, max: 52, value: 8 }), until = inp({ type: 'date', hidden: true });
    endBy.onchange = () => { count.hidden = endBy.value !== 'count'; until.hidden = endBy.value !== 'until'; };
    let pattern = 'weekly';
    const pat = chips([['weekly', 'Every week'], ['biweekly', 'Every 2 weeks'], ['monthly', 'Every month']], pattern, (id) => { pattern = id; }, { label: 'Repeats' });
    const invitees = inp({ placeholder: 'Invitee emails for meetings, comma separated' });
    const create = actionBtn('Create series', async () => {
      if (!title.value || !start.value) throw new Error('Add a title and the first start time');
      const r = await api('/api/series', { method: 'POST', body: { kind: kind.value, title: title.value, firstStart: new Date(start.value).toISOString(), durationMin: Number(dur.value), pattern,
        count: endBy.value === 'count' ? Number(count.value) : undefined, until: endBy.value === 'until' && until.value ? new Date(until.value + 'T23:59:59').toISOString() : undefined, invitees: invitees.value, visibility: 'public' } });
      toast(`Created ${(r.occurrences || []).length} occurrences`, { icon: 'check' }); show('recurring');
    }, { primary: true, ic: 'plus' });
    const PAT = { weekly: 'Weekly', biweekly: 'Every 2 weeks', monthly: 'Monthly' };
    return [
      panel({ icon: 'calendarPlus', title: 'New recurring series', desc: f.reminders ? 'Hosts, RSVPs, ticket holders and invitees get reminders 24 hours and 1 hour before each one.' : 'Reminders need a paid plan.' },
        h('div', { class: 'ht-form-grid' }, field('Type', kind), field('Title', title), field('First start', start), field('Minutes', dur)),
        field('Repeats', pat),
        h('div', { class: 'ht-form-grid' }, field('Ends', endBy), field(' ', h('div', null, count, until)), h('div', { class: 'ht-span2' }, field('Invitees (meetings)', invitees))),
        h('div', { class: 'ht-actions' }, create)),
      panel({ icon: 'calendar', title: 'Your series' },
        table([{ label: 'Series' }, { label: 'Type' }, { label: 'Repeats' }, { label: 'Times', num: true }, { label: 'Next' }, { label: '', cls: 'ht-act' }],
          series.map((s) => [h('span', { class: 'ht-strong' }, s.title), pill(s.kind === 'meeting' ? 'Meeting' : 'Event', 'muted'), PAT[s.pattern] || s.pattern, String(s.occurrences),
            s.next ? whenFmt(s.next.startsAt) : pill('Finished', 'muted'),
            h('span', { class: 'ht-row-actions' }, s.next && s.next.slug ? iconBtn('eye', 'Open the next one', { href: '/e/' + s.next.slug }) : null,
              s.next ? iconBtn('xCircle', 'Cancel future occurrences', { cls: 'danger', onClick: async () => { if (!(await confirmDlg('Cancel all future occurrences of this series?', { ok: 'Cancel them', danger: true }))) return; await api('/api/series/' + s.id, { method: 'DELETE' }); show('recurring'); } }) : null)]),
          { empty: empty('calendar', 'No series yet', 'Create one above and every occurrence is scheduled for you.') })),
    ];
  },

  // ---------------------------------------------------------------- promote
  async promote({ show }) {
    const [{ hosting }, { promotions }, table_] = await Promise.all([api('/api/events/mine'), api('/api/promote/mine'), api('/api/plans')]);
    return [promoteFlow(hosting, promotions, table_, show), yourPromotions(promotions, table_, show)];
  },

  // ---------------------------------------------------------------- tickets
  async tickets() {
    const { hosting } = await api('/api/events/mine');
    const evs = hosting.filter((e) => e.status !== 'ended' && e.status !== 'cancelled');
    if (!evs.length) return [panel({ icon: 'ticket', title: 'Tickets' }, empty('ticket', 'No upcoming events', 'Create an event, then add free or paid tiers here.', h('a', { class: 'btn primary sm', href: '/create', 'data-link': '' }, 'Create an event')))];
    return [h('p', { class: 'small muted ht-note', html: icon('info', { size: 15 }) + '<span>When an event has tiers on sale, people need a ticket to join. You and your speakers always get in. Paid tiers can’t change price once sold.</span>' }),
      ...(await Promise.all(evs.slice(0, 20).map(async (e) => {
        const { tiers } = await api(`/api/events/${e.id}/tickets/tiers`);
        const body = h('tbody');
        const rows = [];
        const none = h('tr', { class: 'ht-none' }, h('td', { colspan: 6, class: 'small muted' }, 'No tiers yet, so anyone can join free. Add a tier to sell tickets or cap the numbers.'));
        const sync = () => { if (rows.length) none.remove(); else body.append(none); };
        const addRow = (t = {}) => {
          const name = inp({ value: t.name || '', placeholder: 'Tier name', 'aria-label': 'Tier name' });
          const price = inp({ type: 'number', min: 0, step: 50, value: t.priceKobo != null ? t.priceKobo / 100 : 0, disabled: t.sold > 0 && t.priceKobo > 0, 'aria-label': 'Price in naira, 0 is free' });
          const qty = inp({ type: 'number', min: 0, value: t.quantity ?? '', placeholder: 'No limit', 'aria-label': 'Quantity' });
          const act = h('input', { type: 'checkbox', checked: t.active !== false, class: 'ht-switch', 'aria-label': 'On sale' });
          const tr = h('tr', null, h('td', { 'data-label': 'Tier' }, name), h('td', { 'data-label': 'Price (₦)' }, price), h('td', { 'data-label': 'Quantity' }, qty), h('td', { 'data-label': 'On sale' }, act),
            h('td', { 'data-label': 'Sold', class: 'num' }, String(t.sold || 0)),
            h('td', { class: 'ht-act' }, !t.sold ? iconBtn('trash', 'Remove tier', { cls: 'danger', onClick: () => { tr.remove(); rows.splice(rows.indexOf(tr), 1); sync(); } }) : null));
          tr.read = () => ({ id: t.id, name: name.value, priceKobo: Math.round(Number(price.value || 0) * 100), quantity: qty.value === '' ? null : Number(qty.value), active: act.checked });
          rows.push(tr); body.append(tr); sync();
        };
        tiers.forEach(addRow); sync();
        const sold = tiers.reduce((x, t) => x + (t.sold || 0), 0);
        return panel({ icon: 'ticket', title: e.title, desc: `${whenFmt(e.startsAt)} · ${tiers.length} tier${tiers.length === 1 ? '' : 's'} · ${sold} sold`, actions: iconBtn('eye', 'View event', { href: '/e/' + e.slug }) },
          h('div', { class: 'ht-table-wrap ht-edit' }, h('table', { class: 'ht-table' }, h('thead', null, h('tr', null, ...['Tier', 'Price (₦)', 'Quantity', 'On sale', 'Sold', ''].map((l, i) => h('th', { class: i === 4 ? 'num' : i === 5 ? 'ht-act' : null }, l)))), body)),
          h('div', { class: 'ht-actions' }, actionBtn('Add tier', () => addRow(), { ic: 'plus' }),
            actionBtn('Save tiers', async () => { await api(`/api/events/${e.id}/tickets/tiers`, { method: 'PUT', body: { tiers: rows.map((r) => r.read()) } }); toast('Tiers saved', { icon: 'check' }); }, { primary: true, ic: 'check' })));
      })))];
  },

  // ---------------------------------------------------------------- earnings
  async earnings({ show }) {
    const e = await api('/api/earnings');
    return earningsView(e, show);
  },

  // ---------------------------------------------------------------- organisation
  async org({ f, show }) {
    const { orgs } = await api('/api/orgs');
    if (!orgs.length) {
      if (!f.orgMembers) return [locked('org')];
      const name = inp({ placeholder: 'Organisation name', maxlength: 80 });
      return [panel({ icon: 'users', title: 'Create your organisation', desc: `Invite up to ${f.orgMembers} people as admins or moderators, run several venues and share a materials library.` },
        h('div', { class: 'ht-inline' }, name, actionBtn('Create', async () => { await api('/api/orgs', { method: 'POST', body: { name: name.value } }); show('org'); }, { primary: true, ic: 'plus' })))];
    }
    return (await Promise.all(orgs.map(async (o) => {
      const d = await api('/api/orgs/' + o.id);
      const p = d.permissions;
      const email = inp({ type: 'email', placeholder: 'name@example.com', 'aria-label': 'Email to invite' }), role = sel([['moderator', 'Moderator'], ['admin', 'Admin']], 'moderator');
      const venueName = inp({ placeholder: 'New venue name', maxlength: 60, 'aria-label': 'New venue name' });
      const roleSel = (m) => { const s = sel([['moderator', 'Moderator'], ['admin', 'Admin']], m.role); s.setAttribute('aria-label', `Role for ${m.name}`); s.onchange = async () => { try { await api(`/api/orgs/${o.id}/members/${m.userId}`, { method: 'PATCH', body: { role: s.value } }); toast('Role updated', { icon: 'check' }); } catch (e) { toastErr(e); } }; return s; };
      const ROLE_TONE = { owner: 'accent', admin: 'ok', moderator: 'muted' };
      return [
        panel({ icon: 'users', title: d.org.name, desc: `You are ${d.role}. ${d.members.length}${d.memberLimit ? ' of ' + d.memberLimit : ''} members.`,
          actions: d.role === 'owner' ? iconBtn('trash', 'Delete organisation', { cls: 'danger', onClick: async () => { if (!(await confirmDlg('Delete this organisation? Venues stay with you; members lose access.', { ok: 'Delete', danger: true }))) return; await api('/api/orgs/' + o.id, { method: 'DELETE' }); show('org'); } }) : null },
          table([{ label: 'Member' }, { label: 'Email' }, { label: 'Role' }, { label: '', cls: 'ht-act' }],
            d.members.map((m) => [h('span', { class: 'ht-strong' }, m.name), m.email || h('span', { class: 'muted' }, 'Hidden'),
              m.role !== 'owner' && p['members.admin'] ? roleSel(m) : pill(m.role, ROLE_TONE[m.role] || 'muted'),
              m.role !== 'owner' && (p['members.admin'] || (p['members.invite'] && m.role === 'moderator') || m.userId === state.user.id)
                ? iconBtn(m.userId === state.user.id ? 'logout' : 'userX', m.userId === state.user.id ? 'Leave organisation' : `Remove ${m.name}`, { cls: 'danger', onClick: async () => { if (!(await confirmDlg(m.userId === state.user.id ? 'Leave this organisation?' : 'Remove this member?', { ok: m.userId === state.user.id ? 'Leave' : 'Remove', danger: true }))) return; await api(`/api/orgs/${o.id}/members/${m.userId}`, { method: 'DELETE' }); show('org'); } }) : null])),
          d.invites.length ? h('h3', { class: 'ht-sub' }, 'Pending invites') : null,
          d.invites.length ? table([{ label: 'Email' }, { label: 'Role' }, { label: 'Expires' }, { label: '', cls: 'ht-act' }], d.invites.map((i) => [i.email, pill(i.role, 'muted'), whenFmt(i.expiresAt),
            iconBtn('x', `Revoke invite for ${i.email}`, { cls: 'danger', onClick: async () => { await api(`/api/orgs/${o.id}/invites/${i.id}`, { method: 'DELETE' }); show('org'); } })])) : null,
          p['members.invite'] ? h('div', { class: 'ht-inline ht-invite' }, email, p['members.admin'] ? role : null, actionBtn('Send invite', async () => { await api(`/api/orgs/${o.id}/invites`, { method: 'POST', body: { email: email.value, role: role.value } }); toast('Invite sent', { icon: 'check' }); show('org'); }, { primary: true, ic: 'send' })) : null),
        h('div', { class: 'ht-grid2' },
          panel({ icon: 'home', title: 'Venues' },
            table([{ label: 'Venue' }, { label: 'Link' }, { label: '', cls: 'ht-act' }], d.venues.map((v) => [h('span', { class: 'ht-strong' }, v.name), h('code', { class: 'tiny' }, '/v/' + v.slug), h('span', { class: 'ht-row-actions' }, v.archived ? pill('Archived', 'muted') : null, iconBtn('eye', `Open ${v.name}`, { href: '/v/' + v.slug }))]),
              { empty: empty('home', 'No venues yet', 'Venues you add here belong to the organisation.') }),
            p['venue.create'] ? h('div', { class: 'ht-inline' }, venueName, actionBtn('Add venue', async () => { await api(`/api/orgs/${o.id}/venues`, { method: 'POST', body: { name: venueName.value } }); show('org'); }, { ic: 'plus' })) : null),
          panel({ icon: 'bookOpen', title: 'Shared library' },
            table([{ label: 'Material' }, { label: 'Kind' }, { label: '', cls: 'ht-act' }], d.library.map((m) => [h('span', { class: 'ht-strong' }, m.title), pill(m.kind, 'muted'),
              p['library.manage'] || m.ownerUserId === state.user.id ? iconBtn('x', `Unshare ${m.title}`, { onClick: async () => { await api(`/api/orgs/${o.id}/materials/${m.id}`, { method: 'DELETE' }); show('org'); } }) : null]),
              { empty: empty('bookOpen', 'Nothing shared yet', 'Share one of your materials so members can use it.') }),
            p['library.manage'] ? sharePicker(o.id, show) : null)),
      ];
    }))).flat();
  },

  // ---------------------------------------------------------------- replays
  async replays({ f, show }) {
    const [{ replays, usedBytes, egress }, { hosting }] = await Promise.all([api('/api/replays/mine'), api('/api/events/mine')]);
    const ev = sel([['', 'No event'], ...hosting.map((e) => [String(e.id), e.title])], '');
    const title = inp({ placeholder: 'Title (optional)', maxlength: 120 });
    const vis = sel([['public', 'Public'], ['unlisted', 'Anyone with the link'], ['private', 'Only me']], 'public');
    const file = h('input', { type: 'file', accept: 'video/*,audio/*', class: 'input' });
    const link = inp({ type: 'url', placeholder: 'https://… (YouTube, Drive, or your own host)' });
    const code = inp({ placeholder: 'Room code of a live room you host' });
    const status = h('p', { class: 'tiny muted', role: 'status' });
    const qs = () => new URLSearchParams({ ...(ev.value ? { eventId: ev.value } : {}), title: title.value, visibility: vis.value }).toString();
    const modes = { record: h('div', { class: 'ht-inline' }, code, actionBtn('Record live room', async () => { await api('/api/replays/egress', { method: 'POST', body: { code: code.value, eventId: ev.value ? Number(ev.value) : undefined, title: title.value, visibility: vis.value } }); toast('Recording started', { icon: 'check' }); show('replays'); }, { primary: true, ic: 'record' })),
      upload: h('div', { class: 'ht-inline' }, file, actionBtn('Upload', async () => {
        const fl = file.files[0]; if (!fl) throw new Error('Choose a video or audio file');
        status.textContent = 'Uploading… keep this page open.';
        const res = await fetch('/api/replays/upload?' + qs(), { method: 'POST', body: fl, credentials: 'include', headers: { 'Content-Type': fl.type || 'video/mp4', 'X-File-Name': encodeURIComponent(fl.name) } });
        const d = await res.json().catch(() => ({})); status.textContent = '';
        if (!res.ok) throw new Error(d.error || `Upload failed (HTTP ${res.status})`);
        toast('Replay uploaded', { icon: 'check' }); show('replays');
      }, { primary: true, ic: 'upload' })),
      link: h('div', { class: 'ht-inline' }, link, actionBtn('Add link', async () => { await api('/api/replays/link', { method: 'POST', body: { url: link.value, eventId: ev.value ? Number(ev.value) : undefined, title: title.value, visibility: vis.value } }); show('replays'); }, { primary: true, ic: 'link' })) };
    const first = egress ? 'record' : 'upload';
    const modeBox = h('div', null, modes[first]);
    const opts = [...(egress ? [['record', 'Record a live room', 'record']] : []), ['upload', 'Upload a file', 'upload'], ['link', 'Add a link', 'link']];
    const mb = Math.round(usedBytes / 1048576), cap = f.replayMB || 0;
    const ST = { ready: ['Ready', 'ok'], recording: ['Recording', 'bad'], processing: ['Processing', 'wait'], failed: ['Failed', 'bad'] };
    const VIS = { public: 'Public', unlisted: 'Link only', private: 'Only me' };
    return [
      panel({ icon: 'plus', title: 'Add a replay', desc: egress ? null : 'Cloud recording isn’t switched on for this server, so upload a file or add a link.' },
        h('div', { class: 'ht-form-grid' }, field('Event', ev), field('Title', title), field('Who can watch', vis)),
        chips(opts, first, (id) => modeBox.replaceChildren(modes[id]), { label: 'How to add it' }), modeBox, status,
        h('div', { class: 'ht-meter', role: 'meter', 'aria-valuemin': '0', 'aria-valuemax': String(cap), 'aria-valuenow': String(mb), 'aria-label': 'Replay storage' },
          h('span', { style: { width: `${cap ? Math.min(100, (mb / cap) * 100) : 0}%` } })), h('p', { class: 'tiny muted' }, `Storage: ${mb.toLocaleString()} MB of ${cap.toLocaleString()} MB`)),
      panel({ icon: 'play', title: 'Your replays' },
        table([{ label: 'Replay' }, { label: 'Status' }, { label: 'Who can watch' }, { label: '', cls: 'ht-act' }],
          replays.map((r) => [h('span', null, h('a', { class: 'ht-strong', href: '/replay/' + r.id, 'data-link': '' }, r.title), r.error ? h('div', { class: 'tiny ht-err' }, r.error) : null),
            pill(...(ST[r.status] || [r.status, 'muted'])), VIS[r.visibility] || r.visibility,
            h('span', { class: 'ht-row-actions' }, iconBtn('play', `Watch ${r.title}`, { href: '/replay/' + r.id }),
              r.status === 'recording' ? iconBtn('stop', 'Stop recording', { onClick: async () => { await api(`/api/replays/${r.id}/stop`, { method: 'POST', body: {} }); show('replays'); } }) : null,
              iconBtn('trash', `Delete ${r.title}`, { cls: 'danger', onClick: async () => { if (!(await confirmDlg('Delete this replay?', { ok: 'Delete', danger: true }))) return; await api('/api/replays/' + r.id, { method: 'DELETE' }); show('replays'); } }))]),
          { empty: empty('play', 'No replays yet', 'Record a room, upload a file or add a link above.') })),
    ];
  },
};

function exportsPanel(f, ex, qs) {
  if (!f.exports) return panel({ icon: 'download', title: 'Exports' }, empty('lock', 'Exports are not on your plan', 'Download attendance, registrations, chat and transcripts as CSV or Excel.', h('a', { class: 'btn primary sm', href: '/upgrade', 'data-link': '' }, 'See plans')));
  const by = Object.fromEntries(ex.exports.map((x) => [x.id, x]));
  const main = table([{ label: 'Export' }, { label: 'What’s inside', cls: 'hide-sm' }, { label: 'Rows', num: true }, { label: 'Last updated' }, { label: 'Download', cls: 'ht-act' }],
    EXPORTS.map(([id, label, ic, desc]) => {
      const x = by[id] || { rows: 0, lastAt: null };
      return [h('span', { class: 'ht-exp' }, h('span', { class: 'ht-exp-ic', html: icon(ic, { size: 16 }) }), h('span', null, h('strong', null, label), h('span', { class: 'tiny muted ht-exp-desc' }, desc))),
        h('span', { class: 'small muted' }, desc), x.rows.toLocaleString(), x.lastAt ? whenFmt(x.lastAt) : h('span', { class: 'muted' }, '—'), downloads(`/api/exports/${id}?${qs}`, label.toLowerCase(), { disabled: !x.rows })];
    }), { cls: 'ht-exports', caption: 'Exports for this date range' });
  const perTable = (list) => table([{ label: 'Session' }, { label: 'Started' }, { label: 'People', num: true }, { label: 'Attendance', cls: 'ht-act' }, { label: 'Chat', cls: 'ht-act' }, { label: 'Transcript', cls: 'ht-act' }],
    list.map((s) => [h('span', { class: 'ht-strong' }, s.name), whenFmt(s.startedAt), String(s.people), downloads(`/api/exports/attendance/${s.id}`, `attendance for ${s.name}`, { disabled: !s.people }),
      downloads(`/api/exports/chat/${s.id}`, `chat for ${s.name}`, { disabled: !s.chatMessages }), downloads(`/api/exports/transcript/${s.id}`, `transcript for ${s.name}`, { disabled: !s.transcriptLines })]),
    { empty: empty('calendar', 'No sessions in this range', 'Pick a longer range to export older sessions.'), caption: 'Exports per session' });
  const LIMIT = 8;
  const per = h('div', { class: 'col', style: { gap: '.6rem' } }, perTable(ex.sessions.slice(0, LIMIT)));
  if (ex.sessions.length > LIMIT) {
    const more = h('button', { class: 'btn sm', type: 'button' }, `Show all ${ex.sessions.length} sessions`);
    more.onclick = () => per.replaceChildren(perTable(ex.sessions));
    per.append(h('div', { class: 'ht-actions', style: { justifyContent: 'center' } }, more));
  }
  return panel({ icon: 'download', title: 'Exports', desc: 'Everything in the selected date range. CSV opens anywhere; Excel keeps the columns.' }, main, h('h3', { class: 'ht-sub' }, 'Per session'), per);
}

// ---------------------------------------------------------------- promote: picker, placements, live server quote
const PLACE = {
  discover: ['Discover top', 'compass', 'Top of the Discover sidebar, where people look for something to join.'],
  feed: ['Feed boost', 'feed', 'A promoted card in the home feed.'],
  venues: ['Venues sidebar', 'home', 'Beside venue pages people are already visiting.'],
  books: ['Books sidebar', 'bookOpen', 'Beside the Bible and books reader.'],
};
const STATE = { live: ['Running', 'ok', 'play'], scheduled: ['Scheduled', 'accent', 'clock'], paused: ['Paused', 'muted', 'pause'], ended: ['Ended', 'muted', 'checkCircle'], pending: ['In review', 'wait', 'hourglass'], rejected: ['Not approved', 'bad', 'xCircle'] };
function cover(ev, cls = 'ht-cover') {
  const url = ev.coverUrl || ev.cover;
  return h('span', { class: cls, style: url ? { backgroundImage: `url("${String(url).replace(/["()\\]/g, '')}")` } : { '--h': String([...String(ev.title || '?')].reduce((a, c) => (a * 31 + c.charCodeAt(0)) % 360, 7)) } }, url ? null : String(ev.title || '?').slice(0, 1).toUpperCase());
}
function eventPicker(events, promos, onPick) {
  const q = inp({ type: 'search', class: 'input ht-ev-q', placeholder: 'Search your upcoming public events…', 'aria-label': 'Search events', role: 'combobox', 'aria-expanded': 'true', 'aria-controls': 'ht-ev-list', autocomplete: 'off' });
  const list = h('div', { class: 'ht-ev-list', id: 'ht-ev-list', role: 'listbox', 'aria-label': 'Events' });
  let picked = null, active = 0, shown = [];
  const promoted = new Set(promos.filter((p) => ['live', 'scheduled', 'pending', 'paused'].includes(p.state)).map((p) => p.eventId));
  const statusOf = (e) => (e.live && e.live.live ? ['Live now', 'bad'] : e.status === 'scheduled' || e.status === 'published' ? ['Upcoming', 'accent'] : [e.status, 'muted']);
  const paint = () => {
    const t = q.value.trim().toLowerCase();
    shown = events.filter((e) => !t || e.title.toLowerCase().includes(t) || (e.category || '').toLowerCase().includes(t));
    active = Math.min(active, Math.max(0, shown.length - 1));
    list.replaceChildren(...(shown.length ? shown.map((e, i) => {
      const [st, tone] = statusOf(e);
      const b = h('button', { type: 'button', role: 'option', class: 'ht-ev' + (picked && picked.id === e.id ? ' picked' : '') + (i === active ? ' on' : ''), 'aria-selected': String(!!(picked && picked.id === e.id)), onclick: () => choose(e) },
        cover(e), h('span', { class: 'grow ht-ev-text' }, h('strong', null, e.title), h('span', { class: 'tiny muted' }, `${whenFmt(e.startsAt)}${e.rsvps != null ? ` · ${e.rsvps} RSVPs` : ''}`)),
        h('span', { class: 'ht-ev-tags' }, pill(st, tone), promoted.has(e.id) ? pill('Promoted', 'ok', 'megaphone') : null),
        h('span', { class: 'ht-ev-tick', html: icon('checkCircle', { size: 20 }) }));
      return b;
    }) : [empty('search', events.length ? 'No events match' : 'No upcoming public events', events.length ? 'Try another word.' : 'Create a public event to promote it.', events.length ? null : h('a', { class: 'btn primary sm', href: '/create', 'data-link': '' }, 'Create an event'))]));
  };
  const choose = (e) => { picked = e; paint(); onPick(e); };
  q.addEventListener('input', () => { active = 0; paint(); });
  q.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); active = Math.max(0, Math.min(shown.length - 1, active + (e.key === 'ArrowDown' ? 1 : -1))); paint(); const on = list.querySelector('.ht-ev.on'); if (on) on.scrollIntoView({ block: 'nearest' }); }
    else if (e.key === 'Enter' && shown[active]) { e.preventDefault(); choose(shown[active]); }
  });
  paint();
  if (events[0]) choose(events[0]);
  return h('div', { class: 'ht-picker' }, h('div', { class: 'ht-ev-search', html: icon('search', { size: 18 }) }, q), list);
}
function quoteView(qt) {
  const m = moneyConfig();
  const row = (k, v, cls = '') => h('div', { class: `ht-q-row ${cls}`.trim() }, h('span', null, k), h('span', null, v));
  return h('div', { class: 'ht-quote', role: 'group', 'aria-label': 'Price breakdown' },
    ...qt.placements.map((l) => row(h('span', null, h('span', { class: 'ht-q-place', html: icon(PLACE[l.id][1], { size: 14 }) }), `${PLACE[l.id][0]} · ${naira(l.dayKobo)} × ${qt.days} day${qt.days === 1 ? '' : 's'}`), naira(l.kobo))),
    row('Subtotal', naira(qt.grossKobo), 'ht-sep'),
    qt.discountPercent ? row(`Duration discount (${qt.days}+ days, ${qt.discountPercent}% off)`, '−' + naira(qt.discountKobo), 'ht-save') : null,
    qt.discountPercent ? row('After discount', naira(qt.subtotalKobo)) : null,
    row(`Processing fee (${qt.feePercent}%)`, naira(qt.processingFeeKobo)),
    row('Total', naira(qt.totalKobo), 'ht-total'),
    m.currency !== m.base ? h('p', { class: 'tiny muted' }, `Charged in ${m.base} as ${fmtIn(qt.totalKobo, m.base)}. ${m.currency} amounts are estimates.`) : null,
    qt.nextTier ? h('p', { class: 'tiny ht-hint', html: icon('sparkle', { size: 13 }) + `<span>Promote for ${qt.nextTier.minDays}+ days to save ${qt.nextTier.percent}%.</span>` }) : null);
}
function daysControl(max, value, onChange) {
  const n = inp({ type: 'number', min: 1, max, value, class: 'input ht-days-n', 'aria-label': 'Days' });
  const r = h('input', { type: 'range', min: 1, max, value, class: 'ht-days-r', 'aria-label': 'Days' });
  const c = chips([3, 7, 14, 30].filter((d) => d <= max).map((d) => [String(d), `${d} days`]), String(value), (id) => set(Number(id)), { label: 'Quick pick' });
  const set = (v) => { v = Math.max(1, Math.min(max, Math.round(Number(v) || 1))); n.value = v; r.value = v; c.set(String(v)); r.style.setProperty('--p', `${((v - 1) / Math.max(1, max - 1)) * 100}%`); onChange(v); };
  n.addEventListener('change', () => set(n.value)); r.addEventListener('input', () => set(r.value));
  r.style.setProperty('--p', `${((value - 1) / Math.max(1, max - 1)) * 100}%`);
  return h('div', { class: 'ht-days' }, h('div', { class: 'ht-inline' }, r, n, h('span', { class: 'small muted' }, 'days')), c);
}
function promoteFlow(hosting, promotions, plansTable, show) {
  const pp = plansTable.promoPricing || { rates: {}, tiers: [], maxDays: 30 };
  const upcoming = hosting.filter((e) => e.visibility === 'public' && !['ended', 'cancelled', 'draft'].includes(e.status));
  const S = { event: null, days: Math.min(7, pp.maxDays), placements: new Set(Object.keys(PLACE).filter((k) => pp.rates[k] > 0)) };
  const quoteBox = h('div', { class: 'ht-quote-box', 'aria-live': 'polite' });
  const payBtn = h('button', { class: 'btn primary ht-pay', type: 'button', html: icon('lock', { size: 16 }) + '<span>Pay and promote</span>' });
  let qv = 0, last = null;
  const requote = debounce(async () => {
    const v = ++qv;
    if (!S.placements.size) { quoteBox.replaceChildren(empty('megaphone', 'Pick at least one placement', null)); payBtn.disabled = true; return; }
    try {
      const r = await api(`/api/promote/quote?days=${S.days}&placements=${[...S.placements].join(',')}`);
      if (v !== qv) return; last = r; quoteBox.replaceChildren(quoteView(r)); payBtn.disabled = !S.event;
    } catch (e) { if (v === qv) { quoteBox.replaceChildren(h('p', { class: 'small ht-err' }, e.message)); payBtn.disabled = true; } }
  }, 150);
  const placeCards = h('div', { class: 'ht-places', role: 'group', 'aria-label': 'Placements' }, ...Object.entries(PLACE).map(([id, [label, ic, desc]]) => {
    const rate = pp.rates[id] || 0;
    const box = h('input', { type: 'checkbox', checked: S.placements.has(id), disabled: !rate, class: 'sr-only' });
    const card_ = h('label', { class: 'ht-place' + (S.placements.has(id) ? ' on' : '') + (!rate ? ' off' : '') }, box,
      h('span', { class: 'ht-place-ic', html: icon(ic, { size: 18 }) }), h('span', { class: 'grow' }, h('strong', null, label), h('span', { class: 'tiny muted' }, desc)),
      h('span', { class: 'ht-place-price' }, rate ? h('strong', null, naira(rate)) : 'Unavailable', rate ? h('span', { class: 'tiny muted' }, '/ day') : null),
      h('span', { class: 'ht-place-tick', html: icon('check', { size: 14 }) }));
    box.onchange = () => { if (box.checked) S.placements.add(id); else S.placements.delete(id); card_.classList.toggle('on', box.checked); requote(); };
    return card_;
  }));
  const tiers = pp.tiers.length ? h('p', { class: 'tiny muted ht-tiers', html: icon('tag', { size: 13 }) + `<span>Longer runs cost less: ${pp.tiers.map((t) => `${t.minDays}+ days ${t.percent}% off`).join(' · ')}.</span>` }) : null;
  payBtn.onclick = async () => {
    if (!S.event || !last) return;
    await checkoutSheet({ title: 'Promote an event', what: `${S.event.title}: ${S.days} days in ${[...S.placements].map((p) => PLACE[p][0]).join(', ')}.${last.discountPercent ? ` Includes ${last.discountPercent}% off for ${S.days}+ days.` : ''}`,
      subtotalKobo: last.subtotalKobo, start: () => api('/api/promote', { method: 'POST', body: { eventId: S.event.id, days: S.days, placements: [...S.placements] } }) });
  };
  payBtn.disabled = true;
  requote();
  return panel({ icon: 'megaphone', title: 'Promote an event', desc: 'Pick an event, where it shows and for how long. The price updates as you go.', cls: 'ht-promote' },
    h('div', { class: 'ht-step' }, h('span', { class: 'ht-step-n' }, '1'), h('h3', null, 'Event')),
    eventPicker(upcoming, promotions, (e) => { S.event = e; payBtn.disabled = !last || !S.placements.size; }),
    h('div', { class: 'ht-step' }, h('span', { class: 'ht-step-n' }, '2'), h('h3', null, 'Placements')), placeCards,
    h('div', { class: 'ht-step' }, h('span', { class: 'ht-step-n' }, '3'), h('h3', null, 'Duration')), daysControl(pp.maxDays, S.days, (v) => { S.days = v; requote(); }), tiers,
    h('div', { class: 'ht-step' }, h('span', { class: 'ht-step-n' }, '4'), h('h3', null, 'Price')), quoteBox,
    h('div', { class: 'ht-actions' }, h('span', { class: 'tiny muted grow' }, plansTable.purchasesEnabled === false ? 'Payments are not switched on yet.' : 'Paid through Paystack. New promotions may wait for a quick review before they run.'), payBtn));
}
function extendSheet(p, pp, show) {
  let days = Math.min(7, pp.maxDays); let last = null;
  const box = h('div', { class: 'ht-quote-box' });
  const go = h('button', { class: 'btn primary', type: 'button', html: icon('lock', { size: 16 }) + '<span>Continue</span>' });
  const requote = debounce(async () => { try { last = await api(`/api/promote/quote?days=${days}&placements=${p.placements.join(',')}`); box.replaceChildren(quoteView(last)); go.disabled = false; } catch (e) { box.replaceChildren(h('p', { class: 'small ht-err' }, e.message)); go.disabled = true; } }, 120);
  const s = sheet({ title: `Extend “${p.title || 'promotion'}”`, icon: 'plus', body: h('div', { class: 'col', style: { gap: '.8rem' } },
    h('p', { class: 'small muted' }, `Adds days on top of the current end date, in ${p.placements.map((x) => (PLACE[x] || [x])[0]).join(', ')}.`), daysControl(pp.maxDays, days, (v) => { days = v; requote(); }), box, h('div', { class: 'ht-actions' }, go)) });
  go.onclick = async () => { if (!last) return; s.close(); await checkoutSheet({ title: 'Extend promotion', what: `${days} more days for ${p.title}.`, subtotalKobo: last.subtotalKobo, start: () => api('/api/promote', { method: 'POST', body: { extendId: p.id, days } }) }); };
  requote(); void show;
}
function yourPromotions(promotions, plansTable, show) {
  const order = { live: 0, scheduled: 1, pending: 2, paused: 3, ended: 4, rejected: 5 };
  const list = [...promotions].sort((a, b) => (order[a.state] ?? 9) - (order[b.state] ?? 9) || b.id - a.id);
  const pp = plansTable.promoPricing || { maxDays: 30, tiers: [], rates: {} };
  const cards = list.map((p) => {
    const [st, tone, ic] = STATE[p.state] || [p.state, 'muted', 'info'];
    const pct = p.totalDays ? Math.min(100, (p.daysElapsed / p.totalDays) * 100) : 0;
    return h('article', { class: `ht-promo ${p.state}` },
      cover({ title: p.title, cover: p.cover }, 'ht-promo-cover'),
      h('div', { class: 'ht-promo-main' },
        h('div', { class: 'ht-promo-top' }, h('a', { class: 'ht-strong grow', href: p.slug ? '/e/' + p.slug : '#', 'data-link': '' }, p.title || 'Event'), pill(st, tone, ic)),
        h('div', { class: 'ht-badges' }, ...p.placements.map((x) => h('span', { class: 'ht-badge', html: icon((PLACE[x] || ['', 'tag'])[1], { size: 12 }) + `<span>${(PLACE[x] || [x])[0]}</span>` }))),
        p.totalDays ? h('div', { class: 'ht-progress' }, h('div', { class: 'ht-bar', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': String(p.totalDays), 'aria-valuenow': String(p.daysElapsed), 'aria-label': 'Days elapsed' }, h('span', { style: { width: pct + '%' } })),
          h('span', { class: 'tiny muted' }, p.state === 'ended' ? `Ran ${p.totalDays} days · ended ${dayFmt(p.endsAt)}` : `Day ${Math.min(p.totalDays, Math.floor(p.daysElapsed) + 1)} of ${p.totalDays} · ${p.daysLeft} left · ends ${dayFmt(p.endsAt)}`))
          : h('span', { class: 'tiny muted' }, p.state === 'pending' ? `${p.days || '?'} days, starts once approved` : ''),
        h('div', { class: 'ht-promo-stats' },
          h('span', null, h('strong', null, (p.views || 0).toLocaleString()), h('span', { class: 'tiny muted' }, 'impressions')),
          h('span', null, h('strong', null, (p.clicks || 0).toLocaleString()), h('span', { class: 'tiny muted' }, 'clicks')),
          h('span', null, h('strong', null, `${p.ctr || 0}%`), h('span', { class: 'tiny muted' }, 'CTR'))),
        h('div', { class: 'ht-promo-actions' },
          p.canExtend ? actionBtn('Extend', () => extendSheet(p, pp, show), { ic: 'plus', cls: 'sm' }) : null,
          p.canPause ? actionBtn(p.state === 'paused' ? 'Resume' : 'Pause', async () => { await api(`/api/promote/${p.id}/pause`, { method: 'POST', body: { paused: p.state !== 'paused' } }); toast(p.state === 'paused' ? 'Promotion resumed' : 'Promotion paused', { icon: 'check' }); show('promote'); }, { ic: p.state === 'paused' ? 'play' : 'pause', cls: 'sm' }) : null,
          p.slug ? iconBtn('eye', 'View event', { href: '/e/' + p.slug }) : null)));
  });
  return panel({ icon: 'activity', title: 'Your promotions', desc: 'Impressions and clicks update as people see your promoted cards.' },
    cards.length ? h('div', { class: 'ht-promos' }, ...cards) : empty('megaphone', 'No promotions yet', 'Promote an event above and it shows here with live stats.'));
}

// ---------------------------------------------------------------- earnings: bank fields, payouts, ledger
function bankPicker(names, value) {
  const input = inp({ value: value || '', placeholder: 'Search banks…', autocomplete: 'off', role: 'combobox', 'aria-expanded': 'false', 'aria-autocomplete': 'list', 'aria-controls': 'ht-bank-list', 'aria-label': 'Bank name' });
  const list = h('div', { class: 'ht-bank-list', id: 'ht-bank-list', role: 'listbox', hidden: true });
  let act = 0, opts = [];
  const close = () => { list.hidden = true; input.setAttribute('aria-expanded', 'false'); };
  const paint = () => {
    const t = input.value.trim().toLowerCase();
    opts = names.filter((n) => !t || n.toLowerCase().includes(t)).slice(0, 8);
    const other = t && !names.some((n) => n.toLowerCase() === t) ? [`Other: “${input.value.trim()}”`] : [];
    const all = [...opts, ...(other.length ? other : t ? [] : ['Other (type your bank’s name)'])];
    act = Math.min(act, all.length - 1);
    list.replaceChildren(...all.map((n, i) => h('button', { type: 'button', role: 'option', class: 'ht-bank' + (i === act ? ' on' : '') + (i >= opts.length ? ' other' : ''), onmousedown: (e) => { e.preventDefault(); pick(i, all); } }, n)));
    list.hidden = false; input.setAttribute('aria-expanded', 'true');
  };
  const pick = (i, all) => { if (i < opts.length) input.value = opts[i]; else if (/^Other: /.test(all[i])) input.value = input.value.trim(); else { input.value = ''; input.placeholder = 'Type your bank’s name'; input.focus(); } close(); input.dispatchEvent(new Event('change')); };
  input.addEventListener('focus', paint); input.addEventListener('input', () => { act = 0; paint(); }); input.addEventListener('blur', () => setTimeout(close, 120));
  input.addEventListener('keydown', (e) => { const n = list.children.length; if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); act = (act + (e.key === 'ArrowDown' ? 1 : -1) + n) % n; paint(); } else if (e.key === 'Enter' && !list.hidden) { e.preventDefault(); list.children[act] && list.children[act].dispatchEvent(new MouseEvent('mousedown')); } else if (e.key === 'Escape') close(); });
  return { el: h('div', { class: 'ht-bank-pick' }, h('span', { class: 'ht-bank-ic', html: icon('search', { size: 16 }) }), input, list), input };
}
function earningsView(e, show) {
  const lb = e.lastBank || {};
  const amount = inp({ type: 'number', min: e.payoutMinKobo / 100, value: Math.floor(Math.max(0, e.balanceKobo) / 100), inputmode: 'decimal' });
  const bank = bankPicker(e.banks || [], lb.bankName);
  const acct = inp({ value: lb.accountNumber || '', inputmode: 'numeric', maxlength: 10, pattern: '\\d{10}', placeholder: '10-digit NUBAN', autocomplete: 'off', 'aria-describedby': 'ht-acct-hint' });
  const acctName = inp({ value: lb.accountName || '', placeholder: 'As it appears at your bank', autocomplete: 'name', maxlength: 100 });
  const hint = h('span', { class: 'tiny muted', id: 'ht-acct-hint' }, 'Nigerian account numbers are 10 digits.');
  const check = () => { const v = acct.value.replace(/\D/g, '').slice(0, 10); if (v !== acct.value) acct.value = v; const ok = v.length === 10; acct.classList.toggle('bad', !!v && !ok); hint.textContent = !v ? 'Nigerian account numbers are 10 digits.' : ok ? '10 digits ✓' : `${v.length} of 10 digits`; hint.classList.toggle('ok', ok); return ok; };
  acct.addEventListener('input', check); check();
  const PST = { requested: ['Requested', 'wait', 'hourglass'], paid: ['Paid', 'ok', 'checkCircle'], rejected: ['Rejected', 'bad', 'xCircle'] };
  const KIND = { sale: 'Ticket sale', donation: 'Gift', refund: 'Refund', payout: 'Payout', payout_reversal: 'Payout returned' };
  const mask = (n) => (n ? '•••• ' + String(n).slice(-4) : '');
  return [
    stats(stat(naira(e.balanceKobo), 'available to pay out', { ic: 'wallet', tone: 'accent' }), stat(naira(e.grossKobo), 'gross sales', { ic: 'chart' }), stat(naira(e.feesKobo), `platform fee (${e.feeBps / 100}%)`, { ic: 'tag' })),
    panel({ icon: 'send', title: 'Request a payout', desc: `Minimum ${naira(e.payoutMinKobo)}. Sent by bank transfer, usually within a few working days.` },
      h('div', { class: 'ht-form-grid ht-bank-grid' },
        field('Amount (₦)', amount), field('Bank', bank.el), field('Account number', acct, hint), field('Account name', acctName)),
      h('div', { class: 'ht-actions' }, actionBtn('Request payout', async () => {
        if (!bank.input.value.trim()) throw new Error('Choose your bank');
        if (!check()) throw new Error('Nigerian account numbers are 10 digits');
        await api('/api/earnings/payouts', { method: 'POST', body: { amountKobo: Math.round(Number(amount.value) * 100), bankName: bank.input.value.trim(), accountNumber: acct.value, accountName: acctName.value } });
        toast('Payout requested', { icon: 'check' }); show('earnings');
      }, { primary: true, ic: 'send' }))),
    panel({ icon: 'history', title: 'Payouts' },
      table([{ label: 'Requested' }, { label: 'Amount', num: true }, { label: 'Pay to' }, { label: 'Status' }, { label: 'Reference' }],
        e.payouts.map((p) => { const [l, t, ic] = PST[p.status] || [p.status, 'muted', 'info']; const b = p.bank || {};
          return [whenFmt(p.requestedAt), naira(p.amountKobo),
            b.accountNumber || b.bankName ? h('span', { class: 'ht-payto' }, h('strong', null, b.bankName || 'Bank not recognised'), h('span', { class: 'tiny muted' }, [mask(b.accountNumber), b.accountName].filter(Boolean).join(' · ')), b.source === 'partial' ? h('span', { class: 'tiny muted' }, `From: ${p.bankDetails}`) : null) : h('span', { class: 'small' }, p.bankDetails || ''),
            pill(l, t, ic), [p.paidReference, p.adminNote].filter(Boolean).join(' · ') || h('span', { class: 'muted' }, '—')]; }),
        { empty: empty('history', 'No payouts yet', 'Requests you make show here with their status.') })),
    panel({ icon: 'fileText', title: 'Ledger', desc: 'Every sale, gift, refund and payout on your balance.' },
      table([{ label: 'Date' }, { label: 'Type' }, { label: 'Event' }, { label: 'Gross', num: true }, { label: 'Fee', num: true }, { label: 'Net', num: true }],
        e.ledger.map((l) => [whenFmt(l.at), KIND[l.kind] || l.kind, l.event || h('span', { class: 'muted' }, '—'), naira(l.grossKobo), naira(l.feeKobo), h('strong', { class: l.netKobo < 0 ? 'ht-neg' : 'ht-pos' }, naira(l.netKobo))]),
        { empty: empty('fileText', 'No sales yet', 'Ticket sales and gifts show here as they come in.') })),
  ];
}

function sharePicker(orgId, show) {
  const wrap = h('div', { class: 'ht-inline' });
  api('/api/materials').then(({ materials = [] }) => {
    const mine = materials.filter((m) => !m.orgId && m.ownerUserId === state.user.id);
    if (!mine.length) return;
    const s = sel(mine.map((m) => [String(m.id), m.title]), String(mine[0].id)); s.setAttribute('aria-label', 'Material to share');
    wrap.append(s, actionBtn('Share', async () => { await api(`/api/orgs/${orgId}/materials/${s.value}`, { method: 'PUT', body: {} }); show('org'); }, { ic: 'share' }));
  }).catch(() => {});
  return wrap;
}
export function unmount() {}
