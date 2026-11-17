// /upgrade: pricing. Free, Premium and Organisation side by side with a Monthly / Yearly switch and a
// Paystack checkout. Every price and limit comes from /api/plans (the plans config, editable in /admin).
import { h, api, toastErr } from '../ui.js';
import { icon } from '../icons.js';
import { state } from '../app.js';
import { loadMoney, fmtMoney, checkoutSheet, moneyConfig } from '../money.js';
import { addonCard as sharedAddonCard } from '../shortlinks.js';

// Shorter venue links: the shared card (see ../shortlinks.js); its button goes to Billing.
const addonCard = (addons, signedIn, releaseDays = 60) => sharedAddonCard(addons, { signedIn, releaseDays });

const money = (kobo) => fmtMoney(kobo, { whole: true });
const LABEL = { free: 'Free', premium: 'Premium', organisation: 'Organisation' };
const BLURB = { free: 'For trying 1venue and small gatherings.', premium: 'For growing communities and regular hosts.', organisation: 'For churches, schools and teams that host a lot.' };
const POPULAR = 'premium';
const FEATURES = [['branding', 'Venue branding: logo, colours, cover, about'], ['recurring', 'Recurring events and meetings'], ['reminders', 'Email reminders (WhatsApp when enabled)'], ['exports', 'Attendance and transcript exports (CSV, Excel)'], ['analytics', 'Analytics dashboard'], ['badge', 'Verified badge (granted on review)'], ['selfPromo', 'Promote your events'], ['ticketing', 'Tickets and donations'], ['replays', 'Cloud replays']];
const size = (mb) => (mb >= 1024 ? `${Math.round(mb / 102.4) / 10} GB` : `${mb} MB`);
const core = (p) => [
  `${p.venues} venue${p.venues === 1 ? '' : 's'}, ${p.id === 'free' ? '/v/name-venue links' : 'clean /v/name links'}`,
  `Up to ${p.audience.toLocaleString()} in stage events`,
  `Up to ${p.meeting} in meetings`,
  `${p.speakerSeats} speaker seats`,
  `${p.aiDaily.toLocaleString()} AI points a day`,
  `${size(p.uploadMB)} uploads`,
];
const extras = (p) => [...FEATURES.filter(([k]) => p.features && p.features[k]).map(([, l]) => l),
  ...(p.features && p.features.orgMembers ? [`Organisation with ${p.features.orgMembers} members, roles and a shared library`] : [])];
const tick = (txt, cls = '') => h('li', { class: cls }, h('span', { class: 'pr-tick', html: icon('check', { size: 13 }) }), h('span', null, txt));

