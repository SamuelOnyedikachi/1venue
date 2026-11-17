/**
 * Who may message whom (plan section 7). A may start a DM with B when they are not blocked either
 * way and any of these hold:
 *   1. they already have a DM thread (including one that started in a meeting);
 *   2. B's setting is "everyone" (the default: anyone on 1venue can start a chat by username or email);
 *   3. B's setting is "contacts" and they follow each other, share an organisation,
 *      were in the same meeting, or are in the same group chat.
 * New chats are rate-limited per hour (service.newChatCap) and per minute for username / email lookups.
 * "nobody" only allows existing threads. Blocks override everything and are symmetric in effect.
 */
const { one, many, q } = require('../../core/db');

const POLICIES = ['everyone', 'contacts', 'nobody'];
const fail = (status, message, extra = {}) => Object.assign(new Error(message), { status, expose: true, ...extra });
const NO_MESSAGE = 'You can’t message this person';

async function prefs(userId) {
  const r = await one('SELECT extra FROM user_prefs WHERE user_id=$1', [userId]).catch(() => null);
  let x = r && r.extra;
  if (typeof x === 'string') { try { x = JSON.parse(x); } catch (_) { x = {}; } }
  x = x && typeof x === 'object' ? x : {};
  return { dmPolicy: POLICIES.includes(x.dmPolicy) ? x.dmPolicy : 'everyone', hidePresence: !!x.hidePresence, notifyPrompt: x.notifyPrompt && typeof x.notifyPrompt === 'object' ? x.notifyPrompt : null, raw: x };
}
async function savePrefs(userId, patch = {}) {
  const cur = await prefs(userId);
  const next = { ...cur.raw };
  if (patch.dmPolicy !== undefined) {
    if (!POLICIES.includes(patch.dmPolicy)) throw fail(400, 'Choose everyone, contacts or nobody');
    next.dmPolicy = patch.dmPolicy;
  }
  if (patch.hidePresence !== undefined) next.hidePresence = !!patch.hidePresence;
  if (patch.notifyPrompt !== undefined) {
    const n = patch.notifyPrompt && typeof patch.notifyPrompt === 'object' ? patch.notifyPrompt : {};
    next.notifyPrompt = { asks: Math.min(50, Math.max(0, Number(n.asks) || 0)), next: Number(n.next) || 0, state: ['granted', 'denied', 'dismissed', 'default'].includes(n.state) ? n.state : 'default' };
  }
  await q(`INSERT INTO user_prefs (user_id, extra, updated_at) VALUES ($1, $2, NOW())
    ON CONFLICT (user_id) DO UPDATE SET extra=EXCLUDED.extra, updated_at=NOW()`, [userId, JSON.stringify(next)]);
  return prefs(userId);
}

async function isBlocked(a, b) {
  if (!a || !b) return false;
  return !!(await one('SELECT 1 AS x FROM user_blocks WHERE (blocker_id=$1 AND blocked_id=$2) OR (blocker_id=$2 AND blocked_id=$1) LIMIT 1', [a, b]));
}
async function blockedByMe(userId) {
  return new Set((await many('SELECT blocked_id FROM user_blocks WHERE blocker_id=$1', [userId])).map((r) => Number(r.blocked_id)));
}
async function block(userId, otherId) {
  if (!otherId || Number(otherId) === Number(userId)) throw fail(400, 'Choose someone else');
  if (!(await one('SELECT id FROM users WHERE id=$1', [otherId]))) throw fail(404, 'User not found');
  await q('INSERT INTO user_blocks (blocker_id, blocked_id) VALUES ($1,$2) ON CONFLICT (blocker_id, blocked_id) DO NOTHING', [userId, otherId]);
  return { ok: true };
}
async function unblock(userId, otherId) {
  await q('DELETE FROM user_blocks WHERE blocker_id=$1 AND blocked_id=$2', [userId, otherId]);
  return { ok: true };
}
async function listBlocked(userId) {
  return (await many(`SELECT u.id, u.username, u.display_name, u.avatar_url FROM user_blocks b JOIN users u ON u.id=b.blocked_id
    WHERE b.blocker_id=$1 ORDER BY b.created_at DESC`, [userId])).map((u) => ({ id: Number(u.id), username: u.username, name: u.display_name || u.username, avatarUrl: u.avatar_url || null }));
}

async function existingThread(a, b) {
  return one('SELECT * FROM dm_threads WHERE user_a_id=$1 AND user_b_id=$2 AND peer_is_guest = FALSE LIMIT 1', [Math.min(a, b), Math.max(a, b)]);
}
/** Shared context: mutual follow, same organisation, same meeting, or same group chat. */
async function sharesContext(a, b) {
  const checks = [
    ['SELECT 1 AS x FROM follows f1 JOIN follows f2 ON f2.follower_id=f1.followee_id AND f2.followee_id=f1.follower_id WHERE f1.follower_id=$1 AND f1.followee_id=$2 LIMIT 1', [a, b]],
    ['SELECT 1 AS x FROM org_members m1 JOIN org_members m2 ON m2.org_id=m1.org_id WHERE m1.user_id=$1 AND m2.user_id=$2 LIMIT 1', [a, b]],
    [`SELECT 1 AS x FROM (SELECT meeting_history_id AS id FROM meeting_participants_log WHERE user_id=$1 UNION SELECT id FROM meeting_history WHERE host_user_id=$1) x
      JOIN (SELECT meeting_history_id AS id FROM meeting_participants_log WHERE user_id=$2 UNION SELECT id FROM meeting_history WHERE host_user_id=$2) y ON y.id=x.id LIMIT 1`, [a, b]],
    [`SELECT 1 AS x FROM conversation_members m1 JOIN conversation_members m2 ON m2.conversation_id=m1.conversation_id JOIN conversations c ON c.id=m1.conversation_id
      WHERE c.type='group' AND m1.user_id=$1 AND m2.user_id=$2 AND m1.left_at IS NULL AND m2.left_at IS NULL LIMIT 1`, [a, b]],
  ];
  for (const [sql, p] of checks) { if (await one(sql, p).catch(() => null)) return true; }
  return false;
}
/** { ok, reason, existing } for A starting (or reopening) a DM with B. */
async function canStartDm(a, b) {
  a = Number(a); b = Number(b);
  if (!b || a === b) return { ok: false, reason: 'Choose someone else' };
  if (!(await one('SELECT id FROM users WHERE id=$1', [b]))) return { ok: false, reason: 'User not found', status: 404 };
  if (await isBlocked(a, b)) return { ok: false, reason: NO_MESSAGE };
  const existing = await existingThread(a, b);
  if (existing) return { ok: true, existing };
  const p = await prefs(b);
  if (p.dmPolicy === 'nobody') return { ok: false, reason: NO_MESSAGE };
  if (p.dmPolicy === 'everyone') return { ok: true };
  return (await sharesContext(a, b)) ? { ok: true } : { ok: false, reason: NO_MESSAGE };
}
async function assertCanStartDm(a, b) {
  const r = await canStartDm(a, b);
  if (!r.ok) throw fail(r.status || 403, r.reason);
  return r;
}
/** May A add B to a group (same allow-list as a new DM, ignoring the existing-thread shortcut only for blocks). */
async function canAddToGroup(a, b) { return (await canStartDm(a, b)).ok; }

module.exports = { POLICIES, NO_MESSAGE, prefs, savePrefs, isBlocked, blockedByMe, block, unblock, listBlocked, existingThread, sharesContext, canStartDm, assertCanStartDm, canAddToGroup, fail };
