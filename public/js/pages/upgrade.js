// /upgrade: pricing. Free, Pro, Business, Organisation and Enterprise side by side
// with a Monthly / Yearly switch and a Paystack checkout. Prices and limits come from /api/plans
// (editable in /admin). Enterprise is talk-to-sales.
import { h, api, toast, toastErr, sheet } from '../ui.js';
import { icon } from '../icons.js';
import { state } from '../app.js';
import { loadMoney, fmtMoney, checkoutSheet, moneyConfig } from '../money.js';
import { addonCard as sharedAddonCard } from '../shortlinks.js';

const addonCard = (addons, signedIn, releaseDays = 60) => sharedAddonCard(addons, { signedIn, releaseDays });

const money = (kobo) => fmtMoney(kobo, { whole: true });
const LABEL = { free: 'Free', pro: 'Pro', premium: 'Pro', business: 'Business', organisation: 'Organisation', enterprise: 'Enterprise' };
const BLURB = {
  free: 'For trying 1venue and small gatherings.',
  pro: 'For solo hosts and small teams.',
  premium: 'For solo hosts and small teams.',
  business: 'For growing teams with venues and branding.',
  organisation: 'For churches, schools and companies that host a lot.',
  enterprise: 'For large organisations. We’ll call you to set this up.',
};
const POPULAR = 'pro';
const FEATURES = [['branding', 'Venue branding: logo, colours, cover, about'], ['recurring', 'Recurring events and meetings'], ['reminders', 'Email reminders (WhatsApp when enabled)'], ['exports', 'Attendance and transcript exports (CSV, Excel)'], ['analytics', 'Analytics dashboard'], ['badge', 'Verified badge (granted on review)'], ['selfPromo', 'Promote your events'], ['ticketing', 'Tickets and donations'], ['replays', 'Cloud replays']];
const size = (mb) => (mb >= 1024 ? `${Math.round(mb / 102.4) / 10} GB` : `${mb} MB`);
const creditsLine = (p) => {
  const n = Number(p.includedCredits || 0);
  if (p.id === 'free') return 'Credits to get started';
  return `${n.toLocaleString()} credits each month`;
};
const core = (p) => [
  `${p.venues} venue${p.venues === 1 ? '' : 's'}, ${p.id === 'free' ? '/v/name-venue links' : 'clean /v/name links'}`,
  `Up to ${p.audience.toLocaleString()} in stage events`,
  `Up to ${p.meeting} in meetings`,
  `${p.speakerSeats} speaker seats`,
  creditsLine(p),
  `${size(p.uploadMB)} uploads`,
];
const extras = (p) => [...FEATURES.filter(([k]) => p.features && p.features[k]).map(([, l]) => l),
  ...(p.features && p.features.orgMembers ? [`Organisation with ${p.features.orgMembers} members, roles and a shared library`] : [])];
const tick = (txt, cls = '') => h('li', { class: cls }, h('span', { class: 'pr-tick', html: icon('check', { size: 13 }) }), h('span', null, txt));

const ENTERPRISE = {
  id: 'enterprise',
  venues: 'Custom',
  audience: 'Custom',
  meeting: 'Custom',
  speakerSeats: 'Custom',
  includedCredits: 0,
  uploadMB: 0,
  priceMonthKobo: 0,
  priceYearKobo: 0,
  features: { branding: 1, recurring: 1, reminders: 1, whatsapp: 1, exports: 1, analytics: 1, badge: 1, selfPromo: 1, ticketing: 1, replays: 1, orgMembers: 'Custom' },
};
const enterpriseCore = () => ['Custom venues and audience size', 'Custom meeting size and speaker seats', 'A credits plan that fits your usage', 'Dedicated onboarding and support'];

