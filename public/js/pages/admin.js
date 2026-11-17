// /admin: site admin tools (admins = confirmed emails in ADMIN_EMAILS). Two columns: a sticky section nav
// (the feed page's rail and filter styles; chips on phones) and the section cards. Deep links via #section,
// the nav follows the scroll (scrollspy). Demo data, plans, FX, user plans, promotions, payouts, reports, read-out.
import { icon } from '../icons.js';
import { h, api, toast, toastErr, avatar, confirmDlg } from '../ui.js';
import { state, requireLogin } from '../app.js';

// ---------------------------------------------------------------- navigation model (every section and subsection)
const SECTIONS = [
  { id: 'demo', label: 'Demo data', icon: 'users' },
  { id: 'plans', label: 'Plans & limits', icon: 'crown', children: [['plans-free', 'Free'], ['plans-premium', 'Premium'], ['plans-organisation', 'Organisation'], ['plans-ai', 'AI cost per use'], ['plans-addons', 'Short links & billing'], ['plans-features', 'Plan features'], ['plans-platform', 'Tickets, promos & payouts']] },
  { id: 'fx', label: 'Currency & FX rates', icon: 'globe' },
  { id: 'users', label: 'User plans', icon: 'shield' },
  { id: 'promotions', label: 'Promotions', icon: 'sparkle', children: [['promo-new', 'New promotion'], ['promo-current', 'Current promotions']] },
  { id: 'commerce', label: 'Reviews & payouts', icon: 'creditCard', children: [['commerce-review', 'Promotions to approve'], ['commerce-payouts', 'Payout requests'], ['commerce-payments', 'Recent payments']] },
  { id: 'reports', label: 'Message reports', icon: 'alert' },
  { id: 'tts', label: 'Read-out check', icon: 'volume' },
];
const ORDER = SECTIONS.flatMap((s) => [s.id, ...(s.children || []).map(([id]) => id)]);
const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

/** A section card with a sticky header. */
function section(id, ic, title, desc, ...body) {
  return h('section', { class: 'card admin-sec', id, 'aria-labelledby': id + '-h' },
    h('header', { class: 'admin-sec-head' }, h('span', { class: 'ico-tile', html: icon(ic, { size: 18 }) }),
      h('div', { class: 'grow min0' }, h('h2', { id: id + '-h' }, title), desc ? h('p', { class: 'muted small' }, desc) : null)),
    h('div', { class: 'admin-sec-body' }, ...body));
}
/** A titled block inside a section; its id is a nav child. */
const sub = (id, title, ...body) => h('div', { class: 'admin-sub', id }, h('h3', { class: 'admin-sub-h' }, title), ...body);
const emptyState = (ic, text) => h('div', { class: 'admin-empty' }, h('span', { html: icon(ic, { size: 20 }) }), h('span', null, text));
const loading = () => h('p', { class: 'tiny muted' }, 'Loading…');

/** Bring a picked item into view and tint its header (accent, fading to a subtle persistent state). */
function spotlight(el) {
  if (!el) return;
  el.classList.remove('admin-spot'); void el.offsetWidth; el.classList.add('admin-spot');
  el.scrollIntoView({ behavior: reduced() ? 'auto' : 'smooth', block: 'start' });
}

/**
 * Typeahead picker: the input guides, at most 5 matches show, ↑/↓ + Enter pick, Esc clears.
 * fetchItems(q) → [{ id, title, sub }]. The picked row stays highlighted.
 */
let pickerSeq = 0;
function picker({ input, fetchItems, onPick, label }) {
  const id = 'admin-picks-' + (++pickerSeq);
  const list = h('div', { class: 'admin-picks', role: 'listbox', id, 'aria-label': label });
  const more = h('p', { class: 'tiny muted admin-picks-more' });
  Object.assign(input, { autocomplete: 'off' });
  input.setAttribute('role', 'combobox'); input.setAttribute('aria-controls', id); input.setAttribute('aria-autocomplete', 'list'); input.setAttribute('aria-expanded', 'false');
  let items = [], active = -1, pickedId = null, seq = 0, t;
  const paint = () => {
    list.replaceChildren(...(items.length ? items.map((it, i) => {
      const b = h('button', { type: 'button', role: 'option', id: `${id}-${i}`, class: `admin-pick${i === active ? ' on' : ''}${String(it.id) === String(pickedId) ? ' picked' : ''}`, 'aria-selected': String(i === active) },
        it.avatar ? avatar(it.title, it.avatar) : null,
        h('span', { class: 'grow min0' }, h('strong', { class: 'small ellipsis' }, it.title), it.sub ? h('span', { class: 'tiny muted ellipsis' }, it.sub) : null),
        String(it.id) === String(pickedId) ? h('span', { class: 'admin-pick-tick', html: icon('check', { size: 15 }) }) : null);
      b.onmouseenter = () => { active = i; for (const [j, x] of [...list.children].entries()) x.classList.toggle('on', j === i); };
      b.onclick = () => choose(i);
      return b;
    }) : [emptyState('search', input.value.trim() ? 'No matches. Try a name, username, email or title.' : 'Nothing to show yet.')]));
    input.setAttribute('aria-expanded', String(items.length > 0));
    if (active >= 0) input.setAttribute('aria-activedescendant', `${id}-${active}`); else input.removeAttribute('aria-activedescendant');
  };
  async function run() {
    const my = ++seq;
    let all = [];
    try { all = await fetchItems(input.value.trim()); } catch (e) { if (my === seq) { list.replaceChildren(h('p', { class: 'tiny muted' }, e.message)); } return; }
    if (my !== seq) return;
    items = all.slice(0, 5); active = items.length ? 0 : -1;
    more.textContent = all.length > 5 ? `Showing 5 of ${all.length >= 25 ? 'many' : all.length}. Keep typing to narrow.` : '';
    paint();
  }
  function choose(i) { const it = items[i]; if (!it) return; pickedId = it.id; active = i; paint(); onPick(it); }
  input.oninput = () => { clearTimeout(t); t = setTimeout(run, 180); };
  input.onkeydown = (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault(); if (!items.length) return;
      active = (active + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length; paint();
      list.children[active]?.scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'Enter') { e.preventDefault(); if (active >= 0) choose(active); }
    else if (e.key === 'Escape') { if (input.value) { input.value = ''; run(); } }
  };
  return { el: h('div', { class: 'admin-picker' }, list, more), run, reset: () => { pickedId = null; paint(); } };
}

