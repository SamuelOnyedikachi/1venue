'use strict';
// Polish: event tiles, typography, stripped page blurbs, session header, cache bump.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

test('event tiles are full-bleed with overlay, chips and an open button', () => {
  const js = read('public/js/components.js');
  assert.match(js, /ev-tile/);
  assert.match(js, /attending/);
  assert.match(js, /ev-open/);
  assert.match(js, /eventTypeLabel|Upcoming/);
  const css = read('public/css/src/10-components/cards.css');
  assert.match(css, /ev-tile \.cover::after/);
  assert.match(css, /linear-gradient\(\s*to top/);
  assert.match(css, /ev-chip-count/);
  assert.match(css, /\.card\.ev-card/);
});

test('UI typography uses one family and title weight 600', () => {
  const tokens = read('public/css/src/00-base/10-tokens.css');
  assert.match(tokens, /--font:/);
  assert.match(tokens, /--fw-title:\s*600/);
  assert.match(tokens, /font:\s*var\(--fw\)\s*1rem\/1\.5\s*var\(--font\)/);
  const home = read('public/css/src/20-pages/home.css');
  assert.match(home, /\.hero-join-first h1[^}]*font-size:\s*36px/);
  assert.match(home, /\.hero-join-first h1[^}]*font-weight:\s*600/);
  assert.doesNotMatch(home, /font-weight:\s*[89]00/);
  const srcDir = path.join(root, 'public/css/src');
  const heavy = [];
  (function walk(d) {
    for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, ent.name);
      if (ent.isDirectory()) walk(p);
      else if (ent.name.endsWith('.css')) {
        const t = fs.readFileSync(p, 'utf8');
        if (/font-weight:\s*(?:800|900)\b/.test(t)) heavy.push(path.relative(srcDir, p));
      }
    }
  })(srcDir);
  assert.deepEqual(heavy, [], 'unexpected 800/900 weights: ' + heavy.join(', '));
});

test('explanatory blurbs are gone; session header and Pricing icon are in place', () => {
  assert.doesNotMatch(read('public/js/pages/billing.js'), /Meeting credits live in your/);
  assert.doesNotMatch(read('public/js/pages/upgrade.js'), /Simple plans for every venue/);
  assert.doesNotMatch(read('public/js/pages/host.js'), /Your plan:/);
  assert.doesNotMatch(read('public/js/pages/wallet.js'), /Purchased credits never expire/);
  assert.doesNotMatch(read('public/js/pages/session.js'), /Every meeting and event you joined/);
  const sess = read('public/js/pages/session.js');
  assert.match(sess, /icon\('history'[\s\S]*s\.name/);
  assert.match(sess, /sess-meta/);
  assert.match(sess, /transcript line/);
  assert.match(read('public/js/pages/upgrade.js'), /icon\('sparkles'[\s\S]*Pricing/);
  assert.match(read('public/index.html'), /app\.css\?v=34/);
  assert.match(read('public/sw.js'), /VERSION = 'v45-2026-11-18'/);
});

test('home full-bleed bands do not use 100vw', () => {
  const css = read('public/css/src/20-pages/home.css');
  assert.doesNotMatch(css, /width:\s*100vw/);
  assert.match(css, /margin-left:\s*calc\(-1 \* max\(1rem,\s*var\(--safe-l\)\)\)/);
});
