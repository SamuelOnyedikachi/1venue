// Safe text for the UI: never show null / undefined / [object Object] / raw JSON / code fences.
// Same rules as src/lib/safe-text.js (server). Use safeText() for any value that came from the API.
const JUNK = /^(null|undefined|nan|none|n\/a|\[object \w+\]|\{\s*\}|\[\s*\]|""|'')$/i;
function fromObject(v) {
  for (const k of ['text', 'point', 'summary', 'value', 'content', 'title', 'name', 'item', 'description']) if (typeof v[k] === 'string') return v[k];
  return Object.values(v).filter((x) => typeof x === 'string' || typeof x === 'number').join(' - ');
}
export function safeText(v, max = 4000) {
  if (v == null || v === false) return '';
  if (Array.isArray(v)) return safeList(v).join('\n').slice(0, max);
  if (typeof v === 'object') v = fromObject(v);
  let s = String(v)
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .replace(/```[a-z0-9_-]*\s*/gi, '').replace(/```/g, '')
    .replace(/\[object \w+\]/g, '')
    .replace(/(^|[\s.,;:])(?:null|undefined|NaN)[ \t]*$/gm, '$1')
    .replace(/^\s*(json|javascript|js)\s*$/gim, '')
    .replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').replace(/[ \t]{2,}/g, ' ').trim();
  if (/^[[{][\s\S]*[\]}]$/.test(s)) { try { const p = JSON.parse(s); return safeText(Array.isArray(p) ? p : p && typeof p === 'object' ? fromObject(p) : p, max); } catch { /* not JSON */ } }
  return JUNK.test(s) ? '' : s.slice(0, max);
}
export const safeList = (v, limit = 20) => (Array.isArray(v) ? v : v == null ? [] : [v]).map((x) => safeText(x, 400)).filter(Boolean).slice(0, limit);
/** Element.append / replaceChildren print "null" for null kids; this drops empty ones. */
export function put(el, ...kids) { el.replaceChildren(...kids.flat(Infinity).filter((k) => k != null && k !== false && k !== '')); return el; }
export function add(el, ...kids) { el.append(...kids.flat(Infinity).filter((k) => k != null && k !== false && k !== '')); return el; }
