'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('path');
const root = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');

describe('out11 instant overlay and device picker', () => {
  it('instant meeting overlay uses icon, placeholder name, and three icon toggles', () => {
    const inst = read('public/js/instant.js');
    assert.match(inst, /im-badge/);
    assert.match(inst, /'Instant meeting'/);
    assert.doesNotMatch(inst, /Start a room right now/);
    assert.match(inst, /placeholder: 'Meeting name'/);
    assert.match(inst, /im-tog-fund/);
    assert.match(inst, /icon\(paid \? 'users' : 'user'/);
    assert.match(inst, /flag\('stage'/);
    assert.match(inst, /flag\('waitingRoom'/);
    assert.match(inst, /meetingAccessMode: opts\.accessMode/);
    assert.match(inst, /Free Entry/);
    assert.match(inst, /Paid Entry/);
    assert.match(inst, /Need tickets\? Use ticketing/);
    assert.doesNotMatch(inst, /Advertised duration/);
    assert.doesNotMatch(inst, /Entry price/);
    assert.match(inst, /Start now/);
  });

  it('prejoin uses a custom accessible device listbox with pills and a padded caret', () => {
    const room = read('public/js/room/room.js');
    assert.match(room, /bindDevicePicker/);
    const dev = read('public/js/room/devices.js');
    assert.match(dev, /export function bindDevicePicker/);
    assert.match(dev, /ArrowDown/);
    assert.match(dev, /Escape/);
    assert.match(dev, /pj-pill/);
    const css = read('public/css/room.css');
    assert.match(css, /\.pj-dev-btn \{/);
    assert.match(css, /padding: 0 1\.15rem/);
    assert.match(css, /\.pj-caret \{/);
    assert.match(css, /\.pj-dev-menu \{/);
    assert.match(css, /\.pj-dev-native \{/);
  });

  it('keeps source icons next to try next and mutes on the preview card', () => {
    const room = read('public/js/room/room.js');
    assert.match(room, /const selectKind = \(kind\)/);
    assert.match(room, /const toggleMedia = \(kind\)/);
    assert.match(room, /class: 'pj-ctl'/);
    assert.match(room, /pj-icons' \}, micB, camB, outB, tryB/);
    assert.doesNotMatch(room, /const pickKind = \(kind\)/);
  });
});
