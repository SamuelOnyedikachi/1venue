/**
 * Daily usage caps for paid AI calls, stored in Postgres (ai_daily_usage) so they survive restarts
 * and are shared by every process. Days are UTC dates.
 *
 *   await usage.take('u:12', 'stt', 4, 1200)   -> { ok: true, used: 37 } or { ok: false, used: 1199 }
 *   await usage.used('u:12', 'stt')            -> 37
 */
const { USE_PG } = require('../../db');
const { one } = require('../core/db');

/** Atomically add `units` if the total stays within `limit` (limit <= 0 means no cap). */
async function take(key, kind, units, limit) {
  const n = Math.max(0, Math.ceil(Number(units) || 0));
  if (!limit || limit <= 0) {
    const r = await one(`INSERT INTO ai_daily_usage (key, day, kind, units) VALUES ($1, ${USE_PG ? "(NOW() AT TIME ZONE 'UTC')::date" : "date('now')"}, $2, $3)
      ON CONFLICT (key, day, kind) DO UPDATE SET units = ai_daily_usage.units + EXCLUDED.units RETURNING units`, [key, kind, n]);
    return { ok: true, used: r.units };
  }
  if (n > limit) return { ok: false, used: await used(key, kind) };
  const r = await one(`INSERT INTO ai_daily_usage (key, day, kind, units) VALUES ($1, ${USE_PG ? "(NOW() AT TIME ZONE 'UTC')::date" : "date('now')"}, $2, $3)
    ON CONFLICT (key, day, kind) DO UPDATE SET units = ai_daily_usage.units + EXCLUDED.units
    WHERE ai_daily_usage.units + EXCLUDED.units <= $4 RETURNING units`, [key, kind, n, limit]);
  if (r) return { ok: true, used: r.units };
  return { ok: false, used: await used(key, kind) };
}
/** Give units back (e.g. the paid call failed). */
async function refund(key, kind, units) {
  const n = Math.max(0, Math.ceil(Number(units) || 0));
  if (!n) return;
  await one(`UPDATE ai_daily_usage SET units = GREATEST(0, units - $3) WHERE key=$1 AND kind=$2 AND day=${USE_PG ? "(NOW() AT TIME ZONE 'UTC')::date" : "date('now')"} RETURNING units`, [key, kind, n]);
}
async function used(key, kind) {
  const r = await one(`SELECT units FROM ai_daily_usage WHERE key=$1 AND kind=$2 AND day=${USE_PG ? "(NOW() AT TIME ZONE 'UTC')::date" : "date('now')"}`, [key, kind]);
  return r ? r.units : 0;
}

module.exports = { take, refund, used };
