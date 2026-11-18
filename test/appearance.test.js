'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

test('accent text color keeps selected accent and gradient text legible', async () => {
  const { accentInk } = await import('../public/js/appearance.mjs');
  assert.equal(accentInk('#2563eb', '#7c3aed'), '#fff');
  assert.equal(accentInk('#b7791f', '#ea580c'), '#0f172a');
  assert.equal(accentInk('#fef08a', '#7c3aed'), '#0f172a');
  assert.equal(accentInk('#000000', '#111827'), '#fff');
  assert.equal(accentInk('invalid', '#7c3aed'), '#fff');
});
