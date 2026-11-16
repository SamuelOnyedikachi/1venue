// /host: host tools. Branding, recurring series, exports and analytics, promotions, tickets,
// earnings, organisation and replays. Every section asks the server; plan gating is enforced there
// and mirrored here from /api/billing features so locked tools show an upgrade link instead.
import { h, api, toast, toastErr, confirmDlg, uploadFile } from '../ui.js';
import { icon } from '../icons.js';
import { state, requireLogin } from '../app.js';

const naira = (k) => '₦' + (Number(k || 0) / 100).toLocaleString('en-NG', { maximumFractionDigits: 2 });
const when = (d) => (d ? new Date(d).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : '');
const TABS = [['analytics', 'Analytics', 'chart'], ['branding', 'Branding', 'palette'], ['recurring', 'Recurring', 'calendar'], ['promote', 'Promote', 'megaphone'],
  ['tickets', 'Tickets', 'ticket'], ['earnings', 'Earnings', 'wallet'], ['org', 'Organisation', 'users'], ['replays', 'Replays', 'play']];
const NEEDS = { analytics: 'analytics', branding: 'branding', recurring: 'recurring', promote: 'selfPromo', tickets: 'ticketing', replays: 'replays' };

const card = (title, ...kids) => h('section', { class: 'card pad col', style: { gap: '.7rem', marginBottom: '1rem' } }, h('h2', { class: 'h3' }, title), ...kids);
const lbl = (text, input) => h('label', { class: 'col', style: { gap: '.25rem' } }, h('span', { class: 'small muted' }, text), input);
const inp = (attrs = {}) => h('input', { class: 'input', ...attrs });
const sel = (opts, value) => h('select', { class: 'input' }, ...opts.map(([v, l]) => h('option', { value: v, selected: v === value }, l)));
const btn = (text, fn, primary) => {
  const b = h('button', { class: 'btn' + (primary ? ' primary' : ''), type: 'button' }, text);
  b.onclick = async () => { b.disabled = true; try { await fn(); } catch (e) { toastErr(e); } finally { b.disabled = false; } };
  return b;
};
const locked = (what) => h('p', { class: 'small' }, `${what} is not on your plan. `, h('a', { href: '/upgrade', 'data-link': '' }, 'Upgrade →'));

export async function mount(view, params = {}) {
  if (!state.user) { requireLogin(); return; }
  const q = new URLSearchParams(location.search);
  const me = await api('/api/billing');
  const f = me.features || {};
  let tab = q.get('tab') || 'analytics';
  const body = h('div');
  const nav = h('div', { class: 'row wrap', role: 'tablist', style: { gap: '.4rem', margin: '0 0 1rem' } });
  view.append(h('div', { class: 'page-head' }, h('h1', { html: icon('stage', { size: 26 }) + 'Host tools' }),
    h('p', { class: 'muted' }, `Your plan: ${me.plan}${me.orgPlan ? ` (organisation features from ${me.orgPlan})` : ''}.`)), nav, body);

  // Payment return (?reference=1vc-…) and org invite (?invite=TOKEN)
  const ref = q.get('reference') || q.get('trxref');
  if (ref && ref.startsWith('1vc-')) api(`/api/commerce/payments/${encodeURIComponent(ref)}/verify`, { method: 'POST', body: {} }).then((p) => toast(p.status === 'paid' ? 'Payment confirmed' : `Payment ${p.status}`, { icon: 'check' })).catch(toastErr);
  if (q.get('invite')) {
    try { const r = await api('/api/orgs/invites/accept', { method: 'POST', body: { token: q.get('invite') } }); toast(`You joined ${(r && (r.name || (r.org && r.org.name))) || 'the organisation'}`, { icon: 'check' }); tab = 'org'; }
    catch (e) { toastErr(e); }
  }

  async function show(id) {
    tab = id;
    history.replaceState(null, '', '/host?tab=' + id);
    nav.replaceChildren(...TABS.map(([t, l, ic]) => h('button', { type: 'button', role: 'tab', class: 'btn sm' + (t === tab ? ' primary' : ''), 'aria-selected': String(t === tab), html: icon(ic, { size: 15 }) + ' ' + l, onclick: () => show(t) })));
    body.replaceChildren(h('p', { class: 'muted small' }, 'Loading…'));
    try {
      if (NEEDS[id] && !f[NEEDS[id]]) { body.replaceChildren(card(TABS.find((t) => t[0] === id)[1], locked(TABS.find((t) => t[0] === id)[1]))); return; }
      body.replaceChildren(...(await SECTIONS[id]({ me, f, show })));
    } catch (e) { body.replaceChildren(h('p', { class: 'small' }, e.message || 'Could not load')); }
  }
  show(TABS.some((t) => t[0] === tab) ? tab : 'analytics');
}

