'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

describe('certificate redesign', () => {
  it('normalises wording, programme, issuer and signatories', () => {
    const { normalizeCerts } = require('../src/features/certificates/service');
    const c = normalizeCerts({
      enabled: true, design: 'elegant', minMinutes: 15,
      titleKind: 'completion', openerId: 'presented', bodyId: 'completed',
      programme: 'Leadership Lab', issuerName: 'Harmon House',
      signatories: [{ name: 'Ada Lovelace', role: 'Director', source: 'typed' }],
    });
    assert.equal(c.title, 'Certificate of Completion');
    assert.equal(c.opener, 'This certificate is proudly presented to');
    assert.equal(c.body, 'has completed');
    assert.equal(c.programme, 'Leadership Lab');
    assert.equal(c.issuerName, 'Harmon House');
    assert.equal(c.design, 'elegant');
    assert.equal(c.signatories.length, 1);
    assert.equal(c.signatories[0].name, 'Ada Lovelace');
    const custom = normalizeCerts({ titleKind: 'custom', titleCustom: 'Award of Merit', openerId: 'custom', openerCustom: 'With gratitude we honour' });
    assert.equal(custom.title, 'Award of Merit');
    assert.equal(custom.opener, 'With gratitude we honour');
    const old = normalizeCerts({ enabled: 1, design: 'classic', minMinutes: 10 });
    assert.equal(old.title, 'Certificate of Attendance');
    assert.equal(old.opener, 'This is to certify that');
    assert.equal(old.body, 'has successfully attended');
  });

  it('formats a single date or a multi-day range', () => {
    const { formatDateRange } = require('../src/features/certificates/wording');
    assert.match(formatDateRange('2026-11-25T09:00:00+01:00', '2026-11-25T17:00:00+01:00'), /25 November 2026/);
    const range = formatDateRange('2026-11-25T09:00:00+01:00', '2026-11-27T17:00:00+01:00');
    assert.match(range, /25/);
    assert.match(range, /27 November 2026/);
  });

  it('cleans a signature photo to tight dark ink on a transparent background', async () => {
    const sharp = require('sharp');
    const { cleanSignature } = require('../src/features/certificates/signatures');
    // White paper with a thick black stroke and a pale margin, plus a faint grey shadow.
    const w = 400, h = 180;
    const buf = Buffer.alloc(w * h * 3, 250);
    for (let x = 40; x < 360; x++) {
      const y = Math.round(90 + Math.sin(x / 28) * 22);
      for (let dy = -4; dy <= 4; dy++) {
        const i = ((y + dy) * w + x) * 3;
        buf[i] = buf[i + 1] = buf[i + 2] = 20;
      }
    }
    const jpg = await sharp(buf, { raw: { width: w, height: h, channels: 3 } }).jpeg().toBuffer();
    const cleaned = await cleanSignature(jpg);
    assert.equal(cleaned.mime, 'image/png');
    assert.ok(cleaned.width < w, 'should trim the paper margin');
    assert.ok(cleaned.height < h);
    const meta = await sharp(cleaned.buffer).metadata();
    assert.equal(meta.channels, 4);
    const raw = await sharp(cleaned.buffer).raw().toBuffer();
    let transparent = 0, ink = 0;
    for (let i = 0; i < raw.length; i += 4) {
      if (raw[i + 3] < 20) transparent++;
      if (raw[i + 3] > 200 && raw[i] < 50) ink++;
    }
    assert.ok(transparent > 50, 'paper should become transparent');
    assert.ok(ink > 20, 'ink should stay dark and opaque');
  });

  it('builds a PDF for each design, including fallbacks for old certificates', async () => {
    const { certificatePdf } = require('../src/features/certificates/pdf');
    const { pdfFor } = require('../src/features/certificates/service');
    for (const design of ['classic', 'modern', 'minimal', 'elegant']) {
      const buf = await certificatePdf({
        name: 'Ada Lovelace',
        certTitle: 'Certificate of Attendance',
        opener: 'This is to certify that',
        body: 'has successfully attended',
        programme: 'Music as Inner Peace',
        description: 'for completing the seminar',
        date: '25 November 2026',
        issuerName: 'Harmon House',
        signatories: [{ name: 'Chinedu Okoye', role: 'Host', source: 'typed' }],
        code: 'ABCDE12345',
        url: 'https://1venue.live/cert/ABCDE12345',
        accent: '#7c3aed',
        design,
      });
      assert.ok(buf.length > 2000);
      assert.equal(buf.subarray(0, 5).toString(), '%PDF-');
    }
    const legacy = await pdfFor({
      attendeeName: 'Legacy Guest',
      eventTitle: 'Old Event',
      hostName: 'Old Host',
      design: 'classic',
      accent: '#2563eb',
      code: 'LEGACY0001',
      url: 'https://1venue.live/cert/LEGACY0001',
      issuedAt: '2026-01-01T12:00:00Z',
    });
    assert.equal(legacy.subarray(0, 5).toString(), '%PDF-');
  });

  it('wires the sign page, live preview editor, and cache versions', () => {
    const app = read('public/js/app.js');
    assert.match(app, /pages\/cert-sign\.js/);
    assert.match(app, /pages\/cert\.js/);
    assert.match(read('public/js/cert-ui.js'), /\/api\/certs\/preview/);
    assert.match(read('public/js/cert-ui.js'), /Programme name on the certificate/);
    assert.match(read('public/js/pages/cert.js'), /Verified/);
    assert.match(read('public/js/pages/cert.js'), /linkedin/i);
    assert.match(read('public/js/pages/cert-sign.js'), /cert-pad/);
    assert.match(read('public/sw.js'), /VERSION = 'v92-2026-11-23'/);
    assert.match(read('public/index.html'), /app\.css\?v=78/);
    assert.ok(fs.existsSync(path.join(__dirname, '..', 'assets/fonts/GreatVibes-Regular.ttf')));
    assert.ok(fs.existsSync(path.join(__dirname, '..', 'migrations/sqlite/031_cert_redesign.sql')));
    assert.ok(fs.existsSync(path.join(__dirname, '..', 'src/features/certificates/migrations/20261125120000_cert_redesign.sql')));
  });
});

