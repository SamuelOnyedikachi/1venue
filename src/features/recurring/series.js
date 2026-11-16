/**
 * Recurring series: weekly, every two weeks or monthly, ending on a date or after a count.
 * Every occurrence is created up front as a normal event (or scheduled meeting) tagged with
 * series_id, so all existing pages, RSVPs, tickets and reminders work on each one unchanged.
 */
const { q, one, many } = require('../../core/db');
const plans = require('../../lib/plans');
const fail = (status, message) => Object.assign(new Error(message), { status, expose: true });
const PATTERNS = ['weekly', 'biweekly', 'monthly'];

function addMonthsClamped(from, n) {
  const d = new Date(from);
  const day = d.getUTCDate();
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, 1, d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds(), d.getUTCMilliseconds()));
  const last = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 1, 0)).getUTCDate();
  t.setUTCDate(Math.min(day, last));
  return t;
}
/** Pure: occurrence start times. Monthly keeps the first day of month (clamped to short months, no drift). */
function occurrences({ firstStart, pattern, until = null, count = null, max = 52 }) {
  if (!PATTERNS.includes(pattern)) throw fail(400, 'Choose weekly, every two weeks or monthly');
  const first = new Date(firstStart);
  if (Number.isNaN(first.getTime())) throw fail(400, 'Choose a valid first date');
  const end = until ? new Date(until) : null;
  if (end && Number.isNaN(end.getTime())) throw fail(400, 'Choose a valid end date');
  if (!end && !count) throw fail(400, 'Choose an end date or a number of occurrences');
  const n = Math.min(count ? Math.max(1, Math.floor(Number(count)) || 1) : max, max);
  const out = [];
  for (let i = 0; out.length < n && i < max; i++) {
    const t = pattern === 'monthly' ? addMonthsClamped(first, i) : new Date(first.getTime() + i * (pattern === 'weekly' ? 7 : 14) * 86400000);
    if (end && t > end) break;
    out.push(t);
  }
  return out;
}

async function createSeries(user, b = {}) {
  await plans.requireFeature(user.id, 'recurring', 'Recurring events and meetings');
  const kind = b.kind === 'meeting' ? 'meeting' : 'event';
  const title = String(b.title || '').trim().slice(0, 120);
  if (title.length < 2) throw fail(400, 'Title must be 2–120 characters');
  const duration = Math.min(24 * 60, Math.max(5, parseInt(b.durationMin, 10) || 60));
  const max = plans.platform(await plans.getSettings()).seriesMax;
  const starts = occurrences({ firstStart: b.firstStart, pattern: b.pattern, until: b.until || null, count: b.count || null, max });
  if (starts[0] < new Date(Date.now() - 3600000)) throw fail(400, 'The first occurrence must be in the future');
  const invitees = kind === 'meeting' ? [...new Set((Array.isArray(b.invitees) ? b.invitees : String(b.invitees || '').split(/[,\s]+/)).map((e) => String(e).trim().toLowerCase()).filter((e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)))].slice(0, 100) : [];
  const template = kind === 'event' ? { description: b.description, category: b.category, visibility: b.visibility, speakerSeats: b.speakerSeats, tags: b.tags, coverUrl: b.coverUrl, theme: b.theme, language: b.language } : { invitees };
  const series = await one(`INSERT INTO recurring_series (owner_user_id, kind, title, pattern, first_start, duration_min, until_at, occurrences, template)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`, [user.id, kind, title, b.pattern, starts[0], duration, b.until ? new Date(b.until) : null, starts.length, JSON.stringify(template)]);
  const created = [];
  if (kind === 'event') {
    const events = require('../events/data');
    for (let i = 0; i < starts.length; i++) {
      const ev = await events.createEvent(user, { ...template, title, startsAt: starts[i], endsAt: new Date(starts[i].getTime() + duration * 60000) }, { quiet: i > 0, seriesId: series.id });
      created.push({ id: ev.id, slug: ev.slug, startsAt: ev.startsAt });
    }
  } else {
    const db = require('../../../db');
    const { generateCode } = require('../../rooms/store');
    for (const s of starts) {
      const row = await db.createScheduledMeeting({ code: generateCode(), name: title, hostUserId: user.id, hostDisplayName: user.displayName || user.username, scheduledStart: s.toISOString(), scheduledEnd: new Date(s.getTime() + duration * 60000).toISOString() });
      await q('UPDATE scheduled_meetings SET series_id=$2, invitees=$3 WHERE id=$1', [row.id, series.id, JSON.stringify(invitees)]);
      created.push({ id: row.id, code: row.code, startsAt: s.toISOString() });
    }
  }
  return { series: seriesOut(series), occurrences: created };
}
function seriesOut(r) {
  return { id: Number(r.id), kind: r.kind, title: r.title, pattern: r.pattern, firstStart: r.first_start, durationMin: r.duration_min, until: r.until_at, occurrences: r.occurrences, createdAt: r.created_at };
}
async function listSeries(userId) {
  const rows = await many('SELECT * FROM recurring_series WHERE owner_user_id=$1 ORDER BY id DESC LIMIT 50', [userId]);
  const out = [];
  for (const r of rows) {
    const next = r.kind === 'event'
      ? await one("SELECT id, slug, starts_at FROM events WHERE series_id=$1 AND status='scheduled' AND starts_at > NOW() ORDER BY starts_at LIMIT 1", [r.id])
      : await one("SELECT id, code, scheduled_start AS starts_at FROM scheduled_meetings WHERE series_id=$1 AND status='scheduled' AND scheduled_start > NOW() ORDER BY scheduled_start LIMIT 1", [r.id]);
    out.push({ ...seriesOut(r), next: next ? { id: Number(next.id), slug: next.slug, code: next.code, startsAt: next.starts_at } : null });
  }
  return out;
}
/** Cancel the rest of a series: future occurrences are removed; past ones stay as history. */
async function cancelSeries(userId, id) {
  const s = await one('SELECT * FROM recurring_series WHERE id=$1 AND owner_user_id=$2', [id, userId]);
  if (!s) throw fail(404, 'Series not found');
  const r = s.kind === 'event'
    ? await q("DELETE FROM events WHERE series_id=$1 AND host_user_id=$2 AND status IN ('scheduled','draft') AND starts_at > NOW()", [id, userId])
    : await q("DELETE FROM scheduled_meetings WHERE series_id=$1 AND host_user_id=$2 AND status='scheduled' AND scheduled_start > NOW()", [id, userId]);
  return { ok: true, removed: r.rowCount };
}

module.exports = { PATTERNS, occurrences, addMonthsClamped, createSeries, listSeries, cancelSeries };