// ---------------------------------------------------------------- page
export async function mount(view) {
  if (!requireLogin('Sign in to continue')) return;
  view.classList.add('admin-view');
  const head = h('div', { class: 'page-head admin-head' }, h('h1', { html: `<span class="ico-tile" data-group="admin">${icon('shield', { size: 20 })}</span> Admin` }));
  if (!state.user.isAdmin) {
    view.append(head, h('div', { class: 'card pad' }, h('h3', null, 'Admins only'),
      h('p', { class: 'muted small' }, 'Add your email to ADMIN_EMAILS in Coolify, redeploy, and confirm your email (Google sign-in counts).')));
    return;
  }
  const content = h('div', { class: 'admin-content' }, head,
    demoCard(), plansCard(), fxCard(), userPlanCard(), promoCard(), commerceCard(), reportsCard(), ttsCard());
  const { rail, chips, links } = navigation();
  view.append(chips, h('div', { class: 'admin-layout' }, rail, content));

  // nav → section (deep link via hash)
  let lock = 0;
  const go = (id, behavior = reduced() ? 'auto' : 'smooth') => {
    const el = document.getElementById(id); if (!el) return false;
    lock = Date.now() + 2500; setActive(id); // hold the clicked item until the smooth scroll settles
    addEventListener('scrollend', () => { lock = 0; }, { once: true });
    el.scrollIntoView({ behavior, block: 'start' });
    history.replaceState(history.state, '', '#' + id);
    return true;
  };
  for (const a of links) a.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); const g = a.closest('.admin-nav-group'); if (g) openGroup(g, true); go(a.dataset.target); });
  function setActive(id) {
    const parent = SECTIONS.find((s) => s.id === id || (s.children || []).some(([c]) => c === id));
    for (const a of links) {
      const on = a.dataset.target === id || (a.classList.contains('chip') && parent && a.dataset.target === parent.id);
      a.classList.toggle('on', on);
      if (on) a.setAttribute('aria-current', 'true'); else a.removeAttribute('aria-current');
    }
    for (const g of rail.querySelectorAll('.admin-nav-group')) {
      const has = parent && g.dataset.group === parent.id;
      g.classList.toggle('has-on', !!has);
      if (has && parent.id !== id) openGroup(g, true);
    }
    const chip = chips.querySelector('.chip.on');
    // instant: a second smooth scroll would cancel the page's smooth scroll in Chromium
    if (chip && chips.offsetParent) chips.scrollLeft = chip.offsetLeft - chips.clientWidth / 2 + chip.clientWidth / 2;
  }
  // scrollspy: the last section/subsection whose top has passed under the header
  let raf = 0;
  const spy = () => {
    raf = 0; if (Date.now() < lock) return;
    const line = (parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--top-h')) || 64) + 96;
    let cur = ORDER[0];
    for (const id of ORDER) { const el = document.getElementById(id); if (el && el.getBoundingClientRect().top <= line) cur = id; }
    if (innerHeight + scrollY >= document.documentElement.scrollHeight - 4) { const last = [...ORDER].reverse().find((id) => { const el = document.getElementById(id); return el && el.getBoundingClientRect().top < innerHeight; }); if (last) cur = last; }
    setActive(cur);
  };
  const onScroll = () => { if (!raf) raf = requestAnimationFrame(spy); };
  addEventListener('scroll', onScroll, { passive: true });
  setActive(ORDER[0]);
  // a deep link may point at a subsection that renders after its data loads
  const want = decodeURIComponent(location.hash.slice(1));
  if (want && ORDER.includes(want)) { let tries = 0; const tick = () => { if (go(want, 'auto') || ++tries > 40) return; setTimeout(tick, 100); }; setTimeout(tick, 60); }
  return { unmount() { removeEventListener('scroll', onScroll); if (raf) cancelAnimationFrame(raf); } };
}

function openGroup(g, open) {
  g.classList.toggle('open', open);
  const b = g.querySelector('.admin-nav-toggle'); if (b) b.setAttribute('aria-expanded', String(open));
}
function navigation() {
  const links = [];
  const link = (id, label, cls, ic) => { const a = h('a', { href: '#' + id, class: cls, 'data-target': id, html: (ic ? icon(ic, { size: 16 }) : '') + `<span>${label}</span>` }); links.push(a); return a; };
  const list = h('nav', { class: 'feed-filters admin-nav', 'aria-label': 'Admin sections' }, ...SECTIONS.map((s) => {
    if (!s.children) return link(s.id, s.label, 'feed-filter admin-nav-item', s.icon);
    const kids = h('div', { class: 'admin-nav-children', id: `nav-${s.id}-kids` }, ...s.children.map(([id, l]) => link(id, l, 'feed-filter admin-nav-child')));
    const toggle = h('button', { class: 'admin-nav-toggle', type: 'button', 'aria-expanded': 'false', 'aria-controls': `nav-${s.id}-kids`, 'aria-label': `Show ${s.label} sections`, html: icon('chevronDown', { size: 16 }) });
    const g = h('div', { class: 'admin-nav-group', 'data-group': s.id }, h('div', { class: 'admin-nav-row' }, link(s.id, s.label, 'feed-filter admin-nav-item', s.icon), toggle), kids);
    toggle.onclick = () => openGroup(g, !g.classList.contains('open'));
    if (s.id === 'plans') openGroup(g, true);
    return g;
  }));
  const rail = h('aside', { class: 'feed-rail admin-rail', 'aria-label': 'Admin navigation' }, h('div', { class: 'feed-card' }, h('div', { class: 'feed-rail-head tiny muted' }, 'Admin'), list));
  const chips = h('nav', { class: 'chips admin-chips', 'aria-label': 'Admin sections' }, ...SECTIONS.map((s) => link(s.id, s.label, 'chip', s.icon)));
  return { rail, chips, links };
}

