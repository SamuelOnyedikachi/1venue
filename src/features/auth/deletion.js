/**
 * Account deletion (Settings → Delete account). Flow, all signed in:
 *   1. POST /api/auth/delete/start   { password }  password check (skipped for Google/Apple-only
 *      accounts), then a 6-digit code is emailed. Valid DELETE_CODE_TTL_MIN (10) minutes.
 *   2. POST /api/auth/delete/verify  { code }      at most 5 wrong tries, then a new code is needed.
 *                                                   Returns a 10-minute deletion grant.
 *   3. POST /api/auth/delete/confirm { grant }     deletes the account, signs out, emails a notice.
 *
 * What goes (see the privacy policy, "Deleting your account"):
 *   - the user row and everything that cascades from it: sessions, sign-in tokens, Google/Apple
 *     links, profile, posts and likes, follows, events they host (with RSVPs), venues they own,
 *     materials, whiteboards, scheduled meetings, preferences;
 *   - their uploaded files, from the database and from storage (disk or R2/S3);
 *   - their comments, private notes, DM threads, room memberships.
 * What stays, anonymised, so other people's records still make sense: messages and questions in
 * shared rooms ("Deleted user"), poll/question votes (counts only, no link back), session
 * history they hosted or attended (name replaced, user link cleared).
 */
const crypto = require('crypto');
const db = require('../../../db');

const ANON = 'Deleted user';
const genCode = () => String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
const hashCode = (userId, code) => crypto.createHash('sha256').update(`acctdel:${userId}:${code}`).digest('hex');

async function issueCode(userId, email, ttlMin) {
  const code = genCode();
  await db.q(
    `INSERT INTO account_deletion_codes (user_id, code_hash, email, attempts, expires_at, verified_at, created_at)
     VALUES ($1, $2, $3, 0, NOW() + make_interval(mins => $4), NULL, NOW())
     ON CONFLICT (user_id) DO UPDATE SET code_hash = EXCLUDED.code_hash, email = EXCLUDED.email, attempts = 0,
       expires_at = EXCLUDED.expires_at, verified_at = NULL, created_at = NOW()`,
    [userId, hashCode(userId, code), email, ttlMin]);
  return code;
}

/** Seconds since the last code was sent (null when none). */
async function lastSentAgo(userId) {
  const r = (await db.q('SELECT EXTRACT(EPOCH FROM (NOW() - created_at))::int AS s FROM account_deletion_codes WHERE user_id = $1 AND verified_at IS NULL', [userId])).rows[0];
  return r ? r.s : null;
}

/** Check a code. Returns 'ok' | 'wrong' | 'expired' | 'locked' | 'none'. */
async function checkCode(userId, code, maxAttempts = 5) {
  return db.tx(async (c) => {
    const row = (await c.query('SELECT * FROM account_deletion_codes WHERE user_id = $1 FOR UPDATE', [userId])).rows[0];
    if (!row || row.verified_at) return 'none';
    if (new Date(row.expires_at) < new Date()) return 'expired';
    if (row.attempts >= maxAttempts) return 'locked';
    const a = Buffer.from(hashCode(userId, String(code || '').replace(/\D/g, '')));
    const b = Buffer.from(row.code_hash);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      await c.query('UPDATE account_deletion_codes SET attempts = attempts + 1 WHERE user_id = $1', [userId]);
      return row.attempts + 1 >= maxAttempts ? 'locked' : 'wrong';
    }
    await c.query('UPDATE account_deletion_codes SET verified_at = NOW() WHERE user_id = $1', [userId]);
    return 'ok';
  });
}

