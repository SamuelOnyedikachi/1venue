/**
 * Generic Replicate prediction runner (speech-to-text, image covers). Creates a prediction with
 * "Prefer: wait", polls while it is still running, and returns the prediction output as-is.
 * Official models: POST /v1/models/{owner}/{name}/predictions. Pinned "owner/name:version"
 * (community models): POST /v1/predictions { version }.
 * The token stays server-side; error messages never include it.
 */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function fail(status, message, detail) { const e = new Error(message); e.status = status; if (detail) e.detail = String(detail).slice(0, 300); return e; }

async function fetchJson(url, opts, what, tag, signal) {
  let res;
  try { res = await fetch(url, { ...opts, signal }); } catch (e) { throw fail(e.name === 'AbortError' ? 504 : 502, `Could not reach Replicate (${what})`); }
  let body = null;
  try { body = await res.json(); } catch { /* not JSON */ }
  if (!res.ok) {
    const detail = body && (body.detail || body.error || body.title);
    console.error(`[${tag}] Replicate ${what} ${res.status}${res.status === 401 || res.status === 403 ? ' (token rejected: check REPLICATE_API_TOKEN)' : res.status === 402 ? ' (billing: add credit on Replicate)' : ''}`, detail || '');
    throw fail(res.status === 429 ? 429 : 502, res.status === 429 ? 'Replicate is busy, try again in a moment' : 'The AI service could not do that right now', `Replicate ${what} ${res.status}`);
  }
  return body;
}

/**
 * run({ token, apiBase, model, input, timeoutMs, tag }) -> { output, id, metrics }
 */
async function run({ token, apiBase = 'https://api.replicate.com/v1', model, input, timeoutMs = 60_000, tag = 'replicate', wait = 60 }) {
  if (!token) throw fail(503, 'REPLICATE_API_TOKEN is not set');
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  const [ref, version] = String(model).split(':');
  const base = apiBase.replace(/\/+$/, '');
  const url = version ? `${base}/predictions` : `${base}/models/${ref}/predictions`;
  const body = version ? { version, input } : { input };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const deadline = Date.now() + timeoutMs;
  try {
    let pred = await fetchJson(url, { method: 'POST', headers: { ...headers, Prefer: `wait=${Math.max(1, Math.min(60, Math.ceil(wait)))}` }, body: JSON.stringify(body) }, 'create', tag, ctrl.signal);
    while (pred && ['starting', 'processing'].includes(pred.status)) {
      if (Date.now() > deadline) throw fail(504, 'That took too long, try again');
      await sleep(400);
      const getUrl = pred.urls && pred.urls.get;
      if (!getUrl) break;
      pred = await fetchJson(getUrl, { headers }, 'poll', tag, ctrl.signal);
    }
    if (!pred || pred.status !== 'succeeded') {
      console.error(`[${tag}] prediction`, pred && pred.id, pred && pred.status, pred && pred.error);
      throw fail(502, 'The AI service could not do that right now', `prediction ${pred && pred.status}`);
    }
    return { output: pred.output, id: pred.id, metrics: pred.metrics || {} };
  } finally {
    clearTimeout(timer);
  }
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

module.exports = { run, download };
