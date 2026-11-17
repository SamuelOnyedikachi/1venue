/**
 * Branded transactional emails: each template returns { subject, text, html }.
 *
 * Plain text is the source of truth. The HTML is table-based (Gmail, Outlook, Apple Mail, phone
 * apps), 600px wide on desktop and stacked on phones (the laptop art moves under the text), with
 * a dark-mode palette for clients that honour prefers-color-scheme. Every value is escaped.
 *
 * Images are PNGs in public/email/ (SVG does not render in Gmail), loaded from MAIL_ASSET_URL,
 * which defaults to PUBLIC_URL when it is https, else https://1venue.live. The laptop's video
 * tiles are licensed Unsplash photos (scripts/email-art/CREDITS.md); the rest is drawn.
 * Regenerate the art from scripts/email-art/ (see the README there).
 */
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const BLUE = '#003EA8';
const NAVY = '#0B1B3F';
const SUB = '#4A5878';
const FAINT = '#7A87A3';
// Same stack as the site (public/css/app.css body font). Headings follow the site's scale too:
// only a little larger than body text and weight 600, not heavy display type.
const FONT = "Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Noto Sans',Helvetica,Arial,sans-serif";
const ASSET_V = '2'; // bump when a PNG in public/email/ changes, so mail clients and proxies refetch it
const TAGLINE = 'Meet · Collaborate · Achieve';