// ---------------------------------------------------------------- demo data
function demoCard() {
  const body = h('div', { class: 'col', style: { gap: '.8rem' } }, loading());
  const load = h('button', { class: 'btn primary', type: 'button', html: icon('plus', { size: 16 }) + '<span>Load demo data</span>' });
  const remove = h('button', { class: 'btn danger', type: 'button', html: icon('trash', { size: 16 }) + 'Remove demo data' });
  const busy = (on) => { load.disabled = on; remove.disabled = on; };
  function paint(s) {
    const stats = h('div', { class: 'admin-stats' }, ...[['Accounts', s.users], ['Events', s.events], ['Posts', s.posts], ['Sessions', s.sessions]].map(([l, n]) => h('div', { class: 'admin-stat' }, h('strong', null, String(n || 0)), h('span', { class: 'tiny muted' }, l))));
    load.lastChild.textContent = s.loaded ? 'Reload demo data' : 'Load demo data';
    remove.hidden = !s.loaded;
    body.replaceChildren(...[stats,
      s.loaded ? h('p', { class: 'small' }, 'Sign in as any demo account with password ', h('code', null, s.password), '.') : null,
      s.loaded ? h('div', { class: 'admin-seed-people' }, ...s.accounts.map((a) => h('a', { class: 'list-item', href: `/u/${a.username}`, 'data-link': '' }, avatar(a.name, a.avatarUrl),
        h('div', { class: 'grow' }, h('strong', null, a.name), h('div', { class: 'tiny muted' }, `@${a.username} · ${a.email}`))))) : null,
      h('div', { class: 'row wrap', style: { gap: '.5rem' } }, load, remove)].filter(Boolean));
  }
  const refresh = async () => paint(await api('/api/admin/seed'));
  load.onclick = async () => { busy(true); try { paint(await api('/api/admin/seed', { method: 'POST' })); toast('Demo data loaded', { icon: 'check' }); } catch (e) { toastErr(e); } finally { busy(false); } };
  remove.onclick = async () => {
    if (!(await confirmDlg('Remove every demo account and everything they created? Real accounts are not affected.', { ok: 'Remove demo data', danger: true }))) return;
    busy(true);
    try { paint(await api('/api/admin/seed', { method: 'DELETE' })); toast('Demo data removed', { icon: 'check' }); } catch (e) { toastErr(e); } finally { busy(false); }
  };
  refresh().catch((e) => body.replaceChildren(h('p', { class: 'small' }, e.message || 'Could not load')));
  return section('demo', 'users', 'Demo data', '10 sample accounts with events, posts, sessions and more. Remove it all in one click.', body);
}

// ---------------------------------------------------------------- plans: limits, prices, AI weights (app_settings)
const PLAN_LABEL = { free: 'Free', premium: 'Premium', organisation: 'Organisation' };
const FIELDS = [['venues', 'Venues'], ['audience', 'Stage audience'], ['meeting', 'Meeting size'], ['speakerSeats', 'Speaker seats'], ['aiDaily', 'AI points / day'], ['uploadMB', 'Uploads (MB)'], ['priceMonthKobo', 'Monthly (kobo)'], ['priceYearKobo', 'Annual (kobo)']];
const FEATURE_FIELDS = [['branding', 'Branding'], ['recurring', 'Recurring'], ['reminders', 'Reminders'], ['whatsapp', 'WhatsApp reminders'], ['exports', 'Exports'], ['analytics', 'Analytics'], ['badge', 'Verified badge eligible'], ['selfPromo', 'Self-serve promotions'], ['ticketing', 'Tickets & donations'], ['replays', 'Cloud replays'], ['orgMembers', 'Org members (0 = no org)'], ['replayMB', 'Replay storage (MB)'], ['callVideo', '1:1 video calls'], ['groupMembers', 'Group chat members'], ['callParticipants', 'Call participants (2 = 1:1 only)'], ['historyDays', 'Message history days (0 = forever)']];
const PLATFORM_FIELDS = [['feeBps', 'Platform fee (basis points, 500 = 5%)'], ['promoDayKobo', 'Promotion price per day (kobo)'], ['promoMaxDays', 'Promotion max days'], ['promoApproval', 'Approve promotions first (1/0)'], ['payoutMinKobo', 'Minimum payout (kobo)'], ['ticketMaxPerOrder', 'Tickets per order'], ['donationMinKobo', 'Minimum gift (kobo)'], ['reminderLeadA', 'First reminder (minutes before)'], ['reminderLeadB', 'Second reminder (minutes, 0 = off)'], ['whatsappEnabled', 'WhatsApp on (1/0, needs env keys)'], ['verifiedBoost', 'Verified Discover boost (1/0)'], ['replayUploadMB', 'Replay upload cap (MB)'], ['seriesMax', 'Max occurrences per series']];
const numIn = (value, name) => h('input', { class: 'input', type: 'number', min: '0', step: '1', value: String(value), name });
function plansCard() {
  const out = h('div', { class: 'col', style: { gap: '1.1rem' } }, loading());
  const paint = ({ settings: s, defaults: d }) => {
    const inputs = [];
    const field = (path, label, value, def) => { const i = numIn(value, path); inputs.push(i); return h('label', { class: value !== def ? 'changed' : '' }, h('span', null, label, value !== def ? h('span', { class: 'muted' }, ` (default ${def})`) : null), i); };
    const grid = (...f) => h('div', { class: 'admin-plan-grid' }, ...f);
    const planBlocks = Object.keys(PLAN_LABEL).map((p) => sub(`plans-${p}`, PLAN_LABEL[p], grid(...FIELDS.filter(([k]) => p !== 'free' || !k.startsWith('price')).map(([k, l]) => field(`plans.${p}.${k}`, l, s.plans[p][k], d.plans[p][k])))));
    const weights = sub('plans-ai', 'AI point cost per use', grid(...Object.keys(s.aiWeights).map((k) => field(`aiWeights.${k}`, k, s.aiWeights[k], d.aiWeights[k]))));
    const other = sub('plans-addons', 'Short links & billing', grid(field('slugAddons.slug4', '4-character link (kobo)', s.slugAddons.slug4, d.slugAddons.slug4), field('slugAddons.slug3', '3-character link (kobo)', s.slugAddons.slug3, d.slugAddons.slug3),
      field('graceDays', 'Grace days after failed renewal', s.graceDays, d.graceDays), field('aiGuestPerIpDaily', 'Guest AI points per IP / day', s.aiGuestPerIpDaily, d.aiGuestPerIpDaily)));
    const features = sub('plans-features', 'Plan features (1 = on, 0 = off)', ...Object.keys(PLAN_LABEL).map((p) => h('div', { class: 'col', style: { gap: '.35rem' } }, h('strong', { class: 'small' }, PLAN_LABEL[p]), grid(...FEATURE_FIELDS.map(([k, l]) => field(`features.${p}.${k}`, l, s.features[p][k], d.features[p][k]))))));
    const platformBlock = sub('plans-platform', 'Tickets, promotions, payouts, reminders and replays', grid(...PLATFORM_FIELDS.map(([k, l]) => field(`platform.${k}`, l, s.platform[k], d.platform[k]))));
    const save = h('button', { class: 'btn primary', type: 'button' }, 'Save settings');
    const reset = h('button', { class: 'btn', type: 'button' }, 'Reset to env defaults');
    save.onclick = async () => {
      const patch = {};
      for (const i of inputs) { const keys = i.name.split('.'); let o = patch; for (const k of keys.slice(0, -1)) o = o[k] = o[k] || {}; o[keys[keys.length - 1]] = Number(i.value); }
      save.disabled = true;
      try { paint(await api('/api/admin/billing/settings', { method: 'PUT', body: patch })); toast('Plan settings saved', { icon: 'check' }); } catch (e) { toastErr(e); } finally { save.disabled = false; }
    };
    reset.onclick = async () => {
      if (!(await confirmDlg('Reset every plan limit and price to the env defaults?', { ok: 'Reset' }))) return;
      try { paint(await api('/api/admin/billing/settings', { method: 'DELETE' })); toast('Reset to defaults', { icon: 'check' }); } catch (e) { toastErr(e); }
    };
    out.replaceChildren(...planBlocks, weights, other, features, platformBlock, h('div', { class: 'admin-actions' }, reset, save));
  };
  api('/api/admin/billing/settings').then(paint).catch((e) => out.replaceChildren(h('p', { class: 'small' }, e.message || 'Could not load')));
  return section('plans', 'crown', 'Plans & limits', 'Saved in the database and live within 30 seconds, no redeploy. Env values are only the defaults. Prices are in kobo (₦1 = 100). Server ceilings MAX_AUDIENCE and MAX_PARTICIPANTS still apply.', out);
}

