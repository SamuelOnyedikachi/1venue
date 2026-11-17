// /billing: current plan, payment methods, billing address and currency, auto top-up, every payment with
// receipts, and short links (the same card as /upgrade, plus the links you own and a buy flow).
import { h, api, toast, toastErr, confirmDlg, sheet } from '../ui.js';
import { icon } from '../icons.js';
import { requireLogin } from '../app.js';
import { loadMoney, fmtMoney, fmtCredits, checkoutSheet, moneyConfig } from '../money.js';
import { addonCard } from '../shortlinks.js';
import { panel, table, iconBtn, pill, empty, actionBtn, dayFmt, whenFmt } from '../host-kit.js';

const money = (kobo) => fmtMoney(kobo, { whole: true });
const LABEL = { free: 'Free', premium: 'Premium', organisation: 'Organisation' };
const VERIFY = { plan: (r) => `/api/billing/payments/${r}/verify`, credits: (r) => `/api/wallet/payments/${r}/verify`, commerce: (r) => `/api/commerce/payments/${r}/verify` };
// Payment status → icon, the same set as /wallet.
const STATUS = { paid: ['checkCircle', 'ok', 'Completed'], pending: ['hourglass', 'wait', 'Pending'], review: ['hourglass', 'wait', 'Being reviewed'], failed: ['xCircle', 'bad', 'Declined'], refunded: ['returnArrow', 'ref', 'Refunded'] };
const statusIcon = (p) => { const [ic, cls, label] = STATUS[p.refunded ? 'refunded' : p.status] || ['clock', 'wait', p.status]; return h('span', { class: `pay-st ${cls}`, 'data-tip': label, html: icon(ic, { size: 20, label }) }); };
const PAGE = 10;

