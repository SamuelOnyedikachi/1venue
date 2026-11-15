// /admin: site admin tools (admins = confirmed emails in ADMIN_EMAILS). Demo data load/remove.
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
  view.append(promoCard(), ttsCard());
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
