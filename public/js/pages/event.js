import { icon } from '../icons.js';
import { h, api, esc, frag, fmtDate, fmtNum, toast, toastErr, sheet, confirmDlg, avatar, md, download, copy, debounce, uploadFile, profilePath } from '../ui.js';
import { state, navigate, requireLogin } from '../app.js';
import { catOf, commentThread, shareLink, sectionHead, empty, followBtn, railSoonRow, railHostBlock, verifiedDot } from '../components.js';
import { registerCommands, unregisterCommands } from '../commands.js';
import { promoCompact, loadPromos } from '../promo.js';
import { loadMoney, fmtMoney, checkoutSheet } from '../money.js';

export const roomPath = (code) => '/' + String(code || '').toLowerCase().replace(/[^a-z0-9]/g, '');

/** Colourful, owner-themed QR with the 1venue mark. SVG from the server; PNG rasterised client-side. */
async function svgToPng(svgUrl, name, scale = 3) {
  const txt = await fetch(svgUrl).then((r) => r.text());
  const img = new Image();
  const blobUrl = URL.createObjectURL(new Blob([txt], { type: 'image/svg+xml' }));
  await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = blobUrl; });
  const c = document.createElement('canvas'); c.width = img.width * scale; c.height = img.height * scale;
  c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
  URL.revokeObjectURL(blobUrl);
  c.toBlob((b) => download(name, b, 'image/png'), 'image/png');
}
export function qrSheet(ev) {
  const s = sheet({ title: 'QR invite', icon: 'qr', group: 'content' });
  let dark = document.documentElement.dataset.theme === 'dark';
  const img = h('img', { alt: `QR code for ${ev.title}`, style: { width: '100%', maxWidth: '360px' } });
  const url = () => `/api/events/${ev.slug}/qr.svg?tz=${encodeURIComponent(Intl.DateTimeFormat().resolvedOptions().timeZone)}${dark ? '&dark=1' : ''}`;
  const paint = () => { img.src = url(); };
  paint();
  s.body.append(h('div', { class: 'qr-wrap' }, img),
    
    h('div', { class: 'row wrap center' },
      h('button', { class: 'btn', 'data-group': 'settings', html: icon('moon', { size: 16 }) + 'Dark / light', onclick: () => { dark = !dark; paint(); } }),
      h('button', { class: 'btn', 'data-group': 'content', html: icon('download', { size: 16 }) + 'SVG', onclick: () => { const a = h('a', { href: url() + '&download=1', download: '' }); a.click(); } }),
      h('button', { class: 'btn primary', html: icon('image', { size: 16 }) + 'PNG', onclick: () => svgToPng(url(), `${ev.slug}-qr.png`).catch(toastErr) }),
      h('button', { class: 'btn', html: icon('link', { size: 16 }) + 'Copy link', onclick: () => copy(`${location.origin}/e/${ev.slug}`, 'Event link copied') })));
}
export function qrMaker(text = '') {
  const s = sheet({ title: 'QR code maker', icon: 'qr', group: 'content' });
  const accent = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#2563eb';
  const accent2 = getComputedStyle(document.documentElement).getPropertyValue('--accent-2').trim() || '#7c3aed';
  const inp = h('input', { class: 'input', placeholder: 'Link or text to encode', value: text || location.href });
  const title = h('input', { class: 'input', placeholder: 'Title (optional)' });
  const c1 = h('input', { type: 'color', value: accent, 'aria-label': 'Colour 1' }), c2 = h('input', { type: 'color', value: accent2, 'aria-label': 'Colour 2' });
  const img = h('img', { alt: 'QR preview', style: { width: '100%', maxWidth: '320px' } });
  const url = () => `/api/qr.svg?text=${encodeURIComponent(inp.value)}&accent=${encodeURIComponent(c1.value)}&accent2=${encodeURIComponent(c2.value)}&title=${encodeURIComponent(title.value)}`;
  let t; const paint = () => { clearTimeout(t); t = setTimeout(() => { if (inp.value) img.src = url(); }, 250); };
  [inp, title, c1, c2].forEach((x) => x.addEventListener('input', paint)); paint();
  s.body.append(h('div', { class: 'col' }, inp, title, h('div', { class: 'row' }, h('span', { class: 'muted small' }, 'Colours'), c1, c2)),
    h('div', { class: 'qr-wrap', style: { marginTop: '1rem' } }, img),
    h('div', { class: 'row center', style: { marginTop: '1rem' } }, h('button', { class: 'btn primary', html: icon('download', { size: 16 }) + 'Download PNG', onclick: () => svgToPng(url(), 'qr.png').catch(toastErr) })));
}

