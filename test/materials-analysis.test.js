'use strict';
// Materials: Word / PowerPoint / CSV / Excel files, the dedicated material page API (access control),
// and AI analysis (Replicate Llama 3 70B; mock path; stored once and never charged twice).
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { boot, client, signupPayload } = require('./helpers/server');
const { zip, xlsx } = require('../src/lib/xlsx');
const ex = require('../src/features/materials/extract');

const skip = !process.env.DATABASE_URL && process.env.DB_DRIVER !== 'sqlite' ? 'set DATABASE_URL or DB_DRIVER=sqlite' : false;
const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const docx = (paras) => zip([{ name: '[Content_Types].xml', data: '<Types/>' }, { name: 'word/document.xml', data: `<w:document><w:body>${paras.map((p) => `<w:p><w:pPr/><w:r><w:t xml:space="preserve">${p}</w:t></w:r></w:p>`).join('')}</w:body></w:document>` }]);
const pptx = (slides) => zip(slides.map((t, i) => ({ name: `ppt/slides/slide${i + 1}.xml`, data: `<p:sld><a:p><a:r><a:t>${t}</a:t></a:r></a:p></p:sld>` })));
const CSV = 'Name,Amount,City\n"Ade, Jr",1200,Lagos\nBola,800,Abuja\nChi,"1,000",Lagos\n';

test('extract: file types, DOCX / PPTX / XLSX text, CSV parsing and local stats', () => {
  assert.equal(ex.fileType({ name: 'a.docx' }), 'docx');
  assert.equal(ex.fileType({ name: 'x', mime: XLSX }), 'xlsx');
  assert.equal(ex.fileType({ name: 'r.CSV' }), 'csv');
  assert.equal(ex.fileType({ name: 'old.ppt' }), 'ppt');
  assert.equal(ex.fileType({ name: 'noext', buf: docx(['hi']) }), 'docx', 'sniffed from the zip parts');
  assert.equal(ex.fileType({ name: 'p.png', mime: 'image/png' }), 'image');
  assert.equal(ex.kindFor('xlsx'), 'sheet'); assert.equal(ex.kindFor('docx'), 'doc'); assert.equal(ex.kindFor('ppt'), 'pptx');
  assert.equal(ex.docxText(docx(['Hello &amp; welcome', 'Second line'])), 'Hello & welcome\nSecond line');
  assert.match(ex.pptxText(pptx(['Intro', 'Budget'])), /Slide 1:\nIntro\n\nSlide 2:\nBudget/);
  const rows = ex.csvRows(CSV);
  assert.deepEqual(rows[1], ['Ade, Jr', '1200', 'Lagos']);
  const st = ex.tableStats(rows);
  assert.equal(st.rowCount, 3);
  assert.deepEqual(st.columns[1], { name: 'Amount', filled: 3, empty: 0, type: 'number', min: 800, max: 1200, mean: 1000, sum: 3000 });
  assert.equal(st.columns[2].top[0].value, 'Lagos');
  const x = ex.xlsxRows(xlsx([['Item', 'Qty'], ['Pens', 4], ['Books', 10]]));
  assert.deepEqual(x.rows, [['Item', 'Qty'], ['Pens', '4'], ['Books', '10']]);
  assert.throws(() => ex.unzip(Buffer.from('not a zip at all, no central directory here')), /damaged/);
});

