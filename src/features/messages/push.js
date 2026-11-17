/**
 * Web Push (standard VAPID). Off unless VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY are set; then every
 * call here is a no-op and the client never offers notifications. Generate keys once with
 *   npx web-push generate-vapid-keys
 * Previews are sender name + a short text; muted conversations and users with a visible tab are skipped.
 */
const { q, many } = require('../../core/db');

let lib = null; let configured = null;
function keys() {
  return { publicKey: String(process.env.VAPID_PUBLIC_KEY || '').trim(), privateKey: String(process.env.VAPID_PRIVATE_KEY || '').trim(), subject: String(process.env.VAPID_SUBJECT || '').trim() || 'mailto:admin@1venue.live' };
}
function enabled() {
  const k = keys();
  if (!k.publicKey || !k.privateKey) return false;
  if (configured === k.publicKey) return true;
  try {
    lib = lib || require('web-push');
    lib.setVapidDetails(k.subject, k.publicKey, k.privateKey);
    configured = k.publicKey;
    return true;
  } catch (e) { console.warn('[push] VAPID keys rejected:', e.message); return false; }
}
const publicConfig = () => ({ enabled: enabled(), publicKey: enabled() ? keys().publicKey : null });

async function subscribe(userId, body = {}, userAgent = '') {
  if (!enabled()) return { ok: false, enabled: false };
  const endpoint = String(body.endpoint || '');
  const k = body.keys || {};
  if (!/^https:\/\//.test(endpoint) || endpoint.length > 1000 || !k.p256dh || !k.auth) throw Object.assign(new Error('Invalid push subscription'), { status: 400, expose: true });
  await q(`INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth, user_agent) VALUES ($1,$2,$3,$4,$5)
    ON CONFLICT (endpoint) DO UPDATE SET user_id=EXCLUDED.user_id, p256dh=EXCLUDED.p256dh, auth=EXCLUDED.auth, user_agent=EXCLUDED.user_agent`,
  [userId, endpoint, String(k.p256dh).slice(0, 200), String(k.auth).slice(0, 100), String(userAgent || '').slice(0, 200)]);
  return { ok: true, enabled: true };
}
async function unsubscribe(userId, endpoint) {
  await q('DELETE FROM push_subscriptions WHERE user_id=$1 AND endpoint=$2', [userId, String(endpoint || '')]);
  return { ok: true };
}

/** Send { title, body, url, tag, kind } to every device of a user. Returns how many were sent. */
async function notify(userId, payload) {
  if (!enabled()) return 0;
  const subs = await many('SELECT id, endpoint, p256dh, auth FROM push_subscriptions WHERE user_id=$1', [userId]).catch(() => []);
  let sent = 0;
  for (const s of subs) {
    try {
      await lib.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, JSON.stringify(payload), { TTL: payload.kind === 'call' ? 45 : payload.kind === 'call-end' ? 300 : 3600, urgency: /^call/.test(payload.kind || '') ? 'high' : 'normal' });
      sent++;
      q('UPDATE push_subscriptions SET last_used_at=NOW() WHERE id=$1', [s.id]).catch(() => {});
    } catch (e) {
      if (e.statusCode === 404 || e.statusCode === 410) await q('DELETE FROM push_subscriptions WHERE id=$1', [s.id]).catch(() => {});
      else console.warn('[push]', e.statusCode || '', e.message);
    }
  }
  return sent;
}

module.exports = { enabled, publicConfig, subscribe, unsubscribe, notify };
