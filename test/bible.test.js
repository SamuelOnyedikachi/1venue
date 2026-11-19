'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

test('src/venue/bible.js loads and normalizes dashed book names', () => {
  const bible = require('../src/venue/bible.js');
  assert.equal(bible.findBook('1 Corinthians').id, '1CO');
  assert.equal(bible.findBook('1-corinthians').id, '1CO');
  assert.equal(bible.findBook('1–corinthians').id, '1CO');
  const p = bible.parseReference('John 1:1');
  assert.ok(p);
  assert.equal(p.book, 'JHN');
});
