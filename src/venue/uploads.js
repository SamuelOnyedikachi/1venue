/**
 * Upload policy: per-type size limits, per-user / per-guest quota, per-meeting cap and
 * rate limits. Everything is configured in config.UPLOADS (env) with lean defaults.
 */
const config = require('../config');
const { rateLimit } = require('../lib/http');

const U = config.UPLOADS;
const PURPOSES = new Set(['attachment', 'avatar', 'cover', 'post', 'timeline', 'transcript', 'content', 'chat', 'voice', 'whiteboard', 'sound', 'other']);
const normalizePurpose = (p) => (PURPOSES.has(String(p || '')) ? String(p) : 'attachment');

function kindOf(mime) {
  const m = String(mime || '').toLowerCase();
  if (m.startsWith('image/')) return 'image';
  if (m === 'application/pdf') return 'pdf';
  if (m.startsWith('audio/')) return 'audio';
  if (m.startsWith('video/')) return 'video';
  if (m === 'application/x-mwb') return 'board';
  return 'other';
}
const LIMIT = { image: 'maxImageBytes', pdf: 'maxPdfBytes', audio: 'maxAudioBytes', video: 'maxVideoBytes', board: 'maxBoardBytes', other: 'maxOtherBytes' };
const LABEL = { image: 'Images', pdf: 'PDFs', audio: 'Audio files', video: 'Videos', board: 'Whiteboard files', other: 'Files' };
const fmtMB = (b) => { const v = b / 1048576; return (v >= 10 ? Math.round(v) : Math.round(v * 10) / 10) + ' MB'; };
/** Seconds, or 0 if unknown. Values that look like milliseconds (e.g. MediaRecorder metadata) are converted. */
function normalizeDurationSec(d) {
  let n = Number(d);
  if (!Number.isFinite(n) || n <= 0) return 0;
  if (n > 10_000 && n < 24 * 3600 * 1000) n = n / 1000;
  return n;
}
function videoMaxSeconds() { return (U.maxVideoSeconds > 0 ? U.maxVideoSeconds : 900); }
/**
 * Per-type cap. Videos go direct to object storage, so they are not capped by the
 * through-Node MAX_UPLOAD_MB (default 25). Pass throughNode: true when the body
 * will be buffered by this server (POST /api/files). 0 still disables a type.
 */
function limitFor(mime, { throughNode = false } = {}) {
  const kind = kindOf(mime);
  const cap = U[LIMIT[kind]] || 0;
  if (kind === 'video') return (throughNode && cap) ? Math.min(cap, config.STORAGE.maxUploadBytes) : cap;
  return Math.min(cap, config.STORAGE.maxUploadBytes);
}
const err = (status, message) => Object.assign(new Error(message), { status, expose: true });

const hours = new Map();
function hourly(key, limit = U.perHour) {
  const h = Math.floor(Date.now() / 3600e3), k = key + ':' + h;
  const n = (hours.get(k) || 0) + 1; hours.set(k, n);
  if (hours.size > 5000) for (const kk of hours.keys()) if (!kk.endsWith(':' + h)) hours.delete(kk);
  return n <= limit;
}

/** Cheap pre-checks before the body is read. */
function precheck({ mime, declaredSize, rateKey, contentBatch = false, throughNode = true }) {
  const kind = kindOf(mime);
  const max = limitFor(mime, { throughNode });
  if (/html|javascript|svg|x-msdownload|x-sh\b/i.test(mime)) throw err(415, 'That file type is not allowed');
  if (!max) throw err(415, kind === 'video' ? 'Video uploads are turned off - share a YouTube link instead.' : `${LABEL[kind]} can’t be uploaded here`);
  if (declaredSize && declaredSize > max) throw err(413, `${LABEL[kind]} can be up to ${fmtMB(max)} (this one is ${fmtMB(declaredSize)})`);
  const batch = contentBatch && kind === 'image';
  const key = batch ? `content:${rateKey}` : rateKey;
  if (!rateLimit(`up:m:${key}`, batch ? U.contentPerMinute : U.perMinute)) throw err(429, 'Too many uploads - wait a minute and try again');
  if (!hourly(key, batch ? U.contentPerHour : U.perHour)) throw err(429, 'Hourly upload limit reached - try again later');
  return max;
}

/** Per-user storage quota from the user's plan (falls back to UPLOAD_USER_QUOTA_MB if plans are unavailable). */
async function userQuotaBytes(userId) {
  try { return (await require('../lib/plans').entitlements(userId)).limits.uploadBytes; } catch (_) { return U.userQuotaBytes; }
}
/** Quota checks once the size is known. data = venue data module. */
async function quota(data, { size, userId, ownerKey, roomCode }) {
  const used = await data.fileUsage({ userId, ownerKey });
  const cap = userId ? await userQuotaBytes(userId) : U.guestQuotaBytes;
  if (cap && used + size > cap) throw err(413, `Storage quota reached (${fmtMB(used)} of ${fmtMB(cap)} used). Delete old uploads or upgrade your plan for more.`);
  if (roomCode && U.meetingCapBytes) {
    const r = await data.fileUsage({ roomCode });
    if (r + size > U.meetingCapBytes) throw err(413, `This meeting has reached its ${fmtMB(U.meetingCapBytes)} upload cap`);
  }
}

function publicLimits() {
  return {
    image: limitFor('image/png'), pdf: limitFor('application/pdf'), audio: limitFor('audio/webm'), video: limitFor('video/mp4'), board: limitFor('application/x-mwb'), other: limitFor('application/octet-stream'),
    userQuota: U.userQuotaBytes, meetingCap: U.meetingCapBytes, perMinute: U.perMinute, videoSeconds: videoMaxSeconds(),
  };
}

module.exports = { userQuotaBytes, PURPOSES, normalizePurpose, kindOf, limitFor, precheck, quota, publicLimits, fmtMB, normalizeDurationSec, videoMaxSeconds };
