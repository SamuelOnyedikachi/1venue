// /market: free and paid materials hosts have opted to list.
import { h, api } from '../ui.js';
import { icon } from '../icons.js';
import { materialCard, takeMaterialReturnScroll } from '../material-sale.js';
import { filterBar } from './discover.js';

const TYPES = [
  ['', 'All types', 'file'],
  ['slides', 'Documents', 'fileText'],
  ['video', 'Videos', 'video'],
  ['audio', 'Audio', 'headphones'],
  ['image', 'Images', 'image'],
  ['file', 'Files', 'file'],
];
const PRICES = [
  ['', 'Any', 'ticket'],
  ['free', 'Free', 'sparkle'],
  ['paid', 'Paid', 'creditCard'],
];
const PAYS = [
  ['', 'Any payment', 'wallet'],
  ['card', 'Card', 'creditCard'],
  ['credits', 'Credits', 'coin'],
];
const CATS = ['Teaching', 'Worship', 'Study', 'Music', 'Training', 'Kids', 'Business', 'Other'];
const SORTS = [
  ['newest', 'Newest', 'clock'],
  ['popular', 'Most popular', 'users'],
  ['price_asc', 'Price: low', 'chevronDown'],
  ['price_desc', 'Price: high', 'chevronUp'],
];

const MARKET_KEYS = ['q', 'type', 'price', 'pay', 'category', 'sort', 'min', 'max'];
function marketHref(q) {
  const p = new URLSearchParams();
  for (const k of MARKET_KEYS) {
    const v = q[k];
    if (v == null || v === '' || (k === 'sort' && v === 'newest')) continue;
    p.set(k, v);
  }
  const s = p.toString();
  return '/market' + (s ? '?' + s : '');
}
function marketFromUrl(sp = new URLSearchParams(location.search)) {
  const q = { q: '', type: '', price: '', pay: '', category: '', sort: 'newest', min: '', max: '' };
  for (const k of MARKET_KEYS) {
    const v = sp.get(k);
    if (v != null && v !== '') q[k] = v;
  }
  if (!q.sort) q.sort = 'newest';
  return q;
}
function syncMarketUrl(q) {
  const href = marketHref(q);
  if (location.pathname + location.search !== href) history.replaceState(history.state || {}, '', href);
}

async function load(box, q) {
  box.replaceChildren(h('div', { class: 'tiny muted' }, 'Loading…'));
  const qs = new URLSearchParams();
  if (q.q) qs.set('q', q.q);
  if (q.type) qs.set('type', q.type);
  if (q.price) qs.set('price', q.price);
  if (q.category) qs.set('category', q.category);
  if (q.sort) qs.set('sort', q.sort);
  if (q.min !== '' && Number.isFinite(+q.min)) qs.set('min', String(Math.round(Number(q.min) * 100)));
  if (q.max !== '' && Number.isFinite(+q.max)) qs.set('max', String(Math.round(Number(q.max) * 100)));
  try {
    const r = await api('/api/market?' + qs);
    const items = r.materials || r.items || [];
    if (!items.length) {
      box.replaceChildren(h('div', { class: 'empty' }, h('p', { class: 'muted' }, q.q || q.type || q.price || q.category || q.min !== '' || q.max !== '' ? 'No materials match these filters.' : 'Nothing listed yet.')));
      return;
    }
    box.replaceChildren(h('div', { class: 'tiny muted', style: { marginBottom: '.6rem' } }, `${items.length} listed`), h('div', { class: 'mat-grid' }, ...items.map((m) => materialCard(m, { from: 'market' }))));
  } catch (e) {
    box.replaceChildren(h('div', { class: 'empty' }, h('p', { class: 'muted' }, e.message || 'Could not load the marketplace')));
  }
}

export async function mount(view) {
  document.body.dataset.page = 'market';
  view.classList.add('page', 'dz-view');
  const results = h('div');
  const q = marketFromUrl();
  const run = () => { syncMarketUrl(q); load(results, q); };
  let t;
  const later = () => { clearTimeout(t); t = setTimeout(run, 220); };
  const search = h('input', {
    class: 'input', type: 'search', placeholder: 'Search materials…', value: q.q,
    'aria-label': 'Search materials',
    oninput: ev => { q.q = ev.target.value; later(); },
  });
  const min = h('input', {
    class: 'dz-num', type: 'number', min: '0', step: '50', placeholder: '0', value: q.min,
    'aria-label': 'Minimum price in naira',
    oninput: ev => { q.min = ev.target.value; later(); },
  });
  const max = h('input', {
    class: 'dz-num', type: 'number', min: '0', step: '50', placeholder: 'Max', value: q.max,
    'aria-label': 'Maximum price in naira',
    oninput: ev => { q.max = ev.target.value; later(); },
  });
  const filters = filterBar({
    fields: [
      { key: 'type', title: 'All types', icon: 'file', options: TYPES },
      { key: 'price', title: 'Any', icon: 'ticket', options: PRICES },
      { key: 'pay', title: 'Any payment', icon: 'wallet', options: PAYS },
      { key: 'category', title: 'Categories', icon: 'tag', options: [['', 'All categories', 'tag'], ...CATS.map((c) => [c, c, 'tag'])] },
      { key: 'sort', title: 'Newest', icon: 'clock', options: SORTS, alwaysSet: true },
    ],
    values: q,
    onChange: run,
    extra: [
      h('label', { class: 'dz-num-wrap', 'data-lab': 'Min' }, min),
      h('label', { class: 'dz-num-wrap', 'data-lab': 'Max' }, max),
    ],
  });
  view.append(
    h('div', { class: 'dz-head mk-head' },
      h('h1', { class: 'dz-title', html: icon('cart') + 'Marketplace' }),
      h('form', { class: 'search-line', onsubmit: ev => { ev.preventDefault(); run(); } }, search),
      filters),
    results);
  run();
  const y = takeMaterialReturnScroll('/market');
  if (y != null) requestAnimationFrame(() => window.scrollTo(0, y));
}

