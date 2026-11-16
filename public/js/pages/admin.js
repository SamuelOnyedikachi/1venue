// /admin: site admin tools (admins = confirmed emails in ADMIN_EMAILS). Demo data, plan settings, user plans, promotions.
import { icon } from '../icons.js';
import { h, api, toast, toastErr, avatar, confirmDlg } from '../ui.js';
import { state, requireLogin } from '../app.js';

export async function mount(view) {
  if (!requireLogin('Sign in to continue')) return;
  view.append(h('div', { class: 'page-head' }, h('h1', { html: `<span class="ico-tile" data-group="admin">${icon('shield', { size: 20 })}</span> Admin` })));
  if (!state.user.isAdmin) {
    view.append(h('div', { class: 'card pad' }, h('h3', null, 'Admins only'),
      h('p', { class: 'muted small' }, 'Add your email to ADMIN_EMAILS in Coolify, redeploy, and confirm your email (Google sign-in counts).')));
    return;
  }
  const body = h('div', { class: 'col', style: { gap: '.8rem' } });
  const card = h('section', { class: 'card pad col', style: { gap: '.9rem' } },
    h('div', { class: 'row', style: { gap: '.6rem' } }, h('span', { class: 'ico-tile', 'data-group': 'people', html: icon('users', { size: 18 }) }),
      h('div', { class: 'grow' }, h('h3', null, 'Demo data'), h('p', { class: 'muted small' }, '10 sample accounts with events, posts, sessions and more. Remove it all in one click.'))),
    body);
  view.append(card);

  const load = h('button', { class: 'btn primary', type: 'button', html: icon('plus', { size: 16 }) + 'Load demo data' });
  const remove = h('button', { class: 'btn danger', type: 'button', html: icon('trash', { size: 16 }) + 'Remove demo data' });
  const busy = (on) => { load.disabled = on; remove.disabled = on; };
  function paint(s) {
    const stats = h('div', { class: 'row wrap small', style: { gap: '1.2rem' } },
      ...[['Accounts', s.users], ['Events', s.events], ['Posts', s.posts], ['Sessions', s.sessions]].map(([l, n]) => h('span', null, h('strong', null, String(n || 0)), ' ', l.toLowerCase())));
    load.lastChild.textContent = s.loaded ? 'Reload demo data' : 'Load demo data';
    remove.hidden = !s.loaded;
    body.replaceChildren(stats,
      s.loaded ? h('p', { class: 'small' }, 'Sign in as any demo account with password ', h('code', null, s.password), '.') : null,
      s.loaded ? h('div', { class: 'admin-seed-people' }, ...s.accounts.map((a) => h('a', { class: 'list-item', href: `/u/${a.username}`, 'data-link': '' }, avatar(a.name, a.avatarUrl),
        h('div', { class: 'grow' }, h('strong', null, a.name), h('div', { class: 'tiny muted' }, `@${a.username} · ${a.email}`))))) : null,
      h('div', { class: 'row wrap', style: { gap: '.5rem' } }, load, remove));
  }
  const refresh = async () => paint(await api('/api/admin/seed'));
  load.onclick = async () => {
    busy(true);
    try { const r = await api('/api/admin/seed', { method: 'POST' }); paint(r); toast('Demo data loaded', { icon: 'check' }); } catch (e) { toastErr(e); } finally { busy(false); }
  };
  remove.onclick = async () => {
    if (!(await confirmDlg('Remove every demo account and everything they created? Real accounts are not affected.', { ok: 'Remove demo data', danger: true }))) return;
    busy(true);
    try { const r = await api('/api/admin/seed', { method: 'DELETE' }); paint(r); toast('Demo data removed', { icon: 'check' }); } catch (e) { toastErr(e); } finally { busy(false); }
  };
  view.append(plansCard(), userPlanCard(), promoCard(), commerceCard(), ttsCard());
  body.append(h('p', { class: 'tiny muted' }, 'Loading…'));
  await refresh().catch((e) => body.replaceChildren(h('p', { class: 'small' }, e.message || 'Could not load')));
}

