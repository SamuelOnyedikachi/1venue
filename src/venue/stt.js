/**
 * Speech-to-text.
 *  1. Whisper on Replicate (primary, REPLICATE_API_TOKEN): voice typing in the / bar and every
 *     text box, and live captions in rooms. Default model: vaibhavs10/incredibly-fast-whisper
 *     (Whisper large-v3, L40S, ~1-3 s per short clip). openai/whisper is also supported.
 *  2. Optional OpenAI-compatible /audio/transcriptions servers: N-ATLaS (NCAIR1, Nigerian-accented
 *     English, Yoruba, Igbo, Hausa; see stt-sidecar/) and a Whisper server.
 *  3. When none is configured (or a cap is hit) clients fall back to the browser Web Speech API.
 */
const config = require('../config');
const replicate = require('../lib/replicate');

// Whisper language names (incredibly-fast-whisper takes names, openai/whisper takes codes).
// Igbo is not a Whisper language: it is sent as auto-detect (N-ATLaS handles Igbo when configured).
const WHISPER_LANG = { en: 'english', yo: 'yoruba', ha: 'hausa', fr: 'french', ar: 'arabic', sw: 'swahili', pt: 'portuguese', es: 'spanish', de: 'german' };
const isFast = (model) => /incredibly-fast-whisper/i.test(model);
function replicateInput(model, audioDataUri, lang) {
  const code = WHISPER_LANG[lang] ? lang : null;
  if (isFast(model)) return { audio: audioDataUri, task: 'transcribe', language: code ? WHISPER_LANG[code] : 'None', batch_size: 8, timestamp: 'chunk', diarise_audio: false };
  return { audio: audioDataUri, model: 'large-v3', language: code || 'auto', transcription: 'plain text', translate: false, temperature: 0, condition_on_previous_text: false, no_speech_threshold: 0.6 };
}
function replicateText(out) {
  if (!out) return '';
  if (typeof out === 'string') return out;
  if (typeof out.text === 'string') return out.text;
  if (typeof out.transcription === 'string') return out.transcription;
  if (Array.isArray(out.segments)) return out.segments.map((x) => x.text || '').join(' ');
  if (Array.isArray(out.chunks)) return out.chunks.map((x) => x.text || '').join(' ');
  return '';
}
const replicateOn = () => !!config.STT.replicate.token && ['auto', 'replicate'].includes(config.STT.provider);

const LANG_MODELS = {
  // Per-language N-ATLaS checkpoints. A sidecar may also route by `language` itself.
  en: 'NCAIR1/NigerianAccentedEnglish',
  yo: 'NCAIR1/Yoruba-ASR',
  ig: 'NCAIR1/Igbo-ASR',
  ha: 'NCAIR1/Hausa-ASR',
};

function chain() {
  const mode = config.STT.provider;
  if (mode === 'off' || mode === 'webspeech') return [];
  const out = [];
  if (replicateOn()) out.push({ name: 'Whisper (Replicate)', kind: 'replicate', model: config.STT.replicate.model });
  if ((mode === 'auto' || mode === 'natlas') && config.STT.primary.baseUrl) out.push({ ...config.STT.primary, kind: 'natlas' });
  if ((mode === 'auto' || mode === 'whisper') && config.STT.secondary.baseUrl) out.push({ ...config.STT.secondary, kind: 'whisper' });
  return out;
}
function status() {
  const c = chain();
  return {
    server: c.length > 0,
    primary: c[0] ? c[0].kind : 'webspeech',
    providers: c.map((p) => p.name),
    segmentMaxSeconds: Math.min(15, Math.max(2, config.STT.segmentMaxSeconds)),
    fallback: config.STT.provider === 'off' ? 'none' : 'webspeech',
    chunkSeconds: config.STT.chunkSeconds,
    maxChunkBytes: config.STT.maxChunkBytes,
    languages: ['en', 'yo', 'ig', 'ha', 'pcm'],
  };
}

async function transcribeReplicate(p, buf, mime, lang) {
  const R = config.STT.replicate;
  const dataUri = `data:${mime || 'audio/webm'};base64,${buf.toString('base64')}`;
  const r = await replicate.run({ token: R.token, apiBase: R.apiBase, model: R.model, input: replicateInput(R.model, dataUri, lang), timeoutMs: R.timeoutMs, tag: 'stt', wait: Math.ceil(R.timeoutMs / 1000) });
  return { text: clean(replicateText(r.output)), provider: p.name, model: R.model, predictTime: r.metrics.predict_time || null };
}

async function transcribeWith(p, buf, mime, lang) {
  if (p.kind === 'replicate') return transcribeReplicate(p, buf, mime, lang);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), config.STT.timeoutMs);
  try {
    const fd = new FormData();
    const ext = /ogg/.test(mime) ? 'ogg' : /wav/.test(mime) ? 'wav' : /mp4|m4a|aac/.test(mime) ? 'm4a' : 'webm';
    fd.append('file', new Blob([buf], { type: mime || 'audio/webm' }), `chunk.${ext}`);
    let model = p.model;
    if (p.kind === 'natlas' && lang && LANG_MODELS[lang] && /^NCAIR1\//.test(p.model)) model = LANG_MODELS[lang];
    fd.append('model', model);
    if (lang && lang !== 'pcm') fd.append('language', lang);
    fd.append('response_format', 'json');
    const r = await fetch(p.baseUrl + '/audio/transcriptions', {
      method: 'POST',
      headers: p.apiKey ? { Authorization: `Bearer ${p.apiKey}` } : {},
      body: fd,
      signal: ctrl.signal,
    });
    if (!r.ok) throw new Error(`${p.name} HTTP ${r.status}`);
    const ct = r.headers.get('content-type') || '';
    const text = ct.includes('json') ? ((await r.json()).text || '') : await r.text();
    return { text: String(text).trim(), provider: p.name, model };
  } finally {
    clearTimeout(timer);
  }
}

async function transcribe(buf, mime, lang, { skipReplicate = false } = {}) {
  const errors = [];
  let list = chain();
  // Whisper has no Igbo: when an N-ATLaS server is configured, it goes first for Igbo.
  if (lang === 'ig' && list.some((p) => p.kind === 'natlas')) list = [...list.filter((p) => p.kind === 'natlas'), ...list.filter((p) => p.kind !== 'natlas')];
  for (const p of list) {
    if (skipReplicate && p.kind === 'replicate') continue;
    try {
      return await transcribeWith(p, buf, mime, lang);
    } catch (e) {
      errors.push(e.message);
    }
  }
  const e = new Error(errors.length ? 'All STT providers failed: ' + errors.join('; ') : 'No server STT configured');
  e.status = 503;
  e.fallback = 'webspeech';
  throw e;
}

// Whisper-family models hallucinate on silence. Drop the usual phantom lines.
const HALLUCINATIONS = /^(thank you\.?|thanks for watching!?|you|\.|bye\.?|subtitles by .*|\[music\]|\[silence\])$/i;
function clean(text) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  return HALLUCINATIONS.test(t) ? '' : t;
}

module.exports = { status, transcribe, clean, LANG_MODELS, replicateInput, replicateText, replicateOn, WHISPER_LANG };
