'use strict';
// Materials + presenting uploads. Regression for: with R2 (STORAGE_DRIVER=s3) and S3_PUBLIC_BASE_URL set,
// /api/files returns https://<public-domain>/<key>, but materials and the room content validator
// accepted only /files/… URLs, so every saved deck / presented PDF was rejected after the upload
// had already landed in the bucket, with nothing in the runtime log.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { boot, client, signupPayload } = require('./helpers/server');

const skip = !process.env.DATABASE_URL ? 'set DATABASE_URL' : false;
const PUB = 'https://files.example.test';
const png = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex');

test('stored-file URL helper accepts /files/ and the S3 public base only', () => {
  const config = require('../src/config');
  const { normalizeStoredFileUrl } = require('../src/lib/file-url');
  const prev = config.STORAGE.s3.publicBaseUrl;
  try {
    config.STORAGE.s3.publicBaseUrl = '';
    assert.equal(normalizeStoredFileUrl('/files/abcDEF123456/page-1.jpg'), '/files/abcDEF123456/page-1.jpg');
    assert.equal(normalizeStoredFileUrl(`${PUB}/2026/11/x-page.jpg`), null, 'no public base configured');
    config.STORAGE.s3.publicBaseUrl = PUB;
    assert.equal(normalizeStoredFileUrl(`${PUB}/2026/11/x-page.jpg`), `${PUB}/2026/11/x-page.jpg`);
    for (const bad of [`${PUB}/../etc`, `${PUB}/a"onerror=1`, `${PUB}/`, `${PUB}.evil.com/a.jpg`, 'https://evil.test/a.jpg', 'javascript:alert(1)', '/files/../x', 42, null]) {
      assert.equal(normalizeStoredFileUrl(bad), null, String(bad));
    }
    const { sanitizeMaterialPayload } = require('../src/features/materials/data');
    assert.deepEqual(sanitizeMaterialPayload('pdf', { pages: [`${PUB}/2026/11/a.jpg`, '/files/abcDEF123456/b.jpg'] }).pages, [`${PUB}/2026/11/a.jpg`, '/files/abcDEF123456/b.jpg']);
    assert.equal(sanitizeMaterialPayload('image', { url: `${PUB}/2026/11/a.jpg` }).url, `${PUB}/2026/11/a.jpg`);
    assert.throws(() => sanitizeMaterialPayload('pdf', { pages: ['https://evil.test/a.jpg'] }), /not uploaded to 1venue storage/);
  } finally { config.STORAGE.s3.publicBaseUrl = prev; }
});

test('room: R2 public URLs can be presented; a rejected share tells the presenter why', () => {
  const config = require('../src/config');
  const prev = config.STORAGE.s3.publicBaseUrl;
  config.STORAGE.s3.publicBaseUrl = PUB;
  try {
    const plugin = require('../src/features/content/ws');
    const { getContentState } = require('../src/rooms/store');
    const handlers = new Map(), sent = [], events = [];
    const meeting = { participants: new Map([['host', { id: 'host', role: 'host' }]]) };
    plugin.register({ onWs: (t, cb) => handlers.set(t, cb), onRegister: () => {}, broadcast: (c, d) => events.push(d), getContentState, clients: new Map(),
      sendToParticipant: (pid, m) => sent.push({ pid, m }) });
    const start = (msg) => handlers.get('content-start')({ msg, participantId: 'host', meeting, meetingCode: 'ab12cd' });
    start({ contentType: 'slides', pages: [`${PUB}/2026/11/p1.jpg`, `${PUB}/2026/11/p2.jpg`] });
    assert.equal(meeting.content.pages.length, 2); assert.equal(events.at(-1).type, 'content-state');
    start({ contentType: 'image', url: 'https://evil.test/x.png' });
    assert.equal(sent.length, 1); assert.equal(sent[0].m.type, 'error'); assert.equal(sent[0].m.code, 'content-rejected');
  } finally { config.STORAGE.s3.publicBaseUrl = prev; }
});

