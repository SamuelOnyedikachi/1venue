'use strict';
// "Continue with Apple" against a mock Apple (authorize URL, token endpoint, JWKS).
// Checks form_post callback, state + nonce, ES256 client secret, ID-token verification, first-time
// name, private relay email, linking by email, and that the button is hidden when unconfigured.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const jwt = require('jsonwebtoken');
const { boot, client, signupPayload } = require('./helpers/server');

const skip = !process.env.DATABASE_URL ? 'set DATABASE_URL' : false;
const uid = () => 'a' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const CLIENT_ID = 'live.1venue.signin';
const TEAM = 'TEAM123456';
const KID = 'KEY1234567';
const ISS = 'https://appleid.apple.com';

async function mockApple() {
  const signing = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const p8 = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = { ...signing.publicKey.export({ format: 'jwk' }), kid: 'apple-k1', alg: 'RS256', use: 'sig' };
  const codes = new Map();
  const calls = [];
  const srv = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://x');
    let raw = ''; for await (const c of req) raw += c;
    calls.push({ path: u.pathname, body: raw });
    const json = (s, b) => { res.writeHead(s, { 'content-type': 'application/json' }); res.end(JSON.stringify(b)); };
    if (u.pathname === '/auth/keys') return json(200, { keys: [jwk] });
    if (u.pathname === '/auth/token' && req.method === 'POST') {
      const p = new URLSearchParams(raw);
      const entry = codes.get(p.get('code'));
      let secretOk = false;
      try {
        const head = jwt.decode(p.get('client_secret'), { complete: true }).header;
        const c = jwt.verify(p.get('client_secret'), p8.publicKey, { algorithms: ['ES256'], audience: ISS, issuer: TEAM, subject: CLIENT_ID });
        secretOk = head.kid === KID && c.exp - c.iat <= 300;
      } catch (_) { secretOk = false; }
      if (!secretOk || p.get('client_id') !== CLIENT_ID) return json(400, { error: 'invalid_client' });
      if (!entry || p.get('grant_type') !== 'authorization_code' || p.get('redirect_uri') !== entry.redirectUri) return json(400, { error: 'invalid_grant' });
      codes.delete(p.get('code'));
      const now = Math.floor(Date.now() / 1000);
      const claims = { iss: ISS, aud: entry.aud || CLIENT_ID, iat: now, exp: now + 600, nonce: entry.nonce, email_verified: 'true', ...entry.claims };
      return json(200, { access_token: 'a', token_type: 'Bearer', expires_in: 3600, id_token: jwt.sign(claims, signing.privateKey, { algorithm: 'RS256', keyid: 'apple-k1' }) });
    }
    json(404, { error: 'not found' });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  // one line with \n escapes, the way it is pasted into Coolify
  const pem = p8.privateKey.export({ format: 'pem', type: 'pkcs8' }).trim().replace(/\n/g, '\\n');
  return {
    srv, codes, calls,
    env: { APPLE_CLIENT_ID: CLIENT_ID, APPLE_TEAM_ID: TEAM, APPLE_KEY_ID: KID, APPLE_PRIVATE_KEY: pem, APPLE_ISSUER: ISS, APPLE_AUTH_URL: base + '/auth/authorize', APPLE_TOKEN_URL: base + '/auth/token', APPLE_JWKS_URL: base + '/auth/keys' },
  };
}

/** /auth/apple/start -> (mock consent) -> POST /auth/apple/callback (form_post). */
async function signInWithApple(s, a, claims, { next = '/dashboard', user, tamper = {} } = {}) {
  const c = client(s.base);
  const start = await c.get('/auth/apple/start?next=' + encodeURIComponent(next));
  assert.equal(start.status, 302);
  const auth = new URL(start.res.headers.get('location'));
  const q = auth.searchParams;
  const code = 'c-' + uid();
  a.codes.set(code, { claims, redirectUri: q.get('redirect_uri'), nonce: tamper.nonce || q.get('nonce'), aud: tamper.aud });
  const form = new URLSearchParams({ code, state: tamper.state || q.get('state'), ...(user ? { user: JSON.stringify(user) } : {}) });
  const cb = await fetch(s.base + '/auth/apple/callback', { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: tamper.dropCookie ? '' : c.jar.header() }, body: form.toString() });
  c.jar.take(cb);
  return { c, start, auth, cb, location: cb.headers.get('location') };
}

test('Apple sign-in is hidden and refused when not configured', { skip }, async () => {
  const s = await boot({ APPLE_CLIENT_ID: '', APPLE_TEAM_ID: '', APPLE_KEY_ID: '', APPLE_PRIVATE_KEY: '' });
  try {
    assert.equal((await client(s.base).get('/api/config')).body.auth.apple, false);
    const r = await client(s.base).get('/auth/apple/start');
    assert.equal(r.status, 303); assert.equal(r.res.headers.get('location'), '/login?error=apple-off');
  } finally { await s.stop(); }
});

