'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');

describe('out9 ui and search contracts', () => {
  it('tokenizes multi-word event search with AND and OR fallback', () => {
    const src = read('src/features/events/data.js');
    assert.match(src, /function searchTokens/);
    assert.match(src, /search\.andWhere/);
    assert.match(src, /search\.orWhere/);
    assert.match(read('src/features/social/data.js'), /tokens\.length > 1/);
  });

  it('prejoin uses two columns, login pill, circular icons, and a dynamic device dropdown', () => {
    const room = read('public/js/room/room.js');
    assert.match(room, /class: 'au-pill'/);
    assert.match(room, /class: 'pj-code'/);
    assert.match(room, /'Joining'/);
    assert.match(room, /icon\('headphones'/);
    assert.match(room, /icon\('refresh'/);
    assert.match(room, /devKind/);
    assert.match(read('public/css/room.css'), /\.pj-circ \{/);
  });

  it('top nav has hover labels, a circular create plus, and a striped account menu', () => {
    const app = read('public/js/app.js');
    assert.match(app, /'data-tip': l/);
    assert.match(app, /top-create/);
    assert.match(app, /cls: 'menu-account'/);
    const shell = read('public/css/src/00-base/30-shell.css');
    assert.match(shell, /gap: 0\.45rem/);
    assert.match(shell, /border-radius: 50%/);
    assert.match(read('public/css/src/10-components/modals.css'), /\.menu\.menu-account/);
  });

  it('messages new-chat button is circular and reminders also send in-app', () => {
    assert.match(read('public/css/src/20-pages/messages.css'), /\.msg-new \{[^}]*border-radius: 50%/s);
    const rem = read('src/features/recurring/reminders.js');
    assert.match(rem, /channel === 'inapp'/);
    assert.match(rem, /messages\/notify/);
  });
});
