'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('leaving a meeting requires confirmation before stopping recording or disconnecting', () => {
  const source = fs.readFileSync(path.join(__dirname, '../public/js/room/room.js'), 'utf8');
  const leave = source.match(/async leave\(\) \{([\s\S]*?)\n  \},\n  ended\(m\)/)?.[1];
  assert.ok(leave, 'Room.leave method exists');

  const confirmation = leave.indexOf('await confirmDlg(');
  assert.notEqual(confirmation, -1, 'leave asks for confirmation');
  assert.ok(leave.indexOf('return;') > confirmation, 'canceling confirmation stops the leave flow');
  assert.ok(leave.indexOf('this.recorder.stop()') > confirmation, 'recording stops only after confirmation');
  assert.ok(leave.indexOf("api('/api/leave'") > confirmation, 'the leave API is called only after confirmation');
});
