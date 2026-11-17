'use strict';
// Messages follow-up: whiteboard (.mwb) files in chat, safe text (no "null" / [object Object] / code in the
// UI), the viewport-aware menu, the whiteboard text-editor lifecycle, AI "Refine page" (mock), palette snap,
// and the background incoming-call alert (notification actions in the service worker, push always).
Object.assign(process.env, { NODE_ENV: 'test', REMINDER_WORKER: 'false', REPLAY_WORKER: 'false', MESSAGES_RETENTION_WORKER: 'false', CALL_SWEEP: 'false' });
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { boot, client, signupPayload } = require('./helpers/server');
const skip = !process.env.DATABASE_URL && process.env.DB_DRIVER !== 'sqlite' ? 'set DATABASE_URL or DB_DRIVER=sqlite' : false;
const root = path.join(__dirname, '..');
const src = (f) => fs.readFileSync(path.join(root, f), 'utf8');

/** Evaluate a dependency-free browser ES module (imports stripped, injected bindings). */
function browserModule(file, bindings, names) {
  const s = src(file).replace(/^import .*;\s*$/mg, '').replace(/^export (?=(?:async )?function|const|let|class)/mg, '');
  return new Function(...Object.keys(bindings), `${s}\nreturn { ${names} };`)(...Object.values(bindings));
}
const board = (extra = {}) => zlib.gzipSync(Buffer.from(JSON.stringify({ format: 'mwb', version: 2, title: 'Maths class', pages: [{ strokes: [{ tool: 'pen', color: '#ef4444', width: 4, points: [[10, 10, 1], [40, 40, 1]] }], images: [], texts: [] }, { strokes: [], images: [], texts: [] }], ...extra })));

test('safe text (server): null / [object Object] / code fences / raw JSON never reach the UI', () => {
  const { cleanText, cleanList } = require('../src/lib/safe-text');
  assert.equal(cleanText(null), ''); assert.equal(cleanText(undefined), ''); assert.equal(cleanText('null'), ''); assert.equal(cleanText('[object Object]'), '');
  assert.equal(cleanText('The budget is 400k.\nnull'), 'The budget is 400k.');
  assert.equal(cleanText('Summary done. undefined'), 'Summary done.');
  assert.equal(cleanText('A null hypothesis is tested here'), 'A null hypothesis is tested here', 'a real word mid-sentence stays');
  assert.equal(cleanText({ text: 'Point one' }), 'Point one');
  assert.equal(cleanText('```json\n{"summary":"Hello there"}\n```'), 'Hello there');
  assert.doesNotMatch(cleanText('see [object Object] here'), /object Object/);
  assert.deepEqual(cleanList(['a', null, { point: 'b' }, '', 'undefined', ['c']]), ['a', 'b', 'c']);
  const { cleanAnalysis } = require('../src/features/messages/power');
  const a = cleanAnalysis({ summary: null, keyPoints: [null, { text: 'Key' }], dataCommentary: 'null' });
  assert.ok(!/null|undefined|object/i.test(JSON.stringify(a)), JSON.stringify(a));
});