export async function mount(view) {
  const [, table, me] = await Promise.all([loadMoney(), api('/api/plans'), state.user ? api('/api/billing').catch(() => null) : null]);
  let interval = 'month';
  const current = me ? me.plan : 'free';
  const rank = ['free', 'premium', 'organisation'];
  const status = h('p', { class: 'small pr-status', role: 'status', 'aria-live': 'polite' });
  const grid = h('div', { class: 'pr-grid' });
  // Yearly saving vs 12 monthly payments: the best across paid plans, shown on the toggle.
  const save = Math.max(0, ...table.plans.filter((p) => p.priceMonthKobo > 0 && p.priceYearKobo > 0).map((p) => Math.round((1 - p.priceYearKobo / (p.priceMonthKobo * 12)) * 100)));
  const seg = (id, label) => h('button', { type: 'button', class: 'pr-seg', role: 'radio', 'data-id': id, onclick: () => { interval = id; paint(); } }, label);
  const toggle = h('div', { class: 'pr-toggle', role: 'radiogroup', 'aria-label': 'Billing interval' }, seg('month', 'Monthly'), seg('year', 'Yearly'));
  const savePill = save > 0 ? h('span', { class: 'pr-save' }, `Save up to ${save}%`) : null;

  function card(p) {
    const yearly = interval === 'year';
    const paid = p.id !== 'free';
    const per = paid ? (yearly ? Math.round(p.priceYearKobo / 12) : p.priceMonthKobo) : 0;
    const isCurrent = p.id === current;
    const lower = rank.indexOf(p.id) < rank.indexOf(current);
    const popular = p.id === POPULAR;
    const pct = paid && p.priceMonthKobo ? Math.round((1 - p.priceYearKobo / (p.priceMonthKobo * 12)) * 100) : 0;
    let label = `Get ${LABEL[p.id]}`;
    if (!paid) label = state.user ? (isCurrent ? 'Your current plan' : 'Included') : 'Get started free';
    else if (isCurrent) label = `Renew or switch to ${yearly ? 'yearly' : 'monthly'}`;
    else if (lower) label = 'Included in your plan';
    const buy = h('button', { class: 'btn primary pr-btn', type: 'button', disabled: paid ? (!table.purchasesEnabled || lower) : !!state.user }, label);
    buy.onclick = async () => {
      if (!paid) { location.assign('/signup'); return; }
      if (!state.user) { location.assign('/login?next=/upgrade'); return; }
      checkoutSheet({ title: `${LABEL[p.id]} · ${yearly ? 'yearly' : 'monthly'}`, what: `${LABEL[p.id]} plan, billed ${yearly ? 'once a year' : 'every month'}. Renewals include the same processing fee.`, subtotalKobo: yearly ? p.priceYearKobo : p.priceMonthKobo,
        start: () => api('/api/billing/checkout', { method: 'POST', body: { plan: p.id, interval } }) });
    };
    const more = extras(p);
    return h('section', { class: 'pr-card' + (popular ? ' popular' : '') + (isCurrent ? ' current' : ''), 'aria-label': `${LABEL[p.id]} plan` },
      popular ? h('span', { class: 'pr-badge' }, 'Most popular') : null,
      h('div', { class: 'pr-name' }, h('h2', null, LABEL[p.id]), isCurrent ? h('span', { class: 'pr-current' }, 'Current') : null),
      h('p', { class: 'pr-blurb' }, BLURB[p.id] || ''),
      h('div', { class: 'pr-price' }, h('strong', null, paid ? money(per) : money(0)), h('span', null, '/month'),
        yearly && pct > 0 ? h('span', { class: 'pr-off' }, `-${pct}%`) : null),
      h('p', { class: 'pr-billed' }, !paid ? 'Free forever' : yearly ? `Billed at ${money(p.priceYearKobo)}/year` : `Billed at ${money(p.priceMonthKobo)}/month`),
      buy,
      h('p', { class: 'pr-note' }, paid ? 'Cancel anytime · secure Paystack checkout' : 'No card needed'),
      h('ul', { class: 'pr-list' }, ...core(p).map((t) => tick(t))),
      more.length ? h('div', { class: 'pr-more' }, h('h3', null, 'Additional features'), h('ul', { class: 'pr-list' }, ...more.map((t) => tick(t)))) : null);
  }
  function paint() {
    toggle.querySelectorAll('.pr-seg').forEach((b) => { const on = b.dataset.id === interval; b.classList.toggle('on', on); b.setAttribute('aria-checked', String(on)); });
    toggle.dataset.on = interval;
    grid.replaceChildren(...table.plans.map(card));
  }

  // Compare plans: every limit and feature in one table.
  const rows = [['Venues', (p) => p.venues], ['Stage audience', (p) => p.audience.toLocaleString()], ['Meeting size', (p) => p.meeting], ['Speaker seats', (p) => p.speakerSeats], ['AI points a day', (p) => p.aiDaily.toLocaleString()], ['Uploads', (p) => size(p.uploadMB)],
    ...FEATURES.map(([k, l]) => [l.split(':')[0].replace(/ \(.*\)$/, ''), (p) => (p.features && p.features[k] ? '✓' : '—')]), ['Organisation members', (p) => (p.features && p.features.orgMembers) || '—']];
  const compare = h('section', { class: 'pr-compare', id: 'compare', hidden: true },
    h('h2', null, 'Compare plans'),
    h('div', { class: 'pr-table-wrap', tabindex: '0', role: 'region', 'aria-label': 'Plan comparison' },
      h('table', { class: 'pr-table' },
        h('thead', null, h('tr', null, h('th', { scope: 'col' }, 'Feature'), ...table.plans.map((p) => h('th', { scope: 'col', class: p.id === POPULAR ? 'popular' : '' }, LABEL[p.id])))),
        h('tbody', null, ...rows.map(([l, f]) => h('tr', null, h('th', { scope: 'row' }, l), ...table.plans.map((p) => h('td', { class: p.id === POPULAR ? 'popular' : '' }, String(f(p))))))))));
  const compareLink = h('button', { class: 'pr-compare-link', type: 'button', 'aria-controls': 'compare', 'aria-expanded': 'false', html: 'Compare plans ' + icon('chevronDown', { size: 16 }) });
  compareLink.onclick = () => { compare.hidden = !compare.hidden; compareLink.setAttribute('aria-expanded', String(!compare.hidden)); compareLink.classList.toggle('open', !compare.hidden); if (!compare.hidden) compare.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' }); };

  const addons = table.slugAddons;
  view.append(h('div', { class: 'pr-page' },
    h('header', { class: 'pr-head' }, h('h1', null, 'Pricing'),
      h('p', { class: 'muted' }, `Simple plans for every venue. Prices in ${moneyConfig().currency}${moneyConfig().currency !== moneyConfig().chargeCurrency ? ` (estimated; charged in ${moneyConfig().chargeCurrency})` : ''}.`),
      h('div', { class: 'pr-toggle-row' }, toggle, savePill)),
    status, grid,
    h('div', { class: 'pr-foot' }, compareLink),
    compare,
    addonCard(addons, !!me, table.shortLinkReleaseDays),
    !table.purchasesEnabled ? h('p', { class: 'small muted pr-center' }, 'Online payments are not switched on yet.') : null));
  paint();
}
