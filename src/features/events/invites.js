/**
 * Speaker invites: pending/active until accept or decline, mail + in-app Notification cards,
 * reminders, and reporting the inviter.
 */
const { q, one, many, tx } = require('../../core/db');
const { rateLimit } = require('../../lib/http');
const { fail } = require('../messages/access');

const MAX_PENDING = 20;
const when = (d) => {
  if (!d) return '';
  const tz = process.env.REMINDER_TIMEZONE || 'Africa/Lagos';
  try { return new Date(d).toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: tz, timeZoneName: 'short' }); } catch (_) { return new Date(d).toUTCString(); }
};
function eventUrl(ev) {
  return require('../../config').siteUrl(`/e/${ev.slug}`, { fallback: 'https://1venue.live' });
}

async function lookupUser({ userId, email }) {
  if (userId) return one('SELECT * FROM users WHERE id=$1', [userId]);
  if (email) return one('SELECT * FROM users WHERE lower(email)=lower($1)', [String(email).trim()]);
  return null;
}

async function notifyInvite(row, ev, actor, invitee, mode) {
  const notify = require('../messages/notify');
  const mail = require('../mail/prefs');
  const inviter = (actor && (actor.displayName || actor.display_name || actor.username)) || ev.host && ev.host.name || 'A host';
  const whenStr = when(ev.startsAt);
  const link = eventUrl(ev);
  if (invitee && invitee.id && !invitee.is_system) {
    await supersedeInviteCards(invitee.id, ev.id, Number(row.id));
    await notify.send(invitee.id, {
      style: 'detailed',
      text: `${inviter} invited you to speak at ${ev.title}${whenStr ? ` on ${whenStr}` : ''}. ${mode === 'active' ? 'Your name is listed on the event until you accept or decline.' : 'Accept to be listed on the event page, or decline with a short comment.'}`,
      links: [{ label: 'Open event', href: `/e/${ev.slug}` }],
      card: { type: 'speaker_invite', title: ev.title, eventId: ev.id, inviteId: Number(row.id), slug: ev.slug, when: ev.startsAt, inviter },
    });
  }
  const to = invitee && invitee.email && !String(invitee.email).endsWith('.invalid') ? invitee.email : row.email;
  if (to) {
    mail.sendOptLater('speakerInvite', to, {
      name: (invitee && (invitee.display_name || invitee.username)) || row.display_name,
      inviter, event: ev.title, when: whenStr, link: `${link}?invite=${row.id}`,
    }, { userId: invitee && invitee.id });
  }
}

async function applyInvite(eventId, speaker, { actor, ev } = {}) {
  ev = ev || await require('./data').getEventById(eventId, actor && actor.id);
  if (!ev) throw fail(404, 'Event not found');
  const name = String(speaker.name || '').trim().slice(0, 80);
  if (!name) return null;
  const email = speaker.email ? String(speaker.email).toLowerCase().slice(0, 200) : null;
  const found = await lookupUser({ userId: speaker.userId, email });
  const hostId = ev.host && ev.host.id;
  const isHost = found && Number(found.id) === Number(hostId);
  const isSystem = found && (found.is_system || found.username === 'notification');
  if (!found || isHost || isSystem) {
    return {
      userId: (found && !isSystem) ? found.id : (speaker.userId || null),
      name, email, headline: speaker.headline, avatarUrl: speaker.avatarUrl,
      status: 'active', invited_by: actor && actor.id || hostId, invite_mode: null,
    };
  }
  const extra = await require('../messages/notify').extraOf(found.id);
  const mode = require('../messages/notify').speakerInviteMode(extra);
  const existing = await one('SELECT * FROM event_speakers WHERE event_id=$1 AND user_id=$2', [eventId, found.id]);
  if (existing && existing.status === 'declined') {
    // Re-inviting after a decline starts a new pending/active invite.
  }
  const pending = Number((await one("SELECT COUNT(*) AS n FROM event_speakers WHERE event_id=$1 AND status='pending'", [eventId])).n) || 0;
  if (pending >= MAX_PENDING && !(existing && existing.status === 'pending')) throw fail(400, 'This event already has 20 pending speaker invites. Wait for replies or remove some.');
  return {
    userId: found.id,
    name: name || found.display_name || found.username,
    email: email || found.email,
    headline: speaker.headline, avatarUrl: speaker.avatarUrl || found.avatar_url,
    status: mode, invited_by: actor && actor.id || hostId, invite_mode: mode,
    invitee: found, isNew: !existing || existing.status === 'declined',
    preserve: existing && existing.status !== 'declined' ? { status: existing.status, invited_at: existing.invited_at, invited_by: existing.invited_by, decline_comment: existing.decline_comment, responded_at: existing.responded_at, invite_mode: existing.invite_mode } : null,
  };
}

