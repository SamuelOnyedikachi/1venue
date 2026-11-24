'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

test('appearance keeps accent text and primary-button contrast accessible', async () => {
  const { accentButtonColors, accentInk } = await import('../public/js/appearance.mjs');
  assert.equal(accentInk('#2563eb', '#7c3aed'), '#fff');
  assert.equal(accentInk('#b7791f', '#ea580c'), '#fff');
  assert.equal(accentInk('#fef08a', '#7c3aed'), '#fff');
  assert.equal(accentInk('#000000', '#111827'), '#fff');
  assert.equal(accentInk('invalid', '#7c3aed'), '#fff');

  const luminance = (hex) => {
    const rgb = hex.match(/[\da-f]{2}/gi).map((channel) => parseInt(channel, 16) / 255);
    const linear = rgb.map((channel) => channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4);
    return linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722;
  };
  for (const [accent, accent2] of [
    ['#2563eb', '#7c3aed'],
    ['#7c3aed', '#db2777'],
    ['#e11d48', '#f59e0b'],
    ['#ea580c', '#e11d48'],
    ['#b7791f', '#ea580c'],
    ['#059669', '#0891b2'],
    ['#0d9488', '#2563eb'],
    ['#334155', '#2563eb'],
    ['#fef08a', '#7c3aed'],
  ]) {
    const colors = accentButtonColors(accent, accent2);
    const mixed = colors.primary.match(/[\da-f]{2}/gi).map((channel, i) => (parseInt(channel, 16) * 0.6 + parseInt(colors.secondary.match(/[\da-f]{2}/gi)[i], 16) * 0.4) / 255);
    const mixedLinear = mixed.map((channel) => channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4);
    const mixedLuminance = mixedLinear[0] * 0.2126 + mixedLinear[1] * 0.7152 + mixedLinear[2] * 0.0722;
    for (const background of [luminance(colors.primary), luminance(colors.secondary), mixedLuminance]) {
      assert.ok(1.05 / (background + 0.05) >= 4.5, `${colors.primary} gradient is not readable with white text`);
    }
  }
});
