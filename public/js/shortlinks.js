// The "Shorter venue links" card: two price tiles (4-character, 3-character) and one accent button.
// Shared by /upgrade (button goes to Billing) and /billing (button opens the buy flow), so both look the same.
import { h } from './ui.js';
import { icon } from './icons.js';
import { fmtMoney } from './money.js';

const money = (kobo) => fmtMoney(kobo, { whole: true });
export function addonCard(addons, { signedIn = false, releaseDays = 60, onBuy = null, buyLabel = 'Get a short link', manage = true, note = null, disabled = false } = {}) {
  const tile = (len, sample, price) => h('div', { class: 'pr-addon-tile' },
    h('span', { class: 'pr-addon-len' }, `${len}-character`),
    h('code', { class: 'pr-addon-url' }, `1venue.live/v/`, h('b', null, sample)),
    h('strong', { class: 'pr-addon-price' }, money(price)),
    h('span', { class: 'pr-addon-once' }, 'one-off'));
  const href = signedIn ? '/billing#short-links' : '/login?next=/billing';
  const btnKids = [h('span', { class: 'i', html: icon('arrowRight', { size: 16 }) }), buyLabel];
  const btn = onBuy ? h('button', { class: 'btn primary pr-btn pr-addon-btn', type: 'button', disabled, onclick: onBuy }, ...btnKids)
    : h('a', { class: 'btn primary pr-btn pr-addon-btn', href, 'data-link': '' }, ...btnKids);
  return h('section', { class: 'pr-addons', 'aria-labelledby': 'pr-addons-h' },
    h('div', { class: 'pr-addon-head' },
      h('span', { class: 'pr-addon-ic', html: icon('link', { size: 20 }) }),
      h('div', null, h('h2', { id: 'pr-addons-h' }, 'Shorter venue links'), h('p', { class: 'pr-addon-pitch' }, 'A link people remember. Yours to keep, for any venue on a paid plan.'))),
    h('div', { class: 'pr-addon-tiles' }, tile(4, 'abcd', addons.slug4), tile(3, 'abc', addons.slug3)),
    h('div', { class: 'pr-addon-foot' }, btn,
      signedIn && manage ? h('a', { class: 'pr-addon-manage', href: '/billing#short-links', 'data-link': '' }, 'Manage billing') : null),
    note ? h('p', { class: 'pr-addon-note' }, note) : null,
    h('p', { class: 'pr-addon-note' }, `Kept while your plan is active; released ${releaseDays} days after it lapses.`));
}
