/**
 * Google sign-in redirects (non-/api paths, so they live in a raw handler):
 *   GET /auth/google/start?next=/dashboard  -> 302 to Google
 *   GET /auth/google/callback               -> back from Google, signs in, 302 to `next`
 * Redirect URI registered in Google Cloud: ${PUBLIC_URL}/auth/google/callback
 * Sign in with Apple (see docs/APPLE_SIGNIN.md):
 *   GET  /auth/apple/start?next=/dashboard  -> 302 to Apple
 *   POST /auth/apple/callback               <- Apple's form_post (cross-site). No CSRF token is
 *        possible here; instead the signed flow cookie (SameSite=None; Secure, 10 minutes) must
 *        match the posted state, and the ID token's nonce must match the cookie's nonce.
 */
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const config = require('../../config');
const db = require('../../../db');
const auth = require('../../lib/auth');
const data = require('./data');
const google = require('./google');
const apple = require('./apple');
const mail = require('../mail/mailer');
const { rateLimit, clientIp } = require('../../lib/http');

const FLOW_COOKIE = () => (config.AUTH.cookieSecure ? '__Host-' : '') + '1v_oauth';
const APPLE_COOKIE = () => (config.AUTH.cookieSecure ? '__Host-' : '') + '1v_apple';
const FLOW_TTL = 600;

function origin(req) {
  if (config.PUBLIC_URL) return config.PUBLIC_URL;
  const proto = (config.TRUST_PROXY && req.headers['x-forwarded-proto']) || 'http';
  return `${String(proto).split(',')[0]}://${req.headers.host}`;
}
const redirectUri = (req) => origin(req) + '/auth/google/callback';
const appleRedirectUri = (req) => origin(req) + '/auth/apple/callback';
function safeNext(raw) {
  const s = String(raw || '');
  return s.startsWith('/') && !s.startsWith('//') && !s.startsWith('/\\') && s.length < 500 ? s : '/dashboard';
}
function redirect(res, to, cookies = [], status = 302) {
  const prev = res.getHeader('Set-Cookie');
  res.writeHead(status, { Location: to, 'Cache-Control': 'no-store', 'Set-Cookie': [].concat(prev || [], cookies) });
  res.end();
  return true;
}
const flowCookie = (value, maxAge) => [`${FLOW_COOKIE()}=${value}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${maxAge}`, ...(config.AUTH.cookieSecure ? ['Secure'] : [])].join('; ');
// Apple posts back cross-site, so its flow cookie must be SameSite=None (which requires Secure).
const appleCookie = (value, maxAge) => [`${APPLE_COOKIE()}=${value}`, 'Path=/', 'HttpOnly', config.AUTH.cookieSecure ? 'SameSite=None' : 'SameSite=Lax', `Max-Age=${maxAge}`, ...(config.AUTH.cookieSecure ? ['Secure'] : [])].join('; ');
const fail = (res, code) => redirect(res, `/login?error=${encodeURIComponent(code)}`, [flowCookie('', 0)]);
const appleFail = (res, code) => redirect(res, `/login?error=${encodeURIComponent(code)}`, [appleCookie('', 0)], 303);
const eq = (a, b) => { const x = Buffer.from(String(a)); const y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };

/**
 * Find or create the 1venue user for a verified external identity (Google, Apple).
 * id = { provider, sub, email, name, givenName, picture, allowSignup }. Returns { row, created } or null.
 */
async function userForIdentity(id) {
  const email = id.email ? data.normEmail(id.email) : null;
  const linked = await data.identity(id.provider, id.sub);
  if (linked) {
    await data.linkIdentity(id.provider, id.sub, linked.user_id, email || linked.email);
    if (id.name) await db.q('UPDATE users SET display_name = COALESCE(display_name, $2) WHERE id = $1', [linked.user_id, id.name]);
    return { row: await auth.userById(linked.user_id), created: false };
  }
  if (!email) return null; // nothing to link or create with
  const existing = await data.userByEmail(email);
  if (existing) {
    // Link by verified email. If the account's email was never verified, someone may have
    // registered it with a password before the real owner arrived: that password (and every
    // session made with it) is dropped. The owner can set a password later via "forgot".
    if (!existing.email_verified_at) {
      if (existing.password_hash) await db.q('UPDATE users SET password_hash = NULL, updated_at = NOW() WHERE id = $1', [existing.id]);
      await auth.revokeAllSessions(existing.id, { reason: `${id.provider}-link-unverified-email` });
    }
    await data.markVerified(existing.id);
    await db.q('UPDATE users SET needs_password_setup = false, avatar_url = COALESCE(avatar_url, $2), display_name = COALESCE(display_name, $3) WHERE id = $1',
      [existing.id, id.picture || null, id.name || null]);
    await data.linkIdentity(id.provider, id.sub, existing.id, email);
    auth.forgetUser(existing.id);
    return { row: await auth.userById(existing.id), created: false };
  }
  if (!id.allowSignup) return null;
  // Apple private-relay addresses make poor usernames ("x7f2k9..."); prefer the given name.
  const relay = /@privaterelay\.appleid\.com$/i.test(email);
  const row = await data.createUser({
    username: await data.freeUsername(id.givenName || (relay ? 'member' : email.split('@')[0])),
    email, displayName: id.name || null, avatarUrl: id.picture || null, verified: true,
  });
  await data.linkIdentity(id.provider, id.sub, row.id, email);
  try { require('../../venue/data').syncSpeakerInvites(row.id, email).catch(() => {}); } catch (_) { /* optional */ }
  return { row, created: true };
}
const userForGoogle = (claims) => userForIdentity({
  provider: 'google', sub: claims.sub, email: claims.email, name: claims.name || null, givenName: claims.given_name || null,
  picture: claims.picture || null, allowSignup: config.AUTH.google.allowSignup,
});

