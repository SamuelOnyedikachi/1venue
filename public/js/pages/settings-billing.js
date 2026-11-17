// Settings → Auto top-up (accounts without a paid plan) and Billing address & currency.
import { h, api, toast, toastErr, confirmDlg, timeAgo } from '../ui.js';
import { icon } from '../icons.js';
import { state } from '../app.js';
import { loadMoney, moneyConfig, fmtMoney, withFee, fmtCredits, coinHtml, checkoutSheet } from '../money.js';
import { refreshCredits } from '../credits.js';

const COUNTRIES = ['NG', 'GH', 'KE', 'ZA', 'EG', 'MA', 'SN', 'CI', 'CM', 'UG', 'TZ', 'RW', 'ET', 'ZM', 'ZW', 'BW', 'NA', 'MW', 'BJ', 'TG', 'LR', 'SL', 'GM',
  'GB', 'IE', 'US', 'CA', 'DE', 'FR', 'NL', 'BE', 'ES', 'IT', 'PT', 'SE', 'NO', 'DK', 'FI', 'CH', 'AT', 'PL', 'AE', 'SA', 'QA', 'IN', 'CN', 'JP', 'SG', 'MY', 'AU', 'NZ', 'BR', 'MX', 'JM', 'TT'];
const regionName = (() => { try { const d = new Intl.DisplayNames(undefined, { type: 'region' }); return (c) => d.of(c) || c; } catch { return (c) => c; } })();

const field = (label, input, hint) => h('label', { class: 'field' }, h('span', { class: 'lbl' }, label), input, hint ? h('span', { class: 'tiny faint' }, hint) : null);
const num = (value, attrs = {}) => h('input', { class: 'input', type: 'number', min: 1, step: 1, inputmode: 'numeric', value, ...attrs });
const STATUS = {
  paid: ['checkCircle', 'ok', 'Last top-up went through'], card_saved: ['checkCircle', 'ok', 'Card saved'], pending: ['hourglass', 'wait', 'Last top-up is being confirmed'],
  failed: ['xCircle', 'bad', 'Last top-up failed'], error: ['xCircle', 'bad', 'Last top-up hit an error'], cap_reached: ['hourglass', 'wait', 'Monthly cap reached, paused until next month'],
  disabled: ['xCircle', 'bad', 'Turned off after repeated failures'],
};

export function autoTopupCard(card, row) {
  const body = h('div', { class: 'col', style: { gap: '.8rem' } }, h('p', { class: 'small muted' }, 'Loading…'));
  const sec = card('Auto top-up', 'zap', body);
  sec.id = 'auto-topup';
  (async () => {
    await loadMoney();
    let a;
    try { a = await api('/api/wallet/auto-topup'); } catch (e) { body.replaceChildren(h('p', { class: 'small muted' }, e.message)); return; }
    paint(a);
  })();
  function paint(a) {
    if (a.subscriber) {
      body.replaceChildren(row('crown', 'settings', 'Covered by your plan', 'Your plan includes meeting time, so you don’t need auto top-up.', h('a', { class: 'btn sm', href: '/billing', 'data-link': '' }, 'Plan')));
      return;
    }
    const enabled = h('input', { type: 'checkbox', checked: a.enabled, disabled: !a.card });
    const threshold = num(a.thresholdCredits, { id: 'at-threshold', max: 100000 });
    const pack = h('select', { class: 'input', id: 'at-pack' }, [10, 30, 60, 120, 240].concat([a.packCredits]).filter((v, i, l) => l.indexOf(v) === i).sort((x, y) => x - y)
      .map((n) => h('option', { value: n, selected: n === a.packCredits }, `${n} credits · ${fmtMoney(withFee(n * (a.packQuote.priceKobo / a.packQuote.credits)).total, { whole: true })}`)));
    const cap = num(a.monthlyCapCredits, { id: 'at-cap', max: 1000000 });
    const perCredit = a.packQuote.priceKobo / a.packQuote.credits;
    const cardRow = a.card
      ? row('creditCard', 'settings', `${a.card.brand ? a.card.brand[0].toUpperCase() + a.card.brand.slice(1) : 'Card'} •••• ${a.card.last4 || '····'}`, a.card.exp ? `Expires ${a.card.exp} · kept by the payment gateway, never by 1venue` : 'Kept by the payment gateway, never by 1venue',
        h('button', { class: 'btn sm', type: 'button', onclick: async () => { if (!(await confirmDlg('Remove this card? Auto top-up turns off.', { ok: 'Remove card', danger: true }))) return; try { paint(await api('/api/wallet/auto-topup/card', { method: 'DELETE' })); } catch (e) { toastErr(e); } } }, 'Remove'))
      : row('creditCard', 'settings', 'No card yet', 'Add a card by buying your first top-up pack. The gateway keeps the card; we only keep a token to charge it.',
        h('button', { class: 'btn sm primary', type: 'button', disabled: !a.purchasesEnabled, onclick: () => checkoutSheet({ title: 'Add a card for auto top-up', what: `Buy ${Number(pack.value)} credits now. Your card is then used for future top-ups.`, subtotalKobo: Number(pack.value) * perCredit, start: async () => { await save(true); return api('/api/wallet/auto-topup/card', { method: 'POST' }); } }) }, a.purchasesEnabled ? 'Add card' : 'Payments off'));
    const st = a.lastStatus && STATUS[a.lastStatus];
    const last = h('div', { class: 'at-status small' }, st ? h('span', { class: `pay-st ${st[1]}`, title: st[2], html: icon(st[0], { size: 16, label: st[2] }) }) : h('span', { class: 'pay-st', html: icon('clock', { size: 16, label: 'Not run yet' }) }),
      h('span', null, st ? `${st[2]}${a.lastRunAt ? ' · ' + timeAgo(a.lastRunAt) : ''}${a.lastError && /failed|error/.test(a.lastStatus) ? ' · ' + a.lastError : ''}` : 'No automatic top-ups yet'),
      h('span', { class: 'grow' }), h('span', { class: 'tiny muted', html: `This month ${fmtCredits(a.usedThisMonthCredits)} ${coinHtml(13)} of ${fmtCredits(a.monthlyCapCredits)}` }));
    async function save(quiet = false) {
      const r = await api('/api/wallet/auto-topup', { method: 'PUT', body: { enabled: enabled.checked, thresholdCredits: Number(threshold.value), packCredits: Number(pack.value), monthlyCapCredits: Number(cap.value) } });
      if (!quiet) { toast(r.enabled ? 'Auto top-up on' : 'Auto top-up saved', { icon: 'zap' }); paint(r); refreshCredits(); }
      return r;
    }
    enabled.onchange = () => save().catch((e) => { enabled.checked = !enabled.checked; toastErr(e); });
    body.replaceChildren(
      row('zap', 'settings', 'Top up automatically', a.card ? 'When your balance runs low, buy more credits with your saved card' : 'Add a card below to turn this on', h('label', { class: 'switch' }, enabled, h('span'))),
      h('div', { class: 'at-grid' },
        field('When my balance falls below', h('div', { class: 'input-suffix' }, threshold, h('span', { html: coinHtml(16) }))),
        field('Top up with', pack, 'Processing fee included'),
        field('Monthly cap', h('div', { class: 'input-suffix' }, cap, h('span', { html: coinHtml(16) })), 'Never more than this per calendar month')),
      cardRow, last,
      h('div', { class: 'row', style: { justifyContent: 'flex-end' } }, h('button', { class: 'btn sm', type: 'button', onclick: () => save().catch(toastErr) }, 'Save')));
  }
  return sec;
}

