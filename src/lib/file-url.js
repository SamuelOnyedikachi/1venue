/**
 * Which file URLs count as "uploaded to this app" (materials, presented slides/images).
 *
 * storage.save() returns one of two shapes:
 *   - `/files/<id>/<name>`              local disk, or S3/R2 without a public URL (proxied by the app)
 *   - `${S3_PUBLIC_BASE_URL}/<key>`     S3/R2 with a public bucket domain (e.g. https://files.1venue.live/2026/11/…)
 *
 * Validation is tolerant of encoding: older uploads have raw spaces / parentheses in the key
 * ("…-CV - Web Developer-p1.jpg"), newer keys are slugs. Both raw and %-encoded forms are accepted and
 * normalised to one canonical, percent-encoded URL. Anything outside those two shapes, traversal
 * (`..`), control characters or markup characters is rejected.
 */
const config = require('../config');

const BAD_CHARS = /[\u0000-\u001f\u007f<>"'`\\]/;
const ID = /^[\w-]{1,64}$/;

const publicBase = () => String((config.STORAGE && config.STORAGE.s3 && config.STORAGE.s3.publicBaseUrl) || '').replace(/\/$/, '');
const appBase = () => String(config.PUBLIC_URL || '').replace(/\/$/, '');

/** Encode one path segment (RFC 3986 unreserved stays; everything else %-encoded, incl. ( ) ! * '). */
const encSeg = (s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
function decSeg(s) { try { return decodeURIComponent(s); } catch { return null; } }

/** Split a path into decoded, safe segments, or null. */
function cleanSegments(p, { max = 8 } = {}) {
  const raw = String(p).split('/');
  if (!raw.length || raw.length > max) return null;
  const out = [];
  for (const r of raw) {
    if (!r) return null; // no empty segments ("//", trailing "/")
    const d = decSeg(r);
    if (d == null || !d || d === '.' || d === '..' || d.includes('/') || BAD_CHARS.test(d) || d.length > 240) return null;
    out.push(d);
  }
  return out;
}

/** Canonical stored-file URL (percent-encoded), or null when `u` is not one of ours. */
function normalizeStoredFileUrl(u) {
  if (typeof u !== 'string') return null;
  let s = u.trim();
  if (!s || s.length > 1200 || /[?#]/.test(s)) return null;
  const app = appBase();
  if (app && s.startsWith(app + '/files/')) s = s.slice(app.length); // absolute link to this app
  if (s.startsWith('/files/')) {
    const seg = cleanSegments(s.slice('/files/'.length), { max: 2 });
    if (!seg || seg.length !== 2 || !ID.test(seg[0])) return null;
    return `/files/${seg[0]}/${encSeg(seg[1])}`;
  }
  const base = publicBase();
  if (base && s.startsWith(base + '/')) {
    const seg = cleanSegments(s.slice(base.length + 1));
    if (!seg) return null;
    return `${base}/${seg.map(encSeg).join('/')}`;
  }
  return null;
}
const isStoredFileUrl = (u) => normalizeStoredFileUrl(u) !== null;

module.exports = { normalizeStoredFileUrl, isStoredFileUrl, publicBase, encSeg };
