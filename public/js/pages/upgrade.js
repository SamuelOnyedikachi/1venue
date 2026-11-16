// /upgrade: compare Free, Premium and Organisation and start a Paystack checkout.
import { h, api, toastErr } from '../ui.js';
import { icon } from '../icons.js';
import { state } from '../app.js';

const money = (kobo) => new Intl.NumberFormat('en-NG', { style: 'currency', currency: 'NGN', maximumFractionDigits: 0 }).format(kobo / 100);
const LABEL = { free: 'Free', premium: 'Premium', organisation: 'Organisation' };
const size = (mb) => (mb >= 1024 ? `${Math.round(mb / 102.4) / 10} GB` : `${mb} MB`);

export async function mount(view) {
  const [table, me] = await Promise.all([api('/api/plans'), state.user ? api('/api/billing').catch(() => null) : null]);
  let interval = 'month';
  const current = me ? me.plan : 'free';
  const status = h('p', { class: 'small', role: 'status', 'aria-live': 'polite' });
  const grid = h('div', { class: 'plan-grid' });
  const toggle = h('div', { class: 'row', role: 'group', 'aria-label': 'Billing interval', style: { gap: '.4rem' } });
  function paintToggle() {
    toggle.replaceChildren(...[['month', 'Monthly'], ['year', 'Annual']].map(([id, label]) => h('button', { type: 'button', class: 'btn sm' + (interval === id ? ' primary' : ''), 'aria-pressed': String(interval === id), onclick: () => { interval = id; paint(); } }, label)));
  }
  function paint() {
    paintToggle();
    grid.replaceChildren(...table.plans.map((p) => {
      const price = interval === 'year' ? p.priceYearKobo : p.priceMonthKobo;
      const isCurrent = p.id === current;
      const rank = ['free', 'premium', 'organisation'];
      const lower = rank.indexOf(p.id) < rank.indexOf(current);
      const buy = h('button', { class: 'btn primary', type: 'button', disabled: !table.purchasesEnabled || p.id === 'free' || lower }, isCurrent ? 'Renew or switch to ' + (interval === 'year' ? 'annual' : 'monthly') : `Get ${LABEL[p.id]}`);
      buy.onclick = async () => {
        if (!state.user) { location.assign('/login?next=/upgrade'); return; }
        buy.disabled = true; status.textContent = 'Opening secure checkout…';
        try { const r = await api('/api/billing/checkout', { method: 'POST', body: { plan: p.id, interval } }); location.assign(r.authorizationUrl); }
        catch (e) { status.textContent = ''; toastErr(e); buy.disabled = false; }
      };
      return h('section', { class: 'card pad col plan-card' + (isCurrent ? ' current' : ''), style: { gap: '.5rem' } },
        h('h2', null, LABEL[p.id], isCurrent ? h('span', { class: 'chip tiny', style: { marginLeft: '.5rem' } }, 'Current') : null),
        h('strong', { class: 'plan-price' }, p.id === 'free' ? '₦0' : money(price), h('span', { class: 'small muted' }, p.id === 'free' ? '' : interval === 'year' ? ' / year' : ' / month')),
        h('ul', { class: 'small plan-list' },
          h('li', null, `${p.venues} venue${p.venues === 1 ? '' : 's'}, ${p.id === 'free' ? '/v/name-venue links' : 'clean /v/name links'}`),
          h('li', null, `Up to ${p.audience.toLocaleString()} in stage events, ${p.meeting} in meetings`),
          h('li', null, `${p.speakerSeats} speaker seats`),
          h('li', null, `${p.aiDaily.toLocaleString()} AI points a day`),
          h('li', null, `${size(p.uploadMB)} uploads`)),
        p.id === 'free' ? null : buy);
    }));
  }
  const addons = table.slugAddons;
  view.append(h('div', { class: 'page-head' }, h('h1', { html: icon('crown', { size: 26 }) + 'Plans' }),
      h('p', { class: 'muted' }, 'Prices in naira. Paystack adds its processing fee at checkout. Upgrades start a new billing period straight away; downgrades take effect at the end of your period.')),
    toggle, status, grid,
    h('section', { class: 'card pad', style: { marginTop: '1rem' } }, h('h2', null, 'Shorter venue links'),
      h('p', { class: 'small muted' }, `One-off add-ons for one venue on a paid plan, yours to keep: 3-character links ${money(addons.slug3)}, 2-character links ${money(addons.slug2)}. Buy them from Billing. If your plan lapses the link stays reserved for you and comes back when you upgrade.`),
      h('p', { class: 'tiny muted' }, `AI points: translate, ask and titles cost ${table.aiWeights.translate}; summaries, catch-up and “Write it for me” cost ${table.aiWeights.summary}. In your rooms, guests use your allowance.`)),
    !table.purchasesEnabled ? h('p', { class: 'small muted' }, 'Online payments are not switched on yet.') : null,
    me ? h('p', { class: 'small' }, h('a', { href: '/billing', 'data-link': '' }, 'Manage billing →')) : null);
  paint();
}