// Read-out self-test: which engine each language uses on THIS device, and a real cloud clip.
const SAMPLES = [['ig', 'Igbo', 'Ndewo. Nnọọ na 1venue.'], ['ha', 'Hausa', 'Sannu. Barka da zuwa 1venue.'], ['ar', 'Arabic', 'مرحبا بكم في ون فينيو.'], ['en', 'English', 'Welcome to 1venue.']];
function ttsCard() {
  const out = h('div', { class: 'col', style: { gap: '.4rem' } }, h('p', { class: 'tiny muted' }, 'Checking…'));
  const card = h('section', { class: 'card pad col', style: { gap: '.8rem', marginTop: '1rem' } },
    h('div', { class: 'row', style: { gap: '.6rem' } }, h('span', { class: 'ico-tile', 'data-group': 'media', html: icon('volume', { size: 18 }) }),
      h('div', { class: 'grow' }, h('h3', null, 'Read-out check'), h('p', { class: 'muted small' }, 'Device voice is used when this device has one; otherwise the cloud voice.'))), out);
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
      out.append(h('div', { class: 'row', style: { gap: '.6rem' } }, h('strong', { style: { minWidth: '5.5rem' } }, label), status, btn));
    }
  })();
  return card;
}

// Promotions: pick public events / posts to show as "Promoted" in the Discover, Feed, Venues and Books sidebars.
const PLACES = [['discover', 'Discover'], ['feed', 'Feed'], ['venues', 'Venues'], ['books', 'Books']];
const dtLocal = (d) => { if (!d) return ''; const x = new Date(d); x.setMinutes(x.getMinutes() - x.getTimezoneOffset()); return x.toISOString().slice(0, 16); };
function promoCard() {
  const listEl = h('div', { class: 'col', style: { gap: '.5rem' } }, h('p', { class: 'tiny muted' }, 'Loading…'));
  let type = 'event', picked = null;
  const typeSel = h('select', { class: 'input', 'aria-label': 'Promote' }, h('option', { value: 'event' }, 'Event'), h('option', { value: 'post' }, 'Post'));
  const q = h('input', { class: 'input', type: 'search', placeholder: 'Search public events by title or host…', 'aria-label': 'Search what to promote' });
  const results = h('div', { class: 'col promo-pick', style: { gap: '4px' } });
  const pickedEl = h('div', { class: 'small muted' }, 'Nothing picked yet');
  const starts = h('input', { class: 'input', type: 'datetime-local', value: dtLocal(new Date()), 'aria-label': 'Starts' });
  const ends = h('input', { class: 'input', type: 'datetime-local', value: dtLocal(Date.now() + 7 * 864e5), 'aria-label': 'Ends' });
  const boxes = PLACES.map(([v, l]) => { const c = h('input', { type: 'checkbox', value: v, checked: true }); return [c, h('label', { class: 'row small', style: { gap: '.35rem' } }, c, l)]; });
  const add = h('button', { class: 'btn primary', type: 'button', html: icon('plus', { size: 16 }) + 'Promote' });
  const search = async () => {
    try {
      const r = await api(`/api/admin/promotions/candidates?type=${type}&q=${encodeURIComponent(q.value.trim())}`);
      results.replaceChildren(...(r.items.length ? r.items.map((it) => h('button', { type: 'button', class: `list-item${picked && picked.id === it.id ? ' on' : ''}`, onclick: () => { picked = it; pickedEl.textContent = `Picked: ${it.title}`; search(); } },
        h('div', { class: 'grow' }, h('strong', { class: 'small' }, it.title), h('div', { class: 'tiny muted' }, it.sub)))) : [h('p', { class: 'tiny muted' }, 'No matches')]));
    } catch (e) { results.replaceChildren(h('p', { class: 'tiny muted' }, e.message)); }
  };
  let t; q.oninput = () => { clearTimeout(t); t = setTimeout(search, 250); };
  typeSel.onchange = () => { type = typeSel.value; picked = null; pickedEl.textContent = 'Nothing picked yet'; q.placeholder = type === 'post' ? 'Search posts by text or @username…' : 'Search public events by title or host…'; search(); };
  add.onclick = async () => {
    if (!picked) return toast('Pick an event or post first', { icon: 'alert' });
    add.disabled = true;
    try {
      await api('/api/admin/promotions', { method: 'POST', body: { type, targetId: picked.id, startsAt: starts.value ? new Date(starts.value).toISOString() : null, endsAt: ends.value ? new Date(ends.value).toISOString() : null, placements: boxes.filter(([c]) => c.checked).map(([c]) => c.value) } });
      toast('Promotion added', { icon: 'check' }); picked = null; pickedEl.textContent = 'Nothing picked yet'; refresh(); search();
    } catch (e) { toastErr(e); } finally { add.disabled = false; }
  };
  const refresh = async () => {
    try {
      const { promotions } = await api('/api/admin/promotions');
      listEl.replaceChildren(...(promotions.length ? promotions.map((p) => {
        const ctr = p.views ? `${((p.clicks / p.views) * 100).toFixed(1)}%` : '–';
        const toggle = h('button', { class: 'btn sm', type: 'button' }, p.active ? 'Pause' : 'Resume');
        toggle.onclick = async () => { try { await api(`/api/admin/promotions/${p.id}`, { method: 'PATCH', body: { active: !p.active } }); refresh(); } catch (e) { toastErr(e); } };
        const del = h('button', { class: 'btn sm ghost', type: 'button', 'aria-label': 'Delete promotion', html: icon('trash', { size: 15 }) });
        del.onclick = async () => { if (!(await confirmDlg('Delete this promotion? Its view and click counts go too.', { ok: 'Delete', danger: true }))) return; try { await api(`/api/admin/promotions/${p.id}`, { method: 'DELETE' }); refresh(); } catch (e) { toastErr(e); } };
        return h('div', { class: 'card pad row wrap', style: { gap: '.6rem' } },
          h('span', { class: `chip tiny${p.live ? ' on' : ''}` }, p.live ? 'Live' : p.active ? 'Scheduled / ended' : 'Paused'),
          h('div', { class: 'grow' }, h('strong', { class: 'small' }, p.target.title || '(deleted)'),
            h('div', { class: 'tiny muted' }, `${p.type} · ${p.placements.join(', ')} · ${new Date(p.startsAt).toLocaleDateString()}${p.endsAt ? ' → ' + new Date(p.endsAt).toLocaleDateString() : ''}`)),
          h('span', { class: 'tiny' }, h('strong', null, String(p.views)), ' views · ', h('strong', null, String(p.clicks)), ` clicks · ${ctr}`),
          toggle, del);
      }) : [h('p', { class: 'tiny muted' }, 'No promotions yet. Up to 3 show per sidebar, newest weight first.')]));
    } catch (e) { listEl.replaceChildren(h('p', { class: 'small' }, e.message || 'Could not load')); }
  };
  refresh(); search();
  return h('section', { class: 'card pad col', style: { gap: '.8rem', marginTop: '1rem' } },
    h('div', { class: 'row', style: { gap: '.6rem' } }, h('span', { class: 'ico-tile', 'data-group': 'engage', html: icon('sparkle', { size: 18 }) }),
      h('div', { class: 'grow' }, h('h3', null, 'Promotions'), h('p', { class: 'muted small' }, 'Shown as “Promoted” in the Discover, Feed, Venues and Books sidebars (3 per sidebar), and as one inline card on phones.'))),
    h('div', { class: 'row wrap', style: { gap: '.5rem' } }, typeSel, h('div', { class: 'grow', style: { minWidth: '220px' } }, q)),
    results, pickedEl,
    h('div', { class: 'row wrap', style: { gap: '.6rem' } }, h('label', { class: 'col tiny', style: { gap: '.2rem' } }, 'Starts', starts), h('label', { class: 'col tiny', style: { gap: '.2rem' } }, 'Ends', ends)),
    h('div', { class: 'row wrap', style: { gap: '.9rem' } }, ...boxes.map(([, l]) => l)),
    h('div', null, add),
    h('h4', { class: 'small', style: { marginTop: '.4rem' } }, 'Current promotions'), listEl);
}

