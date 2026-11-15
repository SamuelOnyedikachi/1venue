/**
 * Which file URLs count as "uploaded to this app" (materials, presented slides/images).
 *
 * storage.save() returns one of two shapes:
 *   - `/files/<id>/<name>`              local disk, or S3/R2 without a public URL (proxied by the app)
 *   - `${S3_PUBLIC_BASE_URL}/<key>`     S3/R2 with a public bucket domain (e.g. https://files.1venue.live/2026/11/…)
 * Validators used to accept only the first shape, so with R2 + S3_PUBLIC_BASE_URL every
 * material save and every presented PDF/image was rejected after the upload had already
 * reached the bucket. Use this helper everywhere a stored-file URL is validated.
 */
const config = require('../config');

const LOCAL = /^\/files\/[\w-]{1,64}\/[\w.%~()'!*-]{1,240}$/;
const BAD = /[\s<>"'\\`]|\.\.|[?#]/;

const publicBase = () => String((config.STORAGE && config.STORAGE.s3 && config.STORAGE.s3.publicBaseUrl) || '').replace(/\/$/, '');
const appBase = () => String(config.PUBLIC_URL || '').replace(/\/$/, '');

/** Canonical stored-file URL, or null when `u` is not one of ours. */
function normalizeStoredFileUrl(u) {
  if (typeof u !== 'string') return null;
  let s = u.trim();
  if (!s || s.length > 600) return null;
  const app = appBase();
  if (app && s.startsWith(app + '/files/')) s = s.slice(app.length); // absolute link to this app
  if (LOCAL.test(s)) return s;
  const base = publicBase();
  if (base && s.startsWith(base + '/') && s.length > base.length + 1 && !BAD.test(s.slice(base.length))) return s;
  return null;
}
const isStoredFileUrl = (u) => normalizeStoredFileUrl(u) !== null;

module.exports = { normalizeStoredFileUrl, isStoredFileUrl, publicBase };