test('Apple sign-in: form_post flow, ES256 secret, new user with name, relay email, linking, tampering', { skip }, async () => {
  const a = await mockApple();
  const s = await boot(a.env);
  const db = require('../db');
  try {
    assert.equal((await client(s.base).get('/api/config')).body.auth.apple, true);

    // new user, "Hide My Email": name comes from the first-time `user` field
    const relay = `${uid()}@privaterelay.appleid.com`;
    const sub = '001234.' + uid();
    const f = await signInWithApple(s, a, { sub, email: relay, is_private_email: 'true' }, { next: '/e/demo', user: { name: { firstName: 'Chiamaka', lastName: 'Eze' }, email: relay } });
    const q = f.auth.searchParams;
    assert.equal(q.get('client_id'), CLIENT_ID);
    assert.equal(q.get('response_type'), 'code');
    assert.equal(q.get('response_mode'), 'form_post');
    assert.equal(q.get('scope'), 'name email');
    assert.equal(q.get('redirect_uri'), s.base + '/auth/apple/callback');
    assert.ok(q.get('state').length >= 40 && q.get('nonce').length >= 40);
    const flow = f.start.res.headers.getSetCookie().find((x) => x.startsWith('1v_apple='));
    assert.match(flow, /HttpOnly/); assert.match(flow, /Max-Age=600/);
    assert.equal(f.cb.status, 303); assert.equal(f.location, '/e/demo');
    const me = (await f.c.get('/api/session')).body.user;
    assert.equal(me.email, relay); assert.equal(me.emailVerified, true); assert.equal(me.hasPassword, false);
    assert.equal(me.displayName, 'Chiamaka Eze');
    assert.match(me.username, /^chiamaka/, 'username from the first name, not the relay address');
    assert.deepEqual((await db.q('SELECT provider, subject FROM oauth_identities WHERE user_id = $1', [me.id])).rows, [{ provider: 'apple', subject: sub }]);
    assert.ok(await s.mailLink(relay, /Welcome/) !== null);

    // returning user: no `user` field and no email in the token, still the same account
    const again = await signInWithApple(s, a, { sub });
    assert.equal((await again.c.get('/api/session')).body.user.id, me.id);
    assert.equal((await again.c.get('/api/session')).body.user.displayName, 'Chiamaka Eze');

    // existing verified local account with the same email: linked, password kept
    const le = `${uid()}@ex.test`;
    await client(s.base).post('/api/signup', signupPayload({ email: le, password: 'local password 1' }));
    await db.q('UPDATE users SET email_verified_at = NOW() WHERE email = $1', [le]);
    const lk = await signInWithApple(s, a, { sub: '001.' + uid(), email: le });
    const lu = (await lk.c.get('/api/session')).body.user;
    assert.equal(lu.email, le); assert.equal(lu.hasPassword, true);
    const acc = (await lk.c.get('/api/auth/account')).body;
    assert.equal(acc.apple, true);
    assert.ok(acc.identities.some((i) => i.provider === 'apple'));

    // tampering: wrong state, missing cookie, wrong nonce, wrong audience, user cancelled
    assert.equal((await signInWithApple(s, a, { sub: 'x.' + uid(), email: `${uid()}@ex.test` }, { tamper: { state: 'nope' } })).location, '/login?error=apple-state');
    assert.equal((await signInWithApple(s, a, { sub: 'x.' + uid(), email: `${uid()}@ex.test` }, { tamper: { dropCookie: true } })).location, '/login?error=apple-expired');
    assert.equal((await signInWithApple(s, a, { sub: 'x.' + uid(), email: `${uid()}@ex.test` }, { tamper: { nonce: 'other' } })).location, '/login?error=apple');
    assert.equal((await signInWithApple(s, a, { sub: 'x.' + uid(), email: `${uid()}@ex.test` }, { tamper: { aud: 'someone.else' } })).location, '/login?error=apple');
    const cancel = await fetch(s.base + '/auth/apple/callback', { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'error=user_cancelled_authorize&state=x' });
    assert.equal(cancel.headers.get('location'), '/login?error=apple-cancelled');

    // open redirect is not possible
    assert.equal((await signInWithApple(s, a, { sub: 'x.' + uid(), email: `${uid()}@ex.test` }, { next: '//evil.example/' })).location, '/dashboard');
  } finally { await s.stop(); a.srv.close(); await db.close().catch(() => {}); }
});

test('Apple client secret: ES256, 5 minutes, accepts a bare base64 key', () => {
  const p8 = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const body = p8.privateKey.export({ format: 'pem', type: 'pkcs8' }).replace(/-----[^-]+-----|\s/g, '');
  const config = require('../src/config');
  const saved = { ...config.AUTH.apple };
  Object.assign(config.AUTH.apple, { clientId: CLIENT_ID, teamId: TEAM, keyId: KID, privateKey: body, issuer: ISS });
  try {
    const apple = require('../src/features/auth/apple');
    const secret = apple.clientSecret();
    const { header, payload } = jwt.decode(secret, { complete: true });
    assert.equal(header.alg, 'ES256'); assert.equal(header.kid, KID);
    assert.equal(payload.iss, TEAM); assert.equal(payload.sub, CLIENT_ID); assert.equal(payload.aud, ISS);
    assert.equal(payload.exp - payload.iat, 300);
    jwt.verify(secret, p8.publicKey, { algorithms: ['ES256'] });
    assert.deepEqual(apple.parseUserField('{"name":{"firstName":"Ada","lastName":"Obi"}}'), { givenName: 'Ada', name: 'Ada Obi' });
    assert.deepEqual(apple.parseUserField('not json'), { givenName: null, name: null });
  } finally { Object.assign(config.AUTH.apple, saved); }
});
