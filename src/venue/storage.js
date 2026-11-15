/**
 * File storage: VPS disk by default (STORAGE_DIR, mount it as a volume) or any
 * S3-compatible bucket (AWS, R2, Wasabi, MinIO, Backblaze) when STORAGE_DRIVER=s3.
 * S3 requests are signed with SigV4 by hand, so there is no heavy SDK.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Readable } = require('stream');
const config = require('../config');
const log = require('../lib/log');
const { encSeg } = require('../lib/file-url');

const S = config.STORAGE;
const driver = () => (S.driver === 's3' && S.s3.bucket && S.s3.accessKeyId ? 's3' : 'local');

function newId() { return crypto.randomBytes(16).toString('base64url'); }
function safeName(n) { return String(n || 'file').replace(/[^\w.\- ]+/g, '_').slice(-120) || 'file'; }
/** Storage-key slug: ASCII letters/digits . _ - only (no spaces), keeps the extension. "CV - Web (v2).pdf" -> "CV-Web-v2.pdf" */
function slugName(n) {
  const name = String(n || 'file').normalize('NFKD').replace(/[\u0300-\u036f]/g, '');
  const m = name.match(/^(.*?)(\.[A-Za-z0-9]{1,8})?$/);
  const stem = (m[1] || '').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/-{2,}/g, '-').replace(/^[-.]+|[-.]+$/g, '').slice(0, 80) || 'file';
  return stem + (m[2] ? m[2].toLowerCase() : '');
}

// ---------------- local
function localPath(key) {
  const p = path.join(S.localDir, key);
  if (!p.startsWith(path.resolve(S.localDir))) throw new Error('bad key');
  return p;
}
async function putLocal(key, buf) {
  const p = localPath(key);
  await fs.promises.mkdir(path.dirname(p), { recursive: true });
  await fs.promises.writeFile(p, buf);
}

// ---------------- s3 (SigV4)
const hmac = (k, s) => crypto.createHmac('sha256', k).update(s).digest();
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
function s3Url(key) {
  const { endpoint, bucket, region, forcePathStyle } = S.s3;
  const base = endpoint || `https://s3.${region}.amazonaws.com`;
  const u = new URL(base);
  const k = key.split('/').map(encodeURIComponent).join('/');
  if (forcePathStyle) return new URL(`${u.origin}/${bucket}/${k}`);
  return new URL(`${u.protocol}//${bucket}.${u.host}/${k}`);
}
function sign(method, url, headers, payloadHash) {
  const { region, accessKeyId, secretAccessKey } = S.s3;
  const now = new Date();
  const amz = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const date = amz.slice(0, 8);
  headers['x-amz-date'] = amz;
  headers['x-amz-content-sha256'] = payloadHash;
  headers.host = url.host;
  const names = Object.keys(headers).map((h) => h.toLowerCase()).sort();
  const canonHeaders = names.map((n) => `${n}:${String(headers[Object.keys(headers).find((k) => k.toLowerCase() === n)]).trim()}\n`).join('');
  const signed = names.join(';');
  const canon = [method, url.pathname, url.searchParams.toString(), canonHeaders, signed, payloadHash].join('\n');
  const scope = `${date}/${region}/s3/aws4_request`;
  const sts = ['AWS4-HMAC-SHA256', amz, scope, sha(canon)].join('\n');
  const kSig = hmac(hmac(hmac(hmac('AWS4' + secretAccessKey, date), region), 's3'), 'aws4_request');
  headers.Authorization = `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${signed}, Signature=${crypto.createHmac('sha256', kSig).update(sts).digest('hex')}`;
  delete headers.host;
  return headers;
}
async function putS3(key, buf, mime) {
  const url = s3Url(key);
  const headers = sign('PUT', url, { 'content-type': mime }, sha(buf));
  let r;
  try { r = await fetch(url, { method: 'PUT', headers, body: buf, signal: AbortSignal.timeout(60000) }); }
  catch (e) { const err = new Error(`Storage is unreachable (${e.name === 'TimeoutError' ? 'timeout' : e.message})`); err.status = 502; err.step = 'storage-put'; throw err; }
  if (!r.ok) {
    const body = await r.text().catch(() => '');
    const code = (body.match(/<Code>([^<]+)<\/Code>/) || [])[1];
    log.error('storage', 'put failed', { key, status: r.status, code, body: body.slice(0, 300), host: url.host });
    const err = new Error(`Storage rejected the file (${r.status}${code ? ' ' + code : ''})`); err.status = 502; err.step = 'storage-put'; throw err;
  }
}
/** Stream an object from the bucket (no whole-file buffering in the app's memory). */
async function getS3(key) {
  const url = s3Url(key);
  const headers = sign('GET', url, {}, sha(''));
  const r = await fetch(url, { headers });
  if (!r.ok) { try { await r.body?.cancel(); } catch (_) {} throw new Error(`S3 read failed (${r.status})`); }
  const len = Number(r.headers.get('content-length'));
  return { stream: Readable.fromWeb(r.body), size: Number.isFinite(len) && len >= 0 ? len : undefined };
}

