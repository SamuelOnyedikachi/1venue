/**
 * Signature image cleanup (paper to transparent ink) and persistence.
 */
'use strict';

const sharp = require('sharp');
const storage = require('../../venue/storage');

const MAX_BYTES = 4 * 1024 * 1024;
const MAX_EDGE = 1800;

function decodeInput(input) {
  if (!input) throw Object.assign(new Error('No signature image was sent'), { status: 400 });
  if (Buffer.isBuffer(input)) return input;
  if (input instanceof Uint8Array) return Buffer.from(input);
  const s = String(input);
  const m = s.match(/^data:image\/[a-zA-Z0-9+.-]+;base64,(.+)$/);
  if (m) return Buffer.from(m[1], 'base64');
  if (/^[A-Za-z0-9+/=\s]+$/.test(s) && s.length > 100) return Buffer.from(s.replace(/\s+/g, ''), 'base64');
  throw Object.assign(new Error('That signature image could not be read'), { status: 400 });
}

/**
 * Turn a photo or scan of a signature into tight, dark ink on a transparent background
 * so it sits on the certificate like handwriting, not a cropped photograph.
 */
async function cleanSignature(input) {
  const rawIn = decodeInput(input);
  if (rawIn.length > MAX_BYTES) throw Object.assign(new Error('That signature image is too large (max 4 MB)'), { status: 413 });
  const base = sharp(rawIn, { failOn: 'none' }).rotate().ensureAlpha();
  const meta = await base.metadata();
  const w0 = meta.width || 0;
  const h0 = meta.height || 0;
  if (!w0 || !h0) throw Object.assign(new Error('That file is not a usable image'), { status: 400 });
  const scale = Math.min(1, MAX_EDGE / Math.max(w0, h0));
  const { data, info } = await base
    .resize(Math.max(1, Math.round(w0 * scale)), Math.max(1, Math.round(h0 * scale)), { fit: 'inside' })
    .raw()
    .toBuffer({ resolveWithObject: true });
  const { width, height } = info;
  const out = Buffer.from(data);
  for (let i = 0; i < out.length; i += 4) {
    const r = out[i], g = out[i + 1], b = out[i + 2], a = out[i + 3];
    const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    const mx = Math.max(r, g, b);
    const mn = Math.min(r, g, b);
    const sat = mx === 0 ? 0 : (mx - mn) / mx;
    // Pale, low-saturation pixels are paper. Darker or saturated strokes are ink.
    const paper = lum > 210 && sat < 0.22;
    const ink = 255 - lum;
    let alpha = 0;
    if (!paper && ink > 28) {
      alpha = Math.min(255, Math.round((ink - 28) * (255 / 170)));
    } else if (!paper && sat > 0.35 && lum < 230) {
      alpha = Math.min(255, Math.round((1 - lum / 255) * 255));
    }
    alpha = Math.round(alpha * (a / 255));
    // Even, dark ink (warm near-black) so mixed pen colours don't look pasted on.
    out[i] = 28;
    out[i + 1] = 24;
    out[i + 2] = 22;
    out[i + 3] = alpha;
  }
  let img = sharp(out, { raw: { width, height, channels: 4 } });
  try { img = img.trim({ threshold: 12, background: { r: 0, g: 0, b: 0, alpha: 0 } }); } catch { /* already tight */ }
  const cleaned = await img.png().toBuffer();
  const trimmed = await sharp(cleaned).metadata();
  if ((trimmed.width || 0) < 4 || (trimmed.height || 0) < 4) {
    throw Object.assign(new Error('No ink was found in that image. Try a darker signature on paler paper.'), { status: 400 });
  }
  return { buffer: cleaned, width: trimmed.width, height: trimmed.height, mime: 'image/png' };
}

function toDataUrl(buffer, mime = 'image/png') {
  return `data:${mime};base64,${buffer.toString('base64')}`;
}

async function persistSignature(buffer, { ownerUserId, filename = 'signature.png' } = {}) {
  const rec = await storage.save(buffer, {
    filename,
    mime: 'image/png',
    ownerUserId: ownerUserId || null,
    purpose: 'content',
    maxBytes: MAX_BYTES,
  });
  return rec;
}

async function cleanAndStore(input, opts = {}) {
  const cleaned = await cleanSignature(input);
  const rec = await persistSignature(cleaned.buffer, opts);
  return {
    url: rec.url,
    width: cleaned.width,
    height: cleaned.height,
    dataUrl: toDataUrl(cleaned.buffer),
  };
}

module.exports = { cleanSignature, cleanAndStore, persistSignature, toDataUrl, MAX_BYTES };