const { test } = require('node:test');
const skip = process.env.DB_DRIVER !== 'sqlite' && !process.env.DATABASE_URL ? 'set DATABASE_URL or DB_DRIVER=sqlite' : false;
if (process.env.DB_DRIVER === 'sqlite') require('./helpers/server');

test('issues a snapshotted certificate and serves the cert, preview, lookup, and sign flow', { skip, timeout: 90000 }, async () => {
  const { boot, client, signupPayload } = require('./helpers/server');
  const db = require('../db');
  const s = await boot();
  try {
    const host = client(s.base);
    const guest = client(s.base);
    const signer = client(s.base);
    const hostSignup = signupPayload();
    const signerSignup = signupPayload();
    await host.post('/api/signup', hostSignup);
    await guest.post('/api/signup', signupPayload());
    await signer.post('/api/signup', signerSignup);
    const hid = (await host.get('/api/session')).body.user.id;
    const gid = (await guest.get('/api/session')).body.user.id;
    const signerUser = (await signer.get('/api/session')).body.user;

    const look = await host.get('/api/certs/lookup?username=' + encodeURIComponent(signerUser.username));
    assert.equal(look.status, 200, JSON.stringify(look.body));
    assert.equal(look.body.id, signerUser.id);

    const cat = await host.get('/api/certs/catalogue');
    assert.equal(cat.status, 200);
    assert.ok(cat.body.titles.some((t) => t.id === 'completion'));

    const preview = await fetch(s.base + '/api/certs/preview', {
      method: 'POST',
      headers: { cookie: host.jar.header(), 'content-type': 'application/json' },
      body: JSON.stringify({
        design: 'elegant', titleKind: 'appreciation', programme: 'Live preview', issuerName: 'Acme Ltd',
        signatories: [{ name: 'Ngozi', role: 'CEO', source: 'typed' }],
      }),
    });
    assert.equal(preview.status, 200);
    assert.match(preview.headers.get('content-type') || '', /pdf/);
    await preview.arrayBuffer();

    // Event with an account signatory triggers a sign request.
    const ev = await host.post('/api/events', {
      title: 'Cert Workshop Event', category: 'workshop', visibility: 'public',
      startsAt: new Date(Date.now() - 2 * 3600e3).toISOString(),
      endsAt: new Date(Date.now() - 3600e3).toISOString(),
      settings: { certs: {
        enabled: true, design: 'classic', minMinutes: 5,
        titleKind: 'completion', programme: 'Advanced Workshop',
        issuerName: 'Harmon House',
        signatories: [
          { name: 'Typed Signer', role: 'Director', source: 'typed' },
          { username: signerUser.username, role: 'Facilitator', source: 'account' },
        ],
      } },
    });
    assert.ok(ev.status < 300, JSON.stringify(ev.body));
    const eventId = ev.body.id;
    const reqRow = (await db.q('SELECT * FROM cert_sign_requests WHERE event_id=$1', [eventId])).rows[0];
    assert.ok(reqRow, 'expected a sign request for the account signatory');

    const signView = await signer.get('/api/certs/sign/' + reqRow.token);
    assert.equal(signView.status, 200, JSON.stringify(signView.body));
    const wrong = await guest.post('/api/certs/sign/' + reqRow.token, { typed: true });
    assert.equal(wrong.status, 403);

    // Draw-like PNG: dark stroke on white
    const sharp = require('sharp');
    const w = 300, h = 100;
    const buf = Buffer.alloc(w * h * 3, 255);
    for (let x = 30; x < 270; x++) for (let dy = -3; dy <= 3; dy++) { const i = ((50 + dy) * w + x) * 3; buf[i] = buf[i + 1] = buf[i + 2] = 10; }
    const png = await sharp(buf, { raw: { width: w, height: h, channels: 3 } }).png().toBuffer();
    const signed = await signer.post('/api/certs/sign/' + reqRow.token, { dataUrl: 'data:image/png;base64,' + png.toString('base64') });
    assert.equal(signed.status, 200, JSON.stringify(signed.body));
    assert.equal(signed.body.request.status, 'signed');
    assert.ok(signed.body.request.signatureUrl);
    const saved = (await db.q('SELECT image_url FROM user_signatures WHERE user_id=$1', [signerUser.id])).rows[0];
    assert.ok(saved && saved.image_url);

    const hist = (await db.q("INSERT INTO meeting_history(code, name, host_user_id) VALUES('CERT43','Cert Workshop Event',$1) RETURNING id", [hid])).rows[0];
    await db.q('INSERT INTO meeting_participants_log(meeting_history_id,user_id,display_name,participant_id,joined_at,left_at) VALUES($1,$2,$3,$4,$5,$6)',
      [hist.id, gid, 'Guest Person', 'p1', new Date(Date.now() - 20 * 60 * 1000).toISOString(), new Date().toISOString()]);
    const { issueForMeeting, getByCode } = require('../src/features/certificates/service');
    const issued = await issueForMeeting({ historyId: hist.id, eventId, name: 'Cert Workshop Event', hostName: 'Host' });
    assert.equal(issued.length, 1);
    const cert = await getByCode(issued[0].code);
    assert.equal(cert.title, 'Certificate of Completion');
    assert.equal(cert.programme, 'Advanced Workshop');
    assert.equal(cert.issuerName, 'Harmon House');
    assert.equal(cert.signatories.length, 2);
    assert.ok(cert.signatories[1].signatureUrl, 'signed account signatory should be snapshotted');
    assert.match(cert.linkedinUrl, /linkedin\.com\/profile\/add/);

    const api = await guest.get('/api/certs/' + cert.code);
    assert.equal(api.status, 200);
    const pdf = await fetch(s.base + '/api/certs/' + cert.code + '/pdf', { headers: { cookie: guest.jar.header() } });
    assert.equal(pdf.status, 200);
    assert.match(pdf.headers.get('content-type') || '', /pdf/);
    const pdfBuf = Buffer.from(await pdf.arrayBuffer());
    assert.equal(pdfBuf.subarray(0, 5).toString(), '%PDF-');

    // Legacy row without snapshot still renders.
    await db.q("INSERT INTO certificates(code, history_id, event_id, user_id, attendee_name, event_title, host_name, design, accent) VALUES('LEGACY0043',$1,NULL,$2,'Old Person','Old Event','Old Host','modern','#2563eb')", [hist.id, hid]);
    const legacy = await fetch(s.base + '/api/certs/LEGACY0043/pdf', { headers: { cookie: guest.jar.header() } });
    assert.equal(legacy.status, 200);
    assert.equal(Buffer.from(await legacy.arrayBuffer()).subarray(0, 5).toString(), '%PDF-');
    const legacyJson = await guest.get('/api/certs/LEGACY0043');
    assert.equal(legacyJson.body.title, 'Certificate of Attendance');
    assert.equal(legacyJson.body.issuerName, 'Old Host');
  } finally { await s.stop(); }
});
