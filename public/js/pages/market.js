/** /market: opt-in public materials, free and paid, with search and filters. */
import { icon } from '../icons.js';
import { h, api, toastErr } from '../ui.js';
import { kindIcon, materialThumb, materialSub } from '../materials-lib.js';
import { openBuySheet, priceLabel, MARKET_CATEGORIES } from '../material-sale.js';
import { navigate } from '../app.js';

const TYPES = [['', 'All types'], ['document', 'Documents'], ['video', 'Videos'], ['audio', 'Audio'], ['image', 'Images'], ['file', 'Files']];
const SORTS = [['newest', 'Newest'], ['popular', 'Most popular'], ['price_asc', 'Price: low to high'], ['price_desc', 'Price: high to low']];

export async function mount(view) {
  document.body.dataset.page = 'market';
  const params = new URLSearchParams(location.search);
  const q = {
    q: params.get('q') || '',
    type: params.get('type') || '',
    price: params.get('price') || '',
    minPrice: params.get('minPrice') || '',
    maxPrice: params.get('maxPrice') || '',
    currency: params.get('currency') || '',
    category: params.get('category') || '',
    host: params.get('host') || '',
    org: params.get('org') || '',
    sort: params.get('sort') || 'newest',
    page: Number(params.get('page') || 1) || 1,
  };

  const listEl = h('div', { class: 'mat-grid' });
  const meta = h('div', { class: 'tiny muted' });
  const search = h('input', { class: 'input', type: 'search', placeholder: 'Search title, host or category', value: q.q, 'aria-label': 'Search marketplace' });
  const type = h('select', { class: 'input', 'aria-label': 'Type' }, ...TYPES.map(([v, l]) => h('option', { value: v, selected: q.type === v }, l)));
  const price = h('select', { class: 'input', 'aria-label': 'Price' },
    h('option', { value: '', selected: !q.price }, 'Free or paid'),
    h('option', { value: 'free', selected: q.price === 'free' }, 'Free'),
    h('option', { value: 'paid', selected: q.price === 'paid' }, 'Paid'));
  const currency = h('select', { class: 'input', 'aria-label': 'Pay with' },
    h('option', { value: '', selected: !q.currency }, 'Any payment'),
    h('option', { value: 'NGN', selected: q.currency === 'NGN' }, 'Card (₦)'),
    h('option', { value: 'credits', selected: q.currency === 'credits' }, 'Credits'));
  const category = h('select', { class: 'input', 'aria-label': 'Category' },
    h('option', { value: '' }, 'All categories'),
    ...MARKET_CATEGORIES.map((c) => h('option', { value: c, selected: q.category === c }, c)));
  const sort = h('select', { class: 'input', 'aria-label': 'Sort' }, ...SORTS.map(([v, l]) => h('option', { value: v, selected: q.sort === v }, l)));
  const minPrice = h('input', { class: 'input', type: 'number', min: '0', step: '50', placeholder: 'Min ₦', value: q.minPrice, 'aria-label': 'Minimum price in naira' });
  const maxPrice = h('input', { class: 'input', type: 'number', min: '0', step: '50', placeholder: 'Max ₦', value: q.maxPrice, 'aria-label': 'Maximum price in naira' });
  const host = h('input', { class: 'input', placeholder: 'Host user id', value: q.host, 'aria-label': 'Host or organisation' });

  function values() {
    return {
      q: search.value.trim(),
      type: type.value, price: price.value, currency: currency.value, category: category.value, sort: sort.value,
      minPrice: minPrice.value, maxPrice: maxPrice.value, host: host.value.trim(), org: q.org, page: 1,
    };
  }
  function apply(next, { push = true } = {}) {
    Object.assign(q, next);
    const sp = new URLSearchParams();
    for (const [k, v] of Object.entries(q)) if (v && !(k === 'page' && Number(v) === 1) && !(k === 'sort' && v === 'newest')) sp.set(k, v);
    const url = '/market' + (sp.toString() ? '?' + sp : '');
    if (push) history.pushState({ path: url }, '', url);
    load();
  }

  async function load() {
    listEl.replaceChildren(h('div', { class: 'tiny muted' }, 'Loading…'));
    meta.textContent = '';
    try {
      const sp = new URLSearchParams();
      if (q.q) sp.set('q', q.q);
      if (q.type) sp.set('type', q.type);
      if (q.price) sp.set('price', q.price);
      if (q.category) sp.set('category', q.category);
      if (q.sort) sp.set('sort', q.sort);
      if (q.minPrice) sp.set('minPrice', String(Math.round(Number(q.minPrice) * 100)));
      if (q.maxPrice) sp.set('maxPrice', String(Math.round(Number(q.maxPrice) * 100)));
      if (q.host) sp.set('host', q.host);
      if (q.org) sp.set('org', q.org);
      sp.set('page', String(q.page || 1));
      const r = await api('/api/market?' + sp);
      const items = r.materials || [];
      meta.textContent = items.length ? `${items.length}${r.hasMore ? '+' : ''} listed` : 'No materials match these filters';
      if (!items.length) { listEl.replaceChildren(h('div', { class: 'empty sm' }, h('p', null, 'No materials here yet. Hosts can opt in from their library.'))); return; }
      listEl.replaceChildren(...items.map((m) => {
        const th = materialThumb(m);
        const price = m.forSale && m.priceKobo ? priceLabel(m) : 'Free';
        const open = () => {
          if (m.forSale && m.locked) openBuySheet(m, { onBought: () => navigate('/materials/' + m.id) });
          else navigate('/materials/' + m.id);
        };
        return h('div', { class: 'mat-card card layer', onclick: open, style: { cursor: 'pointer' } },
          h('div', { class: 'mat-card-link' },
            h('div', { class: 'mat-card-thumb', 'data-kind': m.kind }, th ? h('img', { src: th, alt: '', loading: 'lazy' }) : h('span', { html: icon(kindIcon(m.kind), { size: 28 }) })),
            h('div', { class: 'mat-card-body' },
              h('b', { class: 'ellipsis' }, m.title),
              h('div', { class: 'tiny muted ellipsis' }, materialSub(m), m.category ? ` · ${m.category}` : ''),
              h('div', { class: 'tiny muted ellipsis' }, m.host && m.host.name ? m.host.name : '', ' · ', price))));
      }));
      if (r.hasMore || q.page > 1) {
        listEl.append(h('div', { class: 'row gap-s wrap', style: { gridColumn: '1 / -1' } },
          q.page > 1 ? h('button', { class: 'btn sm', type: 'button', onclick: () => apply({ ...q, page: q.page - 1 }) }, 'Previous') : null,
          r.hasMore ? h('button', { class: 'btn sm', type: 'button', onclick: () => apply({ ...q, page: (q.page || 1) + 1 }) }, 'Next') : null));
      }
    } catch (e) { listEl.replaceChildren(h('div', { class: 'tiny muted' }, e.message || 'Failed to load')); toastErr(e); }
  }

  const filters = h('form', { class: 'card pad layer market-filters', onsubmit: (e) => { e.preventDefault(); apply(values()); } },
    search,
    h('div', { class: 'row wrap gap-s' }, type, price, currency, category, sort),
    h('div', { class: 'row wrap gap-s' }, minPrice, maxPrice, host, h('button', { class: 'btn primary', type: 'submit' }, 'Filter')));

  view.append(
    h('div', { class: 'page-head' },
      h('h1', { html: `<span class="ico-tile" data-group="content">${icon('grid', { size: 20 })}</span> Marketplace` }),
      h('p', { class: 'muted small' }, 'Free and paid materials hosts have chosen to list. Open one to read it, or buy it if it’s paid.')),
    filters, meta, listEl
  );
  load();
  return { update() { /* filters live in history */ } };
}