test('materials: upload Word / CSV / Excel, page access control, analysis cached and mock path', { skip }, async () => {
  const s = await boot();
  try {
    const a = client(s.base); await a.post('/api/signup', signupPayload());
    const b = client(s.base); await b.post('/api/signup', signupPayload());
    const anon = client(s.base);
    const up = async (c, buf, name, mime) => { const r = await fetch(`${s.base}/api/files?purpose=content`, { method: 'POST', headers: { cookie: c.jar.header(), 'content-type': mime, 'x-file-name': name }, body: buf }); const j = await r.json(); assert.equal(r.status, 200, JSON.stringify(j)); return j; };

    const csvF = await up(a, Buffer.from(CSV), 'sales.csv', 'text/csv');
    const sheet = await a.post('/api/materials', { title: 'Sales', kind: 'sheet', payload: { sourceUrl: csvF.url, sourceName: 'sales.csv', sourceMime: 'text/csv', sourceSize: csvF.size } });
    assert.equal(sheet.status, 200, JSON.stringify(sheet.body));
    const xF = await up(a, xlsx([['Item', 'Qty'], ['Pens', 4]]), 'stock.xlsx', XLSX);
    assert.equal((await a.post('/api/materials', { title: 'Stock', kind: 'sheet', payload: { sourceUrl: xF.url, sourceName: 'stock.xlsx', sourceMime: XLSX } })).status, 200);
    const dF = await up(a, docx(['The youth retreat starts on Friday. Everyone should bring a Bible and a notebook.', 'Registration closes on Wednesday evening for all attendees.']), 'plan.docx', DOCX);
    const doc = await a.post('/api/materials', { title: 'Retreat plan', kind: 'doc', payload: { sourceUrl: dF.url, sourceName: 'plan.docx', sourceMime: DOCX } });
    assert.equal(doc.status, 200, JSON.stringify(doc.body));
    assert.equal((await a.post('/api/materials', { title: 'Bad', kind: 'doc', payload: { sourceUrl: 'https://evil.test/x.docx' } })).status, 400);
    assert.equal((await a.post('/api/materials', { title: 'Empty', kind: 'sheet', payload: {} })).status, 400);

    // Access control: owner can edit; another user and guests cannot see a private material.
    const own = await a.get(`/api/materials/${sheet.body.id}`);
    assert.equal(own.status, 200); assert.equal(own.body.canEdit, true);
    assert.equal((await b.get(`/api/materials/${sheet.body.id}`)).status, 404);
    assert.equal((await anon.get(`/api/materials/${sheet.body.id}`)).status, 401);
    assert.equal((await b.get(`/api/materials/${sheet.body.id}/preview`)).status, 404);
    assert.equal((await b.post(`/api/materials/${doc.body.id}/analyse`)).status, 404, 'only the owner spends points on it');

    // Preview: spreadsheet as a table, document as text.
    const pv = await a.get(`/api/materials/${sheet.body.id}/preview`);
    assert.equal(pv.status, 200, JSON.stringify(pv.body));
    assert.deepEqual(pv.body.table.header, ['Name', 'Amount', 'City']); assert.equal(pv.body.table.totalRows, 3);
    assert.match((await a.get(`/api/materials/${doc.body.id}/preview`)).body.text, /youth retreat/);

    // Analysis (AI_MOCK=true): computed once, stored, then served from the DB without spending points again.
    assert.equal((await a.get(`/api/materials/${sheet.body.id}/analysis`)).body.analysis, null);
    const before = (await a.get('/api/wallet')).body.balanceCredits;
    const r1 = await a.post(`/api/materials/${sheet.body.id}/analyse`);
    assert.equal(r1.status, 200, JSON.stringify(r1.body));
    assert.equal(r1.body.analysis.mock, true); assert.equal(r1.body.analysis.cached, false); assert.equal(r1.body.analysis.cost, require('../src/features/wallet/rates').aiCredits('analysis'));
    assert.equal(r1.body.analysis.data.rowCount, 3);
    assert.equal(r1.body.analysis.data.columns.find((c) => c.name === 'Amount').mean, 1000);
    assert.ok(r1.body.analysis.summary && r1.body.analysis.keyPoints.length && r1.body.analysis.dataCommentary);
    const r2 = await a.post(`/api/materials/${sheet.body.id}/analyse`);
    assert.equal(r2.body.analysis.cached, true);
    assert.equal((await a.get('/api/wallet')).body.balanceCredits, before - require('../src/features/wallet/rates').aiCredits('analysis'), 'charged once');
    assert.equal((await a.get(`/api/materials/${sheet.body.id}/analysis`)).body.analysis.summary, r1.body.analysis.summary);
    const d1 = await a.post(`/api/materials/${doc.body.id}/analyse`);
    assert.equal(d1.status, 200); assert.match(d1.body.analysis.summary, /youth retreat/);

    // Attached to a public event: anyone signed in may view it (read-only) and read its stored analysis.
    const ev = await a.post('/api/events', { title: 'Sales review', category: 'seminar' });
    const put = await fetch(`${s.base}/api/events/${ev.body.id}/materials`, { method: 'PUT', headers: { cookie: a.jar.header(), 'content-type': 'application/json' }, body: JSON.stringify({ materialIds: [sheet.body.id] }) });
    assert.equal(put.status, 200);
    const seen = await b.get(`/api/materials/${sheet.body.id}`);
    assert.equal(seen.status, 200); assert.equal(seen.body.canEdit, false);
    assert.equal((await b.get(`/api/materials/${sheet.body.id}/analysis`)).body.analysis.mock, true);
    assert.equal((await b.post(`/api/materials/${sheet.body.id}/analyse`)).status, 404);
    assert.match(s.output(), /\[materials\] analysed \{.*"model":"mock"/);
  } finally { await s.stop(); }
});

test('materials analysis calls Replicate Llama (Prefer: wait) and stores the parsed JSON', { skip }, async () => {
  const calls = [];
  const rep = http.createServer((req, res) => {
    let body = ''; req.on('data', (c) => { body += c; });
    req.on('end', () => {
      calls.push({ url: req.url, auth: req.headers.authorization, prefer: req.headers.prefer, body: JSON.parse(body || '{}') });
      res.writeHead(201, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: 'p1', status: 'succeeded', output: ['Sure! {"summary": "A short plan.", ', '"keyPoints": ["Bring a Bible", "Register by Wednesday"]}'] }));
    });
  });
  await new Promise((r) => rep.listen(0, '127.0.0.1', r));
  const s = await boot({ AI_MOCK: 'false', REPLICATE_API_TOKEN: 'r8_test', REPLICATE_API_BASE: `http://127.0.0.1:${rep.address().port}/v1` });
  try {
    const a = client(s.base); await a.post('/api/signup', signupPayload());
    const f = await (await fetch(`${s.base}/api/files?purpose=content`, { method: 'POST', headers: { cookie: a.jar.header(), 'content-type': DOCX, 'x-file-name': 'plan.docx' }, body: docx(['Retreat on Friday.', 'Register by Wednesday.']) })).json();
    const m = await a.post('/api/materials', { title: 'Plan', kind: 'doc', payload: { sourceUrl: f.url, sourceName: 'plan.docx', sourceMime: DOCX } });
    const r = await a.post(`/api/materials/${m.body.id}/analyse`);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.analysis.summary, 'A short plan.');
    assert.deepEqual(r.body.analysis.keyPoints, ['Bring a Bible', 'Register by Wednesday']);
    assert.equal(r.body.analysis.mock, false); assert.equal(r.body.analysis.model, 'meta/llama-4-scout-instruct');
    const llm = calls.find((c) => c.url.includes('llama-4-scout') || c.url.includes('meta-llama'));
    assert.equal(llm.url, '/v1/models/meta/llama-4-scout-instruct/predictions');
    assert.equal(llm.auth, 'Bearer r8_test'); assert.match(llm.prefer, /^wait/);
    assert.match(llm.body.input.prompt, /Retreat on Friday/);
    assert.equal((await a.post(`/api/materials/${m.body.id}/analyse`)).body.analysis.cached, true);
    assert.equal(calls.filter((c) => (c.url || '').includes('llama-4-scout') || (c.url || '').includes('meta-llama')).length, 1, 'stored result, no second model call');
  } finally { await s.stop(); rep.close(); }
});