/** Delete the account and its data. Returns { email, name, counts, files }. */
async function deleteAccount(userId) {
  const id = Number(userId);
  const key = `u:${id}`;
  const gone = `x:${crypto.randomBytes(9).toString('base64url')}`; // unlinkable replacement for vote keys
  const out = await db.tx(async (c) => {
    const user = (await c.query('SELECT id, email, username, display_name FROM users WHERE id = $1 FOR UPDATE', [id])).rows[0];
    if (!user) return null;
    const counts = {};
    const run = async (name, sql, p) => { counts[name] = (await c.query(sql, p)).rowCount; };
    const files = (await c.query('SELECT id, driver, object_key FROM files WHERE owner_user_id = $1', [id])).rows;
    const postIds = (await c.query('SELECT id::text FROM posts WHERE user_id = $1', [id])).rows.map((r) => r.id);
    const eventIds = (await c.query('SELECT id::text FROM events WHERE host_user_id = $1', [id])).rows.map((r) => r.id);

    // Personal content: removed.
    await run('comments', `DELETE FROM comments WHERE user_id = $1 OR author_key = $2
      OR (target_type = 'post' AND target_key = ANY($3::text[])) OR (target_type = 'event' AND target_key = ANY($4::text[]))`, [id, key, postIds, eventIds]);
    await run('commentLikes', 'DELETE FROM comment_likes WHERE liker_key = $1', [key]);
    await run('notes', 'DELETE FROM personal_notes WHERE user_id = $1', [id]);
    await run('dmMessages', 'DELETE FROM dm_messages WHERE thread_id IN (SELECT id FROM dm_threads WHERE user_a_id = $1 OR user_b_id = $1)', [id]);
    await run('dmThreads', 'DELETE FROM dm_threads WHERE user_a_id = $1 OR user_b_id = $1', [id]);
    await run('memberships', 'DELETE FROM meeting_membership WHERE user_id = $1', [id]);
    await run('groupMembers', 'DELETE FROM chat_group_members WHERE user_id = $1', [id]);
    await run('files', 'DELETE FROM files WHERE owner_user_id = $1', [id]);

    // Shared rooms: kept for the other people in them, but no longer linked to this person.
    await run('chatMessages', 'UPDATE chat_messages SET sender_user_id = NULL, sender_name = $2 WHERE sender_user_id = $1', [id, ANON]);
    await run('dmSent', 'UPDATE dm_messages SET sender_user_id = NULL, sender_name = $2 WHERE sender_user_id = $1', [id, ANON]);
    await run('questions', 'UPDATE questions SET author_key = $3, author_name = $2 WHERE author_key = $1', [key, ANON, gone]);
    await run('pollVotes', 'UPDATE poll_votes SET voter_key = $2 WHERE voter_key = $1', [key, gone]);
    await run('questionVotes', 'UPDATE question_votes SET voter_key = $2 WHERE voter_key = $1', [key, gone]);
    await run('transcript', 'UPDATE transcript_segments SET speaker_key = NULL, speaker_name = $2 WHERE speaker_key = $1', [key, ANON]);
    await run('attended', 'UPDATE meeting_participants_log SET user_id = NULL, display_name = $2 WHERE user_id = $1', [id, ANON]);
    await run('hosted', 'UPDATE meeting_history SET host_user_id = NULL, host_display_name = $2 WHERE host_user_id = $1', [id, ANON]);
    await run('groups', 'UPDATE chat_groups SET created_by_user_id = NULL WHERE created_by_user_id = $1', [id]);
    await run('recordings', 'UPDATE meeting_recordings SET started_by_user_id = NULL WHERE started_by_user_id = $1', [id]);
    await run('speaker', 'UPDATE event_speakers SET user_id = NULL, email = NULL, avatar_url = NULL, display_name = $2 WHERE user_id = $1', [id, ANON]);

    // The account itself; sessions, tokens, OAuth links, posts, events, venues... cascade.
    await c.query('DELETE FROM users WHERE id = $1', [id]);
    return { email: user.email, name: user.display_name || user.username, counts, files };
  });
  if (!out) return null;
  // Storage after the commit: a failed object delete never resurrects the account.
  const storage = require('../../venue/storage');
  let removed = 0;
  for (const f of out.files) if (await storage.remove(f)) removed++;
  out.counts.storageObjects = removed;
  return out;
}

module.exports = { issueCode, lastSentAgo, checkCode, deleteAccount, ANON, _hashCode: hashCode };