// ---------------------------------------------------------------- analytics + exports
function bars(points, { height = 140, label = (p) => p.value } = {}) {
  const max = Math.max(1, ...points.map((p) => p.value));
  const w = Math.max(6, Math.floor(640 / Math.max(1, points.length)));
  const svg = `<svg viewBox="0 0 ${points.length * w} ${height + 18}" width="100%" height="${height + 18}" role="img" aria-label="Chart" preserveAspectRatio="none">${points.map((p, i) => {
    const bh = Math.round((p.value / max) * height);
    return `<rect x="${i * w + 1}" y="${height - bh}" width="${w - 2}" height="${bh}" rx="2" fill="var(--accent, #7c3aed)"><title>${String(p.label).replace(/</g, '')}: ${label(p)}</title></rect>`;
  }).join('')}<line x1="0" y1="${height}" x2="${points.length * w}" y2="${height}" stroke="currentColor" stroke-opacity=".2"/></svg>`;
  return h('div', { html: svg });
}
const stat = (n, l) => h('div', { class: 'card pad col', style: { minWidth: '8rem', gap: '.1rem' } }, h('strong', { style: { fontSize: '1.4rem' } }, String(n)), h('span', { class: 'tiny muted' }, l));
const exportLinks = (path) => h('span', { class: 'row', style: { gap: '.4rem' } }, h('a', { class: 'btn sm', href: path, download: '' }, 'CSV'), h('a', { class: 'btn sm', href: path + (path.includes('?') ? '&' : '?') + 'format=xlsx', download: '' }, 'Excel'));