// ---------------------------------------------------------------- currency
function fxCard() {
  const out = h('div', { class: 'col', style: { gap: '.7rem' } }, loading());
  const paint = (r) => {
    const inputs = {};
    const grid = h('div', { class: 'admin-plan-grid' }, ...Object.keys(r.rates).filter((c) => c !== r.base).map((c) => {
      inputs[c] = h('input', { class: 'input', type: 'number', min: '0', step: 'any', value: String(r.rates[c]), name: c });
      return h('label', null, h('span', null, `1 ${r.base} → ${c}`, r.placeholder.includes(c) ? h('span', { class: 'fx-ph' }, ' placeholder') : null), inputs[c]);
    }));
    const save = h('button', { class: 'btn primary', type: 'button' }, 'Save rates');
    save.onclick = async () => { try { const rates = {}; for (const [c, i] of Object.entries(inputs)) rates[c] = Number(i.value); paint(await api('/api/admin/fx', { method: 'PUT', body: { rates } })); toast('Rates saved', { icon: 'check' }); } catch (e) { toastErr(e); } };
    const reset = h('button', { class: 'btn', type: 'button' }, 'Use env / placeholders');
    reset.onclick = async () => { try { paint(await api('/api/admin/fx', { method: 'DELETE' })); } catch (e) { toastErr(e); } };
    out.replaceChildren(...[h('p', { class: 'small' }, `Base ${r.base} · processing fee ${r.feePercent}% (PROCESSING_FEE_PERCENT)`),
      r.placeholder.length ? h('p', { class: 'small fx-warn', html: icon('alert', { size: 14 }) + ` Placeholder rates for ${r.placeholder.join(', ')}. Replace them with real rates before showing prices in those currencies.` }) : null,
      grid, h('div', { class: 'admin-actions' }, reset, save)].filter(Boolean));
  };
  api('/api/admin/fx').then(paint).catch((e) => out.replaceChildren(h('p', { class: 'small' }, e.message || 'Could not load')));
  return section('fx', 'globe', 'Currency & FX rates', 'How much 1 unit of the base currency is worth in each display currency. Saved values override FX_RATES; payments are still charged in the base currency.', out);
}

