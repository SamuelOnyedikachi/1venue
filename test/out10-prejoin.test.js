'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');

describe('out10 prejoin and messages contrast', () => {
  it('borders the name and device fields and moves try-next into the icon row', () => {
    const room = read('public/js/room/room.js');
    assert.match(room, /class: 'au-pill pj-field'/);
    assert.match(room, /pj-icons' \}, micB, camB, outB, tryB/);
    assert.match(room, /Checking devices/);
    assert.match(room, /No working microphone found/);
    assert.match(room, /Continue without mic/);
    assert.match(room, /skipMissing/);
    const css = read('public/css/room.css');
    assert.match(css, /\.pj-form \.pj-field \{/);
    assert.match(css, /prefers-reduced-motion: no-preference/);
    assert.match(css, /pj-try-idle/);
    assert.match(css, /\.pj-icons \{[^}]*gap: 1\.2rem/s);
  });

  it('makes the messages new-chat icon a theme text color', () => {
    const css = read('public/css/src/20-pages/messages.css');
    assert.match(css, /\.msg-new \{[^}]*color: var\(--text\)/s);
    assert.doesNotMatch(css, /\.msg-new \{[^}]*color: #fff/s);
  });
});
