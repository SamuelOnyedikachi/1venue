'use strict';
// Install prompt must always be a fixed overlay, never in-page under the hero.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

test('install prompt is an overlay: #install-root, early fixed CSS, no in-page injection', () => {
  const html = read('public/index.html');
  assert.match(html, /id="install-root"/);
  assert.match(html, /#install-root\s*\{[^}]*position:\s*fixed/s);
  assert.match(html, /#install-root\.has-banner/);

  const css = read('public/css/app.css');
  assert.match(css, /#install-root\s*\{[^}]*position:\s*fixed/s);
  assert.match(css, /\.install(?:\.inline)?[^{]*\{[^}]*position:\s*fixed\s*!important/s);

  const pwa = read('public/js/pwa.js');
  assert.match(pwa, /export function inlineBanner\(\)\s*\{\s*return null\s*;?\s*\}/);
  assert.match(pwa, /installRoot\(\)/);
  assert.match(pwa, /document\.body\.append/);
  assert.doesNotMatch(pwa, /classList\.add\([^)]*inline/);

  const home = read('public/js/pages/home.js');
  const dash = read('public/js/pages/dashboard.js');
  assert.doesNotMatch(home, /inlineBanner/);
  assert.doesNotMatch(dash, /inlineBanner/);
  assert.doesNotMatch(home, /\.install\.inline/);
  assert.doesNotMatch(dash, /\.install\.inline/);
});
