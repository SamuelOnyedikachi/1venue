/**
 * TTS via the shared Replicate runner (short Prefer: wait, poll the same id, cancel on give-up).
 */
const { run, download, fail } = require('../../lib/replicate');

/** Returns { audio: Buffer, mime, predictionId }. */
async function synthesize(cfg, input) {
  const r = await run({
    token: cfg.token,
    apiBase: cfg.apiBase,
    model: cfg.model,
    input,
    timeoutMs: cfg.timeoutMs || 25_000,
    tag: 'tts',
    wait: 10,
  });
  const out = Array.isArray(r.output) ? r.output[0] : r.output;
  if (typeof out !== 'string' || !/^https?:\/\//.test(out)) throw fail(502, 'The speech service returned no audio');
  const { buf, mime } = await download(out, cfg.maxAudioBytes || 20 * 1048576);
  const kind = /\.wav(\?|$)/i.test(out) || cfg.format === 'wav' || (mime && /wav/.test(mime)) ? 'audio/wav' : (mime || 'audio/mpeg');
  return { audio: buf, mime: kind, predictionId: r.id };
}

module.exports = { synthesize };