async function afterSave(eventId, rows, { actor, ev } = {}) {
  ev = ev || await require('./data').getEventById(eventId, actor && actor.id);
  for (const r of rows) {
    if (!r || !r.isNew || !r.userId) continue;
    const saved = await one('SELECT * FROM event_speakers WHERE event_id=$1 AND user_id=$2', [eventId, r.userId]);
    if (saved) await notifyInvite(saved, ev, actor, r.invitee, r.status);
  }
}

async function getInvite(id) {
  return one(`SELECT es.*, e.slug, e.title, e.starts_at, e.host_user_id, e.id AS event_pk
    FROM event_speakers es JOIN events e ON e.id=es.event_id WHERE es.id=$1`, [id]);
}

async function accept(user, inviteId) {
  const row = await getInvite(Number(inviteId));
  if (!row || Number(row.user_id) !== Number(user.id)) throw fail(404, 'Invite not found');
  if (row.status === 'declined') throw fail(409, 'This invite was already declined');
  if (row.status === 'active') {
    await updateInviteCards(user.id, row.id, 'active');
    return { ok: true, status: 'active', already: true, eventId: Number(row.event_id || row.event_pk) };
  }
  await q("UPDATE event_speakers SET status='active', responded_at=NOW() WHERE id=$1", [row.id]);
  await updateInviteCards(user.id, row.id, 'active');
  await require('../messages/notify').send(user.id, { text: `You’re confirmed as a speaker at ${row.title}.`, links: [{ label: 'Open event', href: `/e/${row.slug}` }], style: 'compact' });
  return { ok: true, status: 'active', eventId: Number(row.event_id || row.event_pk) };
}

async function decline(user, inviteId, comment) {
  const note = String(comment || '').trim();
  if (note.length < 2) throw fail(400, 'Please add a short comment to decline');
  const row = await getInvite(Number(inviteId));
  if (!row || Number(row.user_id) !== Number(user.id)) throw fail(404, 'Invite not found');
  await q("UPDATE event_speakers SET status='declined', decline_comment=$2, responded_at=NOW() WHERE id=$1", [row.id, note.slice(0, 500)]);
  await updateInviteCards(user.id, row.id, 'declined');
  await require('../messages/notify').send(user.id, { text: `You’ve declined the invite to speak at ${row.title}. You won’t be listed on the event page.`, style: 'compact' });
  return { ok: true, status: 'declined', eventId: Number(row.event_id || row.event_pk) };
}

async function report(user, inviteId, { reason, comment } = {}) {
  if (!rateLimit('invite-report:' + user.id, 8)) throw fail(429, 'Please wait before sending another report');
  const why = String(reason || comment || '').trim();
  if (why.length < 3) throw fail(400, 'Please say why you’re reporting this invite');
  const row = await getInvite(Number(inviteId));
  if (!row || Number(row.user_id) !== Number(user.id)) throw fail(404, 'Invite not found');
  const r = await one(`INSERT INTO speaker_invite_reports (speaker_id, event_id, reporter_id, invited_by, reason, comment)
    VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`, [row.id, row.event_id || row.event_pk, user.id, row.invited_by, why.slice(0, 80), (comment && comment !== reason ? String(comment).slice(0, 500) : null)]);
  return { ok: true, id: Number(r.id) };
}