/** Save a buffer and return a file record + public URL. */
async function save(buf, { filename, mime, ownerUserId, ownerKey, purpose, roomCode } = {}) {
  if (buf.length > S.maxUploadBytes) { const e = new Error(`File too large (max ${Math.round(S.maxUploadBytes / 1048576)} MB)`); e.status = 413; throw e; }
  const id = newId();
  const d = driver();
  const now = new Date();
  const key = `${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, '0')}/${id}-${slugName(filename)}`;
  const t0 = Date.now();
  try {
    if (d === 's3') await putS3(key, buf, mime || 'application/octet-stream');
    else await putLocal(key, buf);
  } catch (e) {
    if (!e.step) { e.step = 'storage-put'; log.error('storage', 'put failed', { driver: d, key, error: e.message }); }
    throw e;
  }
  log.info('storage', 'put ok', { driver: d, key, bytes: buf.length, ms: Date.now() - t0 });
  const rec = { id, driver: d, objectKey: key, filename: safeName(filename), mime: mime || 'application/octet-stream', size: buf.length, ownerUserId, ownerKey, purpose, roomCode };
  try { await require('./data').insertFile(rec); }
  catch (e) { log.error('storage', 'db insert failed', { id, key, error: e.message }); e.step = 'db-insert'; throw e; }
  return { ...rec, url: publicUrl(rec) };
}
function publicUrl(rec) {
  // Each key segment is percent-encoded (older keys can contain spaces / parentheses).
  if (rec.driver === 's3' && S.s3.publicBaseUrl) return `${S.s3.publicBaseUrl}/${String(rec.objectKey || rec.object_key).split('/').map(encSeg).join('/')}`;
  return `/files/${rec.id}/${encodeURIComponent(rec.filename)}`;
}
async function open(row) {
  if (row.driver === 's3') return getS3(row.object_key);
  const p = localPath(row.object_key);
  await fs.promises.access(p);
  return { stream: fs.createReadStream(p), size: (await fs.promises.stat(p)).size };
}

/** Delete a stored object (account deletion). Missing objects count as removed. Never throws. */
async function remove(row) {
  const key = row && (row.object_key || row.objectKey);
  if (!key) return false;
  try {
    if (row.driver === 's3') {
      if (driver() !== 's3') return false;
      const url = s3Url(key);
      const r = await fetch(url, { method: 'DELETE', headers: sign('DELETE', url, {}, sha('')), signal: AbortSignal.timeout(15000) });
      return r.ok || r.status === 404;
    }
    await fs.promises.unlink(localPath(key)).catch((e) => { if (e.code !== 'ENOENT') throw e; });
    return true;
  } catch (e) {
    console.warn('[storage] delete failed:', e.message);
    return false;
  }
}

module.exports = { save, open, remove, publicUrl, driver, slugName, _sign: sign };