// ---------------------------------------------------------------- one user's plan, overrides and short-link tiers
const naira = (k) => '₦' + (Number(k || 0) / 100).toLocaleString('en-NG');
/** Total charged with its subtotal + processing-fee split (fee recorded per payment). */
const feeText = (p) => { const fee = p.feeKobo ?? p.processingFeeKobo ?? 0; const sub = p.subtotalKobo ?? p.priceKobo; return fee ? `${naira(p.priceKobo)} (${naira(sub)} + ${naira(fee)} fee ${p.feePercent}%)` : naira(p.priceKobo); };
function userPlanCard() {
  const q = h('input', { class: 'input', type: 'search', placeholder: 'Search by name, username or email…', 'aria-label': 'Find a user' });
  const detail = h('div', { class: 'col admin-detail', style: { gap: '.75rem' } }, emptyState('users', 'Pick someone above to see and change their plan.'));
  const pick = picker({
    input: q, label: 'Matching users',
    fetchItems: async (t) => (await api('/api/admin/billing/users?q=' + encodeURIComponent(t))).users.map((u) => ({ id: u.id, title: u.name || u.username || u.email, sub: [u.username ? '@' + u.username : null, u.email, PLAN_LABEL[u.plan] || u.plan, u.status].filter(Boolean).join(' · ') })),
    onPick: (it) => open(it.id, true),
  });
  async function open(id, spot = false) {
    const d = await api('/api/admin/billing/users/' + id).catch((e) => { toastErr(e); return null; });
    if (!d) return;
    const plan = h('select', { class: 'input' }, ...Object.keys(PLAN_LABEL).map((p) => h('option', { value: p, selected: p === d.plan }, PLAN_LABEL[p])));
    const until = h('input', { class: 'input', type: 'date' });
    const reason = h('input', { class: 'input', placeholder: 'Reason (required, kept in the audit log)' });
    const ov = {};
    const ovGrid = h('div', { class: 'admin-plan-grid' }, ...FIELDS.filter(([k]) => !k.startsWith('price')).map(([k, l]) => {
      const i = h('input', { class: 'input', type: 'number', min: '0', step: '1', placeholder: String(d.limits[k] ?? ''), value: d.overrides[k] != null ? String(d.overrides[k]) : '' });
      ov[k] = i; return h('label', null, h('span', null, l), i);
    }));
    const s = d.subscription;
    const savePlan = h('button', { class: 'btn primary', type: 'button' }, 'Save plan');
    savePlan.onclick = async () => {
      const overrides = {};
      for (const [k, i] of Object.entries(ov)) if (i.value !== '') overrides[k] = Number(i.value);
      try {
        await api('/api/admin/billing/users/' + id, { method: 'POST', body: { plan: plan.value, periodEnd: until.value ? new Date(until.value + 'T23:59:59Z').toISOString() : null, overrides: Object.keys(overrides).length ? overrides : null, reason: reason.value } });
        toast('Saved', { icon: 'check' }); open(id);
      } catch (e) { toastErr(e); }
    };
    const name = d.user.name || d.user.username || d.user.email;
    const headEl = h('div', { class: 'admin-picked-head' }, avatar(name),
      h('div', { class: 'grow min0' }, h('strong', null, name), h('div', { class: 'tiny muted' }, [d.user.username ? '@' + d.user.username : null, d.user.email].filter(Boolean).join(' · ')),
        h('div', { class: 'small' }, `${PLAN_LABEL[d.plan]}${s ? ` · ${s.status} (${s.source})${s.periodEnd ? ' until ' + new Date(s.periodEnd).toLocaleDateString() : ''}${s.graceUntil ? ' · grace until ' + new Date(s.graceUntil).toLocaleDateString() : ''}${s.card ? ' · card •••• ' + s.card.last4 : ''}` : ''}`)),
      h('span', { class: 'chip tiny on' }, PLAN_LABEL[d.plan]));
    detail.replaceChildren(...[headEl,
      h('div', { class: 'admin-plan-grid' }, h('label', null, h('span', null, 'Plan'), plan), h('label', null, h('span', null, 'Complimentary until (blank = no end)'), until)),
      h('strong', { class: 'small' }, 'Limit overrides (blank = plan default)'), ovGrid, reason, h('div', { class: 'admin-actions' }, savePlan),
      h('div', { class: 'row wrap admin-line' }, h('span', { class: 'small grow' }, 'Verified badge (Premium and up; boosts Discover ranking)'),
        h('button', { class: 'btn sm', type: 'button', onclick: async () => { try { await api('/api/admin/verified/' + id, { method: 'POST', body: { verified: true, note: reason.value } }); toast('Verified', { icon: 'check' }); } catch (e) { toastErr(e); } } }, 'Grant badge'),
        h('button', { class: 'btn sm', type: 'button', onclick: async () => { try { await api('/api/admin/verified/' + id, { method: 'POST', body: { verified: false, note: reason.value } }); toast('Badge removed', { icon: 'check' }); } catch (e) { toastErr(e); } } }, 'Remove badge')),
      d.venues.length ? h('strong', { class: 'small' }, 'Venues') : null,
      ...d.venues.map((v) => {
        const tier = h('select', { class: 'input' }, ...[['none', 'None'], ['slug4', '4-character'], ['slug3', '3-character']].map(([t, l]) => h('option', { value: t, selected: t === v.slugTier }, l)));
        const set = h('button', { class: 'btn sm', type: 'button', onclick: async () => {
          try { await api('/api/admin/billing/venues/' + v.id, { method: 'POST', body: { slugTier: tier.value, reason: reason.value } }); toast('Venue updated', { icon: 'check' }); open(id); } catch (e) { toastErr(e); }
        } }, 'Set tier');
        return h('div', { class: 'row wrap admin-line' }, h('span', { class: 'grow small' }, `${v.name} · /v/${v.slug}${v.reservedSlug ? ` (reserved /v/${v.reservedSlug})` : ''}${v.archived ? ' · archived' : ''}`), tier, set);
      }),
      d.payments.length ? h('strong', { class: 'small' }, 'Payments') : null,
      ...d.payments.map((p) => h('div', { class: 'tiny' }, `${p.kind} ${p.plan || p.slugTier || ''} · ${feeText(p)} · ${p.status} · ${new Date(p.createdAt).toLocaleString()}`)),
      d.creditPayments && d.creditPayments.length ? h('strong', { class: 'small' }, 'Credit purchases') : null,
      ...(d.creditPayments || []).map((p) => h('div', { class: 'tiny' }, `${p.credits} credits${p.source !== 'checkout' ? ' (' + p.source.replace(/_/g, ' ') + ')' : ''} · ${feeText(p)} · ${p.status} · ${new Date(p.createdAt).toLocaleString()}`)),
      d.audit.length ? h('strong', { class: 'small' }, 'Audit') : null,
      ...d.audit.map((a) => h('div', { class: 'tiny muted' }, `${new Date(a.at).toLocaleString()} · ${a.action}${a.detail ? ' · ' + JSON.stringify(a.detail) : ''}`))].filter(Boolean));
    if (spot) requestAnimationFrame(() => spotlight(headEl));
  }
  pick.run();
  return section('users', 'shield', 'User plans', 'Grant or remove a plan, set per-account limit overrides, or give a venue a short-link tier. Nothing here charges a card.', q, pick.el, detail);
}

