'use strict';
// Fine-tune (Feed composer): mock cleanup, history undo/redo (>=10), empty box, daily cap.
const test = require('node:test');
const assert = require('node:assert/strict');
const { boot, client, signupPayload } = require('./helpers/server');

const skip = !process.env.DATABASE_URL && process.env.DB_DRIVER !== 'sqlite' ? 'set DATABASE_URL' : false;
const { mockFineTune } = require('../src/features/ai/finetune');

test('mock fine-tune cleans wording but keeps @mentions and scripture refs', () => {
  const out = mockFineTune('  hey  @adaeze  see John 3:16  and come thru  ');
  assert.match(out, /@adaeze/);
  assert.match(out, /John 3:16/);
  assert.doesNotMatch(out, /  /);
  assert.match(out, /[.?]$/);
  const pidgin = mockFineTune('Abeg @chinedu make we read Psalm 23:1 first');
  assert.match(pidgin, /@chinedu/);
  assert.match(pidgin, /Psalm 23:1/);
  assert.match(pidgin, /Abeg/);
});

test('composer history keeps at least 10 versions and undo/redo walk them', async () => {
  const { createHistory, HISTORY_LIMIT } = await import('../public/js/history.js');
  assert.ok(HISTORY_LIMIT >= 10);
  const h = createHistory(12);
  assert.equal(h.undo(), null);
  assert.equal(h.canUndo(), false);
  for (let i = 0; i < 14; i++) h.push('v' + i);
  assert.equal(h.size(), 12, 'caps at the limit, never below 10');
  assert.equal(h.current(), 'v13');
  assert.equal(h.original(), 'v2', 'oldest kept version after cap');
  const back = [];
  while (h.canUndo()) back.push(h.undo());
  assert.equal(back.length, 11);
  assert.equal(h.current(), 'v2');
  assert.equal(h.canUndo(), false);
  assert.equal(h.redo(), 'v3');
  let n = 0;
  while (h.canRedo()) { h.redo(); n++; }
  assert.equal(n, 10);
  assert.equal(h.current(), 'v13');
});

test('POST /api/ai/finetune: empty 400, unauth 401, daily 429, mock keeps mentions', { skip, timeout: 120000 }, async () => {
  const s = await boot({ AI_FINETUNE_DAILY_LIMIT: '2', AI_MOCK: 'true' });
  try {
    const guest = client(s.base);
    const emptyGuest = await guest.post('/api/ai/finetune', { text: 'Hello there, friends' });
    assert.equal(emptyGuest.status, 401);

    const u = client(s.base);
    const signed = await u.post('/api/signup', signupPayload());
    assert.ok(signed.status === 200 || signed.status === 201, JSON.stringify(signed.body));

    const blank = await u.post('/api/ai/finetune', { text: '   ' });
    assert.equal(blank.status, 400, JSON.stringify(blank.body));

    const cfg = await u.get('/api/ai/finetune');
    assert.equal(cfg.status, 200);
    assert.equal(cfg.body.enabled, true);
    assert.equal(cfg.body.dailyLimit, 2);
    assert.equal(cfg.body.left, 2);

    const ok = await u.post('/api/ai/finetune', { text: 'hey @adaeze see John 3:16 later' });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.match(ok.body.text, /@adaeze/);
    assert.match(ok.body.text, /John 3:16/);
    assert.equal(ok.body.left, 1);

    const ok2 = await u.post('/api/ai/finetune', { text: 'second pass for the cap' });
    assert.equal(ok2.status, 200, JSON.stringify(ok2.body));
    assert.equal(ok2.body.left, 0);

    const cap = await u.post('/api/ai/finetune', { text: 'one more should fail' });
    assert.equal(cap.status, 429);
    assert.match(String(cap.body.error || ''), /fine-tune/i);
  } finally {
    await s.stop();
  }
});