function salesForm() {
  const u = state.user || {};
  const field = (label, input) => h('label', { class: 'field' }, h('span', { class: 'lbl' }, label), input);
  const name = h('input', { class: 'input', name: 'name', required: true, autocomplete: 'name', value: u.name || '', maxlength: 120 });
  const org = h('input', { class: 'input', name: 'organisation', required: true, autocomplete: 'organization', value: '', maxlength: 160 });
  const email = h('input', { class: 'input', type: 'email', name: 'email', required: true, autocomplete: 'email', value: u.email || '', maxlength: 160 });
  const phone = h('input', { class: 'input', type: 'tel', name: 'phone', required: true, autocomplete: 'tel', value: u.phone || '', maxlength: 40 });
  const size = h('input', { class: 'input', name: 'teamSize', required: true, placeholder: 'e.g. 40 people, or 500 attendees', maxlength: 80 });
  const message = h('textarea', { class: 'input', name: 'message', rows: 4, maxlength: 2000, placeholder: 'Tell us a little about how you host' });
  const status = h('p', { class: 'small pr-status', role: 'status', 'aria-live': 'polite' });
  const send = h('button', { class: 'btn primary', type: 'submit' }, 'Send');
  const form = h('form', { class: 'sales-form col', style: { gap: '.7rem' } },
    h('p', { class: 'small muted' }, 'Our team will call you.'),
    field('Name', name), field('Organisation', org), field('Email', email), field('Phone', phone),
    field('Team size or expected attendees', size), field('Message (optional)', message), status, send);
  form.onsubmit = async (e) => {
    e.preventDefault();
    send.disabled = true; status.textContent = '';
    try {
      await api('/api/sales/enquiry', { method: 'POST', body: { name: name.value.trim(), organisation: org.value.trim(), email: email.value.trim(), phone: phone.value.trim(), teamSize: size.value.trim(), message: message.value.trim() } });
      form.replaceChildren(h('p', { class: 'sales-thanks' }, 'Our team will call you.'), h('p', { class: 'small muted' }, 'Thanks — we’ll be in touch shortly.'));
      toast('Our team will call you', { icon: 'check' });
    } catch (err) { status.textContent = err.message || 'Could not send'; toastErr(err); send.disabled = false; }
  };
  return form;
}

function openSales() {
  sheet({ title: 'Talk to sales', icon: 'phone', group: 'admin', body: salesForm() });
}

