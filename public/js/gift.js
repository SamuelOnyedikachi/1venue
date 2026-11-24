/** Currency or credit gift sheet for event pages and live meetings. */
import { h, api, toast, toastErr, sheet } from './ui.js';
import { checkoutSheet, fmtMoney, currencyParts, convert, majorToBaseMinor, moneyConfig, creditsEl, loadMoney } from './money.js';
import { icon } from './icons.js';
import { requireLogin } from './app.js';

export async function openGiftSheet({ eventId, meetingCode, hostName } = {}) {
  if (!requireLogin('Sign in to send a gift')) return;
  await loadMoney();
  const s = sheet({ title: 'Send a gift', icon: 'heart', group: 'wallet' });
  const status = h('div', { class: 'tiny muted' }, 'Loading…');
  s.body.append(status);
  let wallet = { balance: 0 };
  try { wallet = await api('/api/wallet'); } catch (_) { /* guest may still send a card gift */ }
  const canCard = !!eventId;
  let method = canCard ? 'card' : 'credits';
  const { symbol: giftSym, code: giftCode, digits: giftDigits } = currencyParts();
  const toDisplayMajor = (baseMinor) => {
    const v = convert(Number(baseMinor || 0));
    return (v == null ? Number(baseMinor || 0) : v) / 10 ** giftDigits;
  };
  let donationMinKobo = 10000;
  if (eventId) {
    try {
      const t = await api(`/api/events/${eventId}/tickets`);
      if (t && t.donationMinKobo) donationMinKobo = Number(t.donationMinKobo);
    } catch (_) {}
  }
  const minCredits = Math.max(1, Math.ceil(donationMinKobo / 50000));
  const minMajor = Math.max(0, toDisplayMajor(donationMinKobo));
  const defMajor = Math.max(minMajor, toDisplayMajor(Math.max(donationMinKobo, 100000)));
  const giftStep = giftDigits <= 0 ? 1 : (giftDigits <= 2 ? 1 : 1 / 10 ** Math.min(2, giftDigits));
  const amount = h('input', { class: 'input gift-amount-input', type: 'number', min: String(minMajor), step: String(giftStep), value: String(Math.round(defMajor * 100) / 100), inputmode: 'decimal', 'aria-label': `Gift amount in ${giftCode}` });
  const creditsIn = h('input', { class: 'input', type: 'number', min: String(minCredits), step: '1', value: String(Math.max(minCredits, 1)), inputmode: 'numeric', 'aria-label': 'Gift amount in credits' });
  const moneyBox = h('div', { class: 'gift-box' },
    h('div', { class: 'gift-amount' },
      h('span', { class: 'gift-cur gift-cur-prefix', 'aria-hidden': 'true' }, giftSym),
      amount,
      h('span', { class: 'gift-cur gift-cur-suffix' }, giftCode)));
  const creditsBox = h('div', { class: 'col', style: { gap: '.35rem' } },
    creditsIn,
    h('div', { class: 'tiny muted row gap-s', style: { alignItems: 'center' } }, 'Your balance:', creditsEl(wallet.balanceCredits || wallet.balance || 0)));
  const cardBtn = h('button', { class: 'btn sm', type: 'button' }, 'Card');
  const credBtn = h('button', { class: 'btn sm', type: 'button' }, 'Credits');
  const fields = h('div', null);
  const sync = () => {
    cardBtn.classList.toggle('primary', method === 'card');
    credBtn.classList.toggle('primary', method === 'credits');
    fields.replaceChildren(method === 'card' ? moneyBox : creditsBox);
  };
  cardBtn.onclick = () => { method = 'card'; sync(); };
  credBtn.onclick = () => { method = 'credits'; sync(); };
  if (!canCard) { cardBtn.disabled = true; cardBtn.title = 'Card gifts are available on the event page'; }
  const giftKobo = () => {
    const base = majorToBaseMinor(Number(amount.value), moneyConfig().currency);
    return Math.max(donationMinKobo, Math.round(base || 0));
  };
  const send = async () => {
    try {
      if (method === 'credits') {
        const n = Math.round(Number(creditsIn.value));
        const path = eventId ? `/api/events/${eventId}/donate` : `/api/meetings/${encodeURIComponent(meetingCode)}/donate`;
        await api(path, { method: 'POST', body: { method: 'credits', credits: n, meetingCode, eventId } });
        toast('Thank you for your gift!', { icon: 'heart' });
        s.close();
        return;
      }
      const amountKobo = giftKobo();
      s.close();
      await checkoutSheet({
        title: 'Send a gift',
        what: hostName ? `A gift for ${hostName}` : 'A gift to the host.',
        subtotalKobo: amountKobo,
        start: () => api(`/api/events/${eventId}/donate`, { method: 'POST', body: { amountKobo, meetingCode } }),
      });
    } catch (e) { toastErr(e); }
  };
  sync();
  s.body.replaceChildren(
    hostName ? h('p', { class: 'small muted' }, `Send a gift to ${hostName}.`) : null,
    h('div', { class: 'row gap-s wrap', style: { marginBottom: '.6rem' } }, cardBtn, credBtn),
    fields,
    h('button', { class: 'btn primary block', type: 'button', style: { marginTop: '.75rem' }, onclick: send, html: icon('heart', { size: 16 }) + ' Send gift' }),
    status.textContent ? null : null,
  );
  status.remove();
  return s;
}
