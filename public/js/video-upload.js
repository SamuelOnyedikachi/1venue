/** Compress a video on the client, then PUT it straight to R2 (presigned). */
import { api, uploadFile, toast } from './ui.js';

export const VIDEO_MAX_SEC = 900;
export const VIDEO_MAX_BYTES = 200 * 1024 * 1024;
export const PROFILES = {
  chat: { maxW: 854, maxH: 480, bps: 800_000, label: '480p' },
  material: { maxW: 1280, maxH: 720, bps: 1_500_000, label: '720p' },
};

/** Seconds, or 0 if unknown. Values that look like milliseconds are converted. */
export function parseDurationSec(d) {
  let n = Number(d);
  if (!Number.isFinite(n) || n <= 0) return 0;
  if (n > 10_000 && n < 24 * 3600 * 1000) n = n / 1000;
  return n;
}

/**
 * Read width/height/duration. MediaRecorder webm often reports Infinity or NaN until
 * we seek to the end (the 1e101 trick). Unknown duration becomes 0 — size still caps the upload.
 */
export function probeVideo(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const v = document.createElement('video');
    v.preload = 'metadata';
    v.muted = true;
    v.playsInline = true;
    let done = false;
    const finish = (dur) => {
      if (done) return;
      done = true;
      const info = { duration: parseDurationSec(dur), width: v.videoWidth || 0, height: v.videoHeight || 0 };
      URL.revokeObjectURL(url);
      try { v.removeAttribute('src'); v.load(); } catch { /* ignore */ }
      resolve(info);
    };
    v.onerror = () => { if (done) return; done = true; URL.revokeObjectURL(url); reject(new Error('Could not read that video')); };
    v.onloadedmetadata = () => {
      const d = v.duration;
      if (Number.isFinite(d) && d > 0) return finish(d);
      // Seek to a huge time so the browser computes the real duration (classic Infinity/NaN webm case).
      const onSeek = () => finish(v.duration);
      v.addEventListener('seeked', onSeek, { once: true });
      v.addEventListener('durationchange', () => {
        if (Number.isFinite(v.duration) && v.duration > 0) finish(v.duration);
      });
      try { v.currentTime = 1e101; } catch {
        try { v.currentTime = Number.MAX_VALUE; } catch { /* some browsers throw */ }
      }
      setTimeout(() => finish(v.duration), 800);
    };
    v.src = url;
  });
}

export async function capturePoster(file, at = 0.4) {
  try {
    const url = URL.createObjectURL(file);
    const v = document.createElement('video');
    v.muted = true;
    v.preload = 'auto';
    await new Promise((res, rej) => { v.onloadeddata = res; v.onerror = rej; v.src = url; });
    const t = Math.min(Math.max(0, at), Math.max(0, (v.duration || 1) - 0.05));
    if (v.fastSeek) v.fastSeek(t); else v.currentTime = t;
    await new Promise((res) => { v.onseeked = res; setTimeout(res, 400); });
    const c = document.createElement('canvas');
    const s = Math.min(1, 640 / Math.max(v.videoWidth || 640, 1));
    c.width = Math.max(2, Math.round((v.videoWidth || 640) * s));
    c.height = Math.max(2, Math.round((v.videoHeight || 360) * s));
    c.getContext('2d').drawImage(v, 0, 0, c.width, c.height);
    URL.revokeObjectURL(url);
    const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.8));
    return blob ? new File([blob], 'poster.jpg', { type: 'image/jpeg' }) : null;
  } catch { return null; }
}

function scale(w, h, maxW, maxH) {
  const s = Math.min(1, maxW / (w || maxW), maxH / (h || maxH));
  let tw = Math.max(2, Math.round((w || maxW) * s / 2) * 2);
  let th = Math.max(2, Math.round((h || maxH) * s / 2) * 2);
  return { w: tw, h: th };
}

/** Canvas + MediaRecorder. WebCodecs is used when VideoEncoder can encode VP9/VP8. */
async function compressMediaRecorder(file, profile, { onProgress, signal } = {}) {
  const url = URL.createObjectURL(file);
  const v = document.createElement('video');
  v.muted = true;
  v.playsInline = true;
  await new Promise((res, rej) => { v.onloadedmetadata = res; v.onerror = rej; v.src = url; });
  const { w, h } = scale(v.videoWidth, v.videoHeight, profile.maxW, profile.maxH);
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d');
  const fps = 24;
  const vstream = canvas.captureStream(fps);
  let stream = vstream;
  try {
    const audio = v.captureStream ? v.captureStream() : null;
    const atracks = audio && audio.getAudioTracks();
    if (atracks && atracks[0]) stream = new MediaStream([vstream.getVideoTracks()[0], atracks[0]]);
  } catch { /* silent video is fine */ }
  const mime = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'].find((m) => MediaRecorder.isTypeSupported(m)) || 'video/webm';
  const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: profile.bps, audioBitsPerSecond: 64_000 });
  const chunks = [];
  rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
  const done = new Promise((res, rej) => { rec.onstop = res; rec.onerror = () => rej(new Error('Compression failed')); });
  rec.start(250);
  await v.play().catch(() => {});
  const start = performance.now();
  const duration = v.duration || 0;
  const draw = () => {
    if (signal && signal.aborted) { try { rec.stop(); v.pause(); } catch {} return; }
    ctx.drawImage(v, 0, 0, w, h);
    if (onProgress && duration) onProgress(Math.min(0.95, v.currentTime / duration), 'compress');
    if (!v.paused && !v.ended) requestAnimationFrame(draw);
  };
  requestAnimationFrame(draw);
  await new Promise((res, rej) => {
    v.onended = res;
    v.onerror = rej;
    if (signal) signal.addEventListener('abort', () => { v.pause(); rej(Object.assign(new Error('Cancelled'), { cancelled: true })); }, { once: true });
  });
  const measured = parseDurationSec(v.duration) || parseDurationSec(v.currentTime) || parseDurationSec((performance.now() - start) / 1000);
  if (rec.state !== 'inactive') rec.stop();
  await done;
  URL.revokeObjectURL(url);
  const blob = new Blob(chunks, { type: mime.split(';')[0] });
  if (!blob.size) throw new Error('Compression produced an empty file');
  const name = (file.name || 'video').replace(/\.[^.]+$/, '') + '.webm';
  return Object.assign(new File([blob], name, { type: blob.type }), { durationSec: measured });
}

