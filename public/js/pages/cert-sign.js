import { h, I, api, toast, toastErr } from '../ui.js';
import { state } from '../app.js';

export async function mount(view, params) {
  const token = String(params.token || '');
  document.title = 'Sign certificate · 1venue';
  const box = h('div', { class: 'cert-sign-page' }, h('p', { class: 'muted' }, 'Loading signature request…'));
  view.append(box);

  let data;
  try { data = await api('/api/certs/sign/' + encodeURIComponent(token)); }
  catch (e) {
    box.replaceChildren(h('div', { class: 'cert-verify-card' }, h('h1', null, 'Link not valid'), h('p', { class: 'muted' }, e.message || 'This signature invitation may have expired.')));
    return;
  }
  const req = data.request;
  const viewerId = data.viewerId || (state.user && state.user.id);
  if (viewerId && Number(viewerId) !== Number(req.userId)) {
    box.replaceChildren(h('div', { class: 'cert-verify-card' },
      h('h1', null, 'Wrong account'),
      h('p', { class: 'muted' }, 'This invitation was sent to @' + (req.username || 'another user') + '. Sign in as that account to continue.')));
    return;
  }

  const canvas = h('canvas', { class: 'cert-pad', width: 720, height: 240, 'aria-label': 'Signature pad' });
  const ctx = canvas.getContext('2d');
  let drawing = false;
  let dirty = false;
  function sizeCanvas() {
    const r = canvas.getBoundingClientRect();
    const ratio = window.devicePixelRatio || 1;
    const w = Math.max(300, Math.round(r.width * ratio));
    const h = Math.max(120, Math.round(180 * ratio));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w; canvas.height = h;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.strokeStyle = '#1c1816';
      ctx.lineWidth = Math.max(2.2, 2.4 * ratio);
    }
  }
  const pt = (e) => {
    const r = canvas.getBoundingClientRect();
    const src = (e.touches && e.touches[0]) || (e.changedTouches && e.changedTouches[0]) || e;
    return {
      x: (src.clientX - r.left) * (canvas.width / r.width),
      y: (src.clientY - r.top) * (canvas.height / r.height),
    };
  };
  const start = (e) => { e.preventDefault(); sizeCanvas(); drawing = true; dirty = true; const p = pt(e); ctx.beginPath(); ctx.moveTo(p.x, p.y); };
  const move = (e) => { if (!drawing) return; e.preventDefault(); const p = pt(e); ctx.lineTo(p.x, p.y); ctx.stroke(); };
  const end = () => { drawing = false; };
  canvas.addEventListener('pointerdown', start);
  canvas.addEventListener('pointermove', move);
  window.addEventListener('pointerup', end);
  canvas.addEventListener('touchstart', start, { passive: false });
  canvas.addEventListener('touchmove', move, { passive: false });
  canvas.addEventListener('touchend', end);

  const clear = () => { sizeCanvas(); ctx.clearRect(0, 0, canvas.width, canvas.height); dirty = false; };

  const status = h('p', { class: 'tiny muted', style: { margin: 0 } });
  const saveChk = h('input', { type: 'checkbox', checked: true });
  async function submit({ useSaved = false, typed = false } = {}) {
    try {
      status.textContent = 'Saving…';
      const body = { saveToProfile: !!saveChk.checked };
      if (useSaved) body.useSaved = true;
      else if (typed) body.typed = true;
      else {
        if (!dirty) { toast('Draw your signature first', { icon: 'alert' }); status.textContent = ''; return; }
        body.dataUrl = canvas.toDataURL('image/png');
      }
      const r = await api('/api/certs/sign/' + encodeURIComponent(token), { method: 'POST', body });
      const signed = r.request || r;
      box.replaceChildren(h('div', { class: 'cert-verify-card' },
        h('div', { class: 'cert-badge' }, I('check', 18), h('div', { class: 'cert-badge-text' },
          h('strong', null, typed ? 'Typed name confirmed' : 'Signature saved'),
          h('span', null, 'Certificates for ' + (signed.eventTitle || req.eventTitle) + ' will use this signature.'))),
        signed.signatureUrl ? h('img', { class: 'cert-sig-ink lg', src: signed.signatureUrl, alt: 'Your signature' }) : null,
        h('p', { class: 'muted' }, 'You can close this page.')));
      toast('Signature saved', { icon: 'check' });
    } catch (e) { status.textContent = ''; toastErr(e); }
  }

  requestAnimationFrame(sizeCanvas);
  window.addEventListener('resize', sizeCanvas);

  const already = req.status === 'signed' && req.signatureUrl;
  box.replaceChildren(h('div', { class: 'cert-verify-card cert-sign-card' },
    h('h1', null, 'Sign this certificate'),
    h('p', { class: 'muted' },
      (req.name || req.displayName || 'You') + ' has been asked to sign certificates'
      + (req.eventTitle ? ' for ' + req.eventTitle : '')
      + (req.role ? ' as ' + req.role : '') + '.'),
    already ? h('div', { class: 'col', style: { gap: '.4rem' } },
      h('p', { class: 'tiny' }, 'A signature is already on file. You can keep it or draw a new one.'),
      h('img', { class: 'cert-sig-ink lg', src: req.signatureUrl, alt: 'Current signature' })) : null,
    h('div', { class: 'cert-pad-wrap' }, canvas),
    h('div', { class: 'cert-actions' },
      h('button', { type: 'button', class: 'btn primary', onclick: () => submit() }, I('check', 16), ' Save signature'),
      req.savedSignatureUrl ? h('button', { type: 'button', class: 'btn', onclick: () => submit({ useSaved: true }) }, 'Use saved signature') : null,
      h('button', { type: 'button', class: 'btn ghost', onclick: clear }, 'Clear'),
      h('button', { type: 'button', class: 'btn ghost', onclick: () => submit({ typed: true }) }, 'Use typed name instead')),
    h('label', { class: 'set-row' }, h('span', { class: 'grow' }, 'Save this signature to my 1venue account for next time'), h('span', { class: 'switch' }, saveChk, h('span'))),
    status));
}