export async function mount(view, { slug }) {
  document.body.dataset.page = 'event';
  const ev = await api(`/api/events/${encodeURIComponent(slug)}`);
  const [cl, ci, cc] = catOf(ev.category);
  const live = ev.status === 'live';
  const c1 = ev.theme?.accent || cc, c2 = ev.theme?.accent2 || 'var(--accent-2)';
  document.title = `${ev.title} · 1venue`;
  const goLive = () => { sessionStorage.setItem('venue.intent', JSON.stringify({ create: true, eventId: ev.id, name: ev.title, stage: ev.category !== 'meeting', speakerSeats: ev.speakerSeats, code: ev.code, meetingAccessMode: ev.meetingAccessMode, meetingDurationMin: ev.meetingDurationMin, meetingEntryPriceCredits: ev.meetingEntryPriceCredits })); navigate(roomPath(ev.code)); };
  const join = () => navigate(roomPath(ev.code));
  const rsvpBtns = [];
  const paintRsvp = () => {
    for (const b of rsvpBtns) {
      const label = ev.rsvped ? 'Going' : 'RSVP';
      b.className = `btn ev-act ${ev.rsvped ? '' : 'primary'}`;
      b.setAttribute('aria-label', label);
      b.setAttribute('data-tip', label);
      b.innerHTML = (ev.rsvped ? icon('check', { size: 18 }) : icon('ticket', { size: 18 })) + `<span class="ev-act-lbl">${label}</span>`;
    }
  };
  const onRsvp = async () => {
    if (!requireLogin('Sign in to RSVP')) return;
    try {
      const r = await api(`/api/events/${ev.id}/rsvp`, { method: 'POST' });
      ev.rsvped = r.going; ev.rsvps = (ev.rsvps || 0) + (r.going ? 1 : -1);
      paintRsvp();
      toast(r.going ? 'You’re going! We’ll show it on your dashboard.' : 'RSVP removed', { icon: 'ticket', group: 'engage' });
    } catch (e) { toastErr(e); }
  };
  function rsvpButton() {
    const b = h('button', { class: `btn lg ${ev.rsvped ? '' : 'primary'}`, type: 'button' });
    rsvpBtns.push(b); paintRsvp();
    b.onclick = onRsvp;
    return b;
  }
  function actionButton({ label, ic, primary = false, pulse = false, group, onclick }) {
    return h('button', {
      class: `btn ev-act${primary ? ' primary' : ''}${pulse ? ' pulse-btn' : ''}`,
      type: 'button',
      'data-group': group || undefined,
      'data-tip': label,
      'aria-label': label,
      onclick,
      html: icon(ic, { size: 18 }) + `<span class="ev-act-lbl">${label}</span>`,
    });
  }
  function primaryButton() {
    if (live) return actionButton({ label: ev.isHost ? 'Return to stage' : 'Join live', ic: 'radio', primary: true, pulse: true, onclick: ev.isHost ? goLive : join });
    if (ev.isHost) return actionButton({ label: 'Go live now', ic: 'radio', primary: true, onclick: goLive });
    return rsvpButton();
  }
  const ics = () => {
    const d = (x) => new Date(x).toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '');
    const st = ev.startsAt || new Date().toISOString(); const en = ev.endsAt || new Date(new Date(st).getTime() + 3600e3).toISOString();
    download(`${ev.slug}.ics`, `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//1venue//EN\r\nBEGIN:VEVENT\r\nUID:${ev.slug}@1venue\r\nDTSTAMP:${d(new Date())}\r\nDTSTART:${d(st)}\r\nDTEND:${d(en)}\r\nSUMMARY:${ev.title.replace(/[,;]/g, ' ')}\r\nURL:${location.origin}/e/${ev.slug}\r\nDESCRIPTION:${(ev.description || '').slice(0, 300).replace(/\n/g, '\\n').replace(/[,;]/g, ' ')}\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n`, 'text/calendar');
  };
  const share = () => shareLink(`${location.origin}/e/${ev.slug}`, ev.title);
  const hostMenu = ev.isHost ? h('div', { class: 'row wrap', style: { gap: '.4rem' } },
    h('a', { class: 'btn sm', href: `/create?edit=${ev.slug}`, 'data-link': '', html: icon('pen', { size: 15 }) + 'Edit' }),
    h('button', { class: 'btn sm', 'data-group': 'people', html: icon('users', { size: 15 }) + 'Speakers', onclick: () => editSpeakers(ev, () => navigate(location.pathname, { replace: true })) }),
    h('button', { class: 'btn sm danger', html: icon('trash', { size: 15 }) + 'Delete', onclick: async () => { if (await confirmDlg('Delete this event? This cannot be undone.', { ok: 'Delete', danger: true })) { await api(`/api/events/${ev.id}`, { method: 'DELETE' }).catch(toastErr); navigate('/dashboard'); } } })) : null;

  const venueLabel = (ev.settings && (ev.settings.venue || ev.settings.location || ev.settings.place)) || null;
  const onlineHref = ev.status === 'live' || ev.isHost ? roomPath(ev.code) : `/e/${ev.slug}`;
  const whenLine = ev.startsAt
    ? (fmtDate(ev.startsAt) + (ev.endsAt ? ' – ' + fmtDate(ev.endsAt, { weekday: undefined, month: undefined, day: undefined }) : ''))
    : (live ? 'Live now' : 'Time to be announced');

  const placeMeta = venueLabel
    ? h('span', { html: icon('pin', { size: 16 }) + esc(venueLabel) })
    : h('a', { class: 'row', href: onlineHref, 'data-link': '', html: icon('radio', { size: 16 }) + 'Online' });

  const hero = h('section', { class: 'ev-hero ev-hero-slim', style: { '--c1': c1, '--c2': c2 } },
    ev.coverUrl ? h('img', { class: 'bg', src: ev.coverUrl, alt: '' }) : null,
    h('div', { class: 'in' },
      h('div', { class: 'row wrap', style: { gap: '.5rem' } },
        h('span', { class: 'cat on-dark', html: icon(ci, { size: 14 }) + esc(cl) }),
        live ? h('span', { class: 'pill live static' }, `LIVE · ${fmtNum(ev.live?.viewers || ev.liveViewers || 0)} watching`) : ev.status === 'ended' ? h('span', { class: 'pill static' }, 'Ended') : null),
      h('h1', null, ev.title),
      h('div', { class: 'row wrap ev-meta' },
        h('a', { class: 'row', href: profilePath(ev.host), 'data-link': '', style: { alignItems: 'center', gap: '.35rem' } }, avatar(ev.host.name, ev.host.avatarUrl, 'sm ring'), h('strong', null, ev.host.name), verifiedDot(ev.host, { title: 'Verified host' })),
        h('span', { html: icon('calendar', { size: 16 }) + esc(whenLine) }),
        placeMeta,
        h('span', { html: icon('ticket', { size: 16 }) + fmtNum(ev.rsvps || 0) + ' going' }))));

  const actionBar = h('div', { class: 'ev-actionbar', 'aria-label': 'Event actions' },
    primaryButton(),
    ev.startsAt && !live ? actionButton({ label: 'Add to calendar', ic: 'calendarPlus', group: 'nav', onclick: ics }) : null,
    actionButton({ label: 'Share', ic: 'share', group: 'content', onclick: share }),
    actionButton({ label: 'QR invite', ic: 'qr', group: 'content', onclick: () => qrSheet(ev) }));

  const speakers = ev.speakers || [];
  const agendaItems = Array.isArray(ev.settings?.agenda) ? ev.settings.agenda : [];
  const agendaSection = agendaItems.length
    ? h('div', { class: 'ev-card' }, sectionHead('Agenda', 'calendar'),
      ...agendaItems.map((a) => h('div', { class: 'ev-meta-row' },
        h('span', { class: 'tiny muted', style: { flex: 'none', minWidth: '4.5rem' } }, a.time || a.when || ''),
        h('strong', { class: 'grow' }, a.title || a.name || String(a)))))
    : (ev.startsAt ? h('div', { class: 'ev-card' }, sectionHead('Agenda', 'calendar'),
      h('div', { class: 'ev-meta-row' }, h('span', { html: icon('clock', { size: 16 }) }),
        h('div', { class: 'grow' }, h('strong', null, ev.title), h('div', { class: 'tiny muted' }, whenLine)))) : null);

  const matsSlot = h('section', { class: 'ev-panel ev-slot' });
  const ticketSlot = h('section', { class: 'ev-panel ev-slot' });
  const replaySlot = h('section', { class: 'ev-panel ev-slot' });
  const meetingAccess = ev.category === 'meeting' && ev.meetingAccessMode === 'paid_entry'
    ? h('div', { class: 'ev-card' }, sectionHead('Paid meeting entry', 'wallet'),
      h('p', { class: 'small', style: { margin: 0 } }, `${ev.meetingEntryPriceCredits} credits · ${ev.meetingDurationMin} minutes advertised. Sign in and ask to join; credits are charged only when the host accepts you.`))
    : null;
  const speakersBlock = speakers.length ? h('div', null, sectionHead('Speakers', 'stage'), h('div', { class: 'speaker-cards' }, speakers.map((sp) => h(sp.userId ? 'a' : 'div', { class: 'card speaker-card', href: sp.userId ? profilePath({ username: sp.username, id: sp.userId }) : null, 'data-link': sp.userId ? '' : null, style: { '--c1': c1, '--c2': c2 } },
    h('div', { class: 'band' }), avatar(sp.name, sp.avatarUrl, 'xl ring'), h('strong', { class: 'row', style: { alignItems: 'center', justifyContent: 'center', gap: '.25rem' } }, sp.name, verifiedDot(sp), sp.status && sp.status !== 'active' ? h('span', { class: 'chip sm' }, sp.status) : null), h('span', { class: 'muted small' }, sp.headline || 'Speaker'))))) : null;
  const mineInvite = (ev.speakers || []).find((s) => s.status === 'pending' && state.user && Number(s.userId) === Number(state.user.id));
  const inviteBanner = mineInvite ? h('div', { class: 'card pad ev-card', style: { display: 'flex', gap: '.8rem', flexWrap: 'wrap', alignItems: 'center' } },
    h('div', { class: 'grow' }, h('strong', null, 'You’re invited to speak at this event.'), h('div', { class: 'tiny muted' }, 'Accept to be listed on the page, or decline with a short comment.')),
    h('button', { class: 'btn sm primary', type: 'button', onclick: async () => { try { await api(`/api/events/invites/${mineInvite.id}/accept`, { method: 'POST' }); toast('You’re confirmed as a speaker', { icon: 'check' }); navigate(location.pathname, { replace: true }); } catch (e) { toastErr(e); } } }, 'Accept'),
    h('button', { class: 'btn sm', type: 'button', onclick: async () => { const comment = prompt('Please add a short comment to decline'); if (comment == null) return; try { await api(`/api/events/invites/${mineInvite.id}/decline`, { method: 'POST', body: { comment } }); toast('Invite declined', { icon: 'check' }); navigate(location.pathname, { replace: true }); } catch (e) { toastErr(e); } } }, 'Decline'),
    h('button', { class: 'btn sm ghost', type: 'button', onclick: async () => { const reason = prompt('Why are you reporting this invite?'); if (!reason) return; try { await api(`/api/events/invites/${mineInvite.id}/report`, { method: 'POST', body: { reason } }); toast('Report sent', { icon: 'check' }); } catch (e) { toastErr(e); } } }, 'Report')) : null;

  const panel = (...nodes) => h('section', { class: 'ev-panel' }, ...nodes.filter(Boolean));
  const liveSlot = h('div');
  const promoSlot = h('div');
  const moreSlot = h('div');
  const comments = h('div', null, sectionHead('Conversation', 'chats'), commentThread('events', ev.id, { isHost: ev.isHost }));
  const about = (ev.description || ev.tags?.length)
    ? panel(
      ev.description ? h('div', { class: 'prose ev-desc', html: md(ev.description) }) : null,
      ev.tags?.length ? h('div', { class: 'chips' }, ev.tags.map((t) => h('a', { class: 'chip', href: `/discover?q=${encodeURIComponent(t)}`, 'data-link': '' }, '#' + t))) : null,
    )
    : null;
  const center = h('div', { class: 'ev-center' },
    hero,
    panel(actionBar, hostMenu),
    meetingAccess ? panel(meetingAccess) : null,
    ticketSlot,
    replaySlot,
    about,
    inviteBanner, speakersBlock ? panel(speakersBlock) : null,
    agendaSection ? panel(agendaSection) : null,
    matsSlot,
    panel(comments));
  const paintPanels = () => {
    const visible = [...center.children].filter((el) => el.classList.contains('ev-panel') && el.childElementCount);
    visible.forEach((p, i) => {
      p.classList.toggle('ev-panel-a', i % 2 === 0);
      p.classList.toggle('ev-panel-b', i % 2 === 1);
    });
  };
  const fillSlot = (slot, ...nodes) => {
    if (!slot.isConnected) return;
    if (!nodes.length) { slot.replaceChildren(); paintPanels(); return; }
    slot.replaceChildren(...nodes);
    paintPanels();
  };
  const right = h('aside', { class: 'ev-rail ev-right', 'aria-label': 'More events' }, liveSlot, promoSlot, moreSlot);
  const shell = h('div', { class: 'ev-shell' }, center, right);
  const page = h('div', { class: 'ev-page' }, shell);
  view.append(page);
  paintPanels();

  const slim = (el) => {
    let t = 0;
    const on = () => { el.classList.add('is-scrolling'); clearTimeout(t); t = setTimeout(() => el.classList.remove('is-scrolling'), 700); };
    el.addEventListener('scroll', on, { passive: true });
    return () => { el.removeEventListener('scroll', on); clearTimeout(t); };
  };
  const stopScroll = [slim(right)];

  // Tickets, donations and replays (Phase 3). Returning from Paystack carries ?reference=1vc-…
  const naira = (k) => fmtMoney(k);
  async function paintTickets() {
    await loadMoney();
    const t = await api(`/api/events/${ev.id}/tickets`).catch(() => null);
    if (!t || !ticketSlot.isConnected || (!t.tiers.length && !t.donations)) { fillSlot(ticketSlot); return; }
    const buy = async (tier, qty) => {
      if (!requireLogin('Sign in to get a ticket')) return;
      if (tier.priceKobo > 0) { await checkoutSheet({ title: 'Ticket checkout', what: `${qty} × ${tier.name}`, subtotalKobo: tier.priceKobo * qty, start: () => api(`/api/events/${ev.id}/tickets`, { method: 'POST', body: { tierId: tier.id, quantity: qty } }) }); return; }
      const r = await api(`/api/events/${ev.id}/tickets`, { method: 'POST', body: { tierId: tier.id, quantity: qty } });
      if (r.authorizationUrl) { location.assign(r.authorizationUrl); return; }
      toast('You have a ticket', { icon: 'ticket' }); paintTickets();
    };
    const gift = h('input', { class: 'input', type: 'number', min: t.donationMinKobo / 100, step: 100, value: Math.max(1000, t.donationMinKobo / 100), style: { maxWidth: '8rem' }, 'aria-label': 'Gift amount in naira' });
    fillSlot(ticketSlot, h('div', { class: 'ev-card' }, sectionHead(t.tiers.length ? 'Tickets' : 'Support this event', 'ticket'),
      t.mine && t.mine.length ? h('p', { class: 'small' }, `You have ${t.mine.length} ticket${t.mine.length === 1 ? '' : 's'}${t.mine[0].tier ? ' · ' + t.mine[0].tier : ''}.`) : null,
      ...t.tiers.map((tier) => {
        const qty = h('input', { class: 'input', type: 'number', min: 1, max: Math.min(t.maxPerOrder, tier.remaining ?? t.maxPerOrder), value: 1, style: { maxWidth: '4.5rem' }, 'aria-label': 'Quantity', hidden: tier.priceKobo === 0 });
        const soldOut = tier.remaining === 0;
        return h('div', { class: 'ev-meta-row' }, h('div', { class: 'grow min0' }, h('strong', null, tier.name), h('div', { class: 'tiny muted' }, `${tier.priceKobo ? naira(tier.priceKobo) : 'Free'}${tier.remaining != null ? ` · ${tier.remaining} left` : ''}`)),
          qty, h('button', { class: 'btn sm primary', type: 'button', disabled: soldOut || (!t.purchasesEnabled && tier.priceKobo > 0), onclick: () => buy(tier, Number(qty.value) || 1).catch(toastErr) }, soldOut ? 'Sold out' : tier.priceKobo ? 'Buy' : 'Get free ticket'));
      }),
      t.donations && t.purchasesEnabled ? h('div', { class: 'ev-meta-row' }, h('span', { class: 'grow small' }, 'Send the host a gift'), gift,
        h('button', { class: 'btn sm', type: 'button', onclick: async () => { if (!requireLogin('Sign in to send a gift')) return; const amountKobo = Math.round(Number(gift.value) * 100); checkoutSheet({ title: 'Send a gift', what: 'A gift to the host of this event.', subtotalKobo: amountKobo, start: () => api(`/api/events/${ev.id}/donate`, { method: 'POST', body: { amountKobo } }) }); } }, 'Give')) : null));
  }
  const ref = new URLSearchParams(location.search).get('reference') || new URLSearchParams(location.search).get('trxref');
  if (ref && ref.startsWith('1vc-')) {
    api(`/api/commerce/payments/${encodeURIComponent(ref)}/verify`, { method: 'POST', body: {} })
      .then((p) => { toast(p.status === 'paid' ? (p.kind === 'donation' ? 'Thank you for your gift!' : 'Payment confirmed. Your ticket is ready.') : `Payment ${p.status}`, { icon: 'ticket' }); history.replaceState(null, '', location.pathname); paintTickets(); })
      .catch(toastErr);
  }
  paintTickets();
  api(`/api/events/${ev.id}/replays`).then(({ replays }) => {
    if (!replays.length || !replaySlot.isConnected) return;
    fillSlot(replaySlot, h('div', { class: 'ev-card' }, sectionHead('Replay', 'play'),
      ...replays.map((r) => h('a', { class: 'ev-meta-row', href: '/replay/' + r.id, 'data-link': '' }, h('span', { html: icon('play', { size: 16 }) }), h('strong', { class: 'grow' }, r.title)))));
  }).catch(() => {});

  api(`/api/events/${ev.id}/materials`).then((r) => {
    const mats = r.materials || [];
    if (!mats.length || !matsSlot.isConnected) return;
    fillSlot(matsSlot, h('div', { class: 'ev-card' }, sectionHead('Materials', 'folder'),
      ...mats.map((m) => h('div', { class: 'ev-meta-row' },
        h('span', { html: icon(m.kind === 'video' ? 'video' : (m.kind === 'image' ? 'image' : 'file'), { size: 16 }) }),
        h('div', { class: 'grow min0' }, h('strong', { class: 'ellipsis' }, m.title || 'Material'), h('div', { class: 'tiny muted' }, m.kind || ''))))));
  }).catch(() => {});

  Promise.all([
    api('/api/discover?status=live&limit=6').catch(() => ({ events: [] })),
    api('/api/discover?status=upcoming&limit=6').catch(() => ({ events: [] })),
    ev.host?.username || ev.host?.id
      ? api('/api/discover?host=' + encodeURIComponent(ev.host.username || ev.host.id) + '&limit=6').catch(() => ({ events: [] }))
      : { events: [] },
    loadPromos('discover'),
  ]).then(([liveR, upR, moreR, promos]) => {
    if (!view.isConnected) return;
    const liveEv = (liveR.events || []).filter((e) => e.id !== ev.id);
    const soon = (upR.events || []).filter((e) => e.id !== ev.id).slice(0, 3);
    if (liveEv.length) {
      liveSlot.append(h('section', { class: 'ev-card ev-rail-block' }, h('div', { class: 'ev-rail-head tiny faint' }, 'Live now'),
        ...liveEv.slice(0, 3).map(railSoonRow)));
    } else if (soon.length) {
      liveSlot.append(h('section', { class: 'ev-card ev-rail-block' }, h('div', { class: 'ev-rail-head tiny faint' }, 'Happening soon'),
        ...soon.map(railSoonRow)));
    } else {
      liveSlot.append(h('section', { class: 'ev-card ev-rail-block' }, h('div', { class: 'ev-rail-head tiny faint' }, 'Live now'),
        h('p', { class: 'small muted', style: { margin: 0 } }, 'Nothing else is live right now.')));
    }
    const cards = (promos || []).slice(0, 2).map((it) => promoCompact(it)).filter(Boolean);
    if (cards.length) promoSlot.append(h('section', { class: 'ev-card ev-rail-block' }, h('div', { class: 'ev-rail-head tiny faint' }, 'Promoted'), ...cards));
    const more = (moreR.events || []).filter((e) => e.id !== ev.id).slice(0, 3);
    if (more.length) {
      moreSlot.append(h('section', { class: 'ev-card ev-rail-block' }, h('div', { class: 'ev-rail-head tiny faint' }, 'More from this host'),
        ...railHostBlock(more)));
    }
  });

  const primary = actionBar.querySelector('.ev-act');
  registerCommands('page', [
    { id: 'ev-primary', label: live ? 'Join live' : ev.isHost ? 'Go live now' : 'RSVP', icon: 'radio', group: 'engage', run: () => primary?.click() },
    { id: 'ev-qr', label: 'Event QR code', icon: 'qr', group: 'content', keywords: ['poster', 'invite'], run: () => qrSheet(ev) },
    { id: 'ev-share', label: 'Share event', icon: 'share', group: 'content', run: share },
    { id: 'ev-cal', label: 'Add to calendar', icon: 'calendarPlus', group: 'nav', when: () => !!ev.startsAt, run: ics },
    { id: 'ev-comment', label: 'Write a comment', icon: 'chat', group: 'social', run: () => view.querySelector('.composer textarea')?.focus() },
    ...(ev.isHost ? [{ id: 'ev-edit', label: 'Edit event', icon: 'pen', group: 'engage', run: () => navigate(`/create?edit=${ev.slug}`) }, { id: 'ev-speakers', label: 'Edit speakers', icon: 'users', group: 'people', run: () => editSpeakers(ev) }] : []),
  ]);
  return { unmount: () => { stopScroll.forEach((fn) => fn()); unregisterCommands('page'); if (document.body.dataset.page === 'event') delete document.body.dataset.page; } };
}
export const barPinned = null;

