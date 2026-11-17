// "Keep exact board colours": the colours used on a page, and snapping an AI result back onto them.
// Pure (works on plain arrays / ImageData-like objects), unit-tested in test/whiteboard-refine.test.js.
export const hexToRgb = (h) => { const n = parseInt(String(h).replace('#', ''), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };
export const rgbToHex = ([r, g, b]) => '#' + [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('');

/** Unique colours of a page's strokes and texts (resolved with `ink` for the theme ink), white paper first. */
export function pagePalette(page, ink = (c) => c) {
  const out = new Set(['#ffffff']);
  for (const s of [...(page.strokes || []), ...(page.texts || [])]) {
    const c = String(ink(s.color || '#111111')).toLowerCase();
    if (/^#[0-9a-f]{6}$/.test(c)) out.add(c);
    if (out.size >= 13) break;
  }
  return [...out];
}

/**
 * Snap pixels onto the palette (in place). Pixels closer to the paper than to any ink stay paper; every other
 * pixel takes its nearest ink colour, so lines come back in the exact board colours. Anti-aliased edges
 * keep a soft look by blending toward paper by how light the original was.
 */
export function snapPixels(px, palette) {
  const cols = palette.map(hexToRgb);
  const paper = cols[0] || [255, 255, 255];
  const inks = cols.slice(1);
  if (!inks.length) return px;
  const d2 = (r, g, b, c) => (r - c[0]) ** 2 + (g - c[1]) ** 2 + (b - c[2]) ** 2;
  for (let i = 0; i < px.length; i += 4) {
    const r = px[i], g = px[i + 1], b = px[i + 2];
    const dp = d2(r, g, b, paper);
    let best = inks[0], bd = d2(r, g, b, best);
    for (let j = 1; j < inks.length; j++) { const d = d2(r, g, b, inks[j]); if (d < bd) { bd = d; best = inks[j]; } }
    if (dp <= bd) { px[i] = paper[0]; px[i + 1] = paper[1]; px[i + 2] = paper[2]; continue; }
    const t = Math.min(1, Math.sqrt(dp) / Math.max(1, Math.sqrt(dp) + Math.sqrt(bd)) * 1.6); // 1 = solid ink
    px[i] = Math.round(paper[0] + (best[0] - paper[0]) * t);
    px[i + 1] = Math.round(paper[1] + (best[1] - paper[1]) * t);
    px[i + 2] = Math.round(paper[2] + (best[2] - paper[2]) * t);
  }
  return px;
}
