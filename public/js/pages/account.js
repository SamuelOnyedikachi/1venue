// Settings → Account: email (verify / change), password (change / set), Google, Apple, devices, sign out,
// and the Danger zone (delete account: password → emailed code → final confirm).
import { icon } from '../icons.js';
import { h, api, toast, toastErr, sheet, confirmDlg, timeAgo } from '../ui.js';
import { put } from '../safe-text.js';
import { logout, refreshSession, navigate } from '../app.js';
import { passwordInput, notice, GOOGLE_G, APPLE_LOGO, usernameField, phoneField } from './login.js';

function deviceName(ua) {
  const s = String(ua || '');
  const os = /iPhone|iPad/.test(s) ? 'iPhone/iPad' : /Android/.test(s) ? 'Android' : /Mac OS X/.test(s) ? 'Mac' : /Windows/.test(s) ? 'Windows' : /Linux/.test(s) ? 'Linux' : '';
  const br = /Edg\//.test(s) ? 'Edge' : /OPR\//.test(s) ? 'Opera' : /Firefox\//.test(s) ? 'Firefox' : /Chrome\//.test(s) ? 'Chrome' : /Safari\//.test(s) ? 'Safari' : '';
  return [br, os].filter(Boolean).join(' on ') || 'Unknown device';
}

function formSheet({ title, ic, fields, submit, onSubmit, note }) {
  const s = sheet({ title, icon: ic, group: 'admin' });
  const msg = h('div', { class: 'auth-msg' });
  const btn = h('button', { class: 'btn primary block', type: 'submit' }, submit);
  const form = h('form', { class: 'col', style: { gap: '.7rem' }, novalidate: true }, msg, ...fields, note ? h('p', { class: 'tiny faint', style: { margin: 0 } }, note) : null, btn);
  form.onsubmit = async (e) => {
    e.preventDefault(); msg.replaceChildren(); btn.disabled = true;
    try { await onSubmit(s, (k, t) => msg.replaceChildren(notice(k, t))); } catch (er) { if (er.status && er.status < 500) msg.replaceChildren(notice('error', er.message)); else toastErr(er); } finally { btn.disabled = false; }
  };
  s.body.append(form);
  return s;
}

