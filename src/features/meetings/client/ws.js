// Banner + countdown when an admin starts an end-in-2-min warning.
import { onMessage } from '/js/room/registry.js';
import { h, api, toast, toastErr } from '/js/ui.js';

function fmtLeft(ms) {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
}

function rootOf(R) {
  return R.root || R.view && R.view.querySelector('.room') || R.view;
}

function stopTimer(R) {
  if (R._endWarnTimer) { clearInterval(R._endWarnTimer); R._endWarnTimer = null; }
}

function hideBanner(R) {
  stopTimer(R);
  R.endWarning = null;
  if (R.endWarnEl) R.endWarnEl.hidden = true;
}

function ensureBanner(R) {
  if (R.endWarnEl && R.endWarnEl.isConnected) return R.endWarnEl;
  const el = h('div', { class: 'end-warn-banner', hidden: true, role: 'status' });
  const root = rootOf(R);
  if (root && R.headEl && R.headEl.parentNode === root) root.insertBefore(el, R.headEl.nextSibling);
  else if (root) root.insertBefore(el, root.firstChild);
  R.endWarnEl = el;
  return el;
}

function paint(R) {
  const w = R.endWarning;
  const el = ensureBanner(R);
  if (!w || !w.deadlineMs) { hideBanner(R); return; }
  const left = Math.max(0, w.deadlineMs - Date.now());
  const clock = fmtLeft(left);
  el.hidden = false;
  el.replaceChildren(
    h('p', { class: 'end-warn-msg' },
      'This meeting will end in ', h('strong', { class: 'end-warn-clock' }, clock),
      '. Tap We are still here to keep it live'),
    h('button', {
      type: 'button',
      class: 'btn sm primary end-warn-keep',
      onclick: async () => {
        try {
          if (R.send) R.send('keep-alive', {});
          else await api(`/api/meeting/${R.code}/keep`, { method: 'POST' });
        } catch (e) { toastErr(e); }
      },
    }, 'We are still here')
  );
  if (left <= 0) stopTimer(R);
}

function startCountdown(R, deadlineMs) {
  R.endWarning = { deadlineMs: Number(deadlineMs) };
  stopTimer(R);
  paint(R);
  R._endWarnTimer = setInterval(() => paint(R), 250);
}

onMessage('end-warning', (R, m) => {
  startCountdown(R, m.deadlineMs);
  return false;
});

onMessage('end-warning-cancelled', (R, m) => {
  hideBanner(R);
  toast(m.kept ? 'The meeting is staying live' : 'The end countdown was cancelled', { icon: 'check', group: 'room' });
  return false;
});
