/**
 * Safe text for anything shown to people (AI output, file text, user content).
 * Never lets null / undefined / "[object Object]" / raw JSON / code fences leak into the UI.
 *   cleanText(v)  -> a trimmed plain string ('' for nothing useful)
 *   cleanList(v)  -> an array of non-empty cleaned strings
 * The browser twin lives in public/js/safe-text.js (same rules, kept tiny on purpose).
 */
const JUNK = /^(null|undefined|nan|none|n\/a|\[object \w+\]|\{\s*\}|\[\s*\]|""|'')$/i;

function fromObject(v) {
  // An AI sometimes returns {"point": "..."} or {"text": "..."} instead of a string: keep the words.
  for (const k of ['text', 'point', 'summary', 'value', 'content', 'title', 'name', 'item', 'description']) if (typeof v[k] === 'string') return v[k];
  const strings = Object.values(v).filter((x) => typeof x === 'string' || typeof x === 'number');
  return strings.join(' — ');
}

function cleanText(v, { max = 4000 } = {}) {
  if (v == null || v === false) return '';
  if (Array.isArray(v)) return cleanList(v, { max }).join('\n').slice(0, max);
  if (typeof v === 'object') v = fromObject(v);
  let s = String(v);
  s = s.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .replace(/```[a-z0-9_-]*\s*/gi, '').replace(/```/g, '')         // code fences
    .replace(/\[object \w+\]/g, '')                                    // stringified objects
    .replace(/(^|[\s.,;:])(?:null|undefined|NaN)[ \t]*$/gm, '$1')   // stray null/undefined tokens
    .replace(/^\s*(json|javascript|js)\s*$/gim, '')                    // a lone language tag line
    .replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').replace(/[ \t]{2,}/g, ' ').trim();
  // A whole JSON blob that slipped through: pull out its readable strings instead of showing braces.
  if (/^[[{][\s\S]*[\]}]$/.test(s)) {
    try { const p = JSON.parse(s); return cleanText(typeof p === 'object' && p ? (Array.isArray(p) ? p : fromObject(p)) : p, { max }); } catch { /* not JSON */ }
  }
  if (JUNK.test(s)) return '';
  return s.slice(0, max);
}

function cleanList(v, { max = 400, limit = 20 } = {}) {
  const arr = Array.isArray(v) ? v : v == null ? [] : [v];
  return arr.map((x) => cleanText(x, { max })).filter(Boolean).slice(0, limit);
}

module.exports = { cleanText, cleanList };
