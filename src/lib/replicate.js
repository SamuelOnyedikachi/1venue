/**
 * Generic Replicate prediction runner. Creates a prediction with a short "Prefer: wait",
 * then polls the same id until it finishes. Retries are cost-safe: a 429 or a failed
 * create may start a new prediction; a timeout or 5xx after an id exists only polls
 * that id. Giving up POSTs /v1/predictions/{id}/cancel. Errors are labeled by status
 * (only 429 is "busy"). Logs prediction id and status for audit.
 */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function fail(status, message, detail, extra) {
  const e = new Error(message);
  e.status = status;
  if (detail) e.detail = String(detail).slice(0, 400);
  if (extra) Object.assign(e, extra);
  return e;
}

function messageFor(status) {
  if (status === 429) return 'Replicate is busy, try again in a moment';
  if (status === 401 || status === 403) return 'The AI service rejected the API token. Check REPLICATE_API_TOKEN.';
  if (status === 402) return 'The AI service needs billing credit on Replicate.';
  if (status === 404 || status === 422) return 'The AI model could not be run. Check the model id and try again.';
  if (status === 408 || status === 504) return 'That took too long, try again';
  return 'The AI service could not do that right now';
}

function parseRetryAfter(res, body) {
  const raw = (res && res.headers && (res.headers.get('retry-after') || res.headers.get('Retry-After')))
    || (body && (body.retry_after || body.retryAfter));
  if (raw == null || raw === '') return null;
  const n = Number(raw);
  if (Number.isFinite(n) && n >= 0) return Math.min(20, n) * 1000;
  const at = Date.parse(raw);
  if (Number.isFinite(at)) return Math.min(20_000, Math.max(0, at - Date.now()));
  return null;
}

async function fetchJson(url, opts, what, tag, signal) {
  let res;
  try { res = await fetch(url, { ...opts, signal }); }
  catch (e) { throw fail(e.name === 'AbortError' ? 504 : 502, e.name === 'AbortError' ? 'That took too long, try again' : `Could not reach Replicate (${what})`); }
  let body = null;
  try { body = await res.json(); } catch { /* not JSON */ }
  const id = body && body.id;
  const st = body && body.status;
  if (id) console.error(`[${tag}] prediction ${id} ${st || `http ${res.status}`} (${what})`);
  if (!res.ok) {
    const detail = body && (body.detail || body.error || body.title || body.message);
    const hint = res.status === 401 || res.status === 403 ? ' (token rejected: check REPLICATE_API_TOKEN)'
      : res.status === 402 ? ' (billing: add credit on Replicate)'
      : res.status === 404 || res.status === 422 ? ' (model or input rejected)'
      : '';
    console.error(`[${tag}] Replicate ${what} ${res.status}${hint}${id ? ` id=${id}` : ''}`, detail || '');
    const mapped = res.status === 429 ? 429 : (res.status === 404 || res.status === 422 ? res.status : (res.status === 401 || res.status === 403 || res.status === 402 ? res.status : (res.status === 408 || res.status === 504 ? 504 : 502)));
    throw fail(mapped, messageFor(res.status), `Replicate ${what} ${res.status}${detail ? `: ${detail}` : ''}`, {
      predictionId: id || null,
      prediction: body && body.id ? body : null,
      retryAfterMs: parseRetryAfter(res, body),
    });
  }
  return body;
}

async function cancel({ token, apiBase = 'https://api.replicate.com/v1', id, tag = 'replicate' }) {
  if (!token || !id) return false;
  const base = String(apiBase).replace(/\/+$/, '');
  try {
    const res = await fetch(`${base}/predictions/${encodeURIComponent(id)}/cancel`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    });
    console.error(`[${tag}] cancel prediction ${id} -> ${res.status}`);
    return res.ok || res.status === 404;
  } catch (e) {
    console.error(`[${tag}] cancel prediction ${id} failed`, e.message);
    return false;
  }
}

/**
 * run({ token, apiBase, model, input, timeoutMs, tag, wait, retries }) -> { output, id, metrics }
 * wait is the Prefer: wait cap in seconds (short, then poll the same id).
 */
