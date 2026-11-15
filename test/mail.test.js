'use strict';
// Mail feature: templates, SMTP transport (mocked), console fallback when SMTP is unset.
const test = require('node:test');
const assert = require('node:assert/strict');

const mailer = require('../src/features/mail/mailer');
const { render, kinds } = require('../src/features/mail/templates');

test('every template has subject, text and escaped HTML with the link', () => {
  for (const k of kinds) {
    const m = render(k, { app: '1venue', url: 'https://1venue.example.com', name: '<b>Ada</b>', link: 'https://1venue.example.com/x?t=a&b=1', expires: '1 hour', newEmail: 'n@ex.test', code: '482913' });
    assert.ok(m.subject && m.text && m.html, k);
    assert.ok(!m.html.includes('<b>Ada</b>'), k + ': name is escaped');
    if (k === 'deleteCode') {
      assert.ok(m.text.includes('482913') && m.html.includes('482913'), k + ': has the code');
    } else if (k !== 'emailChanged') {
      assert.ok(m.text.includes('https://1venue.example.com/x?t=a&b=1'), k + ': text has the raw link');
      assert.ok(m.html.includes('https://1venue.example.com/x?t=a&amp;b=1'), k + ': html has the escaped link');
    }
  }
});

test('emails follow the brand design: hosted PNG art, privacy + terms footer, mobile + dark mode', () => {
  for (const k of kinds) {
    const m = render(k, { app: '1venue', url: 'http://localhost:3000', name: 'Ada', link: 'https://1venue.live/x', expires: '1 hour', newEmail: 'n@ex.test', code: '123456' });
    assert.match(m.html, /src="https:\/\/1venue\.live\/email\/mark\.png\?v=\d+"/, k + ': site icon from https (never localhost), cache-busted');
    assert.match(m.html, /background-image:url\('https:\/\/1venue\.live\/email\/hero\.png\?v=\d+'\)/, k + ': laptop art');
    assert.match(m.html, /<v:fill type="frame" src="https:\/\/1venue\.live\/email\/hero\.png/, k + ': Outlook VML fallback');
    // decoration is never an <img> or a link: only the logo is an image, and it links to the site
    const imgs = m.html.match(/<img\b[^>]*>/g) || [];
    assert.equal(imgs.length, 1, k + ': only the logo is an <img>');
    assert.match(imgs[0], /mark\.png/);
    for (const d of ['hero', 'people', 'i-link', 'i-time', 'i-shield', 'i-lock']) {
      for (const a of m.html.match(/<a\b[\s\S]*?<\/a>/g) || []) assert.ok(!a.includes(`/email/${d}.png`), `${k}: ${d} is not inside a link`);
    }
    assert.match(m.html, /class="deco[^"]*"[^>]*pointer-events:none/, k + ': decoration ignores clicks');
    assert.match(m.html, /font-size:24px;line-height:31px;font-weight:600/, k + ': heading in the site scale');
    assert.doesNotMatch(m.html, /font-weight:(7|8|9)00/, k + ': no heavy display weights');
    assert.match(m.html, /font-family:Inter,ui-sans-serif,system-ui/, k + ': site font stack');
    assert.doesNotMatch(m.html, /\.svg"/, k + ': no SVG images (Gmail drops them)');
    assert.match(m.html, /href="http:\/\/localhost:3000\/privacy"[^>]*>Privacy Policy</, k + ': footer links follow PUBLIC_URL');
    assert.match(m.html, /href="http:\/\/localhost:3000\/terms"[^>]*>Terms of Service</, k);
    assert.doesNotMatch(m.html, /facebook|twitter|linkedin|youtube|instagram/i, k + ': no social links');
    assert.match(m.html, /@media only screen and \(max-width:620px\)/, k + ': stacks on phones');
    assert.match(m.html, /prefers-color-scheme:dark/, k + ': dark mode palette');
    assert.match(m.html, /role="presentation"/, k + ': table layout');
    assert.match(m.text, /Privacy Policy: http:\/\/localhost:3000\/privacy/, k + ': plain-text footer');
    if (k !== 'deleteCode') assert.ok(!m.html.includes('123456'), k + ': codes only appear in the code email');
  }
  const fs = require('node:fs');
  const path = require('node:path');
  for (const f of ['hero', 'mark', 'people', 'i-link', 'i-time', 'i-shield', 'i-lock']) {
    const p = path.join(__dirname, '..', 'public', 'email', f + '.png');
    assert.ok(fs.existsSync(p), f); assert.ok(fs.statSync(p).size < (f === 'hero' ? 150 : 200) * 1024, f + ' small enough');
  }
  const saved = process.env.MAIL_ASSET_URL; process.env.MAIL_ASSET_URL = 'https://cdn.example.com/';
  try { assert.match(render('verify', { app: '1venue', url: 'https://1venue.live', link: 'x', expires: '1 day' }).html, /url\('https:\/\/cdn\.example\.com\/email\/hero\.png\?v=\d+'\)/); } finally { if (saved === undefined) delete process.env.MAIL_ASSET_URL; else process.env.MAIL_ASSET_URL = saved; }
});

test('send() uses the transport with from/to/subject/text/html', async () => {
  const sent = [];
  mailer._setTransport({ sendMail: async (m) => { sent.push(m); return { messageId: 'm1' }; } });
  try {
    const r = await mailer.send('reset', 'ada@ex.test', { link: 'https://app/reset?token=abc', expires: '1 hour' });
    assert.deepEqual(r, { sent: true, id: 'm1' });
    assert.equal(sent.length, 1);
    assert.equal(sent[0].to, 'ada@ex.test');
    assert.match(sent[0].subject, /Reset your .* password/);
    assert.match(sent[0].text, /https:\/\/app\/reset\?token=abc/);
    assert.match(sent[0].html, /<a href="https:\/\/app\/reset\?token=abc"/);
    assert.ok(sent[0].from);
  } finally { mailer._setTransport(null); }
});

test('send() never throws when SMTP fails', async () => {
  mailer._setTransport({ sendMail: async () => { throw Object.assign(new Error('auth failed'), { code: 'EAUTH' }); } });
  const orig = console.error; const logs = []; console.error = (...a) => logs.push(a.join(' '));
  try {
    const r = await mailer.send('verify', 'ada@ex.test', { link: 'https://app/verify?token=secret123', expires: '2 days' });
    assert.deepEqual(r, { sent: false, reason: 'error' });
    assert.ok(!logs.join('\n').includes('secret123'), 'links are not logged on failure');
  } finally { console.error = orig; mailer._setTransport(null); }
});

test('real nodemailer message is built (stream transport, nothing sent)', async () => {
  const nodemailer = require('nodemailer');
  const t = nodemailer.createTransport({ streamTransport: true, buffer: true, newline: 'unix' });
  mailer._setTransport(t);
  try {
    const orig = t.sendMail.bind(t); let raw = '';
    t.sendMail = async (m) => { const info = await orig(m); raw = info.message.toString(); return info; };
    const r = await mailer.send('welcome', 'ada@ex.test', { name: 'Ada', link: 'https://1venue.example.com/' });
    assert.equal(r.sent, true);
    assert.match(raw, /^To: ada@ex\.test$/m);
    assert.match(raw, /multipart\/alternative/);
  } finally { mailer._setTransport(null); }
});

test('without SMTP_HOST: links are printed outside production, hidden in production', async () => {
  const saved = { SMTP_HOST: process.env.SMTP_HOST, NODE_ENV: process.env.NODE_ENV, MAIL_LOG_LINKS: process.env.MAIL_LOG_LINKS };
  delete process.env.SMTP_HOST; delete process.env.MAIL_LOG_LINKS;
  const out = []; const ol = console.log; const ow = console.warn;
  console.log = (...a) => out.push(a.join(' ')); console.warn = (...a) => out.push(a.join(' '));
  try {
    process.env.NODE_ENV = 'development';
    assert.equal((await mailer.send('verify', 'ada@ex.test', { link: 'https://x/verify?token=dev1', expires: '2 days' })).reason, 'not-configured');
    assert.ok(out.some((l) => l.includes('link=https://x/verify?token=dev1')));
    out.length = 0;
    process.env.NODE_ENV = 'production';
    await mailer.send('reset', 'ada@ex.test', { link: 'https://x/reset?token=prod1', expires: '1 hour' });
    assert.ok(!out.join('\n').includes('prod1'), 'no live reset links in production logs');
    assert.ok(out.some((l) => /SMTP not configured/.test(l) && l.includes('a***@ex.test')));
  } finally {
    console.log = ol; console.warn = ow;
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
});
