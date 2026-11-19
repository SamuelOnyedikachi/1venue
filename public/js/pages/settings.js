import { icon } from '../icons.js';
import { h, esc, toast } from '../ui.js';
import { state, setPrefs, ACCENTS, FONT_SIZES, loginUrl } from '../app.js';
import { promptInstall, canInstall } from '../pwa.js';
import { translationSelect } from './bible.js';
import { accountCard, deleteAccountCard } from './account.js';
import { voicePrefs } from '../voice.js';

const CAPTION_LANGS = [['', 'Auto-detect'], ['en', 'English (Nigerian)'], ['yo', 'Yorùbá'], ['ig', 'Igbo'], ['ha', 'Hausa'], ['pcm', 'Naija Pidgin']];
let onPrefsChange = null;

export async function mount(view) {
  unmount();
  view.classList.add('settings-view');
  const P = () => state.prefs;
  const row = (ic, g, title, hint, control, id, cls = '') => h('div', { class: ('set-row ' + cls).trim(), id }, h('span', { class: 'ico', style: { '--g': `var(--g-${g})` }, html: icon(ic) }), h('div', { class: 'grow' }, h('div', { style: { fontWeight: 650 } }, title), hint ? h('div', { class: 'tiny faint' }, hint) : null), control);
  const seg = (opts, get, set) => { const s = h('div', { class: 'seg', role: 'group' }); const paint = () => s.querySelectorAll('button').forEach((b) => { const on = b.dataset.v === String(get()); b.classList.toggle('on', on); b.setAttribute('aria-pressed', String(on)); }); opts.forEach(([v, l, ic]) => s.append(h('button', { 'data-v': String(v), html: (ic ? icon(ic, { size: 15 }) : '') + esc(l), onclick: () => { set(v); paint(); } }))); paint(); return s; };
  const toggle = (get, set) => { const i = h('input', { type: 'checkbox', checked: !!get() }); i.onchange = () => set(i.checked); return h('label', { class: 'switch' }, i, h('span')); };
  const themeSeg = seg([['light', 'Light', 'sun'], ['dark', 'Dark', 'moon'], ['system', 'Auto', 'sliders']], () => P().theme, (v) => setPrefs({ theme: v }));
  const fontSeg = seg(FONT_SIZES.map(([l, v]) => [v, l]), () => P().fontScale || 1, (v) => setPrefs({ fontScale: v }));
  fontSeg.classList.add('text-size-seg');
  const motionToggle = toggle(() => P().reduceMotion, (v) => setPrefs({ reduceMotion: v }));
  const swatches = h('div', { class: 'swatches' }, ACCENTS.map(([n, a, a2]) => h('button', { class: `swatch${P().accent === a ? ' on' : ''}`, 'data-accent': a, 'data-tip': n, 'aria-label': n, 'aria-pressed': String(P().accent === a), style: { background: `linear-gradient(135deg, ${a}, ${a2})` }, onclick: () => setPrefs({ accent: a, accent2: a2 }) })));
  const custom = h('input', { type: 'color', value: P().accent || '#2563eb', 'aria-label': 'Custom accent', 'data-tip': 'Custom colour' });
  custom.oninput = () => setPrefs({ accent: custom.value, accent2: null });
  const sample = h('p', { class: 'muted', style: { marginTop: '.5rem' } }, 'The quick brown fox joins the 9 o’clock seminar.');
  const fontLbl = h('span', { class: 'kbd' }, Math.round((P().fontScale || 1) * 100) + '%');
  const range = h('input', { type: 'range', min: 0.8, max: 1.5, step: 0.02, value: P().fontScale || 1, 'aria-label': 'Text size', style: { width: '100%' } });
  range.oninput = () => { setPrefs({ fontScale: Number(range.value) }); fontLbl.textContent = Math.round(range.value * 100) + '%'; };
  const capSel = h('select', { class: 'input sm' }, CAPTION_LANGS.map(([v, l]) => h('option', { value: v, selected: (P().captionLang || '') === v }, l)));
  capSel.onchange = () => { setPrefs({ captionLang: capSel.value || null }); toast('Speech language saved', { icon: 'captions', group: 'ai' }); };
  const card = (title, ic, ...kids) => h('section', { class: 'card pad layer set-card' }, h('h2', { class: 'set-h', html: icon(ic, { size: 20 }) + esc(title) }), ...kids);
  view.append(h('div', { class: 'page-head' }, h('h1', { html: icon('settings', { size: 28 }) + 'Settings' })),
    h('div', { class: 'set-grid' },
      card('Appearance', 'palette',
        row('sun', 'settings', 'Theme', 'Light, dark or follow your device', themeSeg, 'theme', 'set-row-stack'),
        row('palette', 'settings', 'Accent colour', 'Used for buttons, highlights, your QR codes and events', custom),
        swatches,
        row('activity', 'settings', 'Reduce motion', 'Calmer transitions and fewer animations', motionToggle)),
      card('Text size', 'type',
        h('p', { class: 'tiny faint' }, 'Replaces browser zoom shortcuts - layout stays crisp at every size.'),
        fontSeg,
        h('div', { class: 'row', style: { marginTop: '.8rem' } }, h('span', { html: icon('type', { size: 14 }) }), range, h('span', { html: icon('type', { size: 22 }) }), fontLbl), sample),
      card('Bible', 'bookOpen',
        row('languages', 'faith', 'Default translation', 'Used in the reader and for scripture shown during events', translationSelect(P().bibleTranslation || 'eng_kjv', (v) => { setPrefs({ bibleTranslation: v }); toast('Translation saved', { icon: 'bookOpen', group: 'faith' }); }, { compact: true }), 'bible')),
      card('Voice & captions', 'captions',
        row('mic', 'ai', 'Voice typing', 'A small mic appears when you hover or tap into a text box. Tap it to dictate, tap again to stop; you can keep typing while it listens (Whisper on Replicate, or your browser’s speech service). Never in password, email, phone or code fields. This device only.', toggle(() => voicePrefs.enabled, (v) => { voicePrefs.set(v); toast(v ? 'Voice typing on' : 'Voice typing off', { icon: v ? 'mic' : 'micOff', group: 'ai' }); }), 'voice'),
        row('captions', 'ai', 'Speech language', 'A hint for voice typing and captions. Auto-detect works for most people; pick one if words come out in the wrong language.', capSel, 'captions'),
        row('download', 'content', 'Recordings', 'Recordings stay on your device - they are never uploaded', h('span', { class: 'chip' }, 'Local only'))),
      card('App', 'install',
        row('install', 'nav', 'Install 1venue', canInstall() ? 'Full-screen, faster, works offline' : 'Already installed or not supported in this browser', h('button', { class: 'btn sm', onclick: promptInstall }, 'Install')),
        row('keyboard', 'nav', 'Command bar', 'Press / or Ctrl K anywhere - every feature and setting is searchable', h('span', { class: 'kbd' }, '/'))),
      state.user ? null : card('Account', 'user', row('login', 'nav', 'Not signed in', 'Sign in to use your account here', h('a', { class: 'btn sm primary', href: loginUrl('/settings'), 'data-link': '' }, 'Sign in'))),
      card('About', 'info',
        row('shield', 'admin', 'Privacy policy', 'How 1venue uses your information', h('a', { class: 'btn sm', href: '/privacy' }, 'Read')),
        row('file', 'admin', 'Terms of service', 'The rules for using 1venue', h('a', { class: 'btn sm', href: '/terms' }, 'Read')))));
  const syncPrefs = () => {
    const prefs = P();
    const syncSegment = (segment, value) => segment.querySelectorAll('button').forEach((button) => {
      const on = button.dataset.v === String(value);
      button.classList.toggle('on', on);
      button.setAttribute('aria-pressed', String(on));
    });
    syncSegment(themeSeg, prefs.theme);
    syncSegment(fontSeg, prefs.fontScale || 1);
    swatches.querySelectorAll('.swatch').forEach((button) => {
      const on = button.dataset.accent === prefs.accent;
      button.classList.toggle('on', on);
      button.setAttribute('aria-pressed', String(on));
    });
    custom.value = /^#[\da-f]{6}$/i.test(prefs.accent || '') ? prefs.accent : '#2563eb';
    range.value = prefs.fontScale || 1;
    fontLbl.textContent = Math.round(Number(range.value) * 100) + '%';
    capSel.value = prefs.captionLang || '';
    motionToggle.querySelector('input').checked = !!prefs.reduceMotion;
  };
  onPrefsChange = syncPrefs;
  window.addEventListener('prefs', onPrefsChange);
  syncPrefs();
  if (state.user) {
    const { autoTopupCard, billingProfileCard } = await import('./settings-billing.js');
    view.querySelector('.set-grid').append(autoTopupCard(card, row), billingProfileCard(card, row));
    await accountCard(card, row).then((sec) => view.querySelector('.set-grid').append(sec)).catch(() => {});
    await deleteAccountCard(card).then((sec) => { if (sec) view.querySelector('.set-grid').append(sec); }).catch(() => {});
  }
  if (location.hash) setTimeout(() => { const el = document.getElementById(location.hash.slice(1)); if (el) { el.scrollIntoView({ block: 'center', behavior: 'smooth' }); el.classList.add('flash'); } }, 120);
}

export function unmount() {
  if (onPrefsChange) window.removeEventListener('prefs', onPrefsChange);
  onPrefsChange = null;
}
