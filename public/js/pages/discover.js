import { icon } from '../icons.js';
import { h, api, debounce, frag, menu } from '../ui.js';
import { navigate, CATS } from '../app.js';
import { eventCard, skeletonCards, empty, personRow } from '../components.js';
import { promoInline } from '../promo.js';

export const TIMING = [['', 'Any time', 'sparkle'], ['live', 'Live', 'radio'], ['upcoming', 'Upcoming', 'calendar'], ['past', 'Replays', 'history']];
const reduceMotion = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

/**
 * "Timing | Category" filter. While a half is unset its label slowly cycles through sample values
 * (Live, Upcoming… / Sermons, Seminars…) purely as a hint: the results never change until the user
 * opens the dropdown and picks. With prefers-reduced-motion the labels stay still.
 */
export function filterPicker({ status, category, onPick }) {
  const cur = { status, category };
  const mk = (kind, title) => {
    const txt = h('span', { class: 'dz-txt' });
    const b = h('button', { type: 'button', class: 'dz-dd', 'data-kind': kind, 'aria-haspopup': 'menu', 'aria-label': title },
      h('span', { class: 'dz-ic', html: icon(kind === 'status' ? 'clock' : 'grid', { size: 15 }) }), h('span', { class: 'dz-win' }, txt), h('span', { class: 'dz-car', html: icon('chevronDown', { size: 14 }) }));
    b._txt = txt; return b;
  };
  const tb = mk('status', 'Timing'), cb = mk('category', 'Category');
  const wrap = h('div', { class: 'dz-filters', role: 'group', 'aria-label': 'Filters' }, tb, h('span', { class: 'dz-sep', 'aria-hidden': 'true' }, '|'), cb);
  const catList = [['', 'All categories', 'grid'], ...CATS];
  const nameOf = (kind, v) => (kind === 'status' ? TIMING : catList).find(([k]) => k === v)?.[1] || '';
  const set = (b, text, live) => {
    if (b._txt.textContent === text) return;
    if (!live || reduceMotion()) { b._txt.textContent = text; return; }
    b._txt.classList.remove('in'); b._txt.classList.add('out');
    setTimeout(() => { b._txt.textContent = text; b._txt.classList.remove('out'); void b._txt.offsetWidth; b._txt.classList.add('in'); }, 180);
  };
  const paint = (animate) => {
    tb.classList.toggle('set', !!cur.status); cb.classList.toggle('set', !!cur.category);
    tb.setAttribute('aria-label', `Timing: ${cur.status ? nameOf('status', cur.status) : 'any time'}`);
    cb.setAttribute('aria-label', `Category: ${cur.category ? nameOf('category', cur.category) : 'all'}`);
    if (cur.status) set(tb, nameOf('status', cur.status), animate); else if (!tb._txt.textContent || reduceMotion()) set(tb, 'Timing');
    if (cur.category) set(cb, nameOf('category', cur.category), animate); else if (!cb._txt.textContent || reduceMotion()) set(cb, 'Category');
  };
  // Hint cycle: Timing | Category → Live | Sermons → Upcoming | Seminars → …
  const samplesT = ['Timing', ...TIMING.slice(1).map((t) => t[1])];
  const samplesC = ['Category', ...CATS.map((c) => c[1])];
  let tick = 0;
  const timer = setInterval(() => {
    if (!wrap.isConnected) { clearInterval(timer); return; }
    if (reduceMotion() || document.hidden) return;
    tick++;
    if (!cur.status) set(tb, samplesT[tick % samplesT.length], true);
    if (!cur.category) setTimeout(() => !cur.category && set(cb, samplesC[(tick * 2 + 3) % samplesC.length], true), 260);
  }, 2600);
  const open = (b, kind) => {
    const list = kind === 'status' ? TIMING : catList;
    const m = menu(b, list.map(([k, l, ic]) => ({ label: l, icon: ic, hint: (cur[kind] || '') === k ? '✓' : '', run: () => { cur[kind] = k; paint(true); onPick({ ...cur }); } })));
    m.classList.add('dz-menu');
  };
  tb.onclick = () => open(tb, 'status'); cb.onclick = () => open(cb, 'category');
  paint(false);
  wrap.update = (v) => { Object.assign(cur, v); paint(true); };
  wrap.stop = () => clearInterval(timer);
  return wrap;
}