function assetBase(url) {
  const fromEnv = String(process.env.MAIL_ASSET_URL || '').trim().replace(/\/$/, '');
  if (fromEnv) return fromEnv;
  return /^https:\/\//i.test(url || '') ? String(url).replace(/\/$/, '') : 'https://1venue.live';
}
const site = (url) => (/^https?:\/\//i.test(url || '') ? String(url).replace(/\/$/, '') : 'https://1venue.live');

const CSS = `
:root{color-scheme:light dark;supported-color-schemes:light dark}
body{margin:0!important;padding:0!important;width:100%!important;-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%}
table{border-collapse:collapse;mso-table-lspace:0;mso-table-rspace:0}
img{border:0;outline:none;text-decoration:none;-ms-interpolation-mode:bicubic;display:block}
a{color:${BLUE}}
.btn a:hover{background:#00318a!important}
@media only screen and (max-width:620px){
  .wrap{padding:12px 8px!important}
  .shell{width:100%!important;border-radius:20px!important}
  .px{padding-left:22px!important;padding-right:22px!important}
  .stack{display:block!important;width:100%!important;max-width:100%!important}
  .hero-art{padding:22px 0 0!important}
  .hero-art img{width:100%!important;max-width:320px!important;height:auto!important;margin:0 auto!important}
  .h1{font-size:22px!important;line-height:29px!important}
  .hero-bg{width:100%!important;max-width:320px!important;height:241px!important;background-size:contain!important;margin:0 auto!important}
  .tag{display:none!important}
  .brand-art{width:96px!important}
  .brand-art .deco{width:96px!important;height:67px!important;background-size:96px 67px!important}
  .foot td{display:block!important;width:100%!important;text-align:left!important;padding-top:6px!important}
  .code{font-size:26px!important;letter-spacing:7px!important}
}
@media (prefers-color-scheme:dark){
  .bg{background:#0A1020!important}
  .shell{background:#0F172A!important;background-image:none!important}
  .card{background:#16203A!important;border-color:#24304F!important}
  .brand{background:#132046!important;background-image:none!important}
  .t1{color:#F2F5FF!important}
  .t2{color:#B9C4DE!important}
  .t3{color:#8D9AB8!important}
  .rule{border-color:#24304F!important}
  .lnk{color:#8FB2FF!important}
}
[data-ogsc] .t1{color:#F2F5FF!important}
[data-ogsc] .t2{color:#B9C4DE!important}
`;

/**
 * A purely decorative image that cannot be clicked, saved or opened: a background image on an
 * empty block (no <img>, no link), so Gmail shows no download/zoom overlay on it. Outlook for
 * Windows ignores CSS backgrounds, so it gets the same image through VML.
 */
function deco(url, w, h, cls = '') {
  return `<!--[if mso]><v:rect xmlns:v="urn:schemas-microsoft-com:vml" fill="true" stroke="false" style="width:${w}px;height:${h}px"><v:fill type="frame" src="${url}" color="#F7F9FF" /></v:rect><![endif]-->`
    + `<!--[if !mso]><!--><div role="presentation" aria-hidden="true" class="deco ${cls}" style="width:${w}px;height:${h}px;background-image:url('${url}');background-size:${w}px ${h}px;background-repeat:no-repeat;background-position:center;pointer-events:none;user-select:none;-webkit-user-select:none;font-size:0;line-height:0">&nbsp;</div><!--<![endif]-->`;
}

/** One icon row (link card, expiry, security note). `body` is already-escaped HTML. */
function iconRow(src, body, { card = false } = {}) {
  const inner = `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
<td width="40" valign="top" style="width:40px;padding:0 16px 0 0">${deco(src, 40, 40)}</td>
<td valign="middle" class="t2" style="font-family:${FONT};font-size:14px;line-height:21px;color:${SUB}">${body}</td></tr></table>`;
  return card
    ? `<tr><td class="px" style="padding:8px 40px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:separate"><tr><td class="card" style="background:#F6F9FF;border:1px solid #E1E8F6;border-radius:18px;padding:18px 20px">${inner}</td></tr></table></td></tr>`
    : `<tr><td class="px" style="padding:10px 40px 10px 60px">${inner}</td></tr>`;
}

function layout(d) {
  const { app = '1venue', url = '', title, heading, intro, button, link, showCode: code, expiryNote, note, preheader } = d;
  const base = assetBase(url);
  const img = (name) => `${base}/email/${name}.png?v=${ASSET_V}`;
  const S = site(url);
  const host = S.replace(/^https?:\/\//, '');
  const h = heading || title;

  const buttonHtml = button && link ? `<table role="presentation" cellpadding="0" cellspacing="0" border="0" class="btn" style="margin:26px 0 0;border-collapse:separate"><tr>
<td bgcolor="${BLUE}" style="border-radius:14px;background:${BLUE};box-shadow:0 8px 18px -8px rgba(0,62,168,.55)"><a href="${esc(link)}" target="_blank" style="display:inline-block;padding:15px 26px;font-family:${FONT};font-size:15px;line-height:20px;font-weight:600;color:#FFFFFF;text-decoration:none;border-radius:14px">${esc(button)}&nbsp;&rarr;</a></td></tr></table>` : '';
  const codeHtml = code ? `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:24px 0 0;border-collapse:separate"><tr>
<td class="card" style="background:#FFFFFF;border:1px solid #D7E2F7;border-radius:16px;padding:14px 22px"><span class="code t1" style="font-family:'SF Mono',Menlo,Consolas,'Courier New',monospace;font-size:30px;line-height:38px;font-weight:600;letter-spacing:9px;color:${NAVY}">${esc(code)}</span></td></tr></table>` : '';

  const rows = [];
  if (button && link) rows.push(iconRow(img('i-link'), `Or paste this link into your browser:<br><a class="lnk" href="${esc(link)}" target="_blank" style="color:${BLUE};text-decoration:underline;word-break:break-all;font-size:13px;line-height:20px">${esc(link)}</a>`, { card: true }));
  if (expiryNote) rows.push(iconRow(img('i-time'), esc(expiryNote)));
  if (note) rows.push(iconRow(img(note.icon || 'i-shield'), esc(note.text)));

  const html = `<!doctype html>
<html lang="en" xmlns="http://www.w3.org/1999/xhtml" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="X-UA-Compatible" content="IE=edge">
<meta name="color-scheme" content="light dark"><meta name="supported-color-schemes" content="light dark">
<meta name="format-detection" content="telephone=no,address=no,email=no,date=no">
<title>${esc(title)}</title>
<!--[if mso]><noscript><xml><o:OfficeDocumentSettings><o:PixelsPerInch>96</o:PixelsPerInch></o:OfficeDocumentSettings></xml></noscript><![endif]-->
<style>${CSS}</style></head>
<body class="bg" style="margin:0;padding:0;background:#EEF3FC">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;mso-hide:all">${esc(preheader || intro || '')}&#8199;&#65279;&#847;&#8199;&#65279;&#847;&#8199;&#65279;&#847;&#8199;&#65279;&#847;</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="bg" style="background:#EEF3FC"><tr><td align="center" class="wrap" style="padding:28px 12px">
<!--[if mso]><table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0"><tr><td><![endif]-->
<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" class="shell" style="border-collapse:separate;width:600px;max-width:600px;background:#F7F9FF;background-image:radial-gradient(120% 80% at 100% 0%,#DCE6FF 0%,#EEF3FF 40%,#F9FBFF 75%,#FFFFFF 100%);border-radius:28px;overflow:hidden">

<tr><td class="px" style="padding:30px 40px 22px">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
    <td valign="middle"><a href="${esc(S)}" target="_blank" style="text-decoration:none"><table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
      <td valign="middle" style="padding:0 10px 0 0"><img src="${img('mark')}" width="36" height="36" alt="" style="width:36px;height:36px;border-radius:10px"></td>
      <td valign="middle" class="t1" style="font-family:${FONT};font-size:19px;line-height:24px;font-weight:600;letter-spacing:-0.2px;color:${NAVY}">${esc(app)}</td>
    </tr></table></a></td>
    <td valign="middle" align="right" class="tag t2" style="font-family:${FONT};font-size:12px;line-height:16px;color:${SUB};white-space:nowrap">${esc(TAGLINE)}</td>
  </tr></table>
</td></tr>
<tr><td class="px" style="padding:0 40px"><div class="rule" style="border-top:1px solid #DFE6F4;height:1px;line-height:1px;font-size:0">&nbsp;</div></td></tr>

<tr><td class="px" style="padding:30px 40px 14px">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
    <td class="stack" valign="middle" width="270" style="width:270px">
      <h1 class="h1 t1" style="margin:0;font-family:${FONT};font-size:24px;line-height:31px;font-weight:600;letter-spacing:-0.2px;color:${NAVY}">${esc(h)}</h1>
      <p class="t2" style="margin:12px 0 0;font-family:${FONT};font-size:15px;line-height:24px;color:${SUB}">${esc(intro)}</p>
      ${codeHtml}${buttonHtml}
    </td>
    <td class="stack hero-art" valign="middle" align="right" width="250" style="width:250px;padding:0">${deco(img('hero'), 250, 188, 'hero-bg')}</td>
  </tr></table>
</td></tr>

${rows.join('\n')}

<tr><td class="px" style="padding:22px 40px 8px">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:separate"><tr><td class="brand" style="background:#E7EEFF;background-image:linear-gradient(120deg,#EDF3FF 0%,#DDE7FF 100%);border-radius:22px;padding:24px 26px">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
      <td valign="middle">
        <div class="t1" style="font-family:${FONT};font-size:19px;line-height:24px;font-weight:600;letter-spacing:-0.2px;color:${NAVY}">${esc(app)}</div>
        <div class="t2" style="margin:6px 0 0;font-family:${FONT};font-size:15px;line-height:22px;color:${SUB};max-width:250px">Your premium meeting platform for meaningful connections.</div>
        <div style="margin:14px 0 0;width:44px;height:3px;border-radius:3px;background:${BLUE};line-height:3px;font-size:0">&nbsp;</div>
      </td>
      <td valign="middle" align="right" width="150" class="brand-art" style="width:150px">${deco(img('people'), 150, 104)}</td>
    </tr></table>
  </td></tr></table>
</td></tr>

<tr><td class="px" style="padding:20px 40px 30px">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="foot"><tr>
    <td valign="middle" class="t3" style="font-family:${FONT};font-size:13px;line-height:20px;color:${FAINT}">${esc(app)} &middot; <a class="lnk" href="${esc(S)}" target="_blank" style="color:${BLUE};text-decoration:underline">${esc(host)}</a></td>
    <td valign="middle" align="right" class="t3" style="font-family:${FONT};font-size:13px;line-height:20px;color:${FAINT};white-space:nowrap"><a class="lnk" href="${esc(S)}/privacy" target="_blank" style="color:${BLUE};text-decoration:none">Privacy Policy</a> &middot; <a class="lnk" href="${esc(S)}/terms" target="_blank" style="color:${BLUE};text-decoration:none">Terms of Service</a></td>
  </tr></table>
</td></tr>

</table>
<!--[if mso]></td></tr></table><![endif]-->
</td></tr></table>
</body></html>`;

  const text = [
    h, '', intro,
    ...(code ? ['', `Your code: ${code}`] : []),
    ...(button && link ? ['', `${button}: ${link}`] : []),
    ...(expiryNote ? ['', expiryNote] : []),
    ...(note ? ['', note.text] : []),
    '', '—', `${app} · ${host}`, `Privacy Policy: ${S}/privacy`, `Terms of Service: ${S}/terms`,
  ].join('\n');
  return { subject: title, text, html };
}

const T = {
  orgInvite: (d) => layout({ ...d, title: `Join ${d.org} on ${d.app}`, intro: `${d.inviter || 'An organisation owner'} invited you to ${d.org} as ${d.role === 'admin' ? 'an admin' : 'a moderator'}. Sign in with this email to accept.`, button: 'Accept invite', link: d.link,
    expiryNote: 'This invite expires in 7 days. If you were not expecting it, you can ignore this email.' }),
  reminder: (d) => layout({ ...d, title: d.title || `Starting soon on ${d.app}`, intro: d.intro || '', button: d.button || 'Open', link: d.link }),
  billingNotice: (d) => layout({ ...d, title: d.title || `Your ${d.app} plan`, intro: d.intro || '', button: 'Open billing', link: d.link }),
  shortLinkNotice: (d) => layout({ ...d, title: d.title || 'Your short link', intro: d.intro || '', button: 'Renew your plan', link: d.link }),
  walletNotice: (d) => layout({ ...d, title: d.title || `Your ${d.app} credits`, intro: d.intro || '', button: 'Open wallet', link: d.link }),
  verify: (d) => layout({ ...d, title: `Confirm your email for ${d.app}`, intro: `Hi ${d.name || 'there'}, please confirm that this is your email address.`, button: 'Confirm email', link: d.link,
    expiryNote: `This link expires in ${d.expires}. If you didn't create an account, you can ignore this email.` }),
  reset: (d) => layout({ ...d, title: `Reset your ${d.app} password`, intro: 'Someone (hopefully you) asked to reset the password for this email address.', button: 'Choose a new password', link: d.link,
    expiryNote: `This link works once and expires in ${d.expires}.`,
    note: { icon: 'i-shield', text: "Resetting signs you out on every device. If you didn't ask for this, ignore this email; your password stays the same." } }),
  welcome: (d) => layout({ ...d, title: `Welcome to ${d.app}`, intro: `Hi ${d.name || 'there'}, your account is ready. Host live events and meetings, share slides and files, and keep every session in one place.`, button: `Open ${d.app}`, link: d.link }),
  setPassword: (d) => layout({ ...d, title: `Set a password for ${d.app}`, intro: `Your ${d.app} account doesn't have a password yet. Choose one to sign in with your email, or keep using Google or Apple with this same email.`, button: 'Set my password', link: d.link,
    expiryNote: `This link works once and expires in ${d.expires}. If you didn't ask for this, you can ignore this email.` }),
  accountExists: (d) => layout({ ...d, title: `You already have a ${d.app} account`, intro: 'Someone tried to create a new account with this email address, but it already has one. If that was you, sign in, or reset your password if you have forgotten it.', button: 'Sign in', link: d.link,
    note: { icon: 'i-shield', text: "If it wasn't you, you can ignore this email. Nothing has changed." } }),
  emailChanged: (d) => layout({ ...d, title: `Your ${d.app} email is changing`, intro: `A request was made to change the email on your account to ${d.newEmail}. The change takes effect once the new address is confirmed.`,
    note: { icon: 'i-shield', text: 'If this was not you, reset your password right away; that also signs out every device.' } }),
  deleteCode: (d) => layout({ ...d, title: `Your ${d.app} account deletion code`, heading: 'Confirm account deletion', preheader: `Your code is ${d.code}. It expires in ${d.expires}.`,
    intro: `Hi ${d.name || 'there'}, use this code in Settings to permanently delete your ${d.app} account.`, showCode: d.code,
    expiryNote: `This code expires in ${d.expires}. Never share it with anyone; ${d.app} will never ask you for it.`,
    note: { icon: 'i-lock', text: "If you didn't ask to delete your account, change your password now. Your account stays as it is until the code is entered." } }),
  accountDeleted: (d) => layout({ ...d, title: `Your ${d.app} account was deleted`, heading: 'Your account was deleted', intro: `Hi ${d.name || 'there'}, your ${d.app} account and its data have been deleted, as you asked. Thank you for being part of ${d.app}.`, button: `Visit ${d.app}`, link: d.link,
    note: { icon: 'i-shield', text: "If you didn't do this, contact legal@1venue.live right away. You're welcome back any time with a new account." } }),
};

function render(kind, data) {
  const fn = T[kind];
  if (!fn) throw new Error('Unknown email template: ' + kind);
  return fn(data);
}

module.exports = { render, kinds: Object.keys(T), esc, assetBase };