// ---------------------------------------------------------------- promotions
const PLACES = [['discover', 'Discover'], ['feed', 'Feed'], ['venues', 'Venues'], ['books', 'Books']];
const STATUS_LABEL = { live: 'Live', scheduled: 'Scheduled', ended: 'Ended', paused: 'Paused' };
const dtLocal = (d) => { if (!d) return ''; const x = new Date(d); x.setMinutes(x.getMinutes() - x.getTimezoneOffset()); return x.toISOString().slice(0, 16); };
function promoCard() {
  let type = 'event', picked = null;
  const typeSel = h('select', { class: 'input admin-type', 'aria-label': 'Promote' }, h('option', { value: 'event' }, 'Event'), h('option', { value: 'post' }, 'Post'));
  const q = h('input', { class: 'input', type: 'search', placeholder: 'Search public events by title or host…', 'aria-label': 'Search what to promote' });
  const pickedEl = h('div', { class: 'admin-picked-head empty' }, h('span', { class: 'muted small' }, 'Nothing picked yet. Search above and pick an event or post.'));
  const starts = h('input', { class: 'input', type: 'datetime-local', value: dtLocal(new Date()), 'aria-label': 'Starts' });
  const ends = h('input', { class: 'input', type: 'datetime-local', value: dtLocal(Date.now() + 7 * 864e5), 'aria-label': 'Ends' });
  const boxes = PLACES.map(([v, l]) => { const c = h('input', { type: 'checkbox', value: v, checked: true }); return [c, h('label', { class: 'row small', style: { gap: '.35rem' } }, c, l)]; });
  const add = h('button', { class: 'btn primary', type: 'button', html: icon('plus', { size: 16 }) + 'Promote' });
  const setPicked = (it) => {
    picked = it;
    if (!it) { pickedEl.className = 'admin-picked-head empty'; pickedEl.replaceChildren(h('span', { class: 'muted small' }, 'Nothing picked yet. Search above and pick an event or post.')); return; }
    pickedEl.className = 'admin-picked-head';
    pickedEl.replaceChildren(h('span', { class: 'ico-tile', html: icon(type === 'post' ? 'sparkle' : 'calendar', { size: 18 }) }),
      h('div', { class: 'grow min0' }, h('span', { class: 'tiny muted' }, `Promoting this ${type}`), h('strong', { class: 'ellipsis' }, it.title), it.sub ? h('div', { class: 'tiny muted ellipsis' }, it.sub) : null),
      h('button', { class: 'btn sm ghost', type: 'button', onclick: () => { setPicked(null); pick.reset(); } }, 'Clear'));
  };
  const pick = picker({
    input: q, label: 'Matching events and posts',
    fetchItems: async (t) => (await api(`/api/admin/promotions/candidates?type=${type}&q=${encodeURIComponent(t)}`)).items,
    onPick: (it) => { setPicked(it); requestAnimationFrame(() => spotlight(pickedEl)); },
  });
  typeSel.onchange = () => { type = typeSel.value; setPicked(null); q.placeholder = type === 'post' ? 'Search posts by text or @username…' : 'Search public events by title or host…'; pick.run(); };
  add.onclick = async () => {
    if (!picked) return toast('Pick an event or post first', { icon: 'alert' });
    add.disabled = true;
    try {
      await api('/api/admin/promotions', { method: 'POST', body: { type, targetId: picked.id, startsAt: starts.value ? new Date(starts.value).toISOString() : null, endsAt: ends.value ? new Date(ends.value).toISOString() : null, placements: boxes.filter(([c]) => c.checked).map(([c]) => c.value) } });
      toast('Promotion added', { icon: 'check' }); setPicked(null); pick.reset(); current.reload(); pick.run();
    } catch (e) { toastErr(e); } finally { add.disabled = false; }
  };
  const current = currentPromotions();
  pick.run();
  return section('promotions', 'sparkle', 'Promotions', 'Shown as “Promoted” in the Discover, Feed, Venues and Books sidebars (3 per sidebar), and as one inline card on phones.',
    sub('promo-new', 'New promotion',
      h('div', { class: 'admin-search-row' }, typeSel, q), pick.el,
      pickedEl,
      h('div', { class: 'admin-plan-grid' }, h('label', null, h('span', null, 'Starts'), starts), h('label', null, h('span', null, 'Ends'), ends)),
      h('div', { class: 'row wrap', style: { gap: '.9rem' } }, ...boxes.map(([, l]) => l)),
      h('div', { class: 'admin-actions' }, add)),
    sub('promo-current', 'Current promotions', current.el));
}