export async function accountCard(card, row) {
  const box = h('div', { class: 'col', style: { gap: 0 } }, h('p', { class: 'tiny faint' }, 'Loading…'));
  const section = card('Account', 'user', box);
  section.id = 'account';
  const paint = async () => {
    let acc;
    try { acc = await api('/api/auth/account'); } catch (e) { box.replaceChildren(h('p', { class: 'small muted' }, e.message)); return; }
    const u = acc.user;
    const min = acc.passwordMin || 8;
    const verified = u.emailVerified;
    const chip = h('span', { class: 'chip', style: { '--g': verified ? '#059669' : '#d97706', color: 'var(--g)', fontSize: '.7rem', padding: '.1rem .45rem', minHeight: 0 } }, verified ? 'Confirmed' : 'Not confirmed');
    const resend = !verified ? h('button', { class: 'btn sm', type: 'button', onclick: async (e) => { e.currentTarget.disabled = true; try { const r = await api('/api/auth/resend-verification', { method: 'POST' }); toast(r.message, { icon: 'mail' }); } catch (er) { toastErr(er); } } }, 'Resend link') : null;

    const changeUsername = () => {
      const field = usernameField({ value: u.username, current: u.username });
      formSheet({
        title: 'Change username', ic: 'user', submit: 'Save username',
        fields: [field.el],
        note: '3–30 characters. Lowercase letters, numbers, underscores or periods.',
        onSubmit: async (s) => {
          await api('/api/auth/change-username', { method: 'POST', body: { username: field.input.value.trim() } });
          s.close(); toast('Username saved', { icon: 'check' });
          await refreshSession(); paint();
        },
      });
    };
    const changePhone = () => {
      const field = phoneField({ required: true, value: u.phone || '', country: 'NG' });
      formSheet({
        title: u.phone ? 'Change phone number' : 'Add a phone number', ic: 'user', submit: 'Save phone number',
        fields: [field.el],
        note: 'Stored only as contact information for your account. We do not share it or use it for marketing.',
        onSubmit: async (s) => {
          const r = await api('/api/auth/change-phone', { method: 'POST', body: { phone: field.input.value.trim(), country: field.select.value } });
          s.close(); toast('Phone number saved', { icon: 'check' });
          u.phone = r.phone;
          paint();
        },
      });
    };
    const changeEmail = () => {
      const em = h('input', { class: 'input', type: 'email', placeholder: 'New email address', autocomplete: 'email', 'aria-label': 'New email' });
      const pw = passwordInput('Current password');
      formSheet({
        title: 'Change email', ic: 'mail', submit: 'Send confirmation link',
        fields: [em, ...(u.hasPassword ? [pw.el] : [])],
        note: 'We’ll email the new address. Your email changes once you open that link; your old address gets a notice.',
        onSubmit: async (s, show) => { const r = await api('/api/auth/change-email', { method: 'POST', body: { email: em.value.trim(), password: pw.input.value } }); show('info', r.message); },
      });
    };
    const changePassword = () => {
      const cur = passwordInput('Current password', 'current-password');
      const nw = passwordInput('New password', 'new-password');
      const nw2 = passwordInput('Repeat new password', 'new-password');
      formSheet({
        title: u.hasPassword ? 'Change password' : 'Set a password', ic: 'key', submit: 'Save password',
        fields: [...(u.hasPassword ? [cur.el] : []), nw.el, nw2.el],
        note: `At least ${min} characters. Other devices will be signed out.`,
        onSubmit: async (s, show) => {
          if (nw.input.value.length < min) return show('error', `Use at least ${min} characters.`);
          if (nw.input.value !== nw2.input.value) return show('error', 'The two passwords don’t match.');
          const r = await api('/api/auth/change-password', { method: 'POST', body: { currentPassword: cur.input.value, newPassword: nw.input.value } });
          s.close(); toast(r.otherSessionsSignedOut ? `Password saved. ${r.otherSessionsSignedOut} other device(s) signed out.` : 'Password saved', { icon: 'check' });
          await refreshSession(); paint();
        },
      });
    };
    const google = acc.identities.find((i) => i.provider === 'google');
    const appleId = acc.identities.find((i) => i.provider === 'apple');
    const devices = h('div', { class: 'col', style: { gap: '.4rem' } });
    const loadDevices = async () => {
      try {
        const { sessions } = await api('/api/auth/sessions');
        devices.replaceChildren(...sessions.map((x) => h('div', { class: 'row session-row' },
          h('span', { class: 'faint', html: icon('laptop', { size: 18 }) }),
          h('div', { class: 'grow' },
            h('div', { class: 'small', style: { fontWeight: 600 } }, deviceName(x.userAgent), x.current ? h('span', { class: 'chip', style: { marginLeft: '.4rem', fontSize: '.7rem' } }, 'This device') : null),
            h('div', { class: 'tiny faint' }, `${x.method === 'google' ? 'Google · ' : x.method === 'apple' ? 'Apple · ' : ''}Active ${timeAgo(x.lastSeenAt)}${x.ip ? ' · ' + x.ip : ''}`)),
          x.current ? null : h('button', { class: 'btn sm ghost', type: 'button', onclick: async () => { try { await api('/api/auth/sessions/' + x.id, { method: 'DELETE' }); toast('Signed out that device', { icon: 'logout' }); loadDevices(); } catch (er) { toastErr(er); } } }, 'Sign out'))));
      } catch (er) { devices.replaceChildren(h('p', { class: 'tiny muted' }, er.message)); }
    };
    const everywhere = async () => {
      if (!(await confirmDlg('Sign out on every device, including this one?', { ok: 'Sign out everywhere', danger: true }))) return;
      try { await api('/api/auth/logout-all', { method: 'POST' }); } catch (er) { toastErr(er); return; }
      await refreshSession(); toast('Signed out everywhere', { icon: 'logout' }); navigate('/login');
    };

    put(box,
      row('user', 'people', u.displayName || 'Account', '@' + (u.username || 'user'), h('a', { class: 'btn sm', href: '/me?edit=1', 'data-link': '' }, 'Edit profile')),
      row('user', 'people', 'Username', '@' + (u.username || 'user'), h('button', { class: 'btn sm', type: 'button', onclick: changeUsername }, 'Change')),
      row('mail', 'people', 'Phone', u.phone || 'Not set', h('button', { class: 'btn sm', type: 'button', onclick: changePhone }, u.phone ? 'Change' : 'Add')),
      row('mail', 'people', h('span', { class: 'row', style: { gap: '.4rem', flexWrap: 'wrap' } }, 'Email', chip), h('span', { style: { wordBreak: 'break-all' } }, u.email || 'Not set'),
        h('div', { class: 'col', style: { gap: '.3rem', alignItems: 'flex-end' } }, h('button', { class: 'btn sm', type: 'button', onclick: changeEmail }, 'Change'), resend)),
      row('key', 'admin', 'Password', u.hasPassword ? 'Used with your email or username' : `Not set: you sign in with ${appleId && !google ? 'Apple' : 'Google'}`, h('button', { class: 'btn sm', type: 'button', onclick: changePassword }, u.hasPassword ? 'Change' : 'Set password')),
      acc.apple || appleId ? row('login', 'nav', 'Apple', appleId ? `Connected (${appleId.email || 'Apple ID'})` : 'Use “Continue with Apple” with this same email to connect it', appleId ? h('span', { class: 'chip', html: APPLE_LOGO + ' Connected' }) : null) : null,
      acc.google || google ? row('login', 'nav', 'Google', google ? `Connected (${google.email || 'Google'})` : 'Use “Continue with Google” with this same email to connect it', google ? h('span', { class: 'chip', html: GOOGLE_G + ' Connected' }) : null) : null,
      h('div', { class: 'set-row', style: { alignItems: 'flex-start' } },
        h('span', { class: 'ico', style: { '--g': 'var(--g-admin)' }, html: icon('shield') }),
        h('div', { class: 'grow col', style: { gap: '.5rem' } },
          h('div', null, h('div', { style: { fontWeight: 650 } }, 'Where you’re signed in'), h('div', { class: 'tiny faint' }, 'Sign out any device you don’t recognise.')),
          devices,
          h('div', { class: 'row', style: { gap: '.5rem', flexWrap: 'wrap' } },
            h('button', { class: 'btn sm', type: 'button', onclick: logout }, 'Sign out'),
            h('button', { class: 'btn sm danger', type: 'button', onclick: everywhere }, 'Sign out everywhere')))),
    );
    loadDevices();
  };
  await paint();
  return section;
}