// ---------------------------------------------------------------- plans: limits, prices, AI weights (app_settings)
const PLAN_LABEL = { free: 'Free', premium: 'Premium', organisation: 'Organisation' };
const FIELDS = [['venues', 'Venues'], ['audience', 'Stage audience'], ['meeting', 'Meeting size'], ['speakerSeats', 'Speaker seats'], ['aiDaily', 'AI points / day'], ['uploadMB', 'Uploads (MB)'], ['priceMonthKobo', 'Monthly (kobo)'], ['priceYearKobo', 'Annual (kobo)']];
const FEATURE_FIELDS = [['branding', 'Branding'], ['recurring', 'Recurring'], ['reminders', 'Reminders'], ['whatsapp', 'WhatsApp reminders'], ['exports', 'Exports'], ['analytics', 'Analytics'], ['badge', 'Verified badge eligible'], ['selfPromo', 'Self-serve promotions'], ['ticketing', 'Tickets & donations'], ['replays', 'Cloud replays'], ['orgMembers', 'Org members (0 = no org)'], ['replayMB', 'Replay storage (MB)']];
const PLATFORM_FIELDS = [['feeBps', 'Platform fee (basis points, 500 = 5%)'], ['promoDayKobo', 'Promotion price per day (kobo)'], ['promoMaxDays', 'Promotion max days'], ['promoApproval', 'Approve promotions first (1/0)'], ['payoutMinKobo', 'Minimum payout (kobo)'], ['ticketMaxPerOrder', 'Tickets per order'], ['donationMinKobo', 'Minimum gift (kobo)'], ['reminderLeadA', 'First reminder (minutes before)'], ['reminderLeadB', 'Second reminder (minutes, 0 = off)'], ['whatsappEnabled', 'WhatsApp on (1/0, needs env keys)'], ['verifiedBoost', 'Verified Discover boost (1/0)'], ['replayUploadMB', 'Replay upload cap (MB)'], ['seriesMax', 'Max occurrences per series']];
const numIn = (value, name) => h('input', { class: 'input', type: 'number', min: '0', step: '1', value: String(value), name });
function plansCard() {
  const out = h('div', { class: 'col', style: { gap: '.8rem' } }, h('p', { class: 'tiny muted' }, 'Loading…'));
  const card = h('section', { class: 'card pad col', style: { gap: '.8rem', marginTop: '1rem' } },
    h('div', { class: 'row', style: { gap: '.6rem' } }, h('span', { class: 'ico-tile', 'data-group': 'settings', html: icon('crown', { size: 18 }) }),
      h('div', { class: 'grow' }, h('h3', null, 'Plans, limits and prices'), h('p', { class: 'muted small' }, 'Saved in the database and live within 30 seconds, no redeploy. Env values are only the defaults. Prices are in kobo (₦1 = 100). Server ceilings MAX_AUDIENCE and MAX_PARTICIPANTS still apply.'))), out);
  const paint = ({ settings: s, defaults: d }) => {
    const inputs = [];
    const field = (path, label, value, def) => { const i = numIn(value, path); inputs.push(i); return h('label', null, h('span', null, label, value !== def ? h('span', { class: 'muted' }, ` (default ${def})`) : null), i); };
    const planBlocks = Object.keys(PLAN_LABEL).map((p) => h('div', { class: 'col', style: { gap: '.3rem' } }, h('strong', null, PLAN_LABEL[p]),
      h('div', { class: 'admin-plan-grid' }, ...FIELDS.filter(([k]) => p !== 'free' || !k.startsWith('price')).map(([k, l]) => field(`plans.${p}.${k}`, l, s.plans[p][k], d.plans[p][k])))));
    const weights = h('div', { class: 'col', style: { gap: '.3rem' } }, h('strong', null, 'AI point cost per use'),
      h('div', { class: 'admin-plan-grid' }, ...Object.keys(s.aiWeights).map((k) => field(`aiWeights.${k}`, k, s.aiWeights[k], d.aiWeights[k]))));
    const other = h('div', { class: 'col', style: { gap: '.3rem' } }, h('strong', null, 'Add-ons and billing'),
      h('div', { class: 'admin-plan-grid' }, field('slugAddons.slug3', 'slug3 link (kobo)', s.slugAddons.slug3, d.slugAddons.slug3), field('slugAddons.slug2', 'slug2 link (kobo)', s.slugAddons.slug2, d.slugAddons.slug2),
        field('graceDays', 'Grace days after failed renewal', s.graceDays, d.graceDays), field('aiGuestPerIpDaily', 'Guest AI points per IP / day', s.aiGuestPerIpDaily, d.aiGuestPerIpDaily)));
    const featureBlocks = Object.keys(PLAN_LABEL).map((p) => h('div', { class: 'col', style: { gap: '.3rem' } }, h('strong', null, `${PLAN_LABEL[p]} features (1 = on, 0 = off)`),
      h('div', { class: 'admin-plan-grid' }, ...FEATURE_FIELDS.map(([k, l]) => field(`features.${p}.${k}`, l, s.features[p][k], d.features[p][k])))));
    const platformBlock = h('div', { class: 'col', style: { gap: '.3rem' } }, h('strong', null, 'Tickets, promotions, payouts, reminders and replays'),
      h('div', { class: 'admin-plan-grid' }, ...PLATFORM_FIELDS.map(([k, l]) => field(`platform.${k}`, l, s.platform[k], d.platform[k]))));
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
    out.replaceChildren(...planBlocks, weights, other, ...featureBlocks, platformBlock, h('div', { class: 'row wrap', style: { gap: '.5rem' } }, save, reset));
  };
  api('/api/admin/billing/settings').then(paint).catch((e) => out.replaceChildren(h('p', { class: 'small' }, e.message || 'Could not load')));
  return card;
}