export async function mount(view) {
  const [, table, me] = await Promise.all([loadMoney(), api('/api/plans'), state.user ? api('/api/billing').catch(() => null) : null]);
  let interval = 'month';
  const current = me ? (me.plan === 'premium' ? 'pro' : me.plan) : 'free';
  const rank = ['free', 'pro', 'business', 'organisation', 'enterprise'];
  const status = h('p', { class: 'small pr-status', role: 'status', 'aria-live': 'polite' });
  const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
  const track = h('div', { class: 'pr-track', tabindex: '0', role: 'region', 'aria-label': 'Plans' });
  const prev = h('button', { class: 'pr-nav pr-nav-prev', type: 'button', 'aria-label': 'Previous plans', html: icon('chevronLeft', { size: 20 }) });
  const next = h('button', { class: 'pr-nav pr-nav-next', type: 'button', 'aria-label': 'Next plans', html: icon('chevronRight', { size: 20 }) });
  const slider = h('div', { class: 'pr-slider at-start' }, prev, track, next);
  let primed = false;

  function step() {
    const card = track.querySelector('.pr-card');
    if (!card) return 300;
    const gap = parseFloat(getComputedStyle(track).columnGap || getComputedStyle(track).gap) || 16;
    return card.getBoundingClientRect().width + gap;
  }
  function syncNav() {
    const max = Math.max(0, track.scrollWidth - track.clientWidth);
    const atStart = track.scrollLeft <= 4;
    const atEnd = track.scrollLeft >= max - 4;
    prev.disabled = atStart;
    next.disabled = atEnd;
    slider.classList.toggle('at-start', atStart);
    slider.classList.toggle('at-end', atEnd);
  }
  function go(dir) {
    track.scrollBy({ left: dir * step(), behavior: reduced() ? 'auto' : 'smooth' });
  }
  function showPreferred() {
    const el = (state.user && track.querySelector('.pr-card.current')) || track.querySelector('.pr-card.popular') || track.querySelector('.pr-card.current');
    if (!el) { syncNav(); return; }
    const tr = track.getBoundingClientRect();
    const cr = el.getBoundingClientRect();
    if (!(cr.left >= tr.left - 2 && cr.right <= tr.right + 2)) {
      const delta = (cr.left - tr.left) - (tr.width - cr.width) / 2;
      track.scrollTo({ left: track.scrollLeft + delta, behavior: 'auto' });
    }
    syncNav();
  }
  prev.onclick = () => go(-1);
  next.onclick = () => go(1);
  track.addEventListener('scroll', syncNav, { passive: true });
  track.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowLeft') { e.preventDefault(); go(-1); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); go(1); }
    else if (e.key === 'Home') { e.preventDefault(); track.scrollTo({ left: 0, behavior: reduced() ? 'auto' : 'smooth' }); }
    else if (e.key === 'End') { e.preventDefault(); track.scrollTo({ left: track.scrollWidth, behavior: reduced() ? 'auto' : 'smooth' }); }
  });
  new ResizeObserver(syncNav).observe(track);
  const save = Math.max(0, ...table.plans.filter((p) => p.priceMonthKobo > 0 && p.priceYearKobo > 0).map((p) => Math.round((1 - p.priceYearKobo / (p.priceMonthKobo * 12)) * 100)));
  const seg = (id, label) => h('button', { type: 'button', class: 'pr-seg', role: 'radio', 'data-id': id, onclick: () => { interval = id; paint(); } }, label);
  const toggle = h('div', { class: 'pr-toggle', role: 'radiogroup', 'aria-label': 'Billing interval' }, seg('month', 'Monthly'), seg('year', 'Yearly'));
  const savePill = save > 0 ? h('span', { class: 'pr-save' }, `Save up to ${save}%`) : null;
  const plans = [...table.plans.map((p) => (p.id === 'premium' ? { ...p, id: 'pro' } : p)), ENTERPRISE];

  function card(p) {
    const yearly = interval === 'year';
    const enterprise = p.id === 'enterprise';
    const paid = p.id !== 'free' && !enterprise;
    const per = paid ? (yearly ? Math.round(p.priceYearKobo / 12) : p.priceMonthKobo) : 0;
    const isCurrent = p.id === current;
    const lower = !enterprise && rank.indexOf(p.id) < rank.indexOf(current);
    const popular = p.id === POPULAR;
    const pct = paid && p.priceMonthKobo ? Math.round((1 - p.priceYearKobo / (p.priceMonthKobo * 12)) * 100) : 0;
    let label = `Get ${LABEL[p.id]}`;
    if (enterprise) label = 'Talk to sales';
    else if (!paid) label = state.user ? (isCurrent ? 'Your current plan' : 'Included') : 'Get started free';
    else if (isCurrent) label = `Renew or switch to ${yearly ? 'yearly' : 'monthly'}`;
    else if (lower) label = 'Included in your plan';
    const buy = h('button', { class: 'btn primary pr-btn', type: 'button', disabled: enterprise ? false : (paid ? (!table.purchasesEnabled || lower) : !!state.user) }, label);
    buy.onclick = async () => {
      if (enterprise) { openSales(); return; }
      if (!paid) { location.assign('/signup'); return; }
      if (!state.user) { location.assign('/login?next=/upgrade'); return; }
      checkoutSheet({ title: `${LABEL[p.id]} · ${yearly ? 'yearly' : 'monthly'}`, what: `${LABEL[p.id]} plan, billed ${yearly ? 'once a year' : 'every month'}. Renewals include the same processing fee.`, subtotalKobo: yearly ? p.priceYearKobo : p.priceMonthKobo,
        start: () => api('/api/billing/checkout', { method: 'POST', body: { plan: p.id, interval } }) });
    };
    const more = enterprise
      ? ['Custom contracts and invoicing', 'Priority support', 'A plan shaped around your organisation']
      : extras(p);
    const list = enterprise ? enterpriseCore() : core(p);
    return h('section', { class: 'pr-card' + (popular ? ' popular' : '') + (isCurrent ? ' current' : ''), 'aria-label': `${LABEL[p.id]} plan` },
      popular ? h('span', { class: 'pr-badge' }, 'Most popular') : null,
      h('div', { class: 'pr-name' }, h('h2', null, LABEL[p.id]), isCurrent ? h('span', { class: 'pr-current' }, 'Current') : null),
      h('p', { class: 'pr-blurb' }, BLURB[p.id] || ''),
      h('div', { class: 'pr-price' },
        enterprise ? h('strong', null, 'Talk to sales') : h('strong', null, paid ? money(per) : money(0)),
        enterprise ? null : h('span', null, '/month'),
        yearly && pct > 0 ? h('span', { class: 'pr-off' }, `-${pct}%`) : null),
      h('p', { class: 'pr-billed' }, enterprise ? 'We’ll call you to set this up' : (!paid ? 'Free forever' : yearly ? `Billed at ${money(p.priceYearKobo)}/year` : `Billed at ${money(p.priceMonthKobo)}/month`)),
      buy,
      h('p', { class: 'pr-note' }, enterprise ? 'Our team will call you' : (paid ? 'Cancel anytime · secure Paystack checkout' : 'No card needed')),
      h('ul', { class: 'pr-list' }, ...list.map((t) => tick(t))),
      more.length ? h('div', { class: 'pr-more' }, h('h3', null, 'Additional features'), h('ul', { class: 'pr-list' }, ...more.map((t) => tick(t)))) : null);
  }
  function paint() {
    toggle.querySelectorAll('.pr-seg').forEach((b) => { const on = b.dataset.id === interval; b.classList.toggle('on', on); b.setAttribute('aria-checked', String(on)); });
    toggle.dataset.on = interval;
    const keep = primed ? track.scrollLeft : null;
    track.replaceChildren(...plans.map(card));
    requestAnimationFrame(() => {
      if (keep == null) showPreferred();
      else { track.scrollLeft = keep; syncNav(); }
      primed = true;
    });
  }

  const display = (p, v) => (p.id === 'enterprise' ? 'Custom' : v);
  const rows = [['Venues', (p) => display(p, p.venues)], ['Stage audience', (p) => display(p, typeof p.audience === 'number' ? p.audience.toLocaleString() : p.audience)], ['Meeting size', (p) => display(p, p.meeting)], ['Speaker seats', (p) => display(p, p.speakerSeats)], ['Credits each month', (p) => (p.id === 'enterprise' ? 'Custom' : p.id === 'free' ? 'To get started' : Number(p.includedCredits || 0).toLocaleString())], ['Uploads', (p) => (p.id === 'enterprise' ? 'Custom' : size(p.uploadMB))],
    ...FEATURES.map(([k, l]) => [l.split(':')[0].replace(/ \(.*\)$/, ''), (p) => (p.features && p.features[k] ? '✓' : '-')]), ['Organisation members', (p) => (p.features && p.features.orgMembers) || '-']];
  const compare = h('section', { class: 'pr-compare', id: 'compare', hidden: true },
    h('h2', null, 'Compare plans'),
    h('div', { class: 'pr-table-wrap', tabindex: '0', role: 'region', 'aria-label': 'Plan comparison' },
      h('table', { class: 'pr-table' },
        h('thead', null, h('tr', null, h('th', { scope: 'col' }, 'Feature'), ...plans.map((p) => h('th', { scope: 'col', class: p.id === POPULAR ? 'popular' : '' }, LABEL[p.id])))),
        h('tbody', null, ...rows.map(([l, f]) => h('tr', null, h('th', { scope: 'row' }, l), ...plans.map((p) => h('td', { class: p.id === POPULAR ? 'popular' : '' }, String(f(p))))))))));
  const compareLink = h('button', { class: 'pr-compare-link', type: 'button', 'aria-controls': 'compare', 'aria-expanded': 'false', html: 'Compare plans ' + icon('chevronDown', { size: 16 }) });
  compareLink.onclick = () => { compare.hidden = !compare.hidden; compareLink.setAttribute('aria-expanded', String(!compare.hidden)); compareLink.classList.toggle('open', !compare.hidden); if (!compare.hidden) compare.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' }); };

  const addons = table.slugAddons;
  view.append(h('div', { class: 'pr-page' },
    h('header', { class: 'pr-head' }, h('h1', { html: icon('sparkles', { size: 26 }) + 'Pricing' }),
      h('div', { class: 'pr-toggle-row' }, toggle, savePill)),
    status, slider,
    h('div', { class: 'pr-foot' }, compareLink),
    compare,
    addonCard(addons, !!me, table.shortLinkReleaseDays),
    !table.purchasesEnabled ? h('p', { class: 'small muted pr-center' }, 'Online payments are not switched on yet.') : null));
  paint();
}
