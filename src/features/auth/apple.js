/**
 * "Continue with Apple": Sign in with Apple for the web (OAuth 2 / OpenID Connect).
 *   authorize  https://appleid.apple.com/auth/authorize   response_type=code, response_mode=form_post,
 *              scope "name email", state + nonce. Apple POSTs the result back to
 *              ${PUBLIC_URL}/auth/apple/callback (a cross-site form POST).
 *   token      https://appleid.apple.com/auth/token        client_secret is a short-lived ES256 JWT
 *              signed here with the .p8 key (kid = APPLE_KEY_ID, iss = team, sub = Services ID).
 *   keys       https://appleid.apple.com/auth/keys         ID token verified locally: RS256 against
 *              Apple's JWKS, iss, aud (Services ID), exp, nonce.
 * The user's name is only sent on the very first authorisation (in the form's "user" field), so it
 * is saved then. Emails may be Apple private-relay addresses (...@privaterelay.appleid.com).
 * See docs/APPLE_SIGNIN.md.
 */
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const config = require('../../config');

const A = () => config.AUTH.apple;
const enabled = () => !!(A().clientId && A().teamId && A().keyId && A().privateKey);

let jwks = null; // { keys: Map(kid -> KeyObject), exp, fetchedAt }

/** PEM from the env value: full .p8 contents, or just the base64 body. */
function pem() {
  const k = A().privateKey.replace(/^["']|["']$/g, '').trim();
  if (k.includes('BEGIN')) return k;
  const body = k.replace(/\s+/g, '');
  return `-----BEGIN PRIVATE KEY-----\n${body.match(/.{1,64}/g).join('\n')}\n-----END PRIVATE KEY-----`;
}

/** The client_secret Apple expects: ES256 JWT, valid 5 minutes. */
function clientSecret(now = Math.floor(Date.now() / 1000)) {
  return jwt.sign({ iss: A().teamId, iat: now, exp: now + 300, aud: A().issuer, sub: A().clientId },
    pem(), { algorithm: 'ES256', keyid: A().keyId });
}

async function getJson(url, init) {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(10000) });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) { const e = new Error(`Apple ${res.status}: ${body.error || 'request failed'}`); e.status = 502; throw e; }
  return { res, body };
}
async function keyFor(kid) {
  const fresh = jwks && jwks.exp > Date.now();
  if (fresh && jwks.keys.has(kid)) return jwks.keys.get(kid);
  if (!fresh || Date.now() - jwks.fetchedAt > 60_000) {
    const { body } = await getJson(A().jwksUrl);
    const keys = new Map();
    for (const k of body.keys || []) {
      if (k.kty !== 'RSA' || !k.kid) continue;
      try { keys.set(k.kid, crypto.createPublicKey({ key: k, format: 'jwk' })); } catch (_) { /* skip */ }
    }
    jwks = { keys, exp: Date.now() + 3600_000, fetchedAt: Date.now() };
  }
  return jwks.keys.get(kid) || null;
}

const random = (n = 32) => crypto.randomBytes(n).toString('base64url');

function authUrl({ redirectUri }) {
  const state = random();
  const nonce = random();
  const u = new URL(A().authUrl);
  u.search = new URLSearchParams({
    client_id: A().clientId, redirect_uri: redirectUri, response_type: 'code', response_mode: 'form_post',
    scope: 'name email', state, nonce,
  }).toString();
  return { url: u.toString(), state, nonce };
}

async function finish({ code, nonce, redirectUri }) {
  const { body } = await getJson(A().tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams({ client_id: A().clientId, client_secret: clientSecret(), code, grant_type: 'authorization_code', redirect_uri: redirectUri }).toString(),
  });
  if (!body.id_token) throw new Error('Apple did not return an ID token');
  return verifyIdToken(body.id_token, { nonce });
}

async function verifyIdToken(idToken, { nonce }) {
  const head = jwt.decode(idToken, { complete: true });
  if (!head || !head.header || head.header.alg !== 'RS256' || !head.header.kid) throw new Error('Unexpected ID token format');
  const key = await keyFor(head.header.kid);
  if (!key) throw new Error('ID token signed with an unknown key');
  const claims = jwt.verify(idToken, key, { algorithms: ['RS256'], audience: A().clientId, issuer: A().issuer, clockTolerance: 60 });
  if (!nonce || claims.nonce !== nonce) throw new Error('ID token nonce mismatch');
  if (!claims.sub) throw new Error('ID token has no subject');
  if (claims.email && !(claims.email_verified === true || claims.email_verified === 'true')) { const e = new Error('Your Apple email address is not verified'); e.expose = true; throw e; }
  return { ...claims, isPrivateEmail: claims.is_private_email === true || claims.is_private_email === 'true' };
}

/** The "user" form field (first sign-in only): {"name":{"firstName","lastName"},"email"}. */
function parseUserField(raw) {
  try {
    const u = JSON.parse(String(raw || '').slice(0, 2000));
    const first = String(u?.name?.firstName || '').trim().slice(0, 40);
    const last = String(u?.name?.lastName || '').trim().slice(0, 40);
    return { givenName: first || null, name: [first, last].filter(Boolean).join(' ') || null };
  } catch (_) { return { givenName: null, name: null }; }
}

module.exports = { enabled, authUrl, finish, verifyIdToken, clientSecret, parseUserField, _reset: () => { jwks = null; } };