async function run({ token, apiBase = 'https://api.replicate.com/v1', model, input, timeoutMs = 25_000, tag = 'replicate', wait = 10, retries = 3 }) {
  if (!token) throw fail(503, 'REPLICATE_API_TOKEN is not set');
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  const [ref, version] = String(model).split(':');
  const base = apiBase.replace(/\/+$/, '');
  const url = version ? `${base}/predictions` : `${base}/models/${ref}/predictions`;
  const payload = version ? { version, input } : { input };
  const deadline = Date.now() + Math.max(3_000, timeoutMs);
  const remain = () => Math.max(0, deadline - Date.now());
  let pred = null;

  const createOnce = async () => {
    const waitSec = Math.max(1, Math.min(15, Math.ceil(Math.min(wait, remain() / 1000) || 1)));
    const ctrl = new AbortController();
    // Let Prefer: wait return an id before we abort; then poll.
    const timer = setTimeout(() => ctrl.abort(), Math.min(remain(), (waitSec + 2) * 1000));
    try {
      return await fetchJson(url, {
        method: 'POST',
        headers: { ...headers, Prefer: `wait=${waitSec}` },
        body: JSON.stringify(payload),
      }, 'create', tag, ctrl.signal);
    } finally {
      clearTimeout(timer);
    }
  };

  const maxCreates = Math.max(1, Math.min(4, (retries | 0) + 1));
  for (let attempt = 0; attempt < maxCreates; attempt++) {
    if (remain() <= 0) throw fail(504, 'That took too long, try again');
    try {
      pred = await createOnce();
      if (pred && pred.id) break;
    } catch (e) {
      if (e.prediction && e.prediction.id) { pred = e.prediction; break; }
      const canRetry = (e.status === 429 || e.status === 502 || e.status === 504 || !e.status) && attempt < maxCreates - 1;
      // Only a 429 or a create that never minted an id starts a new paid prediction.
      if (canRetry && !e.predictionId) {
        const backoff = e.retryAfterMs != null ? e.retryAfterMs : Math.min(8_000, 400 * (2 ** attempt));
        console.error(`[${tag}] create retry ${attempt + 1}/${maxCreates - 1} in ${backoff}ms (${e.status || e.message})`);
        await sleep(Math.min(remain(), backoff));
        continue;
      }
      throw e;
    }
  }
  if (!pred || !pred.id) throw fail(502, 'The AI service could not do that right now', 'create returned no prediction id');

  const getUrl = (p) => (p.urls && p.urls.get) || `${base}/predictions/${encodeURIComponent(p.id)}`;

  while (pred && ['starting', 'processing'].includes(pred.status)) {
    if (remain() <= 0) {
      await cancel({ token, apiBase: base, id: pred.id, tag });
      throw fail(504, 'That took too long, try again', `prediction ${pred.id} ${pred.status}`, { predictionId: pred.id });
    }
    await sleep(Math.min(800, remain()));
    try {
      pred = await fetchJson(getUrl(pred), { headers }, 'poll', tag);
    } catch (e) {
      if (e.prediction && e.prediction.id === pred.id) { pred = e.prediction; continue; }
      if (e.status === 429 || e.status === 502 || e.status === 504) {
        const backoff = e.retryAfterMs != null ? e.retryAfterMs : 500;
        console.error(`[${tag}] poll ${pred.id} ${e.status}, retrying same id in ${backoff}ms`);
        await sleep(Math.min(remain(), backoff));
        continue;
      }
      await cancel({ token, apiBase: base, id: pred.id, tag });
      throw e;
    }
  }

  if (!pred || pred.status !== 'succeeded') {
    console.error(`[${tag}] prediction ${pred && pred.id} ${pred && pred.status}`, pred && pred.error);
    if (pred && pred.id && pred.status && !['succeeded', 'failed', 'canceled', 'cancelled'].includes(pred.status)) {
      await cancel({ token, apiBase: base, id: pred.id, tag });
    }
    const st = pred && pred.status;
    const err = pred && pred.error;
    throw fail(502, 'The AI service could not do that right now', `prediction ${pred && pred.id} ${st}${err ? `: ${err}` : ''}`, { predictionId: pred && pred.id });
  }
  console.error(`[${tag}] prediction ${pred.id} succeeded`);
  return { output: pred.output, id: pred.id, metrics: pred.metrics || {} };
}

/** Download a Replicate output file (URL) with a size cap. */
async function download(url, maxBytes = 10 * 1048576) {
  if (typeof url !== 'string' || !/^https?:\/\//.test(url)) throw fail(502, 'The AI service returned no file');
  let res;
  try { res = await fetch(url); } catch { throw fail(502, 'Could not download the result'); }
  if (!res.ok) throw fail(502, 'Could not download the result');
  const buf = Buffer.from(await res.arrayBuffer());
  if (!buf.length || buf.length > maxBytes) throw fail(502, 'The AI service returned an unusable file');
  return { buf, mime: (res.headers.get('content-type') || '').split(';')[0] || null };
}

const DEFAULT_LLM = 'meta/llama-4-scout-instruct';
const DEPRECATED_LLMS = new Set([
  'meta/meta-llama-3-70b-instruct',
  'meta/llama-3-70b-instruct',
  'meta/meta-llama-3-8b-instruct',
  'meta/llama-3-8b-instruct',
]);

function resolveLlm(model) {
  const m = String(model || '').trim();
  if (!m || DEPRECATED_LLMS.has(m)) {
    if (m) console.warn(`[ai] ${m} is retired or unreliable on Replicate; using ${DEFAULT_LLM}`);
    return DEFAULT_LLM;
  }
  return m;
}

/** Chat-style input accepted by Meta Llama instruct models on Replicate (3 and 4). */
function llmInput({ prompt, system, maxTokens = 400, temperature = 0.4 } = {}) {
  return {
    prompt: String(prompt || ''),
    system_prompt: String(system || ''),
    max_tokens: Math.max(16, Math.min(2048, Number(maxTokens) || 400)),
    temperature: Number(temperature) || 0,
  };
}

function llmText(output) {
  if (output == null) return '';
  if (typeof output === 'string') return output;
  if (Array.isArray(output)) return output.join('');
  if (typeof output === 'object') {
    if (typeof output.text === 'string') return output.text;
    if (typeof output.output === 'string') return output.output;
  }
  return String(output);
}

module.exports = { run, download, cancel, fail, messageFor, resolveLlm, llmInput, llmText, DEFAULT_LLM, DEPRECATED_LLMS };
