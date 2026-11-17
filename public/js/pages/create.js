import { icon, LOGO_ART } from '../icons.js';
import { h, api, esc, toast, toastErr, uploadFile, avatar, debounce, sheet, reportClientError } from '../ui.js';
import { state, navigate, requireLogin, CATS, ACCENTS } from '../app.js';
import { catOf } from '../components.js';
import { isRichInput } from '../event-draft.js';
import { listenOn, isListening, stopListening } from '../voice.js';
import { materialPicker } from '../material-picker.js';

const field = (label, ic, el, actions) => h('div', { class: 'field-row' },
  h('div', { class: 'field-lab' },
    h('span', { class: 'ico-lab', html: icon(ic, { size: 15 }) }),
    h('span', null, label),
    actions ? h('span', { class: 'lab-actions' }, actions) : null),
  el);

export async function mount(view, params) {
  if (params.instant) return instantDeepLink(view);
  if (!requireLogin('Sign in to create events')) return;
  const editing = params.edit ? await api(`/api/events/${encodeURIComponent(params.edit)}`).catch(() => null) : null;
  const ev = editing || { category: params.category || 'talk_show', visibility: 'public', speakerSeats: 4, theme: { accent: state.prefs.accent, accent2: state.prefs.accent2 || ACCENTS.find((a) => a[1] === state.prefs.accent)?.[2] || '#7c3aed' }, tags: [] };
  let category = ev.category, visibility = ev.visibility, seats = ev.speakerSeats || 4, coverUrl = ev.coverUrl || null;
  let meetingAccessMode = ev.meetingAccessMode || 'host_funded';
  let catTouched = !!editing, themeTouched = !!editing;
  let acc = ev.theme?.accent || '#2563eb', acc2 = ev.theme?.accent2 || '#7c3aed';
  let materialIds = [];
  let speakers = []; // { userId?, name, email?, headline?, avatarUrl? }

  if (editing) {
    try {
      const r = await api(`/api/events/${editing.id}/materials`);
      materialIds = (r.materials || []).map((m) => m.id);
    } catch { /* */ }
    try {
      const sp = await api(`/api/events/${editing.id}`);
      if (Array.isArray(sp.speakers)) speakers = sp.speakers.map((s) => ({ userId: s.userId, name: s.name, headline: s.headline || '', avatarUrl: s.avatarUrl || null, email: s.email || '' }));
    } catch { /* */ }
  }

  const title = h('input', { class: 'input lg', placeholder: 'Give it a name people will click', value: ev.title || '', maxlength: 120 });
  const desc = h('textarea', { class: 'textarea', rows: 5, placeholder: 'What’s it about? Who should come? Markdown supported.' }); desc.value = ev.description || '';
  const tags = h('input', { class: 'input', placeholder: 'faith, tech, lagos', value: (ev.tags || []).join(', ') });
  const toLocal = (d) => { if (!d) return ''; const x = new Date(d); x.setMinutes(x.getMinutes() - x.getTimezoneOffset()); return x.toISOString().slice(0, 16); };
  const starts = h('input', { class: 'input', type: 'datetime-local', value: toLocal(ev.startsAt) });
  const ends = h('input', { class: 'input', type: 'datetime-local', value: toLocal(ev.endsAt) });
  starts._voiceEnd = ends; // "tomorrow 6 to 8pm" spoken into Starts fills Ends too

  const catSel = h('select', { class: 'cat-select', 'aria-label': 'Category' });
  CATS.concat([['other', 'Other', 'sparkle']]).forEach(([k, l]) => {
    const o = h('option', { value: k }, l);
    if (k === category) o.selected = true;
    catSel.append(o);
  });
  const accessMode = h('select', { class: 'input' },
    h('option', { value: 'host_funded' }, 'Host-funded'),
    h('option', { value: 'paid_entry' }, 'Paid entry'));
  accessMode.value = meetingAccessMode;
  const meetingDuration = h('input', { class: 'input', type: 'number', min: 1, max: 720, step: 1, value: String(ev.meetingDurationMin || 60), inputmode: 'numeric' });
  const entryPrice = h('input', { class: 'input', type: 'number', min: 1, step: 1, value: String(ev.meetingEntryPriceCredits || 30), inputmode: 'numeric' });
  const paidEntryFields = h('div', { class: 'grid2', hidden: meetingAccessMode !== 'paid_entry' },
    field('Advertised duration (minutes)', 'clock', meetingDuration),
    field('Entry price (credits)', 'coin', entryPrice));
  const meetingAccess = h('div', { class: 'card pad layer col', style: { gap: '.8rem' }, hidden: category !== 'meeting' },
    field('Who pays for this meeting?', 'wallet', accessMode),
    h('p', { class: 'tiny muted' }, 'Paid-entry attendees must sign in. They are charged when you accept them. You receive 80% of entry credits after refunds are settled.'),
    paidEntryFields);
  const syncMeetingAccess = () => {
    meetingAccess.hidden = category !== 'meeting';
    if (category !== 'meeting') { meetingAccessMode = 'host_funded'; accessMode.value = 'host_funded'; }
    else meetingAccessMode = accessMode.value;
    paidEntryFields.hidden = meetingAccessMode !== 'paid_entry';
  };
  accessMode.onchange = () => { meetingAccessMode = accessMode.value; paidEntryFields.hidden = meetingAccessMode !== 'paid_entry'; };
  catSel.onchange = () => { category = catSel.value; catTouched = true; syncMeetingAccess(); preview(); };

  const visSeg = h('div', { class: 'seg' }, [['public', 'Public', 'globe'], ['unlisted', 'Unlisted', 'link'], ['private', 'Private', 'lock']].map(([v, l, ic]) =>
    h('button', { type: 'button', class: visibility === v ? 'on' : '', 'data-v': v, html: icon(ic, { size: 15 }) + l, onclick: () => { visibility = v; visSeg.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.v === v)); } })));

  const seatVal = h('strong', { style: { minWidth: '2ch', textAlign: 'center', fontSize: '1.2rem' } }, String(seats));
  // Speaker seats are capped by the host's plan (from /api/billing). The server clamps too.
  let maxSeats = 50;
  const seatInput = h('input', { type: 'hidden', name: 'speakerSeats', min: '1', max: '50', value: String(seats) });
  const seatHint = h('span', { class: 'tiny muted', hidden: true }, 'Upgrade for more seats. ', h('a', { href: '/upgrade', 'data-link': '' }, 'See plans'));
  function setSeats(n) {
    seats = Math.min(maxSeats, Math.max(1, n));
    seatVal.textContent = seats; seatInput.value = String(seats);
    seatHint.hidden = !(n > maxSeats || seats >= maxSeats) || maxSeats >= 50;
  }
  if (state.user) api('/api/billing').then((b) => { maxSeats = Math.max(1, Math.min(50, b.limits.speakerSeats || 50)); seatInput.max = String(maxSeats); setSeats(seats); }).catch(() => {});
  const stepper = h('div', { class: 'row' },
    h('button', { type: 'button', class: 'icon-btn', 'data-group': 'people', 'aria-label': 'Fewer seats', html: icon('chevronLeft'), onclick: () => setSeats(seats - 1) }),
    seatVal,
    h('button', { type: 'button', class: 'icon-btn', 'data-group': 'people', 'aria-label': 'More seats', html: icon('chevronRight'), onclick: () => setSeats(seats + 1) }),
    seatInput, seatHint);

  // Speakers picker
  const speakerChips = h('div', { class: 'row wrap', style: { gap: '.4rem' } });
  const speakerInput = h('input', { class: 'input', placeholder: 'Name, @username or email…', autocomplete: 'off' });
  const speakerSug = h('div', { class: 'suggest-list', hidden: true });
  const paintSpeakers = () => {
    speakerChips.replaceChildren(...speakers.map((s, i) => h('span', { class: 'chip-mat' },
      s.avatarUrl || s.userId ? avatar(s.name, s.avatarUrl, 'xs') : null,
      s.name + (s.email && !s.userId ? ` · ${s.email}` : ''),
      h('button', { class: 'rm', type: 'button', 'aria-label': 'Remove', onclick: () => { speakers.splice(i, 1); paintSpeakers(); } }, '−'))));
  };
  paintSpeakers();
  const searchSpeakers = debounce(async () => {
    const q = speakerInput.value.trim();
    if (q.length < 2) { speakerSug.hidden = true; return; }
    try {
      const r = await api('/api/users/search?q=' + encodeURIComponent(q));
      const users = r.users || [];
      speakerSug.replaceChildren();
      users.forEach((u) => {
        speakerSug.append(h('button', { type: 'button', onclick: () => {
          if (speakers.some((s) => s.userId === u.id)) return toast('Already added', { icon: 'info' });
          speakers.push({ userId: u.id, name: u.name, avatarUrl: u.avatarUrl || null, headline: u.handle ? '@' + u.handle : '' });
          speakerInput.value = ''; speakerSug.hidden = true; paintSpeakers();
        } }, avatar(u.name, u.avatarUrl, 'sm'), h('div', { class: 'grow' }, h('b', null, u.name), h('div', { class: 'tiny muted' }, u.handle ? '@' + u.handle : (u.email || '')))));
      });
      const isEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(q);
      if (isEmail && !users.some((u) => (u.email || '').toLowerCase() === q.toLowerCase())) {
        speakerSug.append(h('button', { type: 'button', onclick: () => {
          speakers.push({ name: q.split('@')[0], email: q.toLowerCase(), headline: 'Invited by email' });
          speakerInput.value = ''; speakerSug.hidden = true; paintSpeakers();
        } }, h('span', { class: 'ico-tile sm', html: icon('mail', { size: 16 }) }), h('div', { class: 'grow' }, h('b', null, 'Invite ' + q), h('div', { class: 'tiny muted' }, 'Will sync when they sign up'))));
      }
      if (!users.length && !isEmail) {
        speakerSug.append(h('button', { type: 'button', onclick: () => {
          speakers.push({ name: q, headline: '' });
          speakerInput.value = ''; speakerSug.hidden = true; paintSpeakers();
        } }, h('span', { class: 'ico-tile sm', html: icon('userPlus', { size: 16 }) }), h('div', { class: 'grow' }, h('b', null, 'Add “' + q + '”'), h('div', { class: 'tiny muted' }, 'Guest speaker'))));
      }
      speakerSug.hidden = !speakerSug.childNodes.length;
    } catch { speakerSug.hidden = true; }
  }, 220);
  speakerInput.addEventListener('input', searchSpeakers);
  speakerInput.addEventListener('blur', () => setTimeout(() => { speakerSug.hidden = true; }, 180));

  // Materials: searchable picker with "Upload materials" inside it.
  const matPicker = materialPicker({ selected: materialIds, onChange: (ids) => { materialIds = ids; } });

  const setTheme = (a, a2, { touched = true } = {}) => { acc = a; acc2 = a2; if (touched) themeTouched = true; swatches.querySelectorAll('.swatch').forEach((sw, i) => sw.classList.toggle('on', ACCENTS[i][1] === a)); preview(); };
  const swatches = h('div', { class: 'swatches' }, ACCENTS.map(([n, a, a2]) => h('button', { type: 'button', class: `swatch${acc === a ? ' on' : ''}`, 'data-tip': n, style: { background: `linear-gradient(135deg, ${a}, ${a2})` }, 'aria-label': n, onclick: () => setTheme(a, a2) })));
  const coverIn = h('input', { type: 'file', accept: 'image/*', class: 'hidden' });
  const prev = h('div', { class: 'ev-card card', style: { pointerEvents: 'none' } });
  function preview() {
    const [cl, ci] = catOf(category);
    prev.innerHTML = '';
    prev.append(h('div', { class: 'cover', style: { '--c1': acc, '--c2': acc2 } }, coverUrl ? h('img', { src: coverUrl, alt: '' }) : h('div', { class: 'art', html: LOGO_ART })),
      h('div', { class: 'body' }, h('span', { class: 'cat', style: { '--g': catOf(category)[2] }, html: icon(ci, { size: 13 }) + esc(cl) }), h('div', { class: 'title' }, title.value || 'Your event title')));
  }
  title.addEventListener('input', preview); preview();
  coverIn.onchange = async () => {
    const f = coverIn.files[0]; if (!f) return;
    try { const r = await uploadFile(f, { purpose: 'cover' }); coverUrl = r.url; preview(); paintCoverBtn(); toast('Cover uploaded', { icon: 'image' }); } catch (e) { toastErr(e); }
  };

  // ---- AI covers (flux-schnell, 16:9, text-free). Generated only when the host clicks "Design with AI".
  // Only the cover they pick is saved (event + Materials). Upload your own is the main option.
  const coversOn = !!state.config?.covers?.enabled;
  const coverBtn = h('button', { type: 'button', class: 'btn sm', 'data-group': 'content', html: '' });
  const paintCoverBtn = () => { coverBtn.innerHTML = icon('image', { size: 15 }) + (coverUrl ? 'Replace with your own' : 'Upload your own'); };
  paintCoverBtn(); coverBtn.onclick = () => coverIn.click();
  const genBtn = coversOn ? h('button', { type: 'button', class: 'btn sm ghost', 'data-group': 'ai', html: icon('sparkles', { size: 15 }) + 'Design with AI' }) : null;
  const coverOpts = h('div', { class: 'cover-opts', hidden: true });
  const coverNote = h('div', { class: 'tiny faint cover-quota' });
  let genBusy = false;
  let coverLimit = state.config?.covers?.dailyLimit || 10;
  let coverLeft = coverLimit;
  const paintCoverQuota = (extra) => {
    if (!coversOn) { coverNote.textContent = extra || ''; return; }
    const quota = coverLeft <= 0
      ? `No AI designs left today (${coverLimit} per day). Upload your own instead.`
      : `${coverLeft} of ${coverLimit} left today`;
    coverNote.textContent = extra ? `${extra} ${quota}` : quota;
    if (genBtn) genBtn.disabled = genBusy || coverLeft <= 0;
  };
  paintCoverQuota();
  if (coversOn) {
    api('/api/covers/config').then((c) => {
      if (typeof c.dailyLimit === 'number') coverLimit = c.dailyLimit;
      if (typeof c.left === 'number') coverLeft = c.left;
      paintCoverQuota();
    }).catch(() => {});
  }
  async function generateCovers() {
    if (!coversOn || genBusy || coverLeft <= 0) return;
    genBusy = true; if (genBtn) genBtn.disabled = true;
    const n = state.config.covers.options || 2;
    coverOpts.hidden = false;
    coverOpts.replaceChildren(...Array.from({ length: n }, () => h('div', { class: 'cover-opt skel' })));
    coverNote.textContent = 'Designing covers…';
    try {
      const r = await api('/api/covers/generate', { method: 'POST', body: { title: title.value || catOf(category)[0], description: desc.value, category, accent: acc, accent2: acc2 } });
      if (typeof r.left === 'number') coverLeft = r.left;
      coverOpts.replaceChildren(...r.options.map((o) => {
        const b = h('button', { type: 'button', class: 'cover-opt', 'aria-label': 'Use this cover' }, h('img', { src: o.url, alt: '' }), h('span', { class: 'cover-use', html: icon('check', { size: 14 }) + 'Use' }));
        b.onclick = async () => {
          coverOpts.querySelectorAll('.cover-opt').forEach((x) => x.classList.toggle('on', x === b)); b.disabled = true;
          try {
            const p = await api('/api/covers/pick', { method: 'POST', body: { token: o.token, title: title.value || 'Event' } });
            coverUrl = p.url; preview(); paintCoverBtn();
            toast(p.materialId ? 'Cover set and saved to your Materials' : 'Cover set', { icon: 'image', group: 'content' });
          } catch (e) { toastErr(e); b.classList.remove('on'); } finally { b.disabled = false; }
        };
        return b;
      }));
      if (genBtn) genBtn.innerHTML = icon('refresh', { size: 15 }) + 'Regenerate';
      paintCoverQuota('Pick one to use it.');
    } catch (e) {
      coverOpts.hidden = true;
      paintCoverQuota();
      toastErr(e);
    } finally { genBusy = false; if (genBtn) genBtn.disabled = coverLeft <= 0; }
  }
  if (genBtn) genBtn.onclick = () => generateCovers();

  const aiBtn = h('button', { type: 'button', class: 'btn sm', 'data-group': 'ai', html: icon('sparkles', { size: 15 }) + 'Write it for me' });

  function askEventNotes(seed = '') {
    return new Promise((resolve) => {
      let done = false;
      const s = sheet({ title: 'Tell us about your event', icon: 'sparkles', group: 'ai', onClose: () => { if (!done) resolve(null); } });
      s.el.previousElementSibling?.classList.add('heavy');
      const box = h('textarea', { class: 'textarea tell-notes no-vmic', rows: 8, maxlength: 4000, placeholder: "What's it about, who's it for, when and where, who's speaking, anything special?" });
      box.value = seed;
      const mic = h('button', { type: 'button', class: 'icon-btn tell-mic', 'aria-label': 'Voice typing', 'data-tip': 'Voice typing', html: icon('mic', { size: 18 }) });
      mic.addEventListener('mousedown', (e) => e.preventDefault());
      const paintMic = () => mic.classList.toggle('on', isListening(box));
      mic.onclick = () => { if (isListening(box)) { stopListening(box, 'user'); paintMic(); return; } box.focus(); listenOn(box, { keepTyping: true, onStart: paintMic, onEnd: paintMic }); };
      const go = () => {
        const t = box.value.trim();
        if (!t) return toast('Tell us a little about the event first', { icon: 'info' });
        done = true; resolve(t); s.close();
      };
      s.body.append(
        h('p', { class: 'muted small', style: { margin: '0 0 .7rem' } }, 'A few sentences is enough — we will draft the title, description, category, tags, colours, and any date, time or place we can pick out.'),
        h('div', { class: 'tell-box' }, box, mic),
        h('div', { class: 'row', style: { justifyContent: 'flex-end', marginTop: '1rem', gap: '.5rem' } },
          h('button', { type: 'button', class: 'btn ghost', onclick: () => s.close() }, 'Cancel'),
          h('button', { type: 'button', class: 'btn primary', onclick: go, html: icon('sparkles', { size: 16 }) + 'Write it for me' })),
      );
      setTimeout(() => box.focus(), 80);
    });
  }

  function applyDraft(r, apply) {
    if (apply.title && r.title) title.value = r.title;
    if (apply.description && r.description) desc.value = r.description;
    if (apply.tags && Array.isArray(r.tags) && r.tags.length) tags.value = r.tags.join(', ');
    if (apply.category && r.category) { category = r.category; catSel.value = r.category; catTouched = true; syncMeetingAccess(); }
    if (apply.theme && r.theme && r.theme.accent) setTheme(r.theme.accent, r.theme.accent2);
    if (apply.starts && r.start) starts.value = r.start;
    if (apply.ends && r.end) ends.value = r.end;
    if (apply.venue && r.venue) {
      const place = String(r.venue).trim();
      if (place && !desc.value.toLowerCase().includes(place.toLowerCase())) {
        desc.value = (desc.value.trim() ? desc.value.trim() + '\n\n' : '') + 'Where: ' + place;
      }
    }
    preview();
  }

  function showDraftPreview(r, { notes }) {
    return new Promise((resolve) => {
      let done = false;
      const s = sheet({ title: 'Review this draft', icon: 'sparkles', group: 'ai', wide: true, onClose: () => { if (!done) resolve(false); } });
      s.el.previousElementSibling?.classList.add('heavy');
      const filled = {
        title: !!title.value.trim(),
        description: !!desc.value.trim(),
        tags: !!tags.value.trim(),
        category: catTouched,
        theme: themeTouched,
        starts: !!starts.value,
        ends: !!ends.value,
        venue: !!(r.venue && desc.value.toLowerCase().includes(String(r.venue).toLowerCase())),
      };
      const tIn = h('input', { class: 'input', value: r.title || '', maxlength: 120 });
      const dIn = h('textarea', { class: 'textarea', rows: 5 }); dIn.value = r.description || '';
      const tagsIn = h('input', { class: 'input', value: (r.tags || []).join(', ') });
      const catIn = h('select', { class: 'cat-select', 'aria-label': 'Category' });
      CATS.concat([['other', 'Other', 'sparkle']]).forEach(([k, l]) => {
        const o = h('option', { value: k }, l);
        if (k === (r.category || category)) o.selected = true;
        catIn.append(o);
      });
      const startIn = h('input', { class: 'input', type: 'datetime-local', value: r.start || '' });
      const endIn = h('input', { class: 'input', type: 'datetime-local', value: r.end || '' });
      const venueIn = h('input', { class: 'input', value: r.venue || '', placeholder: 'If we picked out a place' });
      const themeName = r.theme?.name || (ACCENTS.find((a) => a[1] === r.theme?.accent) || [])[0] || 'Colours';
      const themeSwatch = r.theme?.accent
        ? h('div', { class: 'swatch on', style: { background: `linear-gradient(135deg, ${r.theme.accent}, ${r.theme.accent2 || r.theme.accent})` }, 'aria-label': themeName })
        : h('span', { class: 'tiny faint' }, 'No colour suggested');
      const checks = {};
      const row = (key, label, el, ic) => {
        const already = !!filled[key];
        const c = h('input', { type: 'checkbox', checked: !already });
        checks[key] = c;
        const hint = already ? h('label', { class: 'draft-chk' }, c, `Replace the ${label.toLowerCase()} I already filled`) : h('span', { hidden: true }, c);
        return field(label, ic, h('div', { class: 'col', style: { gap: '.35rem' } }, el, hint));
      };
      const useThis = () => {
        const apply = {};
        for (const k of Object.keys(checks)) apply[k] = checks[k].checked;
        applyDraft({
          title: tIn.value, description: dIn.value,
          tags: tagsIn.value.split(',').map((x) => x.trim()).filter(Boolean),
          category: catIn.value, theme: r.theme,
          start: startIn.value, end: endIn.value, venue: venueIn.value.trim(),
        }, apply);
        done = true; s.close(); resolve('use');
        toast(r.mock ? 'AI demo mode — add RunPod keys for real suggestions' : 'Drafted with AI', { icon: 'sparkles', group: 'ai' });
      };
      s.body.append(
        h('p', { class: 'muted small', style: { margin: '0 0 .8rem' } }, 'Edit anything you like. Fields you already filled are left alone unless you tick the box.'),
        row('title', 'Title', tIn, 'type'),
        row('description', 'Description', dIn, 'notes'),
        row('category', 'Category', catIn, 'tag'),
        row('tags', 'Tags', tagsIn, 'hash'),
        row('theme', 'Event colours', h('div', { class: 'row', style: { gap: '.5rem', alignItems: 'center' } }, themeSwatch, h('span', { class: 'small' }, themeName)), 'palette'),
        h('div', { class: 'grid2' }, row('starts', 'Starts', startIn, 'calendar'), row('ends', 'Ends', endIn, 'clock')),
        row('venue', 'Venue', venueIn, 'pin'),
        h('div', { class: 'row wrap draft-actions' },
          h('button', { type: 'button', class: 'btn primary', onclick: useThis }, 'Use this'),
          h('button', { type: 'button', class: 'btn', onclick: () => { done = true; s.close(); resolve({ retry: true, notes }); } }, 'Try again'),
          h('button', { type: 'button', class: 'btn ghost', onclick: () => { done = true; s.close(); resolve({ edit: true, notes }); } }, 'Edit')),
      );
    });
  }

  aiBtn.onclick = async () => {
    aiBtn.disabled = true;
    try {
      let notes = null;
      let ask = !isRichInput(title.value, desc.value);
      while (true) {
        if (ask) {
          notes = await askEventNotes(notes || '');
          if (!notes) return;
        } else {
          notes = notes || [title.value, desc.value].filter((x) => String(x).trim()).join('\n');
        }
        const r = await api('/api/ai/title', { method: 'POST', body: { notes, category, tzOffset: new Date().getTimezoneOffset(), now: new Date().toISOString() } });
        const outcome = await showDraftPreview(r, { notes });
        if (outcome === 'use' || outcome === false) return;
        if (outcome && outcome.retry) { ask = false; continue; }
        if (outcome && outcome.edit) { ask = true; continue; }
        return;
      }
    } catch (e) { toastErr(e); } finally { aiBtn.disabled = false; }
  };

  const submit = h('button', { class: 'btn primary lg', type: 'submit', html: icon(editing ? 'check' : 'calendarPlus', { size: 18 }) + (editing ? 'Save changes' : 'Publish event') });
  const liveNow = editing ? null : h('button', { type: 'button', class: 'btn lg', 'data-group': 'engage', html: icon('radio', { size: 18 }) + 'Publish & go live' });

  const body = () => ({
    title: title.value, description: desc.value, category, visibility, tags: tags.value,
    speakerSeats: seats, theme: { accent: acc, accent2: acc2 }, coverUrl,
    startsAt: starts.value ? new Date(starts.value).toISOString() : null,
    endsAt: ends.value ? new Date(ends.value).toISOString() : null,
    speakers: speakers.map((s) => ({ userId: s.userId || null, name: s.name, headline: s.headline || null, avatarUrl: s.avatarUrl || null, email: s.email || null })),
    meetingAccessMode: category === 'meeting' ? meetingAccessMode : 'host_funded',
    meetingDurationMin: category === 'meeting' && meetingAccessMode === 'paid_entry' ? Number(meetingDuration.value) : null,
    meetingEntryPriceCredits: category === 'meeting' && meetingAccessMode === 'paid_entry' ? Number(entryPrice.value) : null,
  });

  async function save(goLive) {
    try {
      const r = editing
        ? await api(`/api/events/${editing.id}`, { method: 'PATCH', body: body() })
        : await api('/api/events', { method: 'POST', body: body() });
      if (materialIds.length || editing) {
        await api(`/api/events/${r.id}/materials`, { method: 'PUT', body: { materialIds } }).catch((e) => reportClientError('event-materials', new Error(`Event saved, but its materials could not be attached: ${e.message || 'unknown error'}`), { step: 'attach', pages: materialIds.length }));
      }
      if (speakers.length && !editing) {
        await api(`/api/events/${r.id}/speakers`, { method: 'PUT', body: { speakers: body().speakers } }).catch(() => {});
      }
      toast(editing ? 'Saved' : 'Event published', { icon: 'check', group: 'engage' });
      if (goLive) {
        sessionStorage.setItem('venue.intent', JSON.stringify({ create: true, eventId: r.id, name: r.title, stage: category !== 'meeting', speakerSeats: seats, code: r.code, meetingAccessMode: r.meetingAccessMode, meetingDurationMin: r.meetingDurationMin, meetingEntryPriceCredits: r.meetingEntryPriceCredits }));
        navigate('/' + String(r.code).toLowerCase());
      } else navigate(`/e/${r.slug}`);
    } catch (e) { toastErr(e); }
  }
  if (liveNow) liveNow.onclick = () => save(true);

  const form = h('form', { class: 'col', style: { gap: '1.1rem' }, onsubmit: (e) => { e.preventDefault(); save(false); } },
    h('div', { class: 'card pad layer col', style: { gap: '1rem' } },
      field('Title', 'type', title, aiBtn),
      field('Description', 'notes', desc),
      field('Category', 'tag', catSel),
      field('Tags', 'hash', tags)),
    meetingAccess,
    h('div', { class: 'card pad layer col has-suggest', style: { gap: '1rem' } },
      h('div', { class: 'grid2' }, field('Starts', 'calendar', starts), field('Ends', 'clock', ends)),
      field('Visibility', 'eye', visSeg),
      field('Speaker seats', 'stage', h('div', { class: 'col has-suggest', style: { gap: '.6rem' } },
        h('div', { class: 'row between wrap' }, h('div', { class: 'tiny faint' }, 'Everyone else watches and can request to speak.'), stepper),
        h('div', { class: 'suggest-box' }, speakerInput, speakerSug),
        speakerChips,
      ))),
    h('div', { class: 'card pad layer col has-suggest', style: { gap: '1rem' } },
      field('Event colours', 'palette', swatches),
      field('Cover', 'image', h('div', { class: 'col cover-step', style: { gap: '.6rem' } },
        h('div', { class: 'row wrap', style: { gap: '.5rem' } }, coverBtn, genBtn, coverIn),
        coverOpts, coverNote)),
      field('Materials', 'folder', matPicker.el)),
    h('div', { class: 'row wrap', style: { gap: '.6rem' } }, submit, liveNow));

  view.append(
    h('div', { class: 'page-head' }, h('h1', { html: icon(editing ? 'pen' : 'calendarPlus', { size: 28 }) + (editing ? 'Edit event' : 'Create an event') })),
    h('div', { class: 'split' }, form, h('aside', { class: 'sticky col' },
      h('div', { class: 'preview-label' },
        h('span', { class: 'preview-eye', html: icon('eye', { size: 14 }) }),
        h('span', null, 'Preview')),
      prev,
      h('div', { class: 'card pad layer small muted' }, h('strong', null, 'Just need a quick call? '), h('a', { href: '/create?instant=1', 'data-link': '', style: { color: '#2563eb', fontWeight: '700' } }, 'Start an instant meeting')))));
}

// /create?instant=1 opened directly (bookmark, shared link, old PWA shortcut): show the home page
// blurred underneath the Instant meeting overlay. In-app links never get here (app.js opens the overlay).
async function instantDeepLink(view) {
  document.title = 'Instant meeting — 1venue';
  const home = await import('./home.js');
  const bg = await home.mount(view, {});
  const { openInstant } = await import('../instant.js');
  const ov = openInstant({ onClose: ({ starting }) => { if (!starting && /^\/create\/?$/.test(location.pathname)) navigate('/', { replace: true }); } });
  return { unmount() { ov?.close?.({ starting: true }); (bg || home).unmount?.(); } };
}