function editSpeakers(ev, done) {
  const s = sheet({ title: 'Speakers', icon: 'stage', group: 'people' });
  const list = h('div', { class: 'col', style: { gap: '.6rem' } });
  const rows = (ev.speakers || []).map((x) => ({ ...x }));
  const search = h('input', { class: 'input', placeholder: 'Search name, @username or email…', autocomplete: 'off' });
  const sug = h('div', { class: 'suggest-list', hidden: true });
  const paint = () => {
    list.replaceChildren(...rows.map((r, i) => h('div', { class: 'card pad layer row wrap', style: { gap: '.5rem', alignItems: 'center' } },
      r.avatarUrl || r.userId ? avatar(r.name, r.avatarUrl, 'sm') : h('span', { class: 'ico-tile sm', html: icon('user', { size: 16 }) }),
      h('div', { class: 'grow col', style: { gap: '.35rem', minWidth: '140px' } },
        h('input', { class: 'input sm', placeholder: 'Name', value: r.name || '', oninput: (e) => { r.name = e.target.value; } }),
        h('input', { class: 'input sm', placeholder: 'Headline', value: r.headline || '', oninput: (e) => { r.headline = e.target.value; } }),
        r.email ? h('div', { class: 'tiny muted' }, r.email) : null,
        r.status && r.status !== 'active' ? h('div', { class: 'tiny muted' }, r.status === 'declined' ? `Declined${r.declineComment ? `: ${r.declineComment}` : ''}` : 'Invite pending') : null),
      h('button', { class: 'btn sm', type: 'button', html: icon('image', { size: 14 }), onclick: () => {
        const inp = h('input', { type: 'file', accept: 'image/*', class: 'hidden' });
        document.body.append(inp);
        inp.onchange = async () => {
          const f = inp.files[0]; inp.remove();
          if (!f) return;
          try { const up = await uploadFile(f, { purpose: 'avatar' }); r.avatarUrl = up.url; paint(); toast('Photo set', { icon: 'image' }); } catch (e) { toastErr(e); }
        };
        inp.click();
      } }),
      h('button', { class: 'icon-btn', 'data-group': 'admin', 'aria-label': 'Remove', html: icon('x'), onclick: () => { rows.splice(i, 1); paint(); } }))));
  };
  paint();
  const sugBtn = (fn, ...kids) => h('button', { type: 'button', onpointerdown: (e) => { e.preventDefault(); e.stopPropagation(); fn(); } }, ...kids);
  const runSearch = debounce(async () => {
    const q = search.value.trim();
    if (q.length < 2) { sug.hidden = true; return; }
    try {
      const r = await api('/api/users/search?q=' + encodeURIComponent(q));
      const users = r.users || [];
      sug.replaceChildren();
      users.forEach((u) => sug.append(sugBtn(() => {
        if (rows.some((x) => x.userId === u.id)) return;
        rows.push({ userId: u.id, name: u.name, avatarUrl: u.avatarUrl, headline: u.handle ? '@' + u.handle : '' });
        search.value = ''; sug.hidden = true; paint();
      }, avatar(u.name, u.avatarUrl, 'sm'), h('div', { class: 'grow' }, h('b', null, u.name), h('div', { class: 'tiny muted' }, u.handle ? '@' + u.handle : '')))));
      if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(q)) {
        sug.append(sugBtn(() => {
          rows.push({ name: q.split('@')[0], email: q.toLowerCase(), headline: 'Invited by email' });
          search.value = ''; sug.hidden = true; paint();
        }, h('span', { class: 'ico-tile sm', html: icon('mail', { size: 14 }) }), h('b', null, 'Invite ' + q)));
      } else if (!users.length) {
        sug.append(sugBtn(() => {
          rows.push({ name: q, headline: '' });
          search.value = ''; sug.hidden = true; paint();
        }, h('span', { class: 'ico-tile sm', html: icon('userPlus', { size: 14 }) }), h('b', null, 'Add “' + q + '”')));
      }
      sug.hidden = !sug.childNodes.length;
    } catch { sug.hidden = true; }
  }, 220);
  search.addEventListener('input', runSearch);
  s.body.append(
    h('div', { class: 'suggest-box', style: { marginBottom: '.8rem' } }, search, sug),
    list,
    h('div', { class: 'row between', style: { marginTop: '1rem' } },
      h('button', { class: 'btn', type: 'button', html: icon('plus', { size: 16 }) + 'Blank speaker', onclick: () => { rows.push({ name: '', headline: '' }); paint(); } }),
      h('button', { class: 'btn primary', type: 'button', onclick: async () => {
        try {
          await api(`/api/events/${ev.id}/speakers`, { method: 'PUT', body: { speakers: rows } });
          toast('Speakers saved', { icon: 'check' }); s.close(); done && done();
        } catch (e) { toastErr(e); }
      } }, 'Save')));
}
