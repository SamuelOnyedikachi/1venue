// /billing: current plan, renewal, saved card, payments, cancel/resume, downgrade, short-link add-ons.
import { h, api, toast, toastErr, timeAgo, confirmDlg } from '../ui.js';
import { icon } from '../icons.js';
import { requireLogin } from '../app.js';
import { loadMoney, fmtMoney, checkoutSheet } from '../money.js';

const money = (kobo) => fmtMoney(kobo, { whole: true });
const LABEL = { free: 'Free', premium: 'Premium', organisation: 'Organisation' };
const day = (d) => (d ? new Date(d).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : '');
const STATUS = { paid: 'Paid', pending: 'Awaiting confirmation', failed: 'Not completed', review: 'Needs review' };
const KIND = { subscription: 'Plan', renewal: 'Renewal', slug_addon: 'Short link' };

export async function mount(view) {
  if (!requireLogin('Sign in to see billing')) return;
  let alive = true;
  const msg = h('p', { class: 'small', role: 'status', 'aria-live': 'polite' });
  const body = h('div', { class: 'col', style: { gap: '1rem' } });
  view.append(h('div', { class: 'page-head' }, h('h1', { html: icon('creditCard', { size: 26 }) + 'Billing' }),
    h('p', { class: 'muted' }, 'Your plan and payments. Credits are separate: see your ', h('a', { href: '/wallet', 'data-link': '' }, 'credit wallet'), '.')), msg, body);
  const act = (fn) => async (e) => { const b = e.currentTarget; b.disabled = true; try { await fn(); await refresh(); } catch (err) { toastErr(err); } finally { b.disabled = false; } };

  async function refresh() {
    const [, me, table, venues] = await Promise.all([loadMoney(), api('/api/billing'), api('/api/plans'), api('/api/venues').catch(() => ({ venues: [] }))]);
    if (!alive) return;
    const s = me.subscription;
    const lines = [];
    if (s && s.effectivePlan !== 'free') {
      if (s.status === 'comp') lines.push(s.periodEnd ? `Complimentary until ${day(s.periodEnd)}.` : 'Complimentary plan.');
      else if (s.cancelAtPeriodEnd) lines.push(`Ends on ${day(s.periodEnd)}. It will not renew.`);
      else if (s.status === 'past_due') lines.push(`We could not renew your plan. You keep it until ${day(s.graceUntil)}. Pay again below to keep it.`);
      else lines.push(`Renews ${s.interval === 'year' ? 'yearly' : 'monthly'} on ${day(s.periodEnd)}${s.card ? ` from ${s.card.brand || 'card'} •••• ${s.card.last4}` : ''}.`);
      if (s.source === 'grandfather') lines.push('Free Premium for existing members. Pay before it ends to keep Premium.');
      if (s.pendingPlan) lines.push(`Switches to ${LABEL[s.pendingPlan]} (${s.pendingInterval === 'year' ? 'annual' : 'monthly'}) at the end of this period.`);
    }
    const l = me.limits;
    const actions = h('div', { class: 'row wrap', style: { gap: '.5rem' } },
      h('a', { class: 'btn primary', href: '/upgrade', 'data-link': '' }, me.plan === 'free' ? 'Upgrade' : 'Change plan'),
      s && s.autoRenew ? h('button', { class: 'btn', type: 'button', onclick: act(async () => { if (await confirmDlg('Stop renewing? You keep your plan until the end of this period.', { ok: 'Stop renewing' })) { await api('/api/billing/cancel', { method: 'POST' }); toast('Your plan will not renew'); } }) }, 'Cancel renewal') : null,
      s && s.cancelAtPeriodEnd && s.effectivePlan !== 'free' ? h('button', { class: 'btn', type: 'button', onclick: act(() => api('/api/billing/resume', { method: 'POST' })) }, 'Keep renewing') : null,
      s && s.plan === 'organisation' && s.autoRenew && !s.pendingPlan ? h('button', { class: 'btn', type: 'button', onclick: act(() => api('/api/billing/change', { method: 'POST', body: { plan: 'premium', interval: s.interval } })) }, 'Switch to Premium at period end') : null);
    const plan = h('section', { class: 'card pad col', style: { gap: '.5rem' } },
      h('h2', null, `${LABEL[me.plan]} plan`), ...lines.map((t) => h('p', { class: 'small' }, t)),
      h('p', { class: 'small muted' }, `${me.usage.venues} of ${l.venues} venues · ${l.audience.toLocaleString()} stage audience · ${l.meeting} per meeting · ${l.speakerSeats} speaker seats · ${me.usage.aiLeft} of ${l.aiDaily} AI points left today`),
      actions);
    const paid = me.plan !== 'free';
    const addon = h('section', { class: 'card pad col', style: { gap: '.5rem' } }, h('h2', null, 'Shorter venue links'),
      h('p', { class: 'small muted' }, paid ? `One-off, per venue: 4 characters ${money(table.slugAddons.slug4)}, 3 characters ${money(table.slugAddons.slug3)}.` : 'Short links need a Premium or Organisation plan.'),
      ...(paid ? venues.venues.filter((v) => !v.archived).map((v) => h('div', { class: 'wallet-item' },
        h('div', { class: 'grow' }, h('strong', null, v.name), h('div', { class: 'tiny muted' }, `/v/${v.slug}${v.reservedSlug && v.linkReleaseAt ? ` · /v/${v.reservedSlug} is parked until ${day(v.linkReleaseAt)}, then released; renew to keep it` : ''}${v.slugTier !== 'none' ? ' · ' + (v.slugTier === 'slug4' ? '4-character' : '3-character') + ' link' : ''}`)),
        h('div', { class: 'wallet-actions' }, ...['slug4', 'slug3'].filter((t) => (v.slugTier === 'none') || (v.slugTier === 'slug4' && t === 'slug3')).map((t) => h('button', { class: 'btn sm', type: 'button', disabled: !me.purchasesEnabled, onclick: act(async () => {
          await checkoutSheet({ title: 'Shorter venue link', what: `${t === 'slug4' ? '4' : '3'}-character link for ${v.name}. One-off.`, subtotalKobo: table.slugAddons[t], start: () => api('/api/billing/slug-addon', { method: 'POST', body: { venueSlug: v.slug, tier: t } }) });
        }) }, t === 'slug4' ? '4-character' : '3-character'))))) : []),
      venues.venues.some((v) => v.archived) ? h('p', { class: 'tiny muted' }, 'Archived venues are kept safe and come back when you upgrade.') : null);
    const list = h('section', { class: 'card pad' }, h('h2', null, 'Payments'),
      me.payments.length ? null : h('p', { class: 'small muted' }, 'No plan payments yet.'),
      ...me.payments.map((p) => h('div', { class: 'wallet-item' },
        h('div', { class: 'grow' }, h('strong', null, `${KIND[p.kind]}${p.plan ? ' · ' + LABEL[p.plan] + (p.interval === 'year' ? ' (annual)' : ' (monthly)') : p.slugTier ? ' · ' + (p.slugTier === 'slug4' ? '4-character link' : '3-character link') : ''}`),
          h('div', { class: 'tiny muted' }, `${fmtMoney(p.priceKobo)}${p.feeKobo ? ` (incl. ${fmtMoney(p.feeKobo)} fee)` : ''} · ${timeAgo(p.createdAt)}`), h('div', { class: 'tiny' }, STATUS[p.status] || p.status)),
        p.status === 'paid' ? h('span', { class: 'chip' }, 'Complete') : h('div', { class: 'wallet-actions' },
          p.status === 'pending' && p.authorizationUrl ? h('a', { class: 'btn sm', href: p.authorizationUrl }, 'Open checkout') : null,
          h('button', { class: 'btn sm', type: 'button', onclick: act(() => check(p.reference)) }, 'Check payment')))));
    body.replaceChildren(plan, addon, list);
  }
  async function check(reference) {
    msg.textContent = 'Checking your payment…';
    const r = await api(`/api/billing/payments/${encodeURIComponent(reference)}/verify`, { method: 'POST' });
    if (alive) msg.textContent = r.status === 'paid' ? 'Payment confirmed. Your plan is active.' : r.status === 'pending' ? 'Payment is still pending. You can check again below.' : 'This payment was not completed.';
  }
  await refresh();
  const ref = new URLSearchParams(location.search).get('reference') || new URLSearchParams(location.search).get('trxref');
  if (ref && /^[A-Za-z0-9-]{1,80}$/.test(ref)) { try { await check(ref); await refresh(); } catch (e) { msg.textContent = e.message; } }
  return { unmount() { alive = false; } };
}