test('R2-style storage: upload a 15-page deck, save it as a material, logs show every step', { skip }, async () => {
  // In-memory S3 (R2 stand-in): accepts signed PUTs, records keys.
  const objects = new Map();
  const s3 = http.createServer((req, res) => {
    const chunks = []; req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      if (!/AWS4-HMAC-SHA256 Credential=test-key\//.test(req.headers.authorization || '')) { res.writeHead(403); return res.end('<Error><Code>AccessDenied</Code></Error>'); }
      if (req.method === 'PUT') { objects.set(req.url, Buffer.concat(chunks)); res.writeHead(200); return res.end(); }
      res.writeHead(404); res.end();
    });
  });
  await new Promise((r) => s3.listen(0, '127.0.0.1', r));
  const s = await boot({ STORAGE_DRIVER: 's3', S3_ENDPOINT: `http://127.0.0.1:${s3.address().port}`, S3_BUCKET: 'venue', S3_REGION: 'auto',
    S3_ACCESS_KEY_ID: 'test-key', S3_SECRET_ACCESS_KEY: 'test-secret', S3_FORCE_PATH_STYLE: 'true', S3_PUBLIC_BASE_URL: PUB });
  try {
    const c = client(s.base); await c.post('/api/signup', signupPayload());
    const pages = [];
    for (let i = 1; i <= 15; i++) { // more than UPLOAD_RATE_PER_MIN (12): decks use the content batch limit
      const r = await fetch(`${s.base}/api/files?purpose=content`, { method: 'POST', headers: { cookie: c.jar.header(), 'content-type': 'image/jpeg', 'x-file-name': `deck-p${i}.jpg` }, body: png });
      const j = await r.json();
      assert.equal(r.status, 200, `page ${i}: ${JSON.stringify(j)}`);
      assert.ok(j.url.startsWith(PUB + '/'), j.url);
      pages.push(j.url);
    }
    assert.equal(objects.size, 15, 'all pages reached the bucket');
    const m = await c.post('/api/materials', { title: 'Sunday deck', kind: 'pdf', payload: { pages, sourceName: 'deck.pdf', sourceMime: 'application/pdf' } });
    assert.equal(m.status, 200, JSON.stringify(m.body));
    assert.equal(m.body.payload.pages.length, 15);
    const img = await c.post('/api/materials', { title: 'Poster', kind: 'image', payload: { url: pages[0] } });
    assert.equal(img.status, 200, JSON.stringify(img.body));
    const bad = await c.post('/api/materials', { title: 'Bad', kind: 'pdf', payload: { pages: ['https://evil.test/x.jpg'] } });
    assert.equal(bad.status, 400); assert.match(bad.body.error, /not uploaded to 1venue storage/);
    const list = (await c.get('/api/materials')).body.materials;
    assert.deepEqual(list.map((x) => x.title).sort(), ['Poster', 'Sunday deck']);
    const ev = await c.post('/api/events', { title: 'Deck night', category: 'seminar' });
    assert.ok(ev.status === 200 || ev.status === 201, JSON.stringify(ev.body));
    const put = await fetch(`${s.base}/api/events/${ev.body.id}/materials`, { method: 'PUT', headers: { cookie: c.jar.header(), 'content-type': 'application/json' }, body: JSON.stringify({ materialIds: [m.body.id, img.body.id] }) });
    assert.equal(put.status, 200); assert.equal((await put.json()).materials.length, 2);

    const out = s.output();
    assert.match(out, /\[upload\] received \{.*"purpose":"content"/);
    assert.match(out, /\[storage\] put ok \{"driver":"s3"/);
    assert.match(out, /\[upload\] ok \{.*"driver":"s3"/);
    assert.match(out, /\[materials\] created \{.*"pages":15/);
    assert.match(out, /\[materials\] create failed \{.*"status":400.*"reason":"0 of 1 page urls accepted/);
    assert.match(out, /\[materials\] event attached \{.*"count":2/);

    // Bucket refuses (bad R2 token / permissions): the client gets a clear 502, the log has R2's error code.
    objects.clear();
    const s2 = await boot({ STORAGE_DRIVER: 's3', S3_ENDPOINT: `http://127.0.0.1:${s3.address().port}`, S3_BUCKET: 'venue', S3_REGION: 'auto',
      S3_ACCESS_KEY_ID: 'wrong-key', S3_SECRET_ACCESS_KEY: 'x', S3_PUBLIC_BASE_URL: PUB });
    try {
      const c2 = client(s2.base); await c2.post('/api/signup', signupPayload());
      const r = await fetch(`${s2.base}/api/files?purpose=content`, { method: 'POST', headers: { cookie: c2.jar.header(), 'content-type': 'image/png', 'x-file-name': 'a.png' }, body: png });
      assert.equal(r.status, 502); assert.match((await r.json()).error, /Storage rejected the file \(403 AccessDenied\)/);
      assert.match(s2.output(), /\[storage\] put failed \{.*"status":403,"code":"AccessDenied"/);
      assert.match(s2.output(), /\[upload\] failed \{.*"status":502.*"step":"storage-put"/);
    } finally { await s2.stop(); }
  } finally { await s.stop(); s3.close(); }
});

/* ---------------------------------------------------------------- spaces / special characters (prod: "CV - Web Developer - …-p1.jpg") */
test('file URLs with spaces / parentheses: raw or encoded are accepted and canonicalised; traversal still refused', () => {
  const config = require('../src/config');
  const { normalizeStoredFileUrl } = require('../src/lib/file-url');
  const prev = config.STORAGE.s3.publicBaseUrl;
  config.STORAGE.s3.publicBaseUrl = PUB;
  try {
    const want = `${PUB}/2026/11/fWiqqBXv3mWqVPhL5T9tNg-CV%20-%20Web%20Developer%20-%20Chinedu%20%28Okonkwo%29-p1.jpg`;
    assert.equal(normalizeStoredFileUrl(`${PUB}/2026/11/fWiqqBXv3mWqVPhL5T9tNg-CV - Web Developer - Chinedu (Okonkwo)-p1.jpg`), want, 'raw spaces (exactly what prod returned)');
    assert.equal(normalizeStoredFileUrl(want), want, 'already encoded');
    assert.equal(normalizeStoredFileUrl(`${PUB}/2026/11/x-CV%20-%20Web (Okonkwo)-p1.jpg`), `${PUB}/2026/11/x-CV%20-%20Web%20%28Okonkwo%29-p1.jpg`, 'mixed');
    assert.equal(normalizeStoredFileUrl('/files/fWiqqBXv3mWqVPhL5T9tNg/CV - Web Developer.jpg'), '/files/fWiqqBXv3mWqVPhL5T9tNg/CV%20-%20Web%20Developer.jpg');
    for (const bad of [`${PUB}/2026/%2e%2e/secret`, `${PUB}/2026/a%2Fb.jpg`, `${PUB}/2026/a%3Cscript%3E.jpg`, `${PUB}/2026//a.jpg`, `${PUB}/a.jpg?x=1`, `${PUB}/a%ZZ.jpg`, '/files/abc/def/ghi.jpg', '/files/../x/y.jpg']) {
      assert.equal(normalizeStoredFileUrl(bad), null, bad);
    }
  } finally { config.STORAGE.s3.publicBaseUrl = prev; }
});

test('storage keys are slugs; public URLs are percent-encoded even for old keys with spaces', () => {
  const storage = require('../src/venue/storage');
  const config = require('../src/config');
  assert.equal(storage.slugName('CV - Web Developer - Chinedu (Okonkwo)-p1.jpg'), 'CV-Web-Developer-Chinedu-Okonkwo-p1.jpg');
  assert.equal(storage.slugName('Ọ̀rọ̀ Ìyìn — Sunday.PDF'), 'Oro-Iyin-Sunday.pdf');
  assert.equal(storage.slugName('   '), 'file');
  assert.equal(storage.slugName('..'), 'file');
  const prev = { ...config.STORAGE.s3 };
  Object.assign(config.STORAGE.s3, { publicBaseUrl: PUB });
  try {
    assert.equal(storage.publicUrl({ driver: 's3', object_key: '2026/11/abc-CV - Web (v2).jpg' }), `${PUB}/2026/11/abc-CV%20-%20Web%20%28v2%29.jpg`);
  } finally { Object.assign(config.STORAGE.s3, prev); }
});

test('R2-style storage: spaced filenames, real PDF pages + real PPTX conversion, client error reports, pptx always logged', { skip, timeout: 120000 }, async () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const { spawnSync } = require('node:child_process');
  const objects = new Map();
  const s3 = http.createServer((req, res) => {
    const chunks = []; req.on('data', (c) => chunks.push(c));
    req.on('end', () => { if (req.method === 'PUT') { objects.set(decodeURIComponent(req.url), Buffer.concat(chunks)); res.writeHead(200); return res.end(); } res.writeHead(404); res.end(); });
  });
  await new Promise((r) => s3.listen(0, '127.0.0.1', r));
  const s = await boot({ STORAGE_DRIVER: 's3', S3_ENDPOINT: `http://127.0.0.1:${s3.address().port}`, S3_BUCKET: 'venue', S3_REGION: 'auto',
    S3_ACCESS_KEY_ID: 'k', S3_SECRET_ACCESS_KEY: 's', S3_FORCE_PATH_STYLE: 'true', S3_PUBLIC_BASE_URL: PUB });
  try {
    const c = client(s.base); await c.post('/api/signup', signupPayload());
    const up = async (name) => {
      const r = await fetch(`${s.base}/api/files?purpose=content`, { method: 'POST', headers: { cookie: c.jar.header(), 'content-type': 'image/jpeg', 'x-file-name': encodeURIComponent(name) }, body: png });
      assert.equal(r.status, 200); return (await r.json()).url;
    };
    const u1 = await up('CV - Web Developer - Chinedu (Okonkwo)-p1.jpg');
    const u2 = await up('CV - Web Developer - Chinedu (Okonkwo)-p2.jpg');
    assert.match(u1, /^https:\/\/files\.example\.test\/\d{4}\/\d\d\/[\w-]+-CV-Web-Developer-Chinedu-Okonkwo-p1\.jpg$/, u1);
    assert.ok([...objects.keys()].every((k) => !/\s/.test(k)), 'no spaces in object keys');
    const m = await c.post('/api/materials', { title: 'CV - Web Developer', kind: 'pdf', payload: { pages: [u1, u2], sourceName: 'CV - Web Developer - Chinedu (Okonkwo).pdf', sourceMime: 'application/pdf' } });
    assert.equal(m.status, 200, JSON.stringify(m.body)); assert.deepEqual(m.body.payload.pages, [u1, u2]);
    // Pages uploaded by 65f10a3 (raw spaces in the key) still save.
    const legacy = await c.post('/api/materials', { title: 'Legacy', kind: 'pdf', payload: { pages: [`${PUB}/2026/11/fWiqqBXv3mWqVPhL5T9tNg-CV - Web Developer - Chinedu Okonkwo-p1.jpg`] } });
    assert.equal(legacy.status, 200, JSON.stringify(legacy.body));
    assert.equal(legacy.body.payload.pages[0], `${PUB}/2026/11/fWiqqBXv3mWqVPhL5T9tNg-CV%20-%20Web%20Developer%20-%20Chinedu%20Okonkwo-p1.jpg`);

    // PPTX: every attempt is logged first, even ones that fail auth / type checks.
    const pptxPath = path.join(__dirname, 'fixtures', 'Sunday Service - Order (v2).pptx');
    const pptx = fs.readFileSync(pptxPath);
    const PPTX_MIME = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
    const anon = await fetch(`${s.base}/api/convert/pptx?title=x`, { method: 'POST', headers: { 'content-type': PPTX_MIME }, body: pptx });
    assert.equal(anon.status, 401);
    const wrong = await fetch(`${s.base}/api/convert/pptx`, { method: 'POST', headers: { cookie: c.jar.header(), 'content-type': 'text/plain' }, body: 'nope' });
    assert.equal(wrong.status, 415);
    const out = () => s.output();
    assert.match(out(), /\[pptx\] received \{"bytes":\d+,"mime":"application\/vnd\.openxml/);
    assert.match(out(), /\[pptx\] failed \{.*"who":"anon".*"status":401/);
    assert.match(out(), /\[pptx\] failed \{.*"status":415/);
    const hasLO = !spawnSync('soffice', ['--version'], { timeout: 20000 }).error && !spawnSync('pdftoppm', ['-v']).error;
    if (hasLO) {
      const r = await fetch(`${s.base}/api/convert/pptx?title=${encodeURIComponent('Sunday Service - Order (v2)')}`, { method: 'POST', headers: { cookie: c.jar.header(), 'content-type': PPTX_MIME }, body: pptx });
      const j = await r.json();
      assert.equal(r.status, 200, JSON.stringify(j));
      assert.equal(j.pages.length, 3);
      assert.ok(j.pages.every((p) => p.startsWith(PUB + '/') && !/\s/.test(p)), j.pages[0]);
      const mp = await c.post('/api/materials', { title: j.title, kind: 'pptx', payload: { pages: j.pages, sourceName: 'Sunday Service - Order (v2).pptx' } });
      assert.equal(mp.status, 200, JSON.stringify(mp.body));
      assert.match(out(), /\[pptx\] ok \{.*"pages":3/);
    }

    // Browser-side failures land in the server log.
    const rep = await fetch(`${s.base}/api/client-log`, { method: 'POST', headers: { cookie: c.jar.header(), 'content-type': 'application/json' },
      body: JSON.stringify({ area: 'materials', step: 'render PDF', message: 'Invalid PDF structure', file: 'CV - Web Developer.pdf', mime: 'application/pdf', size: 12345 }) });
    assert.equal(rep.status, 200);
    assert.match(out(), /\[client\] materials error \{"who":"u:\d+","step":"render PDF","message":"Invalid PDF structure","file":"CV - Web Developer\.pdf"/);
  } finally { await s.stop(); s3.close(); }
});

test('room: presenting PDF pages whose URLs contain spaces works (canonicalised for everyone)', () => {
  const config = require('../src/config');
  const prev = config.STORAGE.s3.publicBaseUrl;
  config.STORAGE.s3.publicBaseUrl = PUB;
  try {
    const { sanitizeContent } = require('../src/features/content/ws');
    const c = sanitizeContent({ contentType: 'slides', pages: [`${PUB}/2026/11/a-CV - Web Developer-p1.jpg`, `${PUB}/2026/11/a-CV%20-%20Web%20Developer-p2.jpg`] });
    assert.deepEqual(c.pages, [`${PUB}/2026/11/a-CV%20-%20Web%20Developer-p1.jpg`, `${PUB}/2026/11/a-CV%20-%20Web%20Developer-p2.jpg`]);
  } finally { config.STORAGE.s3.publicBaseUrl = prev; }
});
