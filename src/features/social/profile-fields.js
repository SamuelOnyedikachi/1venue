/**
 * Normalise public profile fields: location, website, and social handles/URLs.
 * Only https URLs (http is upgraded) or network handles are accepted. Output is
 * safe to store and to render as hrefs.
 */
const SOCIAL_KEYS = ['x', 'instagram', 'linkedin', 'tiktok', 'youtube'];
const SOCIAL_HOSTS = {
  x: /^(www\.)?(x\.com|twitter\.com)$/i,
  instagram: /^(www\.)?instagram\.com$/i,
  linkedin: /^(www\.)?linkedin\.com$/i,
  tiktok: /^(www\.)?tiktok\.com$/i,
  youtube: /^(www\.)?(youtube\.com|youtu\.be)$/i,
};
const SOCIAL_PREFIX = {
  x: 'https://x.com/',
  instagram: 'https://www.instagram.com/',
  linkedin: 'https://www.linkedin.com/in/',
  tiktok: 'https://www.tiktok.com/@',
  youtube: 'https://www.youtube.com/@',
};
const HANDLE_RE = /^[A-Za-z0-9._]{1,30}$/;
const YT_HANDLE_RE = /^[A-Za-z0-9._-]{1,60}$/;
const LINKEDIN_PATH_RE = /^\/(in|company|school)\/[A-Za-z0-9._%+-]+\/?$/i;

function bad(msg) { const e = new Error(msg); e.status = 400; e.expose = true; throw e; }

function cleanText(v, max) {
  return String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

function isBlockedHost(host) {
  const h = String(host || '').replace(/^\[|\]$/g, '').toLowerCase();
  if (!h || h === 'localhost' || h.endsWith('.localhost')) return true;
  if (h === '::1' || h === '0.0.0.0') return true;
  if (/^(127|10|0)\./.test(h) || /^192\.168\./.test(h) || /^172\.(1[6-9]|2\d|3[0-1])\./.test(h)) return true;
  if (!/^[a-z0-9.-]+$/i.test(h) || h.includes('..') || !h.includes('.')) return true;
  return false;
}

function hrefOf(u, max) {
  if (u.pathname.length > 1 && u.pathname.endsWith('/')) u.pathname = u.pathname.slice(0, -1);
  const s = u.toString();
  return (u.pathname === '/' && !u.search ? s.replace(/\/$/, '') : s).slice(0, max);
}
function parseHttps(raw, max = 200) {
  const s = cleanText(raw, max);
  if (!s) return null;
  let input = s;
  if (!/^[a-z][a-z0-9+.-]*:/i.test(input)) input = 'https://' + input;
  let u;
  try { u = new URL(input); } catch { bad('Enter a valid website address'); }
  if (u.protocol === 'http:') u.protocol = 'https:';
  if (u.protocol !== 'https:') bad('Only https links are allowed');
  if (u.username || u.password) bad('Enter a valid website address');
  if (isBlockedHost(u.hostname)) bad('Enter a valid website address');
  u.hash = '';
  return hrefOf(u, max);
}

function normalizeWebsite(raw) {
  return parseHttps(raw, 200);
}

function normalizeLocation(raw) {
  const s = cleanText(raw, 80);
  return s || null;
}

function asHandle(raw, re = HANDLE_RE) {
  const s = cleanText(raw, 80).replace(/^@/, '');
  if (!s || !re.test(s)) return null;
  return s;
}

function normalizeSocial(kind, raw) {
  if (!SOCIAL_KEYS.includes(kind)) bad('Unknown social network');
  const s = cleanText(raw, 200);
  if (!s) return null;
  if (/^[a-z][a-z0-9+.-]*:/i.test(s) || s.includes('/') || s.includes('.')) {
    // URL path (possibly missing scheme)
    const u = new URL(parseHttps(s, 200));
    if (!SOCIAL_HOSTS[kind].test(u.hostname)) bad(`That does not look like a ${kind} link`);
    if (kind === 'linkedin' && !LINKEDIN_PATH_RE.test(u.pathname)) bad('Use a LinkedIn profile or company URL');
    if (kind === 'youtube' && !/^\/(?:@|channel\/|c\/|user\/)[A-Za-z0-9._-]+\/?$/.test(u.pathname)) {
      bad('Use a YouTube channel or handle URL');
    }
    if (kind === 'x') u.hostname = 'x.com';
    u.hash = '';
    u.search = '';
    return hrefOf(u, 200);
  }
  if (kind === 'linkedin') {
    const handle = asHandle(s);
    if (!handle) bad('Enter a LinkedIn profile URL or handle');
    return SOCIAL_PREFIX.linkedin + handle;
  }
  if (kind === 'youtube') {
    const handle = asHandle(s, YT_HANDLE_RE);
    if (!handle) bad('Enter a YouTube handle or channel URL');
    return SOCIAL_PREFIX.youtube + handle;
  }
  if (kind === 'tiktok') {
    const handle = asHandle(s);
    if (!handle) bad('Enter a TikTok handle or URL');
    return SOCIAL_PREFIX.tiktok + handle;
  }
  const handle = asHandle(s);
  if (!handle) bad(`Enter a ${kind} handle or URL`);
  return SOCIAL_PREFIX[kind] + handle;
}

function normalizeSocials(input) {
  if (input == null) return null;
  if (typeof input !== 'object' || Array.isArray(input)) bad('Social links must be an object');
  const out = {};
  for (const k of SOCIAL_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(input, k)) continue;
    const v = normalizeSocial(k, input[k]);
    if (v) out[k] = v;
  }
  return out;
}

function socialsOut(value) {
  if (!value) return {};
  let v = value;
  if (typeof v === 'string') { try { v = JSON.parse(v); } catch { return {}; } }
  if (!v || typeof v !== 'object' || Array.isArray(v)) return {};
  const out = {};
  for (const k of SOCIAL_KEYS) {
    if (typeof v[k] === 'string' && /^https:\/\//i.test(v[k])) out[k] = v[k];
  }
  return out;
}

/** Pull only the provided profile fields out of a PATCH body. */
function normalizeProfilePatch(body = {}) {
  const out = {};
  if (body.displayName != null || body.display_name != null) {
    const s = cleanText(body.displayName != null ? body.displayName : body.display_name, 80);
    out.displayName = s || null;
  }
  if (body.bio != null) out.bio = cleanText(body.bio, 500);
  if (body.handle != null) out.handle = body.handle;
  if (body.avatarUrl != null || body.avatar_url != null) out.avatarUrl = body.avatarUrl || body.avatar_url || null;
  if (body.location !== undefined) out.location = normalizeLocation(body.location);
  if (body.website !== undefined) out.website = body.website == null || body.website === '' ? null : normalizeWebsite(body.website);
  if (body.socials !== undefined) out.socials = normalizeSocials(body.socials);
  return out;
}

module.exports = {
  SOCIAL_KEYS, SOCIAL_PREFIX,
  cleanText, normalizeWebsite, normalizeLocation, normalizeSocial, normalizeSocials,
  normalizeProfilePatch, socialsOut,
};