/** Current promotions: search + filters, 5 at a time with "Show more", CSV export of every match. */
function currentPromotions() {
  const PAGE = 5;
  const q = h('input', { class: 'input', type: 'search', placeholder: 'Search title, host or author…', 'aria-label': 'Search promotions' });
  const status = h('select', { class: 'input', 'aria-label': 'Status' }, ...[['', 'Any status'], ['live', 'Live'], ['scheduled', 'Scheduled'], ['ended', 'Ended'], ['paused', 'Paused'], ['pending', 'Waiting for approval']].map(([v, l]) => h('option', { value: v }, l)));
  const type = h('select', { class: 'input', 'aria-label': 'Type' }, ...[['', 'Events and posts'], ['event', 'Events'], ['post', 'Posts']].map(([v, l]) => h('option', { value: v }, l)));
  const from = h('input', { class: 'input', type: 'date', 'aria-label': 'Starts from' });
  const to = h('input', { class: 'input', type: 'date', 'aria-label': 'Starts until' });
  const exportBtn = h('a', { class: 'btn primary sm', href: '#', download: '', html: icon('download', { size: 15 }) + 'Export CSV' });
  const count = h('span', { class: 'tiny muted' });
  const listEl = h('div', { class: 'col', style: { gap: '.5rem' } }, loading());
  const moreBtn = h('button', { class: 'btn sm', type: 'button', hidden: true }, 'Show 5 more');
  let offset = 0, total = 0, shown = 0, seq = 0, t;
  const params = () => { const p = new URLSearchParams(); if (q.value.trim()) p.set('q', q.value.trim()); if (status.value) p.set('status', status.value); if (type.value) p.set('type', type.value); if (from.value) p.set('from', from.value); if (to.value) p.set('to', to.value); return p; };
  const syncExport = () => { const p = params().toString(); exportBtn.href = '/api/admin/promotions/export.csv' + (p ? '?' + p : ''); };
  const row = (p) => {
    const ctr = p.views ? `${((p.clicks / p.views) * 100).toFixed(1)}%` : '–';
    const toggle = h('button', { class: 'btn sm', type: 'button' }, p.active ? 'Pause' : 'Resume');
    toggle.onclick = async () => { try { await api(`/api/admin/promotions/${p.id}`, { method: 'PATCH', body: { active: !p.active } }); reload(); } catch (e) { toastErr(e); } };
    const del = h('button', { class: 'btn sm ghost', type: 'button', 'aria-label': 'Delete promotion', html: icon('trash', { size: 15 }) });
    del.onclick = async () => { if (!(await confirmDlg('Delete this promotion? Its view and click counts go too.', { ok: 'Delete', danger: true }))) return; try { await api(`/api/admin/promotions/${p.id}`, { method: 'DELETE' }); reload(); } catch (e) { toastErr(e); } };
    return h('div', { class: 'admin-promo' },
      h('span', { class: `chip tiny admin-state ${p.state}` }, p.review === 'pending' ? 'Awaiting approval' : STATUS_LABEL[p.state] || p.state),
      h('div', { class: 'grow min0' }, h('strong', { class: 'small ellipsis' }, p.target.title || '(deleted)'),
        h('div', { class: 'tiny muted' }, `${p.type} · ${p.placements.join(', ')} · ${new Date(p.startsAt).toLocaleDateString()}${p.endsAt ? ' → ' + new Date(p.endsAt).toLocaleDateString() : ''}`)),
      h('span', { class: 'tiny admin-promo-stats' }, h('strong', null, String(p.views)), ' views · ', h('strong', null, String(p.clicks)), ` clicks · ${ctr}`),
      h('div', { class: 'row', style: { gap: '.35rem' } }, toggle, del));
  };
  async function load(append = false) {
    const my = ++seq; syncExport();
    const p = params(); p.set('limit', String(PAGE)); p.set('offset', String(append ? offset : 0));
    let r;
    try { r = await api('/api/admin/promotions?' + p); } catch (e) { if (my === seq) listEl.replaceChildren(h('p', { class: 'small' }, e.message || 'Could not load')); return; }
    if (my !== seq) return;
    total = r.total;
    if (!append) { listEl.replaceChildren(); shown = 0; }
    if (!r.promotions.length && !append) listEl.append(emptyState('sparkle', params().toString() ? 'No promotions match these filters.' : 'No promotions yet. Up to 3 show per sidebar, newest weight first.'));
    for (const x of r.promotions) listEl.append(row(x));
    shown += r.promotions.length; offset = shown;
    count.textContent = total ? `Showing ${shown} of ${total}` : '';
    moreBtn.hidden = shown >= total;
    moreBtn.textContent = `Show ${Math.min(PAGE, total - shown)} more`;
    exportBtn.classList.toggle('disabled', !total); exportBtn.setAttribute('aria-disabled', String(!total));
  }
  const reload = () => load(false);
  q.oninput = () => { clearTimeout(t); t = setTimeout(reload, 220); };
  for (const el of [status, type, from, to]) el.onchange = reload;
  moreBtn.onclick = () => load(true);
  exportBtn.onclick = (e) => { if (!total) e.preventDefault(); };
  reload();
  return {
    reload,
    el: h('div', { class: 'col', style: { gap: '.7rem' } },
      h('div', { class: 'admin-filters' }, h('div', { class: 'admin-filter-q' }, q), status, type,
        h('label', { class: 'admin-date' }, h('span', { class: 'tiny muted' }, 'From'), from), h('label', { class: 'admin-date' }, h('span', { class: 'tiny muted' }, 'To'), to), exportBtn),
      listEl, h('div', { class: 'row', style: { gap: '.6rem', alignItems: 'center' } }, count, h('span', { class: 'grow' }), moreBtn)),
  };
}

// ---------------------------------------------------------------- self-serve promotions review, payouts and refunds
function commerceCard() {
  const review = h('div', { class: 'col', style: { gap: '.5rem' } }, loading());
  const payouts = h('div', { class: 'col', style: { gap: '.6rem' } }, loading());
  const payments = h('div', { class: 'col', style: { gap: '.35rem' } }, loading());
  const act = (fn) => async (e) => { e.currentTarget.disabled = true; try { await fn(); toast('Saved', { icon: 'check' }); await load(); } catch (err) { toastErr(err); e.currentTarget.disabled = false; } };
  async function load() {
    const [pr, po, pay] = await Promise.all([api('/api/admin/promotions'), api('/api/admin/payouts?status=requested'), api('/api/admin/commerce/payments')]);
    const pending = pr.promotions.filter((p) => p.review === 'pending');
    review.replaceChildren(...(pending.length ? pending.map((p) => h('div', { class: 'row wrap admin-line' }, h('span', { class: 'grow small' }, `${p.target.title} · ${p.days || '?'} days`),
      h('button', { class: 'btn sm primary', type: 'button', onclick: act(() => api(`/api/admin/promotions/${p.id}/review`, { method: 'POST', body: { decision: 'approve' } })) }, 'Approve'),
      h('button', { class: 'btn sm', type: 'button', onclick: act(() => api(`/api/admin/promotions/${p.id}/review`, { method: 'POST', body: { decision: 'reject' } })) }, 'Reject'))) : [emptyState('check', 'No paid promotions waiting for approval.')]));
    payouts.replaceChildren(...(po.payouts.length ? po.payouts.map((p) => {
      const ref = h('input', { class: 'input', placeholder: 'Transfer reference' });
      return h('div', { class: 'col admin-line', style: { gap: '.35rem' } }, h('span', { class: 'small' }, `${naira(p.amountKobo)} to ${p.username || p.email || 'host ' + p.hostUserId} · ${p.bankDetails || ''}`),
        h('div', { class: 'row wrap', style: { gap: '.5rem' } }, ref,
          h('button', { class: 'btn sm primary', type: 'button', onclick: act(() => api(`/api/admin/payouts/${p.id}`, { method: 'POST', body: { action: 'paid', reference: ref.value } })) }, 'Mark paid'),
          h('button', { class: 'btn sm', type: 'button', onclick: act(() => api(`/api/admin/payouts/${p.id}`, { method: 'POST', body: { action: 'rejected', note: ref.value } })) }, 'Reject')));
    }) : [emptyState('check', 'No payout requests.')]));
    payments.replaceChildren(...(pay.payments.length ? pay.payments.slice(0, 40).map((p) => h('div', { class: 'row wrap admin-line' },
      h('span', { class: 'grow tiny' }, `${p.kind} · ${feeText(p)} · ${p.status}${p.refunded ? ' · refunded' : ''}${p.error ? ' · ' + p.error : ''} · ${p.payer || ''} · ${p.event || ''} · ${new Date(p.createdAt).toLocaleString()}`),
      ['paid', 'review'].includes(p.status) && !p.refunded ? h('button', { class: 'btn sm', type: 'button', onclick: act(async () => { if (await confirmDlg(`Mark ${naira(p.priceKobo)} as refunded? Refund the buyer in Paystack first. Tickets are cancelled and the host balance is reduced.`, { ok: 'Mark refunded' })) await api(`/api/admin/commerce/payments/${p.reference}/refund`, { method: 'POST', body: {} }); }) }, 'Mark refunded') : null)) : [emptyState('creditCard', 'No ticket, gift or promotion payments yet.')]));
  }
  load().catch((e) => review.replaceChildren(h('p', { class: 'small' }, e.message || 'Could not load')));
  return section('commerce', 'creditCard', 'Reviews, payouts & refunds', 'Payouts and refunds are done outside 1venue (bank transfer or the Paystack dashboard). Mark them here once done so the host ledger stays right.',
    sub('commerce-review', 'Paid promotions waiting for approval', review), sub('commerce-payouts', 'Payout requests', payouts), sub('commerce-payments', 'Recent ticket, gift and promotion payments', payments));
}