test('safe text (browser): safeText / put / add drop null children (the "null" after an analysis)', () => {
  const m = browserModule('public/js/safe-text.js', {}, 'safeText, safeList, put, add');
  assert.equal(m.safeText(null), ''); assert.equal(m.safeText({ summary: 'S' }), 'S'); assert.deepEqual(m.safeList([null, 'x', { text: 'y' }]), ['x', 'y']);
  const kids = [];
  const el = { append: (...k) => kids.push(...k), replaceChildren: (...k) => { kids.length = 0; kids.push(...k); } };
  m.add(el, 'a', null, undefined, false, ['b', null]); assert.deepEqual(kids, ['a', 'b']);
  m.put(el, null, 'c'); assert.deepEqual(kids, ['c']);
  // The pages that render AI output use the helpers, not raw append(null) / textContent = null.
  for (const f of ['public/js/pages/messages.js', 'public/js/pages/material.js', 'public/js/messages/mini.js']) {
    const s = src(f); assert.match(s, /from '\.\.\/safe-text\.js'/, f);
    assert.doesNotMatch(s, /\.replaceChildren\(/, `${f}: use put()`);
  }
});

test('menu position: flips at the right / bottom edge, stays 8px inside, scrolls when too tall', () => {
  const { menuPosition } = browserModule('public/js/menu-pos.js', {}, 'menuPosition');
  const r = (l, t, w = 32, hh = 32) => ({ left: l, top: t, right: l + w, bottom: t + hh, width: w, height: hh });
  let p = menuPosition(r(100, 100), 240, 300, 1280, 800);
  assert.deepEqual([p.left, p.top, p.flipX, p.flipY, p.maxHeight], [100, 138, false, false, null]);
  p = menuPosition(r(1250, 100), 240, 300, 1280, 800); // the ⋯ of a message at the right edge
  assert.equal(p.flipX, true); assert.ok(p.left + 240 <= 1280 - 8 && p.left >= 8);
  p = menuPosition(r(600, 740), 240, 300, 1280, 800);
  assert.equal(p.flipY, true); assert.equal(p.top, 740 - 6 - 300);
  p = menuPosition(r(10, 380), 240, 900, 1280, 800);
  assert.ok(p.maxHeight && p.top >= 8 && p.top + p.maxHeight <= 800 - 8, JSON.stringify(p));
  p = menuPosition(r(5, 5), 400, 100, 360, 640);
  assert.equal(p.left, 8); assert.equal(p.maxWidth, 344);
  const ui = src('public/js/ui.js');
  assert.match(ui, /menuPosition\(anchor\.getBoundingClientRect\(\)/); assert.match(ui, /menu-sheet/); assert.match(ui, /header/);
  assert.match(src('public/js/pages/messages.js'), /\{ header: quick \}/, 'reactions are measured with the menu');
  assert.match(src('public/sw.js'), /'\/js\/menu-pos\.js'/, 'precached with ui.js');
});

test('whiteboard text editor: resizes (mobile keyboard) and plain blurs never close it', () => {
  const t = browserModule('public/js/wb-text.js', { Date }, 'textSession, onPointerDown, onBlur, onResize');
  const s = t.textSession(1000);
  assert.equal(t.onResize(), 'reposition');
  assert.equal(t.onBlur(s, { next: 'body', now: 1100 }), 'keep', 'keyboard / iOS scroll');
  assert.equal(t.onBlur(s, { next: 'board', now: 5000 }), 'keep', 'tap compat events on the board');
  assert.equal(t.onBlur(s, { next: 'hidden', now: 5000 }), 'keep', 'switching apps');
  assert.equal(t.onBlur(s, { next: 'control', now: 1100 }), 'keep', 'too soon after opening');
  assert.equal(t.onBlur(s, { next: 'control', now: 5000 }), 'commit', 'moved to another field');
  assert.equal(t.onPointerDown(s, { insideEditor: true }), false);
  assert.equal(t.onPointerDown(s, { insideEditor: false }), true, 'a tap elsewhere commits');
  const wb = src('public/js/pages/whiteboard.js');
  assert.doesNotMatch(wb, /ResizeObserver\(\(\) => \{ finishText/, 'the resize no longer commits the editor');
  assert.doesNotMatch(wb, /addEventListener\('blur', \(\) => setTimeout\(finishText/);
  assert.match(wb, /inp\.focus\(\{ preventScroll: true \}\)/, 'focus inside the gesture');
  assert.match(wb, /pointerType === 'mouse'/, 'touch opens the editor on lift');
});

test('whiteboard palette snap keeps the exact board colours', () => {
  const p = browserModule('public/js/wb-palette.js', {}, 'pagePalette, snapPixels, hexToRgb');
  const pal = p.pagePalette({ strokes: [{ color: 'ink' }, { color: '#EF4444' }, { color: '#ef4444' }], texts: [{ color: '#2563eb' }] }, (c) => (c === 'ink' ? '#111827' : c));
  assert.deepEqual(pal, ['#ffffff', '#111827', '#ef4444', '#2563eb']);
  const px = new Uint8ClampedArray([250, 250, 248, 255, 230, 70, 60, 255, 20, 25, 40, 255]);
  p.snapPixels(px, pal);
  assert.deepEqual([...px.slice(0, 3)], [255, 255, 255]); assert.deepEqual([...px.slice(4, 7)], [239, 68, 68]); assert.deepEqual([...px.slice(8, 11)], [17, 24, 39]);
});

test('refine prompt: faithful by default, extra prompt only when given, palette spelled out', () => {
  const { refinePrompt, presetList } = require('../src/features/whiteboard/refine');
  const base = refinePrompt('clean', '', ['#ffffff', '#ef4444']);
  assert.match(base, /same composition/i); assert.match(base, /#ef4444/); assert.doesNotMatch(base, /Additionally/);
  assert.match(refinePrompt('clean', 'make the face smile'), /Additionally: make the face smile/);
  assert.match(refinePrompt('math', ''), /Do not solve/);
  assert.equal(refinePrompt('custom', 'neon sign').endsWith('neon sign'), true);
  assert.doesNotMatch(refinePrompt('watercolor', '', ['#ef4444']), /#ef4444/, 'creative styles are free with colour');
  assert.deepEqual(presetList().map((x) => x.id), ['clean', 'math', 'diagram', 'illustration', 'watercolor', 'marker', 'custom']);
});

test('.mwb sniffing and board attachments', () => {
  const { sniffMwb, looksMwb } = require('../src/lib/mwb');
  assert.equal(sniffMwb(board()).pages, 2);
  assert.equal(sniffMwb(Buffer.from('not a board')), null);
  assert.equal(sniffMwb(zlib.gzipSync(Buffer.from('{"hello":1}'))), null);
  assert.ok(looksMwb({ name: 'x.MWB' })); assert.ok(!looksMwb({ name: 'x.json' }));
  const { normalizeAttachment } = require('../src/lib/attachment');
  const a = normalizeAttachment({ kind: 'file', name: 'Maths', url: '/files/abc123defg45/maths.mwb', mime: 'application/x-mwb', size: 900, pages: 99, preview: 'javascript:alert(1)' });
  assert.equal(a.kind, 'board'); assert.equal(a.name, 'Maths.mwb'); assert.equal(a.pages, 50); assert.equal(a.preview || null, null);
  const sw = src('public/sw.js');
  assert.match(sw, /action: 'answer'/); assert.match(sw, /type: 'call-action'/); assert.match(sw, /requireInteraction: true/); assert.match(sw, /calls\/\$\{encodeURIComponent\(data\.callId\)\}\/decline/);
  assert.doesNotMatch(src('src/features/messages/calls.js'), /if \(!socket\.isOnline\(uid\)\) push\.notify/, 'calls are pushed even when a tab is open');
});

test('incoming call alert: title, plan (notification only when hidden, PiP only with a gesture)', () => {
  const m = browserModule('public/js/messages/call-alert.js', {}, 'plan, ALERT_TITLE');
  assert.equal(m.ALERT_TITLE('Ada'), '📞 Incoming call – Ada');
  assert.deepEqual(m.plan({ hidden: true, permission: 'granted', hasSW: true, hasPiP: true, activation: false }), { notify: true, title: true, favicon: true, pip: false });
  assert.equal(m.plan({ hidden: false, permission: 'granted', hasSW: true, hasPiP: true, activation: true }).notify, false);
  assert.equal(m.plan({ hidden: true, permission: 'granted', hasSW: true, hasPiP: true, activation: true }).pip, true);
  const call = src('public/js/messages/call.js');
  assert.match(call, /stopCallAlert\(ringing\.call\.id\)/, 'stopped with the ring (answer / decline / miss)');
});

test('whiteboard files in messages + AI refine (mock) end to end', { skip, timeout: 120000 }, async (t) => {
  const s = await boot({ VAPID_PUBLIC_KEY: '', VAPID_PRIVATE_KEY: '', AI_WEIGHT_WHITEBOARD_AI: '3' });
  t.after(() => s.stop());
  const user = async () => { const c = client(s.base); const p = signupPayload(); assert.equal((await c.post('/api/signup', p)).status, 201); c.me = (await c.get('/api/session')).body.user; return c; };
  const [A, B] = [await user(), await user()];
  const up = (c, body, name, type = 'application/octet-stream') => fetch(`${s.base}/api/files`, { method: 'POST', headers: { cookie: c.jar.header(), 'content-type': type, 'x-file-name': name }, body });

  await t.test('.mwb uploads are accepted (typed application/x-mwb); fake ones are refused', async () => {
    const r = await up(A, board(), 'Maths class.mwb'); const f = await r.json();
    assert.equal(r.status, 200, JSON.stringify(f)); assert.equal(f.mime, 'application/x-mwb'); assert.match(f.url, /\.mwb$/);
    const bad = await up(A, Buffer.from('<html>nope</html>'), 'evil.mwb');
    assert.equal(bad.status, 415);
    const conv = (await A.post('/api/messages/new', { handle: '@' + B.me.username })).body.conversation;
    const sent = await A.post(`/api/messages/conversations/${conv.id}/messages`, { attachment: { kind: 'board', url: f.url, name: 'Maths class.mwb', mime: 'application/x-mwb', size: f.size, pages: 2 } });
    assert.equal(sent.status, 201, JSON.stringify(sent.body));
    const got = (await B.get(`/api/messages/conversations/${conv.id}/messages`)).body.messages.find((m) => m.attachment && m.attachment.kind === 'board');
    assert.ok(got); assert.equal(got.attachment.pages, 2);
    const list = (await B.get('/api/messages/conversations')).body.conversations.find((c) => c.id === conv.id);
    assert.match(JSON.stringify(list), /Whiteboard: Maths class/);
    const file = await fetch(s.base + f.url, { headers: { cookie: B.jar.header() } });
    assert.equal(file.status, 200); assert.ok(zlib.gunzipSync(Buffer.from(await file.arrayBuffer())).toString().includes('"pages"'));
  });

  await t.test('refine page: mock returns an image URL and charges whiteboard_ai points', async () => {
    const png = 'data:image/png;base64,' + Buffer.alloc(300, 1).toString('base64');
    assert.equal((await A.post('/api/whiteboards/refine', { image: 'data:text/html;base64,AAAA' })).status, 400);
    assert.equal((await A.post('/api/whiteboards/refine', { image: png, preset: 'custom', prompt: '' })).status, 400);
    const r = await A.post('/api/whiteboards/refine', { image: png, preset: 'clean', prompt: 'keep it simple', palette: ['#ffffff', '#ef4444'] });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.mock, true); assert.equal(r.body.cost, 3); assert.match(r.body.url, /^\/files\//);
    assert.equal((await fetch(s.base + r.body.url)).status, 200);
    assert.equal((await client(s.base).post('/api/whiteboards/refine', { image: png })).status, 401);
    assert.equal((await A.get('/api/whiteboards/refine')).body.presets[0].id, 'clean');
  });
});