// ---------------------------------------------------------------- one user's plan, overrides and short-link tiers
function userPlanCard() {
  const q = h('input', { class: 'input', type: 'search', placeholder: 'Search email, username or name' });
  const results = h('div', { class: 'col', style: { gap: '.3rem' } });
  const detail = h('div', { class: 'col', style: { gap: '.6rem' } });
  const card = h('section', { class: 'card pad col', style: { gap: '.8rem', marginTop: '1rem' } },
    h('div', { class: 'row', style: { gap: '.6rem' } }, h('span', { class: 'ico-tile', 'data-group': 'people', html: icon('users', { size: 18 }) }),
      h('div', { class: 'grow' }, h('h3', null, 'User plans'), h('p', { class: 'muted small' }, 'Grant or remove a plan, set per-account limit overrides, or give a venue a short-link tier. Nothing here charges a card.'))),
    q, results, detail);
  let timer;
  q.oninput = () => { clearTimeout(timer); timer = setTimeout(search, 250); };
  async function search() {
    try {
      const r = await api('/api/admin/billing/users?q=' + encodeURIComponent(q.value));
      results.replaceChildren(...r.users.map((u) => h('button', { class: 'list-item', type: 'button', onclick: () => open(u.id) },
        h('div', { class: 'grow' }, h('strong', null, u.name || u.username || u.email), h('div', { class: 'tiny muted' }, `${u.email || ''} · ${PLAN_LABEL[u.plan] || u.plan}${u.status ? ' · ' + u.status : ''}`)))));
    } catch (e) { toastErr(e); }
  }
  async function open(id) {
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
    detail.replaceChildren(
      h('h3', null, d.user.name || d.user.username || d.user.email),
      h('p', { class: 'small' }, `${PLAN_LABEL[d.plan]}${s ? ` · ${s.status} (${s.source})${s.periodEnd ? ' until ' + new Date(s.periodEnd).toLocaleDateString() : ''}${s.graceUntil ? ' · grace until ' + new Date(s.graceUntil).toLocaleDateString() : ''}${s.card ? ' · card •••• ' + s.card.last4 : ''}` : ''}`),
      h('div', { class: 'admin-plan-grid' }, h('label', null, h('span', null, 'Plan'), plan), h('label', null, h('span', null, 'Complimentary until (blank = no end)'), until)),
      h('strong', { class: 'small' }, 'Limit overrides (blank = plan default)'), ovGrid, reason, savePlan,
      h('div', { class: 'row wrap', style: { gap: '.5rem' } }, h('span', { class: 'small grow' }, 'Verified badge (Premium and up; boosts Discover ranking)'),
        h('button', { class: 'btn sm', type: 'button', onclick: async () => { try { await api('/api/admin/verified/' + id, { method: 'POST', body: { verified: true, note: reason.value } }); toast('Verified', { icon: 'check' }); } catch (e) { toastErr(e); } } }, 'Grant badge'),
        h('button', { class: 'btn sm', type: 'button', onclick: async () => { try { await api('/api/admin/verified/' + id, { method: 'POST', body: { verified: false, note: reason.value } }); toast('Badge removed', { icon: 'check' }); } catch (e) { toastErr(e); } } }, 'Remove badge')),
      d.venues.length ? h('strong', { class: 'small' }, 'Venues') : null,
      ...d.venues.map((v) => {
        const tier = h('select', { class: 'input' }, ...['none', 'slug3', 'slug2'].map((t) => h('option', { value: t, selected: t === v.slugTier }, t)));
        const set = h('button', { class: 'btn sm', type: 'button', onclick: async () => {
          try { await api('/api/admin/billing/venues/' + v.id, { method: 'POST', body: { slugTier: tier.value, reason: reason.value } }); toast('Venue updated', { icon: 'check' }); open(id); } catch (e) { toastErr(e); }
        } }, 'Set tier');
        return h('div', { class: 'row wrap', style: { gap: '.5rem' } }, h('span', { class: 'grow small' }, `${v.name} · /v/${v.slug}${v.reservedSlug ? ` (reserved /v/${v.reservedSlug})` : ''}${v.archived ? ' · archived' : ''}`), tier, set);
      }),
      d.payments.length ? h('strong', { class: 'small' }, 'Payments') : null,
      ...d.payments.map((p) => h('div', { class: 'tiny' }, `${p.kind} ${p.plan || p.slugTier || ''} · ₦${(p.priceKobo / 100).toLocaleString()} · ${p.status} · ${new Date(p.createdAt).toLocaleString()}`)),
      d.audit.length ? h('strong', { class: 'small' }, 'Audit') : null,
      ...d.audit.map((a) => h('div', { class: 'tiny muted' }, `${new Date(a.at).toLocaleString()} · ${a.action}${a.detail ? ' · ' + JSON.stringify(a.detail) : ''}`)));
  }
  search();
  return card;
}