/** Multi-field Discover-style filter chips: animated labels, .dz-dd menus. */
export function filterBar({ fields, values, onChange, extra } = {}) {
  const row = h('div', { class: 'dz-filters mk-filters' });
  function paint() {
    row.replaceChildren();
    for (const f of fields) {
      const opts = f.options || [];
      const cur = values[f.key];
      const always = !!f.alwaysSet;
      const set = always || (cur != null && cur !== '');
      const hit = opts.find(([v]) => v === cur) || [];
      const curLab = hit[1] || f.title;
      const samples = (f.samples || opts.filter(([v]) => v !== '' && v != null).map(([, l]) => l)).filter(Boolean);
      const ico = hit[2] || f.icon;
      const lab = h('span', { class: 'dz-txt' + (set ? ' set' : '') }, set ? curLab : (samples[0] || f.title));
      if (!set && samples.length > 1 && !reduceMotion()) {
        let i = 0;
        const tick = () => {
          if (!lab.isConnected) return;
          lab.classList.add('out');
          setTimeout(() => { lab.textContent = samples[++i % samples.length]; lab.classList.remove('out'); lab.classList.add('in'); }, 180);
          setTimeout(() => lab.classList.remove('in'), 500);
          setTimeout(tick, 2600);
        };
        setTimeout(tick, 1200);
      }
      const btn = h('button', {
        type: 'button', class: 'dz-dd' + (set ? ' on' : ''),
        'aria-haspopup': 'listbox', 'aria-label': f.title,
      }, ico ? icon(ico, 14) : null, lab, icon('chevronDown', { size: 12 }));
      btn.onclick = (ev) => {
        ev.stopPropagation();
        const m = menu(btn, opts.map(([v, l, ic]) => ({
          label: l, icon: ic || f.icon, hint: v === cur ? '✓' : '',
          run: () => { values[f.key] = v; paint(); onChange && onChange(values); },
        })));
        if (m) m.classList.add('dz-menu');
      };
      row.append(btn);
    }
    if (extra) {
      const nodes = Array.isArray(extra) ? extra : [extra];
      for (const n of nodes) if (n) row.append(n);
    }
  }
  paint();
  row.repaint = paint;
  return row;
}

