/**
 * The thread "Meet" menu (plan section 6). Every option reuses an existing path and posts a card:
 *   meeting   a live instant meeting you host (created by the normal /api/create flow, so credits apply)
 *   schedule  a scheduled meeting (or a recurring series on Premium+) with Phase 2 email reminders
 *             for every member; WhatsApp only when the provider and the host's plan allow it
 *   venue     one of your existing venues (never auto-created; venue caps stay as they are)
 */
const { q, one } = require('../../core/db');
const db = require('../../../db');
const store = require('../../rooms/store');
const { normCode } = require('../../lib/codes');
const plans = require('../../lib/plans');
const service = require('./service');
const { fail } = require('./access');

const nameOf = (u) => (u && (u.displayName || u.display_name || u.username)) || 'Someone';
async function writableThread(user, convId) {
  const c = await service.convRow(user.id, convId);
  if (service.isMeetingScoped(c)) throw fail(400, 'This chat already belongs to a meeting');
  const st = await service.sendState(c, user.id);
  if (!st.canSend) throw fail(403, st.reason || 'You can’t post here');
  return c;
}
const card = (user, c, payload, text) => service.postSystem(c, { senderUserId: user.id, senderName: nameOf(user), text, kind: 'card', payload, notify: true });

async function postMeeting(user, convId, b = {}) {
  const c = await writableThread(user, convId);
  const code = normCode(b.code);
  const m = code ? store.getMeeting(code) : null;
  if (!m) throw fail(404, 'That meeting is not live');
  if (Number(m.hostUserId) !== Number(user.id)) throw fail(403, 'Only the host can share this meeting here');
  const key = String(b.key || '').replace(/[^\w-]/g, '').slice(0, 80);
  const payload = { type: 'meeting', code, title: m.name || 'Meeting', link: `/${code}${key ? `?key=${key}` : ''}` };
  return card(user, c, payload, `${nameOf(user)} started a meeting: ${payload.title}`);
}

async function postVenue(user, convId, b = {}) {
  const c = await writableThread(user, convId);
  const vdata = require('../venues/data');
  const v = await vdata.getVenueById(Number(b.venueId));
  if (!v) throw fail(404, 'Venue not found');
  const mine = Number(v.ownerUserId) === Number(user.id) || await vdata.isVenueAdmin(v.id, user.id);
  if (!mine) throw fail(403, 'Choose one of your own venues');
  if (v.archived) throw fail(403, 'This venue is archived because its plan changed');
  const payload = { type: 'venue', slug: v.slug, code: v.code, title: v.name, link: `/v/${v.slug}` };
  return card(user, c, payload, `${nameOf(user)} shared a venue: ${v.name}`);
}

async function memberEmails(convId) {
  const rows = await require('../../core/db').many(`SELECT u.email FROM conversation_members m JOIN users u ON u.id=m.user_id
    WHERE m.conversation_id=$1 AND m.left_at IS NULL AND u.email IS NOT NULL`, [convId]);
  return [...new Set(rows.map((r) => String(r.email).toLowerCase()))].slice(0, 100);
}
async function schedule(user, convId, b = {}) {
  const c = await writableThread(user, convId);
  const title = String(b.title || '').trim().slice(0, 120) || (c.title ? `${c.title} meeting` : 'Meeting');
  const start = new Date(b.startsAt || b.firstStart);
  if (Number.isNaN(start.getTime())) throw fail(400, 'Choose a date and time');
  if (start < new Date(Date.now() - 5 * 60000)) throw fail(400, 'Choose a time in the future');
  const duration = Math.min(24 * 60, Math.max(5, parseInt(b.durationMin, 10) || 60));
  const invitees = (await memberEmails(c.id)).filter((e) => e !== String(user.email || '').toLowerCase());
  let code; let seriesId = null; let occurrences = 1;
  if (b.pattern) {
    const series = await require('../recurring/series').createSeries(user, { kind: 'meeting', title, firstStart: start.toISOString(), durationMin: duration, pattern: b.pattern, count: b.count || null, until: b.until || null, invitees });
    code = series.occurrences[0].code; seriesId = series.series.id; occurrences = series.occurrences.length;
  } else {
    const row = await db.createScheduledMeeting({ code: store.generateCode(), name: title, hostUserId: user.id, hostDisplayName: nameOf(user), scheduledStart: start.toISOString(), scheduledEnd: new Date(start.getTime() + duration * 60000).toISOString() });
    await q('UPDATE scheduled_meetings SET invitees=$2 WHERE id=$1', [row.id, JSON.stringify(invitees)]);
    code = row.code;
  }
  const reminders = !!(await plans.entitlements(user.id)).features.reminders;
  const payload = { type: 'schedule', code, title, startsAt: start.toISOString(), durationMin: duration, pattern: b.pattern || null, occurrences, seriesId, reminders, link: `/${code}` };
  const msg = await card(user, c, payload, `${nameOf(user)} scheduled ${title}`);
  return { message: msg, code, reminders };
}

module.exports = { postMeeting, postVenue, schedule };