export function billingProfileCard(card) {
  const body = h('div', { class: 'col', style: { gap: '.75rem' } }, h('p', { class: 'small muted' }, 'Loading…'));
  const sec = card('Billing address & currency', 'globe', body);
  sec.id = 'billing';
  (async () => {
    const [m, p] = await Promise.all([loadMoney(), api('/api/me/billing-profile').catch(() => ({}))]);
    const inp = (name, v, attrs = {}) => h('input', { class: 'input', name, value: v || '', ...attrs });
    const country = h('select', { class: 'input', name: 'country', autocomplete: 'country' }, h('option', { value: '' }, 'Choose a country'),
      COUNTRIES.map((c) => [c, regionName(c)]).sort((x, y) => x[1].localeCompare(y[1])).map(([c, n]) => h('option', { value: c, selected: p.country === c }, n)));
    const currency = h('select', { class: 'input', name: 'currency' }, m.currencies.map((c) => h('option', { value: c.code, selected: (p.currency || m.currency) === c.code }, `${c.code} · ${c.name}`)));
    const line1 = inp('line1', p.line1, { autocomplete: 'address-line1', placeholder: 'Street and number' });
    const line2 = inp('line2', p.line2, { autocomplete: 'address-line2', placeholder: 'Apartment, suite (optional)' });
    const city = inp('city', p.city, { autocomplete: 'address-level2' });
    const st = inp('state', p.state, { autocomplete: 'address-level1' });
    const postal = inp('postal', p.postalCode, { autocomplete: 'postal-code' });
    const sample = h('span', { class: 'tiny muted' });
    const paintSample = () => { sample.textContent = `e.g. 30 credits = ${fmtMoney(1500000, { currency: currency.value })}`; };
    currency.onchange = paintSample; paintSample();
    const warn = state.user?.isAdmin && m.placeholderRates && m.placeholderRates.length ? h('p', { class: 'tiny at-warn', html: icon('alert', { size: 14 }) + ` Exchange rates for ${m.placeholderRates.join(', ')} are placeholders. Set FX_RATES or edit them in Admin → Currency.` }) : null;
    const save = h('button', { class: 'btn sm primary', type: 'button' }, 'Save');
    save.onclick = async () => {
      save.disabled = true;
      try {
        await api('/api/me/billing-profile', { method: 'PUT', body: { country: country.value, line1: line1.value, line2: line2.value, city: city.value, state: st.value, postalCode: postal.value, currency: currency.value } });
        await loadMoney(true); toast(`Prices now show in ${currency.value}`, { icon: 'check' });
      } catch (e) { toastErr(e); } finally { save.disabled = false; }
    };
    body.replaceChildren(...[
      field('Currency', currency, `Prices show in this currency. Payments are charged in ${m.chargeCurrency}.`), sample, warn,
      h('div', { class: 'addr-grid' }, field('Country', country), field('Address line 1', line1), field('Address line 2', line2), field('City', city), field('State / region', st), field('Postal code', postal)),
      h('div', { class: 'row', style: { justifyContent: 'flex-end' } }, save)].filter(Boolean));
  })();
  return sec;
}
