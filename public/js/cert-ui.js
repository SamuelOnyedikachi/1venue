import { h, I, toast, toastErr, uploadFile, debounce } from './ui.js';

const DESIGNS = [
  ['classic', 'Classic'],
  ['modern', 'Modern'],
  ['minimal', 'Minimal'],
  ['elegant', 'Elegant'],
];

const TITLES = [
  ['attendance', 'Certificate of Attendance'],
  ['completion', 'Certificate of Completion'],
  ['participation', 'Certificate of Participation'],
  ['achievement', 'Certificate of Achievement'],
  ['appreciation', 'Certificate of Appreciation'],
  ['custom', 'Custom title'],
];

const OPENERS = [
  ['certify', 'This is to certify that'],
  ['presented', 'This certificate is proudly presented to'],
  ['recognition', 'In recognition of'],
  ['awarded', 'Awarded to'],
  ['custom', 'Custom wording'],
];

const BODIES = [
  ['attended', 'has successfully attended'],
  ['completed', 'has completed'],
  ['participation', 'for active participation in'],
  ['custom', 'Custom wording'],
];

function sel(options, value, onchange, cls = 'input') {
  return h('select', { class: cls, onchange: (e) => onchange(e.target.value) },
    ...options.map(([id, label]) => h('option', { value: id, selected: value === id }, label)));
}

function inp(value, attrs, oninput) {
  const el = h('input', { class: 'input', value: value || '', ...attrs });
  el.addEventListener(attrs.type === 'file' ? 'change' : 'input', () => oninput(el));
  return el;
}

function miniCert(id, accent) {
  return h('div', { class: 'cert-mini', 'data-design': id, style: { '--cert-accent': accent } },
    h('div', { class: 'cert-mini-frame' },
      h('div', { class: 'cert-mini-org' }),
      h('div', { class: 'cert-mini-title' }),
      h('div', { class: 'cert-mini-open' }),
      h('div', { class: 'cert-mini-name' }),
      h('div', { class: 'cert-mini-sent' }),
      h('div', { class: 'cert-mini-sigs' }, h('i'), h('i')),
      h('div', { class: 'cert-mini-foot' }, h('span'), h('span', { class: 'qr' }))));
}