/** Read a small application/x-www-form-urlencoded body. */
function readForm(req, max = 16 * 1024) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (c) => { raw += c; if (raw.length > max) { reject(new Error('too large')); req.destroy(); } });
    req.on('end', () => resolve(new URLSearchParams(raw)));
    req.on('error', reject);
  });
}

async function handleApple(req, res, parsed) {
  const p = parsed.pathname;
  const start = p === '/auth/apple/start' && req.method === 'GET';
  const callback = p === '/auth/apple/callback' && (req.method === 'POST' || req.method === 'GET');
  if (!start && !callback) return false;
  if (!apple.enabled()) return appleFail(res, 'apple-off');
  if (!rateLimit('apple:' + clientIp(req), config.AUTH.ratePerMin)) return appleFail(res, 'rate');

  if (start) {
    const a = apple.authUrl({ redirectUri: appleRedirectUri(req) });
    const flow = jwt.sign({ s: a.state, n: a.nonce, next: safeNext(parsed.searchParams.get('next')) }, config.JWT_SECRET, { expiresIn: FLOW_TTL, audience: 'apple-flow' });
    return redirect(res, a.url, [appleCookie(flow, FLOW_TTL)]);
  }

  let form;
  try { form = req.method === 'POST' ? await readForm(req) : parsed.searchParams; } catch (_) { return appleFail(res, 'apple'); }
  if (form.get('error')) return appleFail(res, /cancel/i.test(form.get('error')) ? 'apple-cancelled' : 'apple');
  let flow;
  try { flow = jwt.verify(auth.parseCookies(req)[APPLE_COOKIE()] || '', config.JWT_SECRET, { audience: 'apple-flow' }); } catch (_) { return appleFail(res, 'apple-expired'); }
  if (!form.get('state') || !eq(form.get('state'), flow.s) || !form.get('code')) return appleFail(res, 'apple-state');
  try {
    const claims = await apple.finish({ code: form.get('code'), nonce: flow.n, redirectUri: appleRedirectUri(req) });
    const who = apple.parseUserField(form.get('user'));
    const r = await userForIdentity({
      provider: 'apple', sub: claims.sub, email: claims.email || null, name: who.name, givenName: who.givenName,
      allowSignup: config.AUTH.apple.allowSignup,
    });
    if (!r || !r.row) return appleFail(res, 'apple-signup-closed');
    if (r.created) {
      mail.sendLater('welcome', r.row.email, { name: r.row.display_name || r.row.username, link: origin(req) + '/' });
      require('../messages/welcome').onSignup(r.row);
    } else require('../messages/welcome').onReturn(r.row);
    await auth.startSession(req, res, r.row, { method: 'apple' });
    // 303: the browser follows with a GET, a top-level same-site navigation, so the new
    // (SameSite=Lax) session cookies are sent on it.
    return redirect(res, flow.next || '/dashboard', [appleCookie('', 0)], 303);
  } catch (e) {
    console.warn('[apple] sign-in failed:', e.message);
    return appleFail(res, /not verified/.test(e.message) ? 'apple-unverified' : 'apple');
  }
}

module.exports = async function handle(req, res, parsed) {
  const p = parsed.pathname;
  if (p.startsWith('/auth/apple/')) return handleApple(req, res, parsed);
  if (p !== '/auth/google/start' && p !== '/auth/google/callback') return false;
  if (req.method !== 'GET') return false;
  if (!google.enabled()) return fail(res, 'google-off');
  if (!rateLimit('google:' + clientIp(req), config.AUTH.ratePerMin)) return fail(res, 'rate');

  if (p === '/auth/google/start') {
    try {
      const a = await google.authUrl({ redirectUri: redirectUri(req) });
      const flow = jwt.sign({ s: a.state, n: a.nonce, v: a.verifier, next: safeNext(parsed.searchParams.get('next')) }, config.JWT_SECRET, { expiresIn: FLOW_TTL, audience: 'oauth-flow' });
      return redirect(res, a.url, [flowCookie(flow, FLOW_TTL)]);
    } catch (e) {
      console.error('[google] start failed:', e.message);
      return fail(res, 'google-unavailable');
    }
  }

  // callback
  const q = parsed.searchParams;
  if (q.get('error')) return fail(res, q.get('error') === 'access_denied' ? 'google-cancelled' : 'google');
  let flow;
  try { flow = jwt.verify(auth.parseCookies(req)[FLOW_COOKIE()] || '', config.JWT_SECRET, { audience: 'oauth-flow' }); } catch (_) { return fail(res, 'google-expired'); }
  if (!q.get('state') || !eq(q.get('state'), flow.s) || !q.get('code')) return fail(res, 'google-state');
  try {
    const claims = await google.finish({ code: q.get('code'), verifier: flow.v, nonce: flow.n, redirectUri: redirectUri(req) });
    const r = await userForGoogle(claims);
    if (!r || !r.row) return fail(res, 'google-signup-closed');
    if (r.created) {
      mail.sendLater('welcome', r.row.email, { name: r.row.display_name || r.row.username, link: origin(req) + '/' });
      require('../messages/welcome').onSignup(r.row);
    } else require('../messages/welcome').onReturn(r.row);
    await auth.startSession(req, res, r.row, { method: 'google' });
    return redirect(res, flow.next || '/dashboard', [flowCookie('', 0)]);
  } catch (e) {
    console.warn('[google] sign-in failed:', e.message);
    return fail(res, /not verified/.test(e.message) ? 'google-unverified' : 'google');
  }
};
module.exports.userForGoogle = userForGoogle;
module.exports.userForIdentity = userForIdentity;