export async function mount(view, params) {
  const isSearch = !!params.search;
  document.body.dataset.page = 'discover';
  view.classList.add('dz-view');
  let q = params.q || '', category = params.category || '', status = params.status || '', tab = params.tab || 'events';
  const input = h('input', { class: 'input', type: 'search', placeholder: isSearch ? 'Search events, people, scripture…' : 'Search talk shows, seminars, sermons…', value: q, 'aria-label': 'Search' });
  const results = h('div');
  const tabs = h('div', { class: 'tabs' }, [['events', 'Events', 'calendar'], ['people', 'People', 'users'], ['scripture', 'Scripture', 'bookOpen']].map(([v, l, ic]) =>
    h('button', { class: tab === v ? 'on' : '', html: icon(ic, { size: 16 }) + l, onclick: () => { tab = v; sync(); } })));
  const searchLine = h('div', { class: 'search-line' }, frag(icon('search', { size: 20 })), input);
  const picker = isSearch ? null : filterPicker({ status, category, onPick: (v) => { status = v.status; category = v.category; sync(); } });
  if (isSearch) {
    view.append(
      h('div', { class: 'page-head' }, h('h1', { html: icon('search', { size: 28 }) + 'Search' }), h('p', { class: 'muted' }, 'Everything on 1venue in one place.')),
      searchLine, tabs, results);
  } else {
    // Phone: [◎ Discover ........ Timing | Category] / [search]. Wide (CSS grid): [◎ Discover] [search] [Timing] [Category].
    view.append(
      h('div', { class: 'dz-head' }, h('h1', { class: 'dz-title', html: icon('compass', { size: 22 }) + 'Discover' }), searchLine, picker),
      // Phones: Messages took Feed's bottom-nav slot, so Feed is reached from here.
      h('a', { class: 'dz-feed', href: '/feed', 'data-link': '' }, h('span', { class: 'dz-feed-ic', html: icon('feed', { size: 20 }) }),
        h('span', { class: 'dz-feed-txt' }, h('b', null, 'Your feed'), h('span', null, 'Posts and updates from people you follow')), h('span', { html: icon('chevronRight', { size: 18 }) })),
      results);
  }
  function sync() {
    const sp = new URLSearchParams();
    if (q) sp.set('q', q); if (!isSearch && category) sp.set('category', category); if (!isSearch && status) sp.set('status', status); if (isSearch && tab !== 'events') sp.set('tab', tab);
    history.replaceState({}, '', location.pathname + (sp.toString() ? '?' + sp : ''));
    picker && picker.update({ status, category });
    tabs.querySelectorAll('button').forEach((b, i) => b.classList.toggle('on', ['events', 'people', 'scripture'][i] === tab));
    load();
  }
  let seq = 0;
  async function load() {
    const my = ++seq;
    results.innerHTML = ''; results.append(skeletonCards(6));
    try {
      let node;
      if (isSearch && tab === 'people') {
        const r = q.length >= 2 ? await api('/api/users/search?q=' + encodeURIComponent(q)) : await api('/api/people/suggested').then((x) => ({ users: x.people }));
        node = r.users.length ? h('div', { class: 'card layer', style: { padding: '.4rem' } }, r.users.map((u) => personRow(u))) : empty('users', 'No people found', 'Try a different name or handle.');
      } else if (isSearch && tab === 'scripture') {
        const r = q.length >= 2 ? await api('/api/search?q=' + encodeURIComponent(q)) : {};
        node = r.scripture ? h('a', { class: 'card hover pad row', href: '/books?ref=' + encodeURIComponent(r.scripture.reference), 'data-link': '', 'data-group': 'faith' }, h('span', { class: 'ico-tile', html: icon('bookOpen', { size: 22 }) }), h('div', { class: 'grow' }, h('strong', null, r.scripture.reference), h('div', { class: 'muted small' }, 'Open in Books')), frag(icon('chevronRight')))
          : empty('bookOpen', 'Type a reference', 'Try “John 3:16”, “Psalm 23” or “Rom 8:28-39”.', h('a', { class: 'btn', href: '/books', 'data-link': '' }, 'Open Books'));
      } else {
        const sp = new URLSearchParams({ limit: '30' }); if (q) sp.set('q', q); if (category) sp.set('category', category); if (status) sp.set('status', status);
        const r = await api('/api/discover?' + sp);
        node = r.events.length ? h('div', { class: 'grid-cards stagger', 'data-promo-slot': '6' }, r.events.map((e) => eventCard(e)))
          : empty('compass', q ? `Nothing matches “${q}”` : 'No events here yet', 'Try another category - or host the first one.', h('a', { class: 'btn primary', href: '/create', 'data-link': '' }, 'Create event'));
      }
      if (my !== seq) return;
      results.innerHTML = ''; results.append(node);
      if (!isSearch) promoInline(node, 'discover');
    } catch (e) { if (my === seq) { results.innerHTML = ''; results.append(empty('alert', 'Could not load', e.message)); } }
  }
  input.addEventListener('input', debounce(() => { q = input.value.trim(); sync(); }, 280));
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { q = input.value.trim(); sync(); } });
  load();
  if (picker) return { unmount: () => picker.stop() };
  if (isSearch && !q) setTimeout(() => input.focus(), 50);
}
