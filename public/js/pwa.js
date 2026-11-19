// PWA install: captures beforeinstallprompt and always shows a fixed overlay
// mounted at the end of <body> (never in the page flow under the hero).
import { LOGO, icon } from './icons.js';
import { h, sheet, toast } from './ui.js';

let deferred = null;
const KEY = 'venue.install.dismissed';
const isStandalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const isIOS = () => /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const snoozed = () => Date.now() - Number(localStorage.getItem(KEY) || 0) < 3 * 86400e3;
export const canInstall = () => !isStandalone() && (!!deferred || isIOS());

/** Fixed overlay host at the end of body. Created if the HTML shell omitted it. */
export function installRoot() {
  let root = document.getElementById('install-root');
  if (!root) {
    root = document.createElement('div');
    root.id = 'install-root';
    document.body.append(root);
  }
  return root;
}

export function initPwa() {
  window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); deferred = e; setTimeout(() => maybeShowBanner('first-visit'), 6000); });
  window.addEventListener('appinstalled', () => { deferred = null; clearBanner(); toast('1venue installed', { icon: 'check' }); });
  if (isIOS() && !isStandalone()) setTimeout(() => maybeShowBanner('first-visit'), 8000);
}

function clearBanner() {
  const root = document.getElementById('install-root');
  if (root) { root.replaceChildren(); root.classList.remove('has-banner'); root.hidden = true; }
}

export function maybeShowBanner(reason = '') {
  if (!canInstall() || snoozed() || document.body.classList.contains('in-room')) return;
  const root = installRoot();
  if (root.querySelector('.install')) return;
  root.hidden = false;
  root.classList.add('has-banner');
  root.append(banner(reason));
}

/** @deprecated Kept so old callers do not crash; always returns null (overlay only). */
export function inlineBanner() { return null; }

function banner(reason) {
  const copy = reason === 'after-room' ? 'Rejoin faster next time - install 1venue.' : reason === 'dashboard' ? 'Get live alerts and one-tap joining.' : 'Faster, full-screen, works offline.';
  const el = h('div', { class: 'install', role: 'dialog', 'aria-label': 'Install app', 'aria-live': 'polite' },
    h('div', { class: 'logo-tile', html: LOGO(30) }),
    h('div', { class: 'grow' }, h('strong', null, 'Install 1venue'), h('div', { class: 'small', style: { opacity: '.85' } }, copy)),
    h('button', { class: 'btn sm', type: 'button', onclick: () => { promptInstall(); } }, isIOS() && !deferred ? 'How to' : 'Install'),
    h('button', { class: 'icon-btn x', type: 'button', 'aria-label': 'Dismiss', html: icon('x', { size: 18 }), onclick: () => { localStorage.setItem(KEY, Date.now()); clearBanner(); } }));
  return el;
}
export async function promptInstall() {
  if (isStandalone()) return toast('1venue is already installed', { icon: 'check' });
  if (deferred) { deferred.prompt(); const r = await deferred.userChoice.catch(() => null); deferred = null; clearBanner(); if (r?.outcome === 'dismissed') localStorage.setItem(KEY, Date.now()); return; }
  const s = sheet({ title: 'Install 1venue', icon: 'install' });
  const steps = isIOS()
    ? [['share', 'Tap the Share button in Safari’s toolbar'], ['plus', 'Scroll and choose “Add to Home Screen”'], ['check', 'Tap “Add” - 1venue opens full-screen like a native app']]
    : [['moreV', 'Open your browser menu (⋮ or ⋯)'], ['install', 'Choose “Install app” or “Add to Home screen”'], ['check', 'Launch 1venue from your home screen or dock']];
  s.body.append(h('div', { class: 'layer' }, steps.map(([ic, t], i) => h('div', { class: 'set-row' }, h('span', { class: 'ico', style: { '--g': 'var(--accent)' }, html: icon(ic) }), h('span', null, h('strong', null, `${i + 1}. `), t)))));
}