// ---------------------------------------------------------------- message reports (Messages: block and report)
function reportsCard() {
  let status = 'open';
  const out = h('div', { class: 'col', style: { gap: '.6rem' } }, loading());
  const seg = h('div', { class: 'seg' });
  const act = (id, st) => async (e) => { e.currentTarget.disabled = true; try { await api(`/api/admin/message-reports/${id}`, { method: 'POST', body: { status: st } }); toast('Saved', { icon: 'check' }); await load(); } catch (err) { toastErr(err); } };
  async function load() {
    seg.replaceChildren(...[['open', 'Open'], ['actioned', 'Actioned'], ['dismissed', 'Dismissed'], ['all', 'All']].map(([k, l]) => h('button', { type: 'button', class: status === k ? 'on' : '', onclick: () => { status = k; load(); } }, l)));
    const r = await api(`/api/admin/message-reports?status=${status}`);
    if (!r.reports.length) { out.replaceChildren(emptyState('check', 'Nothing here.')); return; }
    out.replaceChildren(...r.reports.map((x) => h('div', { class: 'col admin-line', style: { gap: '.3rem' } },
      h('span', { class: 'small' }, h('strong', null, x.reportedName || x.reported || 'Deleted user'), ` reported by @${x.reporter || 'deleted'} · ${new Date(x.createdAt).toLocaleString()} · ${x.status}`),
      x.reason ? h('span', { class: 'small' }, `Reason: ${x.reason}`) : null,
      x.text || x.attachmentUrl ? h('blockquote', { class: 'small muted admin-quote' }, x.text || '', x.attachmentUrl ? h('a', { href: x.attachmentUrl, target: '_blank', rel: 'noopener' }, ' attachment') : null) : null,
      h('div', { class: 'row wrap', style: { gap: '.5rem' } },
        x.reportedUserId ? h('a', { class: 'btn sm', href: `/u/${x.reportedUserId}`, 'data-link': '' }, 'Profile') : null,
        x.status !== 'actioned' ? h('button', { class: 'btn sm primary', type: 'button', onclick: act(x.id, 'actioned') }, 'Mark actioned') : null,
        x.status !== 'dismissed' ? h('button', { class: 'btn sm', type: 'button', onclick: act(x.id, 'dismissed') }, 'Dismiss') : null,
        x.status !== 'open' ? h('button', { class: 'btn sm ghost', type: 'button', onclick: act(x.id, 'open') }, 'Reopen') : null))));
  }
  load().catch((e) => out.replaceChildren(h('p', { class: 'small' }, e.message || 'Could not load')));
  return section('reports', 'alert', 'Message reports', 'Reports from Messages. The reported text is a snapshot taken when it was reported, so it stays even if the sender deletes it.', seg, out);
}

// ---------------------------------------------------------------- read-out self-test
const SAMPLES = [['ig', 'Igbo', 'Ndewo. Nnọọ na 1venue.'], ['ha', 'Hausa', 'Sannu. Barka da zuwa 1venue.'], ['ar', 'Arabic', 'مرحبا بكم في ون فينيو.'], ['en', 'English', 'Welcome to 1venue.']];
function ttsCard() {
  const out = h('div', { class: 'col', style: { gap: '.4rem' } }, h('p', { class: 'tiny muted' }, 'Checking…'));
  (async () => {
    const [cfg, voices] = await Promise.all([api('/api/tts/config').catch(() => ({ enabled: false, languages: [] })), new Promise((r) => {
      const read = () => (window.speechSynthesis?.getVoices() || []).map((v) => v.lang.toLowerCase().replace('_', '-'));
      if (read().length) return r(read());
      window.speechSynthesis?.addEventListener?.('voiceschanged', () => r(read()), { once: true }); setTimeout(() => r(read()), 1500);
    })]);
    out.replaceChildren(h('p', { class: 'small' }, `Cloud: ${cfg.enabled ? `on (${cfg.model}) for ${cfg.languages.join(', ')}` : 'off: REPLICATE_API_TOKEN is not set'}`));
    for (const [code, label, text] of SAMPLES) {
      const local = voices.some((v) => v.split('-')[0] === code);
      const cloud = cfg.enabled && cfg.languages.includes(code);
      const status = h('span', { class: 'tiny muted grow' }, local ? 'device voice' : cloud ? 'cloud voice' : 'no voice (icon hidden)');
      const btn = h('button', { class: 'btn sm', type: 'button', disabled: !cloud }, 'Test cloud');
      btn.onclick = async () => {
        btn.disabled = true; status.textContent = 'Generating…';
        try {
          const t0 = performance.now();
          const r = await api('/api/tts', { method: 'POST', body: { text, lang: code } });
          await new Audio(r.url).play();
          status.textContent = `✓ cloud works (${r.cached ? 'cached' : `${Math.round((performance.now() - t0) / 100) / 10}s`})`;
        } catch (e) { status.textContent = `✗ ${e.message || 'failed'}`; } finally { btn.disabled = false; }
      };
      out.append(h('div', { class: 'row admin-line', style: { gap: '.6rem' } }, h('strong', { style: { minWidth: '5.5rem' } }, label), status, btn));
    }
  })();
  return section('tts', 'volume', 'Read-out check', 'Device voice is used when this device has one; otherwise the cloud voice.', out);
}