export function certEditor(certs = {}, { accent = '#2563eb', eventTitle, startsAt, endsAt, hostName, hostLogo, onChange } = {}) {
  const v = (fn, fallback = '') => {
    try { const x = typeof fn === 'function' ? fn() : fn; return x || fallback; } catch { return fallback; }
  };

  let enabled = !!certs.enabled;
  let design = DESIGNS.some(([id]) => id === certs.design) ? certs.design : 'classic';
  let minMinutes = certs.minMinutes || 10;
  let titleKind = TITLES.some(([id]) => id === certs.titleKind) ? certs.titleKind : 'attendance';
  let titleCustom = certs.titleCustom || (titleKind === 'custom' ? certs.title : '') || '';
  let openerId = OPENERS.some(([id]) => id === certs.openerId) ? certs.openerId : 'certify';
  let openerCustom = certs.openerCustom || (openerId === 'custom' ? certs.opener : '') || '';
  let bodyId = BODIES.some(([id]) => id === certs.bodyId) ? certs.bodyId : 'attended';
  let bodyCustom = certs.bodyCustom || (bodyId === 'custom' ? certs.body : '') || '';
  let description = certs.description || '';
  let programme = certs.programme || certs.programmeName || '';
  let issuerName = certs.issuerName || '';
  let issuerLogoUrl = certs.issuerLogoUrl || '';
  let dateStart = certs.dateStart || '';
  let dateEnd = certs.dateEnd || '';
  let signatories = Array.isArray(certs.signatories)
    ? certs.signatories.map((s) => ({ name: s.name || '', role: s.role || '' })).filter((s) => s.name || s.role)
    : [];

  function payload() {
    return {
      enabled, design, minMinutes,
      titleKind, titleCustom,
      openerId, openerCustom,
      bodyId, bodyCustom,
      description, programme,
      issuerName, issuerLogoUrl,
      dateStart, dateEnd,
      signatories: signatories.map((s) => ({ name: s.name || '', role: s.role || '' })),
      eventTitle: v(eventTitle, ''),
      startsAt: dateStart || v(startsAt, ''),
      endsAt: dateEnd || v(endsAt, ''),
      hostName: issuerName || v(hostName, ''),
      accent,
    };
  }

  const emit = () => { onChange && onChange(payload()); refreshPreview(); };

  const previewFrame = h('iframe', { class: 'cert-live-frame', title: 'Certificate preview' });
  const previewStatus = h('div', { class: 'tiny muted cert-live-status' }, 'Live preview');
  let previewUrl = '';
  const refreshPreview = debounce(async () => {
    if (!enabled) return;
    previewStatus.textContent = 'Updating preview…';
    try {
      const res = await fetch('/api/certs/preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...payload(), name: 'Alex Okonkwo' }),
        credentials: 'same-origin',
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.statusText);
      const blob = await res.blob();
      const next = URL.createObjectURL(blob);
      previewFrame.src = next;
      if (previewUrl) URL.revokeObjectURL(previewUrl);
      previewUrl = next;
      previewStatus.textContent = 'Live preview · sample name Alex Okonkwo';
    } catch (e) {
      previewStatus.textContent = e.message || 'Preview failed';
    }
  }, 400);

  const on = h('input', { type: 'checkbox', checked: enabled, onchange: () => { enabled = on.checked; emit(); paint(); } });
  const mins = h('input', { class: 'input sm', type: 'number', min: '1', max: '180', value: String(minMinutes), oninput: () => { minMinutes = Math.min(180, Math.max(1, Number(mins.value) || 10)); emit(); } });
  const picks = h('div', { class: 'cert-picks' });

  const programmeIn = inp(programme, { placeholder: 'Defaults to the event title', maxlength: '200' }, (el) => { programme = el.value; emit(); });
  const titleSel = sel(TITLES, titleKind, (val) => { titleKind = val; emit(); paintFields(); });
  const titleIn = inp(titleCustom, { placeholder: 'Certificate title', maxlength: '120' }, (el) => { titleCustom = el.value; emit(); });
  const openerSel = sel(OPENERS, openerId, (val) => { openerId = val; emit(); paintFields(); });
  const openerIn = inp(openerCustom, { placeholder: 'Opening line', maxlength: '160' }, (el) => { openerCustom = el.value; emit(); });
  const bodySel = sel(BODIES, bodyId, (val) => { bodyId = val; emit(); paintFields(); });
  const bodyIn = inp(bodyCustom, { placeholder: 'Body line', maxlength: '160' }, (el) => { bodyCustom = el.value; emit(); });
  const descIn = h('textarea', { class: 'textarea', rows: 2, maxlength: '280', placeholder: 'Optional short line, folded into the same sentence' });
  descIn.value = description;
  descIn.addEventListener('input', () => { description = descIn.value; emit(); });

  const issuerIn = inp(issuerName, { placeholder: v(hostName, 'Organisation or host name'), maxlength: '120' }, (el) => { issuerName = el.value; emit(); });
  const logoPreview = h('div', { class: 'cert-logo-preview' });
  function paintLogo() {
    logoPreview.replaceChildren(issuerLogoUrl
      ? h('img', { src: issuerLogoUrl, alt: 'Organisation logo' })
      : h('span', { class: 'tiny muted' }, 'No logo yet'));
  }
  const logoFile = h('input', { type: 'file', accept: 'image/*', hidden: true });
  logoFile.onchange = async () => {
    const f = logoFile.files && logoFile.files[0];
    logoFile.value = '';
    if (!f) return;
    try {
      const r = await uploadFile(f, { purpose: 'content' });
      issuerLogoUrl = r.url;
      paintLogo(); emit();
      toast('Logo uploaded', { icon: 'image' });
    } catch (e) { toastErr(e); }
  };

  const sigBox = h('div', { class: 'cert-sigs col' });
  function paintSigs() {
    const cards = signatories.map((s, i) => {
      const nameIn = inp(s.name, { placeholder: 'Name', maxlength: '80' }, (el) => { s.name = el.value; emit(); });
      const roleIn = inp(s.role, { placeholder: 'Role, e.g. Director', maxlength: '80' }, (el) => { s.role = el.value; emit(); });
      return h('div', { class: 'cert-sig-card' },
        h('div', { class: 'row', style: { justifyContent: 'space-between', alignItems: 'center' } },
          h('b', { class: 'tiny' }, 'Signatory ' + (i + 1)),
          h('button', { type: 'button', class: 'icon-btn sm', title: 'Remove', onclick: () => { signatories.splice(i, 1); emit(); paintSigs(); } }, I('x', 14))),
        nameIn, roleIn,
        h('p', { class: 'tiny muted', style: { margin: 0 } }, 'Their name is written in a handwriting font, with the role underneath.'));
    });
    const add = signatories.length < 3
      ? h('button', { type: 'button', class: 'btn sm', onclick: () => { signatories.push({ name: '', role: '' }); emit(); paintSigs(); } }, I('userPlus', 14), ' Add signatory')
      : h('p', { class: 'tiny muted', style: { margin: 0 } }, 'Up to three signatories.');
    sigBox.replaceChildren(h('div', { class: 'tiny muted' }, 'Signatories'), ...cards, add);
  }

  function paintFields() {
    titleIn.hidden = titleKind !== 'custom';
    openerIn.hidden = openerId !== 'custom';
    bodyIn.hidden = bodyId !== 'custom';
  }

  function paintPicks() {
    picks.replaceChildren(...DESIGNS.map(([id, label]) => h('button', {
      type: 'button', class: 'cert-pick' + (design === id ? ' on' : ''), 'data-design': id,
      style: { '--cert-accent': accent },
      onclick: () => { design = id; emit(); paintPicks(); },
    }, miniCert(id, accent), h('b', null, label))));
  }

  function paint() {
    extras.hidden = !enabled;
    previewWrap.hidden = !enabled;
  }

  paintPicks();
  paintFields();
  paintLogo();
  paintSigs();

  const extras = h('div', { class: 'cert-extras col' },
    picks,
    h('label', { class: 'cert-field' }, h('span', { class: 'tiny muted' }, 'Programme name on the certificate'), programmeIn),
    h('label', { class: 'cert-field' }, h('span', { class: 'tiny muted' }, 'Certificate title'), titleSel, titleIn),
    h('label', { class: 'cert-field' }, h('span', { class: 'tiny muted' }, 'Opening line'), openerSel, openerIn),
    h('label', { class: 'cert-field' }, h('span', { class: 'tiny muted' }, 'Body line'), bodySel, bodyIn),
    h('label', { class: 'cert-field' }, h('span', { class: 'tiny muted' }, 'Optional description'), descIn),
    h('label', { class: 'cert-field' }, h('span', { class: 'tiny muted' }, 'Issued by (organisation name)'), issuerIn),
    h('div', { class: 'cert-logo-row row', style: { gap: '.6rem', alignItems: 'center' } },
      logoPreview,
      h('button', { type: 'button', class: 'btn sm', onclick: () => logoFile.click() }, I('image', 14), ' ', issuerLogoUrl ? 'Replace logo' : 'Upload logo'),
      issuerLogoUrl ? h('button', { type: 'button', class: 'btn sm ghost', onclick: () => { issuerLogoUrl = ''; paintLogo(); emit(); } }, 'Remove') : null,
      logoFile),
    sigBox,
    h('label', null, h('span', { class: 'tiny muted' }, 'Minimum minutes attended'), mins),
    h('p', { class: 'tiny muted', style: { margin: 0 } }, 'Attendance still decides who qualifies. The certificate shows the event date, not the minutes attended.'));

  const previewWrap = h('div', { class: 'cert-live' },
    previewStatus,
    h('div', { class: 'cert-live-frame-wrap' }, previewFrame));

  const el = h('div', { class: 'col cert-editor', style: { gap: '.55rem' } },
    h('label', { class: 'set-row' }, h('span', { class: 'grow' }, 'Send a certificate when the event ends'), h('span', { class: 'switch' }, on, h('span'))),
    h('div', { class: 'tiny muted' }, 'Everyone who stays past the minimum time gets a PDF by Notification and email, in your event colour.'),
    extras, previewWrap);
  paint();
  if (enabled) refreshPreview();

  el.get = () => payload();
  el.setAccent = (a) => { accent = a; paintPicks(); emit(); };
  el.preview = previewWrap;
  return el;
}