export async function mount(view) {
  if (!requireLogin('Sign in to see billing')) return;
  let alive = true; let shown = PAGE;
  view.classList.add('ht-view', 'bl-view');
  const msg = h('p', { class: 'small bl-msg', role: 'status', 'aria-live': 'polite' });
  const body = h('div', { class: 'bl-body' }, h('div', { class: 'ht-loading' }, h('span', { class: 'spinner' }), 'Loading…'));
  view.append(h('div', { class: 'page-head' }, h('h1', { html: icon('creditCard', { size: 26 }) + 'Billing' }),
    h('p', { class: 'muted' }, 'Your plan, payment methods and receipts. Meeting credits live in your ', h('a', { href: '/wallet', 'data-link': '' }, 'credit wallet'), '.')), msg, body);
  const act = (fn) => async (e) => { const b = e.currentTarget; b.disabled = true; try { await fn(); await refresh(); } catch (err) { toastErr(err); } finally { b.disabled = false; } };

  async function refresh() {
    const [, me, table_, venues, hist, auto, prof] = await Promise.all([loadMoney(), api('/api/billing'), api('/api/plans'), api('/api/venues').catch(() => ({ venues: [] })),
      api('/api/billing/history').catch(() => ({ payments: [] })), api('/api/wallet/auto-topup').catch(() => null), api('/api/me/billing-profile').catch(() => ({}))]);
    if (!alive) return;
    body.replaceChildren(h('div', { class: 'bl-grid' },
      planCard(me, table_), h('div', { class: 'bl-side' }, methodsCard(me, auto), profileCard(prof), autoCard(me, auto))),
    historyCard(hist.payments), shortLinks(me, table_, venues.venues || []));
    if (location.hash) { const t = document.getElementById(location.hash.slice(1)); if (t) setTimeout(() => t.scrollIntoView({ block: 'start' }), 60); }
  }

  function planCard(me, t) {
    const s = me.subscription; const l = me.limits; const paid = me.plan !== 'free';
    const plan = t.plans.find((p) => p.id === me.plan) || {};
    const interval = s && s.interval === 'year' ? 'year' : 'month';
    const price = paid ? (interval === 'year' ? plan.priceYearKobo : plan.priceMonthKobo) : 0;
    let status = ['Free', 'muted', 'user'], line = 'Upgrade any time for more venues, bigger rooms and host tools.';
    if (s && s.effectivePlan !== 'free') {
      if (s.status === 'comp') { status = ['Complimentary', 'accent', 'star']; line = s.periodEnd ? `Complimentary until ${dayFmt(s.periodEnd)}.` : 'Complimentary plan, no end date.'; }
      else if (s.status === 'past_due') { status = ['Payment due', 'bad', 'alert']; line = `We could not renew your plan. You keep it until ${dayFmt(s.graceUntil)}. Pay now to keep it.`; }
      else if (s.cancelAtPeriodEnd) { status = ['Ends soon', 'wait', 'clock']; line = `Ends on ${dayFmt(s.periodEnd)}. It will not renew.`; }
      else if (s.autoRenew) { status = ['Active', 'ok', 'checkCircle']; line = `Renews ${interval === 'year' ? 'yearly' : 'monthly'} on ${dayFmt(s.periodEnd)}${s.card ? ` from ${s.card.brand || 'card'} •••• ${s.card.last4}` : ''}.`; }
      else { status = ['Active', 'ok', 'checkCircle']; line = `Paid until ${dayFmt(s.periodEnd)}. There is no saved card, so when it ends you can pay again here.`; }
      if (s.source === 'grandfather') line += ' Free Premium for existing members. Pay before it ends to keep Premium.';
      if (s.pendingPlan) line += ` Switches to ${LABEL[s.pendingPlan]} (${s.pendingInterval === 'year' ? 'annual' : 'monthly'}) at the end of this period.`;
    }
    const needsPay = s && s.effectivePlan !== 'free' && (s.status === 'past_due' || s.source === 'grandfather' || (s.status === 'comp' && s.periodEnd));
    const payNow = needsPay && plan.id && me.plan !== 'free' ? h('button', { class: 'btn primary', type: 'button', disabled: !me.purchasesEnabled, html: icon('lock', { size: 16 }) + `<span>${s.status === 'past_due' ? 'Pay now' : 'Pay to keep it'}</span>`,
      onclick: () => checkoutSheet({ title: `${LABEL[me.plan]} plan`, what: `${LABEL[me.plan]}, ${interval === 'year' ? 'annual' : 'monthly'}.`, subtotalKobo: interval === 'year' ? plan.priceYearKobo : plan.priceMonthKobo, start: () => api('/api/billing/checkout', { method: 'POST', body: { plan: me.plan, interval } }) }) }) : null;
    const other = interval === 'year' ? 'month' : 'year';
    const canSwitch = s && ['active', 'past_due'].includes(s.status) && s.source === 'paystack' && !s.pendingPlan && !s.cancelAtPeriodEnd;
    const meter = (label, used, max) => h('div', { class: 'bl-meter' }, h('div', { class: 'bl-meter-top' }, h('span', { class: 'small' }, label), h('span', { class: 'tiny muted' }, `${used.toLocaleString()} of ${max.toLocaleString()}`)),
      h('div', { class: 'ht-bar', role: 'meter', 'aria-label': label, 'aria-valuemin': '0', 'aria-valuemax': String(max), 'aria-valuenow': String(used) }, h('span', { style: { width: `${max ? Math.min(100, (used / max) * 100) : 0}%` } })));
    return panel({ icon: 'crown', title: `${LABEL[me.plan]} plan`, cls: 'bl-plan', id: 'plan', actions: pill(...status) },
      h('div', { class: 'bl-price' }, h('strong', null, paid ? money(price) : money(0)), h('span', { class: 'muted' }, paid ? (interval === 'year' ? '/ year' : '/ month') : 'forever'),
        moneyConfig().currency !== moneyConfig().base && paid ? h('span', { class: 'tiny muted' }, `charged in ${moneyConfig().base}`) : null),
      h('p', { class: 'small' }, line),
      s && s.periodEnd && s.effectivePlan !== 'free' ? h('div', { class: 'bl-dates' }, h('span', null, h('span', { class: 'tiny muted' }, s.cancelAtPeriodEnd || !s.autoRenew ? 'Ends' : 'Renews'), h('strong', null, dayFmt(s.periodEnd))),
        s.periodStart ? h('span', null, h('span', { class: 'tiny muted' }, 'Started'), h('strong', null, dayFmt(s.periodStart))) : null) : null,
      h('div', { class: 'bl-meters' }, meter('Venues', me.usage.venues, l.venues), meter('AI points today', Math.max(0, l.aiDaily - me.usage.aiLeft), l.aiDaily)),
      h('p', { class: 'tiny muted' }, `${l.audience.toLocaleString()} stage audience · ${l.meeting} per meeting · ${l.speakerSeats} speaker seats`),
      h('div', { class: 'bl-actions' },
        payNow,
        h('a', { class: 'btn' + (payNow ? '' : ' primary'), href: '/upgrade', 'data-link': '', html: icon(paid ? 'sliders' : 'sparkles', { size: 16 }) + `<span>${paid ? 'Change plan' : 'Upgrade'}</span>` }),
        s && s.autoRenew ? h('button', { class: 'btn', type: 'button', onclick: act(async () => { if (await confirmDlg('Stop renewing? You keep your plan until the end of this period.', { ok: 'Stop renewing' })) { await api('/api/billing/cancel', { method: 'POST' }); toast('Your plan will not renew'); } }) }, 'Cancel renewal') : null,
        s && s.cancelAtPeriodEnd && s.effectivePlan !== 'free' && ['active', 'past_due'].includes(s.status) ? h('button', { class: 'btn', type: 'button', onclick: act(async () => { await api('/api/billing/resume', { method: 'POST' }); toast(s.card ? 'Your plan will renew' : 'Renewal is back on. Add a card by paying once to renew automatically.', { icon: 'check' }); }) }, 'Resume renewal') : null,
        canSwitch ? h('button', { class: 'btn', type: 'button', onclick: act(async () => { await api('/api/billing/change', { method: 'POST', body: { plan: s.plan, interval: other } }); toast(`Switches to ${other === 'year' ? 'annual' : 'monthly'} billing at period end`, { icon: 'check' }); }) }, other === 'year' ? 'Switch to annual' : 'Switch to monthly') : null,
        canSwitch && s.plan === 'organisation' ? h('button', { class: 'btn', type: 'button', onclick: act(() => api('/api/billing/change', { method: 'POST', body: { plan: 'premium', interval: s.interval } })) }, 'Move to Premium at period end') : null,
        s && s.pendingPlan ? h('button', { class: 'btn', type: 'button', onclick: act(() => api('/api/billing/change', { method: 'POST', body: { plan: s.plan, interval: s.interval } })) }, 'Keep current plan') : null));
  }

  function methodsCard(me, auto) {
    const s = me.subscription;
    const card = (c, label, onRemove) => h('div', { class: 'bl-card-row' }, h('span', { class: 'bl-card-ic', html: icon('creditCard', { size: 20 }) }),
      h('div', { class: 'grow' }, h('strong', null, `${c.brand ? c.brand[0].toUpperCase() + c.brand.slice(1) : 'Card'} •••• ${c.last4 || '????'}`), h('span', { class: 'tiny muted' }, `${label}${c.exp ? ` · expires ${c.exp}` : ''}`)),
      iconBtn('trash', `Remove ${label.toLowerCase()} card`, { cls: 'danger', onClick: onRemove }));
    const rows = [];
    if (s && s.card) rows.push(card(s.card, 'Plan renewals', async () => { if (!(await confirmDlg('Remove this card? Your plan stays until the period ends, then you pay again by hand.', { ok: 'Remove card', danger: true }))) return; await api('/api/billing/card', { method: 'DELETE' }); toast('Card removed', { icon: 'check' }); await refresh(); }));
    if (auto && auto.card) rows.push(card(auto.card, 'Auto top-up', async () => { if (!(await confirmDlg('Remove this card? Auto top-up turns off.', { ok: 'Remove card', danger: true }))) return; await api('/api/wallet/auto-topup/card', { method: 'DELETE' }); toast('Card removed', { icon: 'check' }); await refresh(); }));
    return panel({ icon: 'creditCard', title: 'Payment methods', id: 'payment-methods' },
      rows.length ? h('div', { class: 'bl-cards' }, ...rows) : empty('creditCard', 'No saved cards', 'Cards are saved securely by Paystack when you pay for a plan or turn on auto top-up. We only keep the last four digits.'));
  }
  function profileCard(p) {
    const m = moneyConfig();
    const addr = [p.line1, p.line2, p.city, p.state, p.postalCode, p.country].filter(Boolean).join(', ');
    const cur = h('select', { class: 'input bl-cur', 'aria-label': 'Display currency' }, ...m.currencies.map((c) => h('option', { value: c.code, selected: (p.currency || m.currency) === c.code }, `${c.code} · ${c.name}`)));
    cur.onchange = async () => { try { await api('/api/me/billing-profile', { method: 'PUT', body: { country: p.country || '', line1: p.line1 || '', line2: p.line2 || '', city: p.city || '', state: p.state || '', postalCode: p.postalCode || '', currency: cur.value } }); await loadMoney(true); toast(`Prices now show in ${cur.value}`, { icon: 'check' }); await refresh(); } catch (e) { toastErr(e); } };
    return panel({ icon: 'globe', title: 'Billing address & currency', id: 'billing-address', actions: iconBtn('pencil', 'Edit in settings', { href: '/settings#billing' }) },
      h('p', { class: 'small' + (addr ? '' : ' muted') }, addr || 'No billing address yet. It appears on your receipts.'),
      h('label', { class: 'ht-field' }, h('span', { class: 'ht-field-l' }, 'Show prices in'), cur), h('p', { class: 'tiny muted' }, `Payments are charged in ${m.chargeCurrency || m.base}.`));
  }
  function autoCard(me, a) {
    const link = h('a', { class: 'btn sm', href: '/settings#auto-topup', 'data-link': '' }, a && a.enabled ? 'Manage' : 'Set up');
    let content;
    if (!a) content = h('p', { class: 'small muted' }, 'Not available right now.');
    else if (a.subscriber) content = h('p', { class: 'small muted' }, 'Your plan covers meeting time, so auto top-up is off.');
    else if (a.enabled) content = h('div', { class: 'bl-kv' }, h('span', null, 'When below'), h('strong', null, `${fmtCredits(a.thresholdCredits)} credits`), h('span', null, 'Top up with'), h('strong', null, `${fmtCredits(a.packCredits)} credits`),
      h('span', null, 'Monthly cap'), h('strong', null, `${fmtCredits(a.monthlyCapCredits)} credits`), h('span', null, 'Used this month'), h('strong', null, `${fmtCredits(a.usedThisMonthCredits || 0)} credits`));
    else content = h('p', { class: 'small muted' }, 'Off. Turn it on to buy credits automatically when you run low.');
    return panel({ icon: 'zap', title: 'Auto top-up', id: 'auto-topup', actions: a && !a.subscriber ? link : null, desc: a && a.enabled && a.lastStatus ? `Last run: ${a.lastStatus}${a.lastRunAt ? ' · ' + whenFmt(a.lastRunAt) : ''}` : null },
      a && !a.subscriber ? pill(a.enabled ? 'On' : 'Off', a.enabled ? 'ok' : 'muted', a.enabled ? 'zap' : null) : null, content);
  }
  function historyCard(list) {
    const rows = list.slice(0, shown).map((p) => [
      h('span', null, h('span', { class: 'small' }, dayFmt(p.createdAt)), h('span', { class: 'tiny muted bl-time' }, new Date(p.createdAt).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }))),
      h('span', null, h('strong', { class: 'small' }, p.kind), h('span', { class: 'tiny muted bl-what' }, p.what)),
      h('span', { class: 'bl-amt' }, h('strong', null, fmtMoney(p.totalKobo)), p.feeKobo ? h('span', { class: 'tiny muted' }, `incl. ${fmtMoney(p.feeKobo)} fee`) : null),
      statusIcon(p),
      h('span', { class: 'ht-row-actions' },
        p.receipt ? iconBtn('fileText', `Receipt for ${p.what}`, { href: p.receipt, tip: 'Receipt' }) : null,
        p.status === 'pending' && p.authorizationUrl ? iconBtn('arrowRight', 'Open checkout', { href: p.authorizationUrl }) : null,
        ['pending', 'review'].includes(p.status) ? iconBtn('refresh', 'Check payment', { onClick: async () => { const r = await api(VERIFY[p.source](encodeURIComponent(p.reference)), { method: 'POST', body: {} }); msg.textContent = r.status === 'paid' ? 'Payment confirmed.' : r.status === 'pending' ? 'Still pending. You can check again.' : 'This payment was not completed.'; await refresh(); } }) : null)]);
    const more = list.length > shown ? h('button', { class: 'btn sm', type: 'button', onclick: () => { shown += PAGE; refresh(); } }, `Show ${Math.min(PAGE, list.length - shown)} more`) : null;
    return panel({ icon: 'history', title: 'Payments & receipts', id: 'payments', desc: 'Plans, short links, credits, promotions and tickets. Open a receipt and use Print to save it as a PDF.' },
      table([{ label: 'Date' }, { label: 'Item' }, { label: 'Amount', num: true }, { label: 'Status', cls: 'st' }, { label: '', cls: 'ht-act' }], rows,
        { empty: empty('history', 'No payments yet', 'Everything you pay for on 1venue shows here with a receipt.'), cls: 'bl-history' }),
      list.length ? h('div', { class: 'ht-actions' }, h('span', { class: 'tiny muted grow' }, `Showing ${Math.min(shown, list.length)} of ${list.length}`), more) : null);
  }
  function buyFlow(me, t, venues, preVenue, preTier) {
    const owned = venues.filter((v) => !v.archived);
    if (!owned.length) { toast('Create a venue first', { icon: 'info' }); return; }
    let venue = preVenue || owned.find((v) => v.slugTier !== 'slug3') || owned[0]; let tier = preTier || (venue.slugTier === 'slug4' ? 'slug3' : 'slug4');
    const vsel = h('select', { class: 'input', 'aria-label': 'Venue' }, ...owned.map((v) => h('option', { value: v.slug, selected: v.slug === venue.slug, disabled: v.slugTier === 'slug3' }, `${v.name} · /v/${v.slug}${v.slugTier === 'slug3' ? ' (has a 3-character link)' : ''}`)));
    const tiles = h('div', { class: 'bl-tiers', role: 'radiogroup', 'aria-label': 'Link length' });
    const go = h('button', { class: 'btn primary', type: 'button', html: icon('lock', { size: 16 }) + '<span>Continue</span>' });
    const paint = () => {
      tiles.replaceChildren(...['slug4', 'slug3'].map((tt) => { const has = (venue.slugTier === 'slug4' && tt === 'slug4') || venue.slugTier === 'slug3';
        return h('button', { type: 'button', role: 'radio', 'aria-checked': String(tier === tt), disabled: has, class: 'pr-addon-tile bl-tier' + (tier === tt ? ' on' : ''), onclick: () => { tier = tt; paint(); } },
          h('span', { class: 'pr-addon-len' }, tt === 'slug4' ? '4-character' : '3-character'), h('code', { class: 'pr-addon-url' }, '1venue.live/v/', h('b', null, tt === 'slug4' ? 'abcd' : 'abc')),
          h('strong', { class: 'pr-addon-price' }, money(t.slugAddons[tt])), h('span', { class: 'pr-addon-once' }, has ? 'already yours' : 'one-off')); }));
      go.disabled = !me.purchasesEnabled || (venue.slugTier === 'slug3') || (venue.slugTier === 'slug4' && tier === 'slug4');
    };
    vsel.onchange = () => { venue = owned.find((v) => v.slug === vsel.value); if (venue.slugTier === 'slug4') tier = 'slug3'; paint(); };
    paint();
    const sh = sheet({ title: 'Get a shorter link', icon: 'link', body: h('div', { class: 'col', style: { gap: '.8rem' } }, h('label', { class: 'ht-field' }, h('span', { class: 'ht-field-l' }, 'Venue'), vsel), tiles,
      h('p', { class: 'tiny muted' }, 'After paying, set the new link in the venue’s settings.'), h('div', { class: 'ht-actions' }, me.purchasesEnabled ? null : h('span', { class: 'tiny muted grow' }, 'Payments are not switched on yet.'), go)) });
    go.onclick = async () => { sh.close(); await checkoutSheet({ title: 'Shorter venue link', what: `${tier === 'slug4' ? '4' : '3'}-character link for ${venue.name}. One-off.`, subtotalKobo: t.slugAddons[tier], start: () => api('/api/billing/slug-addon', { method: 'POST', body: { venueSlug: venue.slug, tier } }) }); };
  }
  function shortLinks(me, t, venues) {
    const paid = me.plan !== 'free';
    const card = addonCard(t.slugAddons, { signedIn: true, releaseDays: t.shortLinkReleaseDays, manage: false, buyLabel: paid ? 'Get a short link' : 'Upgrade to get one',
      onBuy: paid ? () => buyFlow(me, t, venues) : () => { location.assign('/upgrade'); }, disabled: paid && !venues.some((v) => !v.archived) });
    const TIER = { none: 'Standard', slug4: '4-character', slug3: '3-character' };
    const rows = venues.map((v) => {
      const st = v.archived ? pill('Archived', 'muted', 'archive') : v.reservedSlug && v.linkReleaseAt ? pill(`Parked until ${dayFmt(v.linkReleaseAt)}`, 'wait', 'clock') : pill('Active', 'ok', 'checkCircle');
      const up = !v.archived && paid && v.slugTier !== 'slug3' ? h('button', { class: 'btn sm', type: 'button', onclick: () => buyFlow(me, t, venues, v, v.slugTier === 'slug4' ? 'slug3' : 'slug4') }, v.slugTier === 'slug4' ? 'Get 3-character' : 'Get shorter') : null;
      return [h('span', { class: 'ht-strong' }, v.name), h('span', null, h('code', { class: 'small' }, '/v/' + v.slug), v.reservedSlug ? h('span', { class: 'tiny muted bl-what' }, `Reserved: /v/${v.reservedSlug}`) : null), pill(TIER[v.slugTier] || v.slugTier, v.slugTier === 'none' ? 'muted' : 'accent'), st,
        h('span', { class: 'ht-row-actions' }, up, iconBtn('eye', `Open ${v.name}`, { href: '/v/' + v.slug }))];
    });
    return h('section', { class: 'bl-links', id: 'short-links' }, card,
      panel({ icon: 'link', title: 'Your venue links', desc: venues.some((v) => v.reservedSlug) ? 'Parked links are released after the date shown unless your plan is active again.' : null },
        table([{ label: 'Venue' }, { label: 'Link' }, { label: 'Length' }, { label: 'Status' }, { label: '', cls: 'ht-act' }], rows,
          { empty: empty('home', 'No venues yet', 'Create a venue to give it a link.', h('a', { class: 'btn sm', href: '/venues', 'data-link': '' }, 'Venues')) })));
  }
  async function check(reference) {
    msg.textContent = 'Checking your payment…';
    const r = await api(`/api/billing/payments/${encodeURIComponent(reference)}/verify`, { method: 'POST' });
    if (alive) msg.textContent = r.status === 'paid' ? 'Payment confirmed. Your plan is active.' : r.status === 'pending' ? 'Payment is still pending. You can check again below.' : 'This payment was not completed.';
  }
  try { await refresh(); } catch (e) { body.replaceChildren(panel({ icon: 'alert', title: 'Could not load billing' }, h('p', { class: 'small' }, e.message))); }
  const ref = new URLSearchParams(location.search).get('reference') || new URLSearchParams(location.search).get('trxref');
  if (ref && /^[A-Za-z0-9-]{1,80}$/.test(ref)) { try { await check(ref); await refresh(); } catch (e) { msg.textContent = e.message; } }
  return { unmount() { alive = false; } };
}