async function listReports(status = 'open') {
  const rows = await many(`SELECT r.*, u.username AS reporter, u.display_name AS reporter_name,
      iv.username AS inviter, iv.display_name AS inviter_name, e.title AS event_title, e.slug AS event_slug
    FROM speaker_invite_reports r
    LEFT JOIN users u ON u.id=r.reporter_id LEFT JOIN users iv ON iv.id=r.invited_by LEFT JOIN events e ON e.id=r.event_id
    WHERE ($1='all' OR r.status=$1) ORDER BY r.id DESC LIMIT 100`, [status]);
  return rows.map((r) => ({
    id: Number(r.id), status: r.status, reason: r.reason, comment: r.comment, createdAt: r.created_at,
    reporter: r.reporter_name || r.reporter, inviter: r.inviter_name || r.inviter, invitedBy: r.invited_by,
    eventTitle: r.event_title, eventSlug: r.event_slug, note: r.admin_note, reviewedAt: r.reviewed_at,
  }));
}
async function reviewReport(adminId, id, b = {}) {
  const status = ['dismissed', 'actioned', 'open'].includes(b.status) ? b.status : null;
  if (!status) throw fail(400, 'Choose dismissed, actioned or open');
  const r = await q('UPDATE speaker_invite_reports SET status=$2, admin_note=$3, reviewed_by=$4, reviewed_at=NOW() WHERE id=$1', [id, status, String(b.note || '').slice(0, 500) || null, adminId]);
  if (!r.rowCount) throw fail(404, 'Report not found');
  return { ok: true };
}


async function supersedeInviteCards(userId, eventId, exceptInviteId) {
  try {
    const { conversation } = await require('../messages/notify').ensureThread(userId);
    const threadId = conversation && conversation.dm_thread_id;
    if (!threadId) return;
    const rows = await many("SELECT id, payload FROM dm_messages WHERE thread_id=$1 AND kind='card'", [threadId]);
    for (const row of rows) {
      let p = row.payload;
      if (typeof p === 'string') { try { p = JSON.parse(p); } catch (_) { continue; } }
      if (!p || p.type !== 'speaker_invite') continue;
      if (Number(p.eventId) !== Number(eventId)) continue;
      if (exceptInviteId && Number(p.inviteId) === Number(exceptInviteId)) continue;
      if (p.status === 'superseded') continue;
      await q('UPDATE dm_messages SET payload=$2 WHERE id=$1', [row.id, JSON.stringify({ ...p, status: 'superseded' })]);
    }
  } catch (e) { console.warn('[invites] supersede cards', e.message); }
}

async function updateInviteCards(userId, inviteId, status) {
  try {
    const { conversation } = await require('../messages/notify').ensureThread(userId);
    const threadId = conversation && conversation.dm_thread_id;
    if (!threadId) return;
    const rows = await many("SELECT id, payload FROM dm_messages WHERE thread_id=$1 AND kind='card'", [threadId]);
    for (const row of rows) {
      let p = row.payload;
      if (typeof p === 'string') { try { p = JSON.parse(p); } catch (_) { continue; } }
      if (!p || p.type !== 'speaker_invite' || Number(p.inviteId) !== Number(inviteId)) continue;
      await q('UPDATE dm_messages SET payload=$2 WHERE id=$1', [row.id, JSON.stringify({ ...p, status })]);
    }
  } catch (e) { console.warn('[invites] update cards', e.message); }
}

async function listMine(user) {
  const rows = await many(`SELECT es.id, es.status, es.event_id, es.responded_at, e.slug, e.title
    FROM event_speakers es JOIN events e ON e.id=es.event_id
    WHERE es.user_id=$1 ORDER BY es.id DESC LIMIT 200`, [user.id]);
  return { invites: rows.map((r) => ({
    id: Number(r.id), status: r.status, eventId: Number(r.event_id),
    slug: r.slug, title: r.title, respondedAt: r.responded_at,
  })) };
}

async function onSignupLink(userId, email) {
  if (!email) return 0;
  const rows = await many(`SELECT es.* FROM event_speakers es WHERE es.user_id=$1 AND es.status IN ('pending','active') AND es.invited_at IS NOT NULL`, [userId]).catch(() => []);
  const data = require('./data');
  const notify = require('../messages/notify');
  for (const row of rows) {
    const ev = await data.getEventById(row.event_id, userId).catch(() => null);
    if (!ev) continue;
    const already = await one("SELECT 1 FROM reminder_sends WHERE target_type='speaker_invite' AND target_id=$1 AND lead_min=0 AND channel='email' AND recipient=$2", [row.id, email]).catch(() => null);
    if (already) continue;
    await notifyInvite(row, ev, null, { id: userId, email, display_name: ev.host && ev.host.name }, row.status || 'pending');
  }
  return rows.length;
}

module.exports = {
  when, eventUrl, lookupUser, applyInvite, afterSave, notifyInvite,
  accept, decline, report, listReports, reviewReport, getInvite, listMine, updateInviteCards, supersedeInviteCards, onSignupLink, MAX_PENDING,
};
