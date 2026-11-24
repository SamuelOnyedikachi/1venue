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
async function getS3(key, range) {
  const url = s3Url(key);
  const headers = sign('GET', url, range ? { range: `bytes=${range.start}-${range.end == null ? '' : range.end}` } : {}, sha(''));
  const r = await fetch(url, { headers });
  if (!r.ok) { try { await r.body?.cancel(); } catch (_) {} throw new Error(`S3 read failed (${r.status})`); }
  const len = Number(r.headers.get('content-length'));
  return { stream: Readable.fromWeb(r.body), size: Number.isFinite(len) && len >= 0 ? len : undefined };
}

/** Save a buffer and return a file record + public URL. */
async function save(buf, { filename, mime, ownerUserId, ownerKey, purpose, roomCode, maxBytes } = {}) {
  if (buf.length > (maxBytes || S.maxUploadBytes)) { const e = new Error(`File too large (max ${Math.round((maxBytes || S.maxUploadBytes) / 1048576)} MB)`); e.status = 413; throw e; }
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
/**
 * Stream a large upload (e.g. a replay video) straight to disk or the bucket without buffering it
 * in memory. `size` must be the declared Content-Length; more bytes than that (or than maxBytes)
 * abort the upload. S3/R2 uses an UNSIGNED-PAYLOAD SigV4 PUT. Returns { driver, objectKey, size }.
 */
async function saveStream(input, { filename, mime, size, maxBytes }) {
  if (!Number.isSafeInteger(size) || size <= 0) { const e = new Error('The upload needs a Content-Length'); e.status = 411; throw e; }
  if (maxBytes && size > maxBytes) { const e = new Error(`File too large (max ${Math.round(maxBytes / 1048576)} MB)`); e.status = 413; throw e; }
  const { Transform } = require('stream');
  let seen = 0;
  const guard = new Transform({ transform(chunk, _enc, cb) { seen += chunk.length; if (seen > size) cb(Object.assign(new Error('Upload is larger than declared'), { status: 400 })); else cb(null, chunk); } });
  const body = input.pipe(guard);
  input.on('error', (e) => guard.destroy(e));
  const d = driver();
  const now = new Date();
  const key = `replays/${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, '0')}/${newId()}-${slugName(filename)}`;
  if (d === 's3') {
    const url = s3Url(key);
    const headers = sign('PUT', url, { 'content-type': mime || 'application/octet-stream', 'content-length': String(size) }, 'UNSIGNED-PAYLOAD');
    let r;
    try { r = await fetch(url, { method: 'PUT', headers, body, duplex: 'half', signal: AbortSignal.timeout(30 * 60000) }); }
    catch (e) { const err = new Error(`Storage is unreachable (${e.message})`); err.status = e.status || 502; throw err; }
    if (!r.ok) { const t = await r.text().catch(() => ''); const err = new Error(`Storage rejected the file (${r.status})`); err.status = 502; log.error('storage', 'stream put failed', { key, status: r.status, body: t.slice(0, 200) }); throw err; }
  } else {
    const p = localPath(key);
    await fs.promises.mkdir(path.dirname(p), { recursive: true });
    await require('stream/promises').pipeline(body, fs.createWriteStream(p)).catch(async (e) => { await fs.promises.unlink(p).catch(() => {}); throw e; });
  }
  if (seen !== size) { const e = new Error('The upload was incomplete'); e.status = 400; throw e; }
  return { driver: d, objectKey: key, size: seen };
}
function publicUrl(rec) {
  // Each key segment is percent-encoded (older keys can contain spaces / parentheses).
  if (rec.driver === 's3' && S.s3.publicBaseUrl) return `${S.s3.publicBaseUrl}/${String(rec.objectKey || rec.object_key).split('/').map(encSeg).join('/')}`;
  return `/files/${rec.id}/${encodeURIComponent(rec.filename)}`;
}
/** Open a stored object for reading. Optional range { start, end } (inclusive) for video seeking. */
async function open(row, range) {
  if (row.driver === 's3') return getS3(row.object_key, range);
  const p = localPath(row.object_key);
  await fs.promises.access(p);
  const size = (await fs.promises.stat(p)).size;
  if (range) return { stream: fs.createReadStream(p, { start: range.start, end: range.end == null ? undefined : range.end }), size: (range.end == null ? size - 1 : range.end) - range.start + 1 };
  return { stream: fs.createReadStream(p), size };
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

/** Browser-friendly query-string SigV4 PUT (R2/S3). No Authorization header, so CORS is simpler. */
function encodeRfc3986(s) { return encodeURIComponent(s).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase()); }
function presignPut(key, { mime = 'application/octet-stream', expires = 900 } = {}) {
  if (driver() !== 's3') { const e = new Error('Video uploads need object storage (set STORAGE_DRIVER=s3)'); e.status = 503; throw e; }
  const url = s3Url(key);
  const { region, accessKeyId, secretAccessKey } = S.s3;
  const now = new Date();
  const amz = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const date = amz.slice(0, 8);
  const scope = `${date}/${region}/s3/aws4_request`;
  const signed = 'content-type;host';
  const params = {
    'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
    'X-Amz-Credential': `${accessKeyId}/${scope}`,
    'X-Amz-Date': amz,
    'X-Amz-Expires': String(Math.min(3600, Math.max(60, expires))),
    'X-Amz-SignedHeaders': signed,
    'X-Amz-Content-Sha256': 'UNSIGNED-PAYLOAD',
  };
  const canonQs = Object.keys(params).sort().map((k) => `${encodeRfc3986(k)}=${encodeRfc3986(params[k])}`).join('&');
  const canonHeaders = `content-type:${mime}\nhost:${url.host}\n`;
  const canon = ['PUT', url.pathname, canonQs, canonHeaders, signed, 'UNSIGNED-PAYLOAD'].join('\n');
  const sts = ['AWS4-HMAC-SHA256', amz, scope, sha(canon)].join('\n');
  const kSig = hmac(hmac(hmac(hmac('AWS4' + secretAccessKey, date), region), 's3'), 'aws4_request');
  const sig = crypto.createHmac('sha256', kSig).update(sts).digest('hex');
  const href = `${url.origin}${url.pathname}?${canonQs}&X-Amz-Signature=${sig}`;
  return { url: href, method: 'PUT', headers: { 'Content-Type': mime }, expires: Number(params['X-Amz-Expires']) };
}
async function headObject(key) {
  if (driver() !== 's3') return null;
  const url = s3Url(key);
  const r = await fetch(url, { method: 'HEAD', headers: sign('HEAD', url, {}, sha('')), signal: AbortSignal.timeout(15000) });
  if (r.status === 404) return null;
  if (!r.ok) throw Object.assign(new Error(`Storage could not confirm the upload (${r.status})`), { status: 502 });
  const len = Number(r.headers.get('content-length'));
  return { size: Number.isFinite(len) ? len : null, etag: r.headers.get('etag') || null };
}

module.exports = { save, saveStream, open, remove, publicUrl, driver, slugName, s3Settings: () => S.s3, presignPut, headObject, newId, _sign: sign };

