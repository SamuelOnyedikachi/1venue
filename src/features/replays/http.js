/**
 * GET /replays/:id/media: access-checked replay video. With a public R2/S3 base URL
 * (S3_PUBLIC_BASE_URL) viewers are redirected to it so Cloudflare serves the bytes; otherwise the
 * app streams with HTTP Range support so the player can seek.
 */
const { one } = require('../../core/db');
const { getAuthUser } = require('../../lib/auth');
module.exports = async function handle(req, res, url) {
  const m = /^\/replays\/(\d+)\/media$/.exec(url.pathname);
  if (!m || (req.method !== 'GET' && req.method !== 'HEAD')) return false;
  const svc = require('./service');
  const r = await one('SELECT * FROM replays WHERE id=$1', [Number(m[1])]);
  const viewer = await getAuthUser(req, res).catch(() => null);
  const a = await svc.access(r, viewer);
  if (!a.ok || !r.object_key) { res.writeHead(a.status || 404, { 'Content-Type': 'text/plain' }); res.end('Not found'); return true; }
  const storage = require('../../venue/storage');
  const base = storage.s3Settings().publicBaseUrl;
  if (r.driver === 's3' && base && process.env.REPLAY_PUBLIC_REDIRECT !== 'false') {
    res.writeHead(302, { Location: `${base}/${r.object_key.split('/').map(encodeURIComponent).join('/')}`, 'Cache-Control': 'private, max-age=60' });
    res.end(); return true;
  }
  const total = r.size_bytes ? Number(r.size_bytes) : null;
  let range = null;
  const h = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range || ''));
  if (h && total) {
    let start = h[1] === '' ? Math.max(0, total - Number(h[2])) : Number(h[1]);
    let end = h[1] === '' || h[2] === '' ? total - 1 : Math.min(Number(h[2]), total - 1);
    if (start > end || start >= total) { res.writeHead(416, { 'Content-Range': `bytes */${total}` }); res.end(); return true; }
    range = { start, end };
  }
  let o;
  try { o = await storage.open({ driver: r.driver, object_key: r.object_key }, range); }
  catch (_) { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('Recording file is missing'); return true; }
  const headers = { 'Content-Type': r.mime || 'video/mp4', 'Accept-Ranges': 'bytes', 'Cache-Control': 'private, max-age=300' };
  if (range) { headers['Content-Range'] = `bytes ${range.start}-${range.end}/${total}`; headers['Content-Length'] = String(range.end - range.start + 1); }
  else if (o.size != null) headers['Content-Length'] = String(o.size);
  res.writeHead(range ? 206 : 200, headers);
  if (req.method === 'HEAD') { o.stream.destroy(); res.end(); return true; }
  o.stream.on('error', () => res.destroy());
  o.stream.pipe(res);
  return true;
};