const SECTIONS = {
  async analytics({ f }) {
    const out = [];
    if (f.analytics) {
      const a = await api('/api/host/analytics?days=30');
      const t = a.totals;
      out.push(card('Last 30 days',
        h('div', { class: 'row wrap', style: { gap: '.6rem' } }, stat(t.sessions, 'sessions'), stat(t.people, 'people joined'), stat(t.peak, 'peak in one room'), stat(t.tickets, 'valid tickets'), stat(naira(t.grossKobo), 'ticket & gift sales'), stat(naira(t.balanceKobo), 'balance')),
        h('strong', { class: 'small' }, 'Joins per day'), bars(a.audienceByDay.map((d) => ({ label: d.day, value: d.joins }))),
        a.events.length ? h('strong', { class: 'small' }, 'Events: peak viewers') : null,
        a.events.length ? bars(a.events.slice(0, 20).reverse().map((e) => ({ label: e.title, value: e.peak }))) : null,
        ...a.events.slice(0, 10).map((e) => h('div', { class: 'row small', style: { gap: '.5rem' } }, h('a', { class: 'grow', href: '/e/' + e.slug, 'data-link': '' }, e.title), h('span', { class: 'muted' }, `${e.rsvps} RSVPs · ${e.joins} joins · peak ${e.peak}`))),
        a.promotions.length ? h('strong', { class: 'small' }, 'Promotions') : null,
        ...a.promotions.map((p) => h('div', { class: 'tiny' }, `#${p.id} · ${p.views} views · ${p.clicks} clicks · ${p.ctr}% CTR · ${p.review}${p.active ? ' · active' : ''}`))));
      out.push(card('Exports', h('div', { class: 'row', style: { gap: '.5rem' } }, h('span', { class: 'grow small' }, 'All sessions (attendance summary)'), f.exports ? exportLinks('/api/exports/sessions') : locked('Exports')),
        ...a.sessions.map((s) => h('div', { class: 'row wrap', style: { gap: '.5rem' } }, h('span', { class: 'grow small' }, `${s.name} · ${when(s.startedAt)} · ${s.people} people`),
          f.exports ? h('span', { class: 'tiny muted' }, 'Attendance') : null, f.exports ? exportLinks('/api/exports/attendance/' + s.id) : null,
          f.exports ? h('span', { class: 'tiny muted' }, 'Transcript') : null, f.exports ? exportLinks('/api/exports/transcript/' + s.id) : null))));
    } else {
      out.push(card('Analytics', locked('The analytics dashboard')));
      if (f.exports) out.push(card('Exports', h('div', { class: 'row' }, h('span', { class: 'grow small' }, 'All sessions'), exportLinks('/api/exports/sessions'))));
    }
    return out;
  },

  // ---------------------------------------------------------------- branding
  async branding() {
    const { venues } = await api('/api/venues');
    if (!venues.length) return [card('Branding', h('p', { class: 'small' }, 'Create a venue first. ', h('a', { href: '/venues', 'data-link': '' }, 'Venues →')))];
    return venues.map((v) => {
      const b = v.brand || {};
      const logo = inp({ value: b.logoUrl || '', placeholder: 'Logo image link' }), cover = inp({ value: b.coverUrl || '', placeholder: 'Cover image link' });
      const acc = inp({ type: 'color', value: b.accent || '#7c3aed' }), acc2 = inp({ type: 'color', value: b.accent2 || '#db2777' });
      const about = h('textarea', { class: 'input', rows: 4, maxlength: 2000, placeholder: 'About this venue' }, b.about || '');
      const up = (target) => { const i = h('input', { type: 'file', accept: 'image/*', hidden: true }); i.onchange = async () => { try { const r = await uploadFile(i.files[0], { purpose: 'cover' }); target.value = r.url; toast('Uploaded', { icon: 'check' }); } catch (e) { toastErr(e); } }; return h('span', null, i, h('button', { class: 'btn sm', type: 'button', onclick: () => i.click() }, 'Upload')); };
      return card(`${v.name} · /v/${v.slug}`,
        h('div', { class: 'row', style: { gap: '.4rem' } }, h('div', { class: 'grow' }, lbl('Logo', logo)), up(logo)),
        h('div', { class: 'row', style: { gap: '.4rem' } }, h('div', { class: 'grow' }, lbl('Cover', cover)), up(cover)),
        h('div', { class: 'row', style: { gap: '.8rem' } }, lbl('Main colour', acc), lbl('Second colour', acc2)), lbl('About', about),
        h('div', { class: 'row', style: { gap: '.5rem' } }, btn('Save branding', async () => {
          await api('/api/branding/venues/' + v.slug, { method: 'PUT', body: { logoUrl: logo.value || null, coverUrl: cover.value || null, accent: acc.value, accent2: acc2.value, about: about.value } });
          toast('Branding saved', { icon: 'check' });
        }, true), h('a', { class: 'btn', href: '/v/' + v.slug, 'data-link': '' }, 'View venue')));
    });
  },

  // ---------------------------------------------------------------- recurring
  async recurring({ f, show }) {
    const { series } = await api('/api/series');
    const kind = sel([['event', 'Public event'], ['meeting', 'Meeting']], 'event');
    const title = inp({ placeholder: 'Title', maxlength: 120 });
    const start = inp({ type: 'datetime-local' });
    const dur = inp({ type: 'number', min: 15, max: 720, step: 15, value: 60 });
    const pattern = sel([['weekly', 'Every week'], ['biweekly', 'Every two weeks'], ['monthly', 'Every month']], 'weekly');
    const endBy = sel([['count', 'After a number of times'], ['until', 'On a date']], 'count');
    const count = inp({ type: 'number', min: 2, max: 52, value: 8 }), until = inp({ type: 'date', hidden: true });
    endBy.onchange = () => { count.hidden = endBy.value !== 'count'; until.hidden = endBy.value !== 'until'; };
    const invitees = inp({ placeholder: 'Invitee emails for meetings (comma separated)' });
    const create = btn('Create series', async () => {
      if (!title.value || !start.value) throw new Error('Add a title and the first start time');
      const r = await api('/api/series', { method: 'POST', body: { kind: kind.value, title: title.value, firstStart: new Date(start.value).toISOString(), durationMin: Number(dur.value), pattern: pattern.value,
        count: endBy.value === 'count' ? Number(count.value) : undefined, until: endBy.value === 'until' && until.value ? new Date(until.value + 'T23:59:59').toISOString() : undefined, invitees: invitees.value, visibility: 'public' } });
      toast(`Created ${(r.occurrences || []).length} occurrences`, { icon: 'check' }); show('recurring');
    }, true);
    return [
      card('New recurring series', h('div', { class: 'admin-plan-grid' }, lbl('Type', kind), lbl('Title', title), lbl('First start', start), lbl('Minutes', dur), lbl('Repeats', pattern), lbl('Ends', endBy), lbl('Times / end date', h('div', null, count, until))),
        invitees, h('p', { class: 'tiny muted' }, f.reminders ? 'Hosts, RSVPs, ticket holders and invitees get email reminders 24 hours and 1 hour before each one.' : 'Reminders need a paid plan.'), create),
      card('Your series', series.length ? null : h('p', { class: 'small muted' }, 'None yet.'),
        ...series.map((s) => h('div', { class: 'row wrap', style: { gap: '.5rem' } },
          h('span', { class: 'grow small' }, `${s.title} · ${s.kind} · ${s.pattern} · ${s.occurrences} times${s.next ? ' · next ' + when(s.next.startsAt) : ' · finished'}`),
          s.next && s.next.slug ? h('a', { class: 'btn sm', href: '/e/' + s.next.slug, 'data-link': '' }, 'Next') : null,
          btn('Cancel future', async () => { if (!(await confirmDlg('Cancel all future occurrences of this series?', { ok: 'Cancel them', danger: true }))) return; await api('/api/series/' + s.id, { method: 'DELETE' }); show('recurring'); })))),
    ];
  },

  // ---------------------------------------------------------------- promote
  async promote({ show }) {
    const [{ hosting }, { promotions }, plansTable] = await Promise.all([api('/api/events/mine'), api('/api/promote/mine'), api('/api/plans')]);
    const upcoming = hosting.filter((e) => e.visibility === 'public' && e.status !== 'ended');
    const ev = sel(upcoming.map((e) => [String(e.id), e.title]), upcoming[0] && String(upcoming[0].id));
    const days = inp({ type: 'number', min: 1, max: plansTable.platform ? plansTable.platform.promoMaxDays : 30, value: 7 });
    const quote = h('strong');
    const requote = async () => { try { const r = await api('/api/promote/quote?days=' + days.value); quote.textContent = `${naira(r.priceKobo)} for ${r.days} days`; } catch (_) { quote.textContent = ''; } };
    days.oninput = requote; requote();
    return [
      card('Promote an event', upcoming.length ? null : h('p', { class: 'small muted' }, 'You need an upcoming public event.'),
        h('div', { class: 'row wrap', style: { gap: '.6rem' } }, lbl('Event', ev), lbl('Days', days)), quote,
        h('p', { class: 'tiny muted' }, 'Shown in Discover, Feed and Venues. Paid through Paystack. New promotions may wait for a quick review before they run.'),
        btn('Pay and promote', async () => { const r = await api('/api/promote', { method: 'POST', body: { eventId: Number(ev.value), days: Number(days.value) } }); location.assign(r.authorizationUrl); }, true)),
      card('Your promotions', promotions.length ? null : h('p', { class: 'small muted' }, 'None yet.'),
        ...promotions.map((p) => h('div', { class: 'row wrap small', style: { gap: '.5rem' } }, h('span', { class: 'grow' }, `${p.title || 'Event'} · ${p.days || '?'} days · ${p.review}${p.live ? ' · running' : ''}`),
          h('span', { class: 'muted' }, `${p.views} views · ${p.clicks} clicks · ${p.ctr}%`)))),
    ];
  },

  // ---------------------------------------------------------------- tickets
  async tickets() {
    const { hosting } = await api('/api/events/mine');
    const evs = hosting.filter((e) => e.status !== 'ended');
    if (!evs.length) return [card('Tickets', h('p', { class: 'small muted' }, 'Create an event first.'))];
    return Promise.all(evs.slice(0, 20).map(async (e) => {
      const { tiers } = await api(`/api/events/${e.id}/tickets/tiers`);
      const rows = h('div', { class: 'col', style: { gap: '.4rem' } });
      const addRow = (t = {}) => {
        const name = inp({ value: t.name || '', placeholder: 'Tier name' }), price = inp({ type: 'number', min: 0, step: 50, value: t.priceKobo != null ? t.priceKobo / 100 : 0, disabled: t.sold > 0 && t.priceKobo > 0 });
        const qty = inp({ type: 'number', min: 0, value: t.quantity ?? '', placeholder: 'No limit' }), act = h('input', { type: 'checkbox', checked: t.active !== false });
        const row = h('div', { class: 'row wrap', style: { gap: '.4rem' } }, name, lbl('Price (₦, 0 = free)', price), lbl('Quantity', qty), h('label', { class: 'small' }, act, ' On sale'), t.sold ? h('span', { class: 'tiny muted' }, `${t.sold} sold`) : null);
        row.read = () => ({ id: t.id, name: name.value, priceKobo: Math.round(Number(price.value || 0) * 100), quantity: qty.value === '' ? null : Number(qty.value), active: act.checked });
        rows.append(row);
      };
      tiers.forEach(addRow);
      return card(e.title, rows, h('div', { class: 'row', style: { gap: '.5rem' } }, h('button', { class: 'btn sm', type: 'button', onclick: () => addRow() }, 'Add tier'),
        btn('Save tiers', async () => { await api(`/api/events/${e.id}/tickets/tiers`, { method: 'PUT', body: { tiers: [...rows.children].map((r) => r.read()) } }); toast('Tiers saved', { icon: 'check' }); }, true)),
      h('p', { class: 'tiny muted' }, 'When an event has tiers on sale, people need a ticket to join. You and your speakers always get in. Paid tiers can’t change price once sold.'));
    }));
  },

  // ---------------------------------------------------------------- earnings
  async earnings({ show }) {
    const e = await api('/api/earnings');
    const amount = inp({ type: 'number', min: e.payoutMinKobo / 100, value: Math.floor(e.balanceKobo / 100) });
    const bank = h('textarea', { class: 'input', rows: 2, placeholder: 'Bank name, account number and account name' });
    return [
      card('Earnings', h('div', { class: 'row wrap', style: { gap: '.6rem' } }, stat(naira(e.balanceKobo), 'available'), stat(naira(e.grossKobo), 'gross sales'), stat(naira(e.feesKobo), `platform fee (${e.feeBps / 100}%)`)),
        h('div', { class: 'row wrap', style: { gap: '.6rem' } }, lbl('Amount (₦)', amount), h('div', { class: 'grow' }, lbl('Pay to', bank))),
        h('p', { class: 'tiny muted' }, `Minimum payout ${naira(e.payoutMinKobo)}. Payouts are sent by bank transfer, usually within a few working days.`),
        btn('Request payout', async () => { await api('/api/earnings/payouts', { method: 'POST', body: { amountKobo: Math.round(Number(amount.value) * 100), bankDetails: bank.value } }); toast('Payout requested', { icon: 'check' }); show('earnings'); }, true)),
      card('Payouts', ...(e.payouts.length ? e.payouts.map((p) => h('div', { class: 'small' }, `${naira(p.amountKobo)} · ${p.status} · ${when(p.requestedAt)}${p.paidReference ? ' · ref ' + p.paidReference : ''}${p.adminNote ? ' · ' + p.adminNote : ''}`)) : [h('p', { class: 'small muted' }, 'None yet.')])),
      card('Ledger', ...(e.ledger.length ? e.ledger.map((l) => h('div', { class: 'tiny' }, `${when(l.at)} · ${l.kind} · ${l.event || ''} · gross ${naira(l.grossKobo)} · fee ${naira(l.feeKobo)} · net ${naira(l.netKobo)}`)) : [h('p', { class: 'small muted' }, 'No sales yet.')])),
    ];
  },

  // ---------------------------------------------------------------- organisation
  async org({ f, show }) {
    const { orgs } = await api('/api/orgs');
    if (!orgs.length) {
      if (!f.orgMembers) return [card('Organisation', locked('Organisations'))];
      const name = inp({ placeholder: 'Organisation name', maxlength: 80 });
      return [card('Create your organisation', h('p', { class: 'small muted' }, `Invite up to ${f.orgMembers} people as admins or moderators, run several venues and share a materials library.`), name,
        btn('Create', async () => { await api('/api/orgs', { method: 'POST', body: { name: name.value } }); show('org'); }, true))];
    }
    return Promise.all(orgs.map(async (o) => {
      const d = await api('/api/orgs/' + o.id);
      const p = d.permissions;
      const email = inp({ type: 'email', placeholder: 'Email to invite' }), role = sel([['moderator', 'Moderator'], ['admin', 'Admin']], 'moderator');
      const venueName = inp({ placeholder: 'New venue name', maxlength: 60 });
      const roleSel = (m) => { const s = sel([['moderator', 'Moderator'], ['admin', 'Admin']], m.role); s.onchange = async () => { try { await api(`/api/orgs/${o.id}/members/${m.userId}`, { method: 'PATCH', body: { role: s.value } }); toast('Role updated', { icon: 'check' }); } catch (e) { toastErr(e); } }; return s; };
      return card(`${d.org.name} · you are ${d.role}`,
        h('strong', { class: 'small' }, `Members (${d.members.length}${d.memberLimit ? ' of ' + d.memberLimit : ''})`),
        ...d.members.map((m) => h('div', { class: 'row wrap small', style: { gap: '.5rem' } }, h('span', { class: 'grow' }, `${m.name}${m.email ? ' · ' + m.email : ''}`),
          m.role !== 'owner' && p['members.admin'] ? roleSel(m) : h('span', { class: 'chip tiny' }, m.role),
          m.role !== 'owner' && (p['members.admin'] || (p['members.invite'] && m.role === 'moderator') || m.userId === state.user.id)
            ? btn(m.userId === state.user.id ? 'Leave' : 'Remove', async () => { if (!(await confirmDlg('Remove this member?', { ok: 'Remove', danger: true }))) return; await api(`/api/orgs/${o.id}/members/${m.userId}`, { method: 'DELETE' }); show('org'); }) : null)),
        ...d.invites.map((i) => h('div', { class: 'row small', style: { gap: '.5rem' } }, h('span', { class: 'grow muted' }, `Invited ${i.email} as ${i.role} · expires ${when(i.expiresAt)}`), btn('Revoke', async () => { await api(`/api/orgs/${o.id}/invites/${i.id}`, { method: 'DELETE' }); show('org'); }))),
        p['members.invite'] ? h('div', { class: 'row wrap', style: { gap: '.4rem' } }, email, p['members.admin'] ? role : null, btn('Send invite', async () => { await api(`/api/orgs/${o.id}/invites`, { method: 'POST', body: { email: email.value, role: role.value } }); toast('Invite sent', { icon: 'check' }); show('org'); }, true)) : null,
        h('strong', { class: 'small' }, 'Venues'),
        ...d.venues.map((v) => h('div', { class: 'row small', style: { gap: '.5rem' } }, h('a', { class: 'grow', href: '/v/' + v.slug, 'data-link': '' }, `${v.name} · /v/${v.slug}${v.archived ? ' · archived' : ''}`))),
        p['venue.create'] ? h('div', { class: 'row', style: { gap: '.4rem' } }, venueName, btn('Add venue', async () => { await api(`/api/orgs/${o.id}/venues`, { method: 'POST', body: { name: venueName.value } }); show('org'); })) : null,
        h('strong', { class: 'small' }, 'Shared library'),
        ...(d.library.length ? d.library.map((m) => h('div', { class: 'row small', style: { gap: '.5rem' } }, h('span', { class: 'grow' }, `${m.title} · ${m.kind}`),
          p['library.manage'] || m.ownerUserId === state.user.id ? btn('Unshare', async () => { await api(`/api/orgs/${o.id}/materials/${m.id}`, { method: 'DELETE' }); show('org'); }) : null))
          : [h('p', { class: 'tiny muted' }, 'Nothing shared yet. Pick one of your materials below to share it with members.')]),
        p['library.manage'] ? sharePicker(o.id, show) : null,
        d.role === 'owner' ? btn('Delete organisation', async () => { if (!(await confirmDlg('Delete this organisation? Venues stay with you; members lose access.', { ok: 'Delete', danger: true }))) return; await api('/api/orgs/' + o.id, { method: 'DELETE' }); show('org'); }) : null);
    }));
  },

  // ---------------------------------------------------------------- replays
  async replays({ f, show }) {
    const [{ replays, usedBytes, egress }, { hosting }] = await Promise.all([api('/api/replays/mine'), api('/api/events/mine')]);
    const ev = sel([['', 'No event'], ...hosting.map((e) => [String(e.id), e.title])], '');
    const title = inp({ placeholder: 'Title (optional)', maxlength: 120 });
    const vis = sel([['public', 'Public'], ['unlisted', 'Anyone with the link'], ['private', 'Only me']], 'public');
    const file = h('input', { type: 'file', accept: 'video/*,audio/*' });
    const link = inp({ type: 'url', placeholder: 'https://… (YouTube, Drive, or your own host)' });
    const code = inp({ placeholder: 'Room code of a live room you host' });
    const status = h('p', { class: 'tiny muted', role: 'status' });
    const qs = () => new URLSearchParams({ ...(ev.value ? { eventId: ev.value } : {}), title: title.value, visibility: vis.value }).toString();
    return [
      card('Add a replay', h('div', { class: 'row wrap', style: { gap: '.6rem' } }, lbl('Event', ev), lbl('Title', title), lbl('Who can watch', vis)),
        egress ? h('div', { class: 'row wrap', style: { gap: '.4rem' } }, code, btn('Record live room', async () => { await api('/api/replays/egress', { method: 'POST', body: { code: code.value, eventId: ev.value ? Number(ev.value) : undefined, title: title.value, visibility: vis.value } }); toast('Recording started', { icon: 'check' }); show('replays'); }, true))
          : h('p', { class: 'tiny muted' }, 'Cloud recording isn’t switched on for this server, so upload a file or add a link.'),
        h('div', { class: 'row wrap', style: { gap: '.4rem' } }, file, btn('Upload', async () => {
          const fl = file.files[0]; if (!fl) throw new Error('Choose a video or audio file');
          status.textContent = 'Uploading… keep this page open.';
          const res = await fetch('/api/replays/upload?' + qs(), { method: 'POST', body: fl, credentials: 'include', headers: { 'Content-Type': fl.type || 'video/mp4', 'X-File-Name': encodeURIComponent(fl.name) } });
          const d = await res.json().catch(() => ({})); status.textContent = '';
          if (!res.ok) throw new Error(d.error || `Upload failed (HTTP ${res.status})`);
          toast('Replay uploaded', { icon: 'check' }); show('replays');
        })),
        h('div', { class: 'row wrap', style: { gap: '.4rem' } }, link, btn('Add link', async () => { await api('/api/replays/link', { method: 'POST', body: { url: link.value, eventId: ev.value ? Number(ev.value) : undefined, title: title.value, visibility: vis.value } }); show('replays'); })),
        status, h('p', { class: 'tiny muted' }, `Storage: ${Math.round(usedBytes / 1048576)} MB of ${f.replayMB || 0} MB`)),
      card('Your replays', replays.length ? null : h('p', { class: 'small muted' }, 'None yet.'),
        ...replays.map((r) => h('div', { class: 'row wrap small', style: { gap: '.5rem' } }, h('a', { class: 'grow', href: '/replay/' + r.id, 'data-link': '' }, `${r.title} · ${r.status} · ${r.visibility}`), r.error ? h('span', { class: 'tiny' }, r.error) : null,
          r.status === 'recording' ? btn('Stop recording', async () => { await api(`/api/replays/${r.id}/stop`, { method: 'POST', body: {} }); show('replays'); }) : null,
          btn('Delete', async () => { if (!(await confirmDlg('Delete this replay?', { ok: 'Delete', danger: true }))) return; await api('/api/replays/' + r.id, { method: 'DELETE' }); show('replays'); })))),
    ];
  },
};

function sharePicker(orgId, show) {
  const wrap = h('div', { class: 'row', style: { gap: '.4rem' } });
  api('/api/materials').then(({ materials = [] }) => {
    const mine = materials.filter((m) => !m.orgId && m.ownerUserId === state.user.id);
    if (!mine.length) return;
    const s = sel(mine.map((m) => [String(m.id), m.title]), String(mine[0].id));
    wrap.append(s, btn('Share with organisation', async () => { await api(`/api/orgs/${orgId}/materials/${s.value}`, { method: 'PUT', body: {} }); show('org'); }));
  }).catch(() => {});
  return wrap;
}
export function unmount() {}