// ---------------------------------------------------------------- self-serve promotions review, payouts and refunds
const naira = (k) => '₦' + (Number(k || 0) / 100).toLocaleString('en-NG');
function commerceCard() {
  const out = h('div', { class: 'col', style: { gap: '.6rem' } }, h('p', { class: 'tiny muted' }, 'Loading…'));
  const card = h('section', { class: 'card pad col', style: { gap: '.8rem', marginTop: '1rem' } },
    h('div', { class: 'row', style: { gap: '.6rem' } }, h('span', { class: 'ico-tile', 'data-group': 'settings', html: icon('creditCard', { size: 18 }) }),
      h('div', { class: 'grow' }, h('h3', null, 'Promotions to review, payouts and refunds'), h('p', { class: 'muted small' }, 'Payouts and refunds are done outside 1venue (bank transfer or the Paystack dashboard). Mark them here once done so the host ledger stays right.'))), out);
  const act = (fn) => async (e) => { e.currentTarget.disabled = true; try { await fn(); toast('Saved', { icon: 'check' }); await load(); } catch (err) { toastErr(err); e.currentTarget.disabled = false; } };
  async function load() {
    const [pr, po, pay] = await Promise.all([api('/api/admin/promotions'), api('/api/admin/payouts?status=requested'), api('/api/admin/commerce/payments')]);
    const pending = pr.promotions.filter((p) => p.review === 'pending');
    out.replaceChildren(
      h('strong', { class: 'small' }, `Paid promotions waiting for approval (${pending.length})`),
      ...pending.map((p) => h('div', { class: 'row wrap', style: { gap: '.5rem' } }, h('span', { class: 'grow small' }, `${p.target.title} · ${p.days || '?'} days`),
        h('button', { class: 'btn sm primary', type: 'button', onclick: act(() => api(`/api/admin/promotions/${p.id}/review`, { method: 'POST', body: { decision: 'approve' } })) }, 'Approve'),
        h('button', { class: 'btn sm', type: 'button', onclick: act(() => api(`/api/admin/promotions/${p.id}/review`, { method: 'POST', body: { decision: 'reject' } })) }, 'Reject'))),
      h('strong', { class: 'small' }, `Payout requests (${po.payouts.length})`),
      ...po.payouts.map((p) => {
        const ref = h('input', { class: 'input', placeholder: 'Transfer reference' });
        return h('div', { class: 'col', style: { gap: '.3rem' } }, h('span', { class: 'small' }, `${naira(p.amountKobo)} to ${p.username || p.email || 'host ' + p.hostUserId} · ${p.bankDetails || ''}`),
          h('div', { class: 'row wrap', style: { gap: '.5rem' } }, ref,
            h('button', { class: 'btn sm primary', type: 'button', onclick: act(() => api(`/api/admin/payouts/${p.id}`, { method: 'POST', body: { action: 'paid', reference: ref.value } })) }, 'Mark paid'),
            h('button', { class: 'btn sm', type: 'button', onclick: act(() => api(`/api/admin/payouts/${p.id}`, { method: 'POST', body: { action: 'rejected', note: ref.value } })) }, 'Reject')));
      }),
      h('strong', { class: 'small' }, 'Recent ticket, gift and promotion payments'),
      ...pay.payments.slice(0, 40).map((p) => h('div', { class: 'row wrap', style: { gap: '.5rem' } },
        h('span', { class: 'grow tiny' }, `${p.kind} · ${naira(p.priceKobo)} · ${p.status}${p.refunded ? ' · refunded' : ''}${p.error ? ' · ' + p.error : ''} · ${p.payer || ''} · ${p.event || ''} · ${new Date(p.createdAt).toLocaleString()}`),
        ['paid', 'review'].includes(p.status) && !p.refunded ? h('button', { class: 'btn sm', type: 'button', onclick: act(async () => { if (await confirmDlg(`Mark ${naira(p.priceKobo)} as refunded? Refund the buyer in Paystack first. Tickets are cancelled and the host balance is reduced.`, { ok: 'Mark refunded' })) await api(`/api/admin/commerce/payments/${p.reference}/refund`, { method: 'POST', body: {} }); }) }, 'Mark refunded') : null)));
  }
  load().catch((e) => out.replaceChildren(h('p', { class: 'small' }, e.message || 'Could not load')));
  return card;
}
