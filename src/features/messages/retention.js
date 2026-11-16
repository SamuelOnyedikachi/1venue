/**
 * Message retention (plan "historyDays": Free 365, paid 0 = forever; editable in /admin).
 *
 *  - Soft hide: reads hide DM and group messages older than the viewer's historyDays (service.js).
 *  - Purge: this job deletes a DM or group message only when it is older than the LONGEST
 *    retention among the conversation's members plus MESSAGES_PURGE_GRACE_DAYS (default 30), so
 *    a member on a paid plan keeps everything and a short downgrade loses nothing. Each pass is a
 *    plain "DELETE … WHERE created_at < cutoff", so re-running it is harmless (idempotent).
 *    Meeting chats keep following the meeting record and are never purged here.
 *  Set MESSAGES_RETENTION_PURGE=false to keep soft-hiding without deleting anything.
 */
const { q, many } = require('../../core/db');
const plans = require('../../lib/plans');

const DAY = 86400000;
const graceDays = () => { const v = Number(process.env.MESSAGES_PURGE_GRACE_DAYS); return Number.isFinite(v) && v >= 0 ? v : 30; };

/** Longest retention in days among these users (Infinity when any of them keeps forever). */
async function keepDays(userIds, cache) {
  let best = 0;
  for (const uid of userIds) {
    if (!cache.has(uid)) {
      const exists = (await many('SELECT id FROM users WHERE id=$1', [uid])).length;
      cache.set(uid, exists ? Number((await plans.entitlements(uid)).features.historyDays) || 0 : null);
    }
    const d = cache.get(uid);
    if (d === null) continue; // deleted account: does not hold history
    if (d === 0) return Infinity;
    best = Math.max(best, d);
  }
  return best || null; // null: nobody left who can read it, leave it alone
}

async function purge({ now = Date.now() } = {}) {
  const out = { dm: 0, group: 0, skipped: false };
  if (process.env.MESSAGES_RETENTION_PURGE === 'false') return { ...out, skipped: true };
  const s = await plans.getSettings();
  const finite = plans.PLAN_IDS.map((p) => Number(plans.featuresFor(s, p).historyDays) || 0).filter((d) => d > 0);
  if (!finite.length) return out;
  const grace = graceDays();
  const oldest = new Date(now - (Math.min(...finite) + grace) * DAY);
  const cache = new Map();

  const threads = await many(`SELECT DISTINCT t.id, t.user_a_id, t.user_b_id, t.peer_is_guest FROM dm_threads t
    WHERE EXISTS (SELECT 1 FROM dm_messages d WHERE d.thread_id=t.id AND d.created_at < $1) LIMIT 1000`, [oldest]);
  for (const t of threads) {
    const days = await keepDays([t.user_a_id, t.user_b_id].filter(Boolean).map(Number), cache);
    if (!days || days === Infinity) continue;
    const cutoff = new Date(now - (days + grace) * DAY);
    await q("DELETE FROM message_reactions WHERE message_source='dm' AND message_id IN (SELECT id FROM dm_messages WHERE thread_id=$1 AND created_at < $2)", [t.id, cutoff]);
    out.dm += (await q('DELETE FROM dm_messages WHERE thread_id=$1 AND created_at < $2', [t.id, cutoff])).rowCount;
  }

  const groups = await many(`SELECT DISTINCT cm.conversation_id AS id FROM chat_messages cm WHERE cm.conversation_id IS NOT NULL AND cm.created_at < $1 LIMIT 1000`, [oldest]);
  for (const g of groups) {
    const members = (await many('SELECT user_id FROM conversation_members WHERE conversation_id=$1 AND left_at IS NULL', [g.id])).map((r) => Number(r.user_id));
    const days = await keepDays(members, cache);
    if (!days || days === Infinity) continue;
    const cutoff = new Date(now - (days + grace) * DAY);
    await q("DELETE FROM message_reactions WHERE message_source='chat' AND message_id IN (SELECT id FROM chat_messages WHERE conversation_id=$1 AND created_at < $2)", [g.id, cutoff]);
    out.group += (await q('DELETE FROM chat_messages WHERE conversation_id=$1 AND created_at < $2', [g.id, cutoff])).rowCount;
  }
  if (out.dm || out.group) console.log(`[messages] retention purged ${out.dm} DM and ${out.group} group message(s)`);
  return out;
}

let timer = null;
function startWorker() {
  if (timer || process.env.MESSAGES_RETENTION_WORKER === 'false') return null;
  const every = Math.max(60000, Number(process.env.MESSAGES_RETENTION_INTERVAL_MS) || 6 * 3600000);
  const first = setTimeout(() => purge().catch((e) => console.warn('[messages] retention', e.message)), 120000); first.unref();
  timer = setInterval(() => { purge().catch((e) => console.warn('[messages] retention', e.message)); }, every);
  timer.unref();
  return timer;
}
module.exports = { purge, keepDays, startWorker };
