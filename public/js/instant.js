// Instant meeting setup as an overlay over the current (blurred) page - same shell as the log-in overlay
// (.au-scrim / .au-modal). Opens from anywhere: hero / dashboard links to /create?instant=1 are
// intercepted in app.js, and the command bar calls openInstant() directly.
import { icon } from './icons.js';
import { h, toast } from './ui.js';
import { state, navigate, requireLogin } from './app.js';

let open = null;

export function openInstant({ onClose } = {}) {
  if (open) { open.focus(); return open; }
  const prevFocus = document.activeElement;
  const defName = state.user ? `${(state.user.displayName || state.user.username || 'My').split(' ')[0]}’s meeting` : 'Quick meeting';
  const nameIn = h('input', { class: 'au-pill pj-field', type: 'text', maxlength: 120, autocomplete: 'off', placeholder: 'Meeting name', value: defName, enterkeyhint: 'go', 'data-voice': 'off', 'aria-label': 'Meeting name' });
  const opts = { stage: false, waitingRoom: false, accessMode: 'host_funded' };

  const duration = h('input', { class: 'input', type: 'number', min: 1, max: 720, step: 1, value: '60', inputmode: 'numeric' });
  const entryPrice = h('input', { class: 'input', type: 'number', min: 1, step: 1, value: '30', inputmode: 'numeric' });
  const paidEntry = h('div', { class: 'col im-paid', hidden: true },
    h('div', { class: 'grid2' },
      h('label', { class: 'field' }, h('span', { class: 'field-lab' }, 'Advertised duration (minutes)'), duration),
      h('label', { class: 'field' }, h('span', { class: 'field-lab' }, 'Entry price (credits)'), entryPrice)),
    h('p', { class: 'tiny muted' }, 'Attendees sign in and pay when you accept them. You receive 80% of entry credits after refunds are settled.'));

  const fundIc = h('span', { class: 'im-tog-ic' });
  const fundLab = h('span', { class: 'im-tog-lab' }, 'Host funded');
  const fundBtn = h('button', { class: 'im-tog on', type: 'button', 'aria-label': 'Host funded' }, fundIc);
  const paintFund = () => {
    const paid = opts.accessMode === 'paid_entry';
    fundIc.innerHTML = icon(paid ? 'users' : 'user', { size: 22 });
    fundLab.textContent = paid ? 'Participant funded' : 'Host funded';
    fundBtn.setAttribute('aria-label', fundLab.textContent);
    paidEntry.hidden = !paid;
  };
  fundBtn.onclick = () => {
    opts.accessMode = opts.accessMode === 'host_funded' ? 'paid_entry' : 'host_funded';
    paintFund();
  };
  paintFund();
  const fund = h('div', { class: 'im-tog-wrap im-tog-fund' }, fundBtn, fundLab);

  const flag = (key, ic, label) => {
    const badge = h('span', { class: 'im-tog-badge', html: icon('xCircle', { size: 14 }) });
    const btn = h('button', { class: 'im-tog', type: 'button', 'aria-pressed': 'false', 'aria-label': label }, badge, h('span', { class: 'im-tog-ic', html: icon(ic, { size: 22 }) }));
    const wrap = h('div', { class: 'im-tog-wrap' }, btn, h('span', { class: 'im-tog-lab' }, label));
    const paint = () => {
      const on = !!opts[key];
      wrap.classList.toggle('on', on);
      btn.classList.toggle('on', on);
      btn.setAttribute('aria-pressed', String(on));
      badge.innerHTML = icon(on ? 'checkCircle' : 'xCircle', { size: 14 });
    };
    btn.onclick = () => { opts[key] = !opts[key]; paint(); };
    paint();
    return wrap;
  };

  const start = h('button', { class: 'au-btn au-primary', type: 'submit', html: icon('zap', { size: 18 }) + '<span>Start now</span>' });
  const form = h('form', { class: 'au-form', novalidate: true },
    nameIn,
    h('div', { class: 'im-togs' }, fund, flag('stage', 'stage', 'Stage mode'), flag('waitingRoom', 'door', 'Waiting room')),
    paidEntry,
    start);
  form.onsubmit = (e) => {
    e.preventDefault();
    const n = nameIn.value.trim();
    if (!n) { nameIn.focus(); return toast('Give your meeting a name.', { icon: 'alert' }); }
    if (opts.accessMode === 'paid_entry' && !requireLogin('Sign in to host a paid-entry meeting')) return;
    if (opts.accessMode === 'paid_entry' && (!Number.isInteger(Number(duration.value)) || Number(duration.value) < 1 || Number(duration.value) > 720 || !Number.isSafeInteger(Number(entryPrice.value)) || Number(entryPrice.value) < 1)) return toast('Enter a duration from 1 to 720 minutes and a positive whole-credit entry price.', { icon: 'alert' });
    sessionStorage.setItem('venue.intent', JSON.stringify({ create: true, name: n, stage: opts.stage, waitingRoom: opts.waitingRoom, meetingAccessMode: opts.accessMode, meetingDurationMin: Number(duration.value), meetingEntryPriceCredits: Number(entryPrice.value) }));
    close({ starting: true });
    navigate('/new');
  };

  const scrim = h('div', { class: 'au-scrim im-scrim' });
  const closeBtn = h('button', { class: 'icon-btn au-x', type: 'button', 'aria-label': 'Close', html: icon('x', { size: 20 }) });
  const modal = h('div', { class: 'au-modal im-modal', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'im-title' },
    closeBtn,
    h('div', { class: 'au-body' },
      h('div', { class: 'im-badge', html: icon('zap', { size: 26 }) }),
      h('h2', { class: 'au-title', id: 'im-title' }, 'Instant meeting'),
      form));

  function close({ starting = false } = {}) {
    if (!open) return;
    open = null;
    document.removeEventListener('keydown', onKey, true);
    window.removeEventListener('popstate', onPop);
    modal.classList.add('out'); scrim.classList.add('out');
    setTimeout(() => { modal.remove(); scrim.remove(); }, 200);
    document.documentElement.classList.remove('au-lock');
    if (!starting) prevFocus?.focus?.();
    onClose?.({ starting });
  }
  const onPop = () => close({ starting: true });
  const onKey = (e) => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); return; }
    if (e.key === 'Tab') {
      const f = [...modal.querySelectorAll('a[href],button:not([disabled]),input:not([type=hidden]),select,textarea')].filter((x) => x.offsetParent || x.closest('.switch'));
      if (!f.length) return;
      const i = f.indexOf(document.activeElement);
      if (e.shiftKey && i <= 0) { e.preventDefault(); f[f.length - 1].focus(); } else if (!e.shiftKey && i === f.length - 1) { e.preventDefault(); f[0].focus(); }
    }
  };
  scrim.onclick = () => close();
  closeBtn.onclick = () => close();
  document.body.append(scrim, modal);
  document.documentElement.classList.add('au-lock');
  document.addEventListener('keydown', onKey, true);
  window.addEventListener('popstate', onPop);
  setTimeout(() => { nameIn.focus(); nameIn.select(); }, 40);
  open = { close, el: modal, focus: () => nameIn.focus() };
  return open;
}
export const instantOpen = () => !!open;
export const closeInstant = () => open?.close();