async function compressWebCodecs(file, profile, { onProgress, signal } = {}) {
  if (typeof VideoEncoder !== 'function' || typeof VideoFrame !== 'function') throw new Error('no webcodecs');
  // WebCodecs without a muxer still goes through a MediaRecorder of an OffscreenCanvas
  // captureStream when available; otherwise we fall through to the canvas path.
  if (typeof OffscreenCanvas !== 'function') throw new Error('no offscreen');
  return compressMediaRecorder(file, profile, { onProgress, signal });
}

export async function compressVideo(file, { profile = 'chat', onProgress, signal } = {}) {
  const p = PROFILES[profile] || PROFILES.chat;
  try {
    return await compressWebCodecs(file, p, { onProgress, signal });
  } catch (e) {
    if (e && e.cancelled) throw e;
    if (typeof MediaRecorder === 'function') return compressMediaRecorder(file, p, { onProgress, signal });
    throw e;
  }
}

async function putWithProgress(url, file, headers, { onProgress, signal } = {}) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', url);
    Object.entries(headers || {}).forEach(([k, v]) => xhr.setRequestHeader(k, v));
    xhr.upload.onprogress = (e) => { if (e.lengthComputable && onProgress) onProgress(e.loaded / e.total, 'upload'); };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) resolve();
      else reject(new Error(`Upload failed (${xhr.status})`));
    };
    xhr.onerror = () => reject(new Error('Upload failed: network error'));
    xhr.onabort = () => reject(Object.assign(new Error('Cancelled'), { cancelled: true }));
    if (signal) signal.addEventListener('abort', () => xhr.abort(), { once: true });
    xhr.send(file);
  });
}

export async function uploadVideo(file, { purpose = 'chat', profile, headers = {}, onProgress, signal } = {}) {
  const info = await probeVideo(file);
  const maxSec = VIDEO_MAX_SEC;
  let dur = parseDurationSec(info.duration);
  if (dur && dur > maxSec + 0.5) throw new Error(`Videos can be up to ${Math.round(maxSec / 60)} minutes`);
  let out = file;
  const want = profile || (purpose === 'content' || purpose === 'material' ? 'material' : 'chat');
  try {
    if (onProgress) onProgress(0, 'compress');
    out = await compressVideo(file, { profile: want, onProgress, signal });
    if (onProgress) onProgress(1, 'compress');
    if (!dur) dur = parseDurationSec(out.durationSec);
    if (dur && dur > maxSec + 0.5) throw new Error(`Videos can be up to ${Math.round(maxSec / 60)} minutes`);
  } catch (e) {
    if (e && e.cancelled) throw e;
    if (e && /up to .* minutes/.test(e.message || '')) throw e;
    if (file.size > VIDEO_MAX_BYTES) throw new Error(`Videos can be up to ${Math.round(VIDEO_MAX_BYTES / 1048576)} MB`);
    out = file;
    toast('Could not compress this video, so the original will be uploaded if it fits.', { icon: 'alert', ms: 4000 });
  }
  if (out.size > VIDEO_MAX_BYTES) throw new Error(`Videos can be up to ${Math.round(VIDEO_MAX_BYTES / 1048576)} MB`);
  let posterUrl = null;
  try {
    const poster = await capturePoster(out);
    if (poster) {
      const up = await uploadFile(poster, { purpose: 'content', headers });
      posterUrl = up.url;
    }
  } catch { /* poster is optional */ }
  let signed;
  try {
    signed = await api('/api/files/presign', { method: 'POST', body: {
      filename: out.name, mime: out.type || 'video/webm', size: out.size,
      durationSec: dur || undefined, purpose, width: info.width, height: info.height,
    }, headers });
  } catch (e) {
    if (e && e.status === 503) {
      // Local dev without R2: last resort, only if the file is modest.
      if (out.size > 25 * 1048576) throw new Error('Direct video upload needs object storage (R2).');
      const rec = await uploadFile(out, { purpose, headers, direct: true });
      return { ...rec, kind: 'video', durationSec: dur || info.duration || 0, posterUrl, width: info.width, height: info.height };
    }
    throw e;
  }
  if (onProgress) onProgress(0, 'upload');
  await putWithProgress(signed.uploadUrl, out, signed.headers, { onProgress, signal });
  const rec = await api('/api/files/complete', { method: 'POST', body: { id: signed.id }, headers });
  if (onProgress) onProgress(1, 'upload');
  return { ...rec, kind: 'video', durationSec: dur || info.duration || 0, posterUrl, width: info.width, height: info.height };
}