/* ---------- Danger zone: delete account ---------- */
const GONE = [
  'Your profile, username, email, phone and sign-in methods (password, Google, Apple)',
  'Your posts, comments, likes, follows and private notes',
  'Events you host, venues you own, materials, whiteboards and scheduled meetings',
  'Files you uploaded, removed from storage too',
  'Your direct-message threads',
];

function deleteFlow(u) {
  const s = sheet({ title: 'Delete account', icon: 'trash', group: 'admin' });
  const body = h('div', { class: 'col del-flow', style: { gap: '.8rem' } });
  s.body.append(body);
  let password = '';
  const msgBox = () => h('div', { class: 'auth-msg' });
  const steps = (n) => h('div', { class: 'del-steps', 'aria-label': `Step ${n} of 3` }, [1, 2, 3].map((i) => h('span', { class: i <= n ? 'on' : '' })));
  const busy = (btn, on) => { btn.disabled = on; btn.classList.toggle('loading', on); };
  const fail = (box, er) => { if (er.status && er.status < 500) box.replaceChildren(notice('error', er.message)); else toastErr(er); };

  async function sendCode(btn, box) {
    busy(btn, true); box.replaceChildren();
    try {
      const r = await api('/api/auth/delete/start', { method: 'POST', body: { password } });
      return r;
    } catch (er) { fail(box, er); return null; } finally { busy(btn, false); }
  }

  function step1() {
    const msg = msgBox();
    const pw = passwordInput('Your password', 'current-password');
    const btn = h('button', { class: 'btn danger block', type: 'submit' }, u.hasPassword ? 'Continue' : 'Email me a code');
    const form = h('form', { class: 'col', style: { gap: '.7rem' }, novalidate: true },
      steps(1),
      h('p', { class: 'small', style: { margin: 0 } }, 'Deleting your account is permanent. This removes:'),
      h('ul', { class: 'del-list small muted' }, GONE.map((t) => h('li', null, t))),
      h('p', { class: 'tiny faint', style: { margin: 0 } }, 'Messages and questions you posted in other people’s rooms stay so their records make sense, but show as “Deleted user”.'),
      msg,
      u.hasPassword ? pw.el : h('p', { class: 'small', style: { margin: 0 } }, 'You sign in with Google or Apple, so we’ll confirm by email instead of a password.'),
      btn);
    form.onsubmit = async (e) => {
      e.preventDefault();
      if (u.hasPassword && !pw.input.value) { msg.replaceChildren(notice('error', 'Enter your password to continue.')); pw.input.focus(); return; }
      password = pw.input.value;
      const r = await sendCode(btn, msg);
      if (r) step2(r);
    };
    body.replaceChildren(form);
    if (u.hasPassword) setTimeout(() => pw.input.focus(), 60);
  }

  function step2(info) {
    const msg = msgBox();
    const code = h('input', { class: 'input del-code', inputmode: 'numeric', autocomplete: 'one-time-code', pattern: '[0-9]*', maxlength: 6, placeholder: '••••••', 'aria-label': '6-digit code' });
    code.oninput = () => { code.value = code.value.replace(/\D/g, '').slice(0, 6); if (code.value.length === 6) form.requestSubmit(); };
    const btn = h('button', { class: 'btn primary block', type: 'submit' }, 'Verify code');
    const resend = h('button', { class: 'btn sm ghost', type: 'button' }, 'Send a new code');
    resend.onclick = async () => { const r = await sendCode(resend, msg); if (r) { msg.replaceChildren(notice('info', `New code sent to ${r.email}.`)); code.value = ''; code.focus(); } };
    const form = h('form', { class: 'col', style: { gap: '.7rem' }, novalidate: true },
      steps(2),
      h('p', { class: 'small', style: { margin: 0 } }, 'We emailed a 6-digit code to ', h('strong', null, info.email), `. It expires in ${info.expiresInMin} minutes.`),
      msg, code, btn, h('div', { class: 'row', style: { justifyContent: 'center' } }, resend));
    form.onsubmit = async (e) => {
      e.preventDefault(); msg.replaceChildren();
      if (code.value.length !== 6) { msg.replaceChildren(notice('error', 'Enter the 6 digits from the email.')); return; }
      busy(btn, true);
      try { const r = await api('/api/auth/delete/verify', { method: 'POST', body: { code: code.value } }); step3(r.grant); } catch (er) { fail(msg, er); code.select(); } finally { busy(btn, false); }
    };
    body.replaceChildren(form);
    setTimeout(() => code.focus(), 60);
  }

  function step3(grant) {
    const msg = msgBox();
    const ack = h('input', { type: 'checkbox' });
    const btn = h('button', { class: 'btn danger block', type: 'button', disabled: true }, 'Delete my account permanently');
    ack.onchange = () => { btn.disabled = !ack.checked; };
    btn.onclick = async () => {
      busy(btn, true); msg.replaceChildren();
      try {
        await api('/api/auth/delete/confirm', { method: 'POST', body: { grant } });
        s.close();
        await refreshSession().catch(() => {});
        toast('Your account was deleted. Goodbye for now.', { icon: 'check' });
        navigate('/', { replace: true });
      } catch (er) { fail(msg, er); busy(btn, false); }
    };
    body.replaceChildren(steps(3),
      h('div', { class: 'del-final' }, h('span', { html: icon('alert', { size: 22 }) }),
        h('div', null, h('div', { style: { fontWeight: 700 } }, `Delete @${u.username} forever?`), h('div', { class: 'small muted' }, 'You’ll be signed out everywhere and this can’t be undone. We’ll send a confirmation to your email.'))),
      msg,
      h('label', { class: 'row small', style: { gap: '.5rem', alignItems: 'flex-start' } }, ack, h('span', null, 'I understand my account and data will be permanently deleted.')),
      btn,
      h('button', { class: 'btn ghost block', type: 'button', onclick: () => s.close() }, 'Keep my account'));
  }

  step1();
}

export async function deleteAccountCard(card) {
  let u;
  try { u = (await api('/api/auth/account')).user; } catch (_) { return null; }
  const sec = card('Danger zone', 'alert',
    h('div', { class: 'set-row danger-row' },
      h('span', { class: 'ico', style: { '--g': '#dc2626' }, html: icon('trash') }),
      h('div', { class: 'grow' }, h('div', { style: { fontWeight: 650 } }, 'Delete account'), h('div', { class: 'tiny faint' }, 'Permanently delete your account and data. You’ll confirm with your password and a code we email you.')),
      h('button', { class: 'btn sm danger', type: 'button', onclick: () => deleteFlow(u) }, 'Delete account')));
  sec.id = 'delete-account';
  sec.classList.add('danger-zone');
  return sec;
}
