/**
 * Core: app config, the current session, /api/me.
 * Sign-up / sign-in / reset / Google live in src/features/auth (see docs/AUTH.md).
 * Each block answers its path and returns; unmatched requests fall through (return false).
 */
const {
  config, sendJSON, getAuthUser, publicUser, features, LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET,
} = require('./http-kit');

module.exports = async function handle(req, res, parsed) {
  const urlPath = parsed.pathname;

  if (urlPath === '/api/config' && req.method === 'GET') {
    // Auth flags are computed first so a failure in AI/STT/covers cannot hide "Continue with Google".
    const safe = (fn, fallback) => { try { return fn(); } catch (e) { console.warn('[config]', e && e.message); return fallback; } };
    const google = require('../features/auth/google');
    const apple = require('../features/auth/apple');
    const auth = {
      google: !!google.enabled(),
      apple: !!apple.enabled(),
      googleSignup: !!(google.enabled() && config.AUTH.google.allowSignup),
      allowSignup: config.ALLOW_LOCAL_SIGNUP,
      requireVerifiedEmail: config.AUTH.requireVerifiedEmail,
      passwordMin: config.AUTH.passwordMin,
    };
    return sendJSON(res, 200, {
      appName: config.APP_NAME,
      publicUrl: config.PUBLIC_URL || null,
      allowLocalSignup: config.ALLOW_LOCAL_SIGNUP,
      auth,
      livekitUrl: LIVEKIT_URL || null,
      livekitConfigured: !!(LIVEKIT_URL && LIVEKIT_API_KEY && LIVEKIT_API_SECRET),
      media: config.MEDIA,
      maxParticipants: config.MAX_PARTICIPANTS,
      maxAudience: config.MAX_AUDIENCE,
      defaultSpeakerSeats: config.DEFAULT_SPEAKER_SEATS,
      ai: safe(() => require('../venue/ai').status(), { server: false }),
      stt: safe(() => require('../venue/stt').status(), { server: false }),
      covers: safe(() => {
        const token = config.STT && config.STT.replicate && config.STT.replicate.token;
        const c = config.COVERS || {};
        return { enabled: !!token && c.dailyLimit > 0, dailyLimit: c.dailyLimit || 0, options: c.options || 1 };
      }, { enabled: false, dailyLimit: 0, options: 1 }),
      bible: { defaultTranslation: (config.BIBLE && config.BIBLE.defaultTranslation) || 'eng_kjv' },
      storage: safe(() => ({ driver: config.STORAGE.driver, maxUploadBytes: config.STORAGE.maxUploadBytes, limits: require('../venue/uploads').publicLimits() }), { driver: 'local' }),
      features,
    });
  }

  if (urlPath === '/api/session' && req.method === 'GET') {
    const raw = await getAuthUser(req, res, { allowUnverified: true });
    const user = raw && (!config.AUTH.requireVerifiedEmail || raw.emailVerified) ? raw : null;
    if (user) require('../features/messages/welcome').onReturn(user);
    return sendJSON(res, 200, {
      authenticated: !!user,
      user: user ? publicUser(user) : null,
      // signed in but must confirm their email first (AUTH_REQUIRE_VERIFIED_EMAIL=true)
      pendingVerification: raw && !user ? { email: raw.email } : null,
    });
  }

  if (urlPath === '/api/me' && req.method === 'GET') {
    const user = await getAuthUser(req, res);
    if (!user) return sendJSON(res, 401, { error: 'Not authenticated' });
    const prefs = await require('../venue/data').getPrefs(user.id).catch(() => null);
    return sendJSON(res, 200, { user: publicUser(user), prefs });
  }

  return false;
};
