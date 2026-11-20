const { USE_PG } = require('../../../db');
/**
 * events queries (PostgreSQL, parameterised). Split out of src/venue/data.js;
 * src/venue/data.js still re-exports everything for older call sites.
 */
const crypto = require('crypto');
const { q, tx, one, many } = require('../../core/db');
const { createPost } = require('../social/data');
const { UNITS_PER_CREDIT } = require('../wallet/rules');
const { isVerified, verifiedSql } = require('../../lib/auth');

// ---------------------------------------------------------------- events
const CATEGORIES = ['talk_show', 'presentation', 'seminar', 'sermon', 'webinar', 'workshop', 'meeting', 'concert', 'class', 'other'];
function slugify(s) {
  const base = String(s || 'event').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'event';
  return `${base.length < 3 ? base + '-ev' : base}-${crypto.randomBytes(3).toString('hex')}`;
}
function eventOut(r) {
  if (!r) return null;
  return {
    id: Number(r.id), slug: r.slug, code: r.code, title: r.title, description: r.description, category: r.category,
    tags: r.tags || [], language: r.language, visibility: r.visibility, status: r.status,
    startsAt: r.starts_at, endsAt: r.ends_at, startedAt: r.started_at, endedAt: r.ended_at,
    coverUrl: r.cover_url, theme: r.theme || {}, speakerSeats: r.speaker_seats, settings: r.settings || {},
    meetingAccessMode: r.meeting_access_mode || 'host_funded', meetingDurationMin: r.meeting_duration_min == null ? null : Number(r.meeting_duration_min),
    meetingEntryPriceCredits: r.meeting_entry_units == null ? null : Number(r.meeting_entry_units) / UNITS_PER_CREDIT,
    templateSlug: r.template_slug, liveViewers: r.live_viewers, peakViewers: r.peak_viewers, totalJoins: r.total_joins,
    host: { id: r.host_user_id, username: r.host_username || null, name: r.host_name, avatarUrl: r.host_avatar || null, verified: !!r.host_verified },
    seriesId: r.series_id ? Number(r.series_id) : null,
    rsvps: r.rsvps != null ? Number(r.rsvps) : undefined,
    rsvped: r.rsvped != null ? !!r.rsvped : undefined,
    historyId: r.meeting_history_id || null,
    createdAt: r.created_at,
  };
}
const EVENT_SELECT = (viewer = '0') => `SELECT e.*, u.avatar_url AS host_avatar, u.username AS host_username, ${verifiedSql('u')} AS host_verified,
  (SELECT COUNT(*) FROM event_rsvps WHERE event_id=e.id) AS rsvps,
  EXISTS(SELECT 1 FROM event_rsvps WHERE event_id=e.id AND user_id=${viewer}) AS rsvped
  FROM events e JOIN users u ON u.id=e.host_user_id`;

async function uniqueEventCode() {
  const { generateCode } = require('../../rooms/store');
  for (let i = 0; i < 20; i++) {
    const c = generateCode();
    if (!(await one('SELECT 1 FROM events WHERE code=$1', [c]))) return c;
  }
  throw new Error('Could not allocate event code');
}
function validateEventInput(b, partial = false) {
  const out = {};
  if (!partial || b.title != null) {
    const t = String(b.title || '').trim();
    if (t.length < 2 || t.length > 120) { const e = new Error('Title must be 2–120 characters'); e.status = 400; throw e; }
    out.title = t;
  }
  if (b.description != null) out.description = String(b.description).slice(0, 5000);
  if (b.category != null) out.category = CATEGORIES.includes(b.category) ? b.category : 'other';
  if (b.tags != null) out.tags = (Array.isArray(b.tags) ? b.tags : String(b.tags).split(','))
    .map((t) => String(t).trim().toLowerCase().replace(/^#/, '')).filter(Boolean).slice(0, 12).map((t) => t.slice(0, 32));
  if (b.language != null) out.language = String(b.language).slice(0, 12) || 'en';
  if (b.visibility != null) out.visibility = ['public', 'unlisted', 'private'].includes(b.visibility) ? b.visibility : 'public';
  if (b.startsAt !== undefined) out.starts_at = b.startsAt ? new Date(b.startsAt) : null;
  if (b.endsAt !== undefined) out.ends_at = b.endsAt ? new Date(b.endsAt) : null;
  for (const k of ['starts_at', 'ends_at']) if (out[k] && isNaN(out[k])) { const e = new Error('Invalid date'); e.status = 400; throw e; }
  if (out.starts_at && out.ends_at && out.ends_at < out.starts_at) { const e = new Error('End must be after start'); e.status = 400; throw e; }
  if (b.coverUrl !== undefined) out.cover_url = b.coverUrl ? String(b.coverUrl).slice(0, 500) : null;
  if (b.theme != null) {
    const hex = (v) => (typeof v === 'string' && /^#[0-9a-fA-F]{6}$/.test(v) ? v : undefined);
    out.theme = JSON.stringify({ accent: hex(b.theme.accent), accent2: hex(b.theme.accent2) });
  }
  if (b.speakerSeats != null) out.speaker_seats = Math.min(50, Math.max(1, parseInt(b.speakerSeats, 10) || 4));
  if (b.settings != null && typeof b.settings === 'object') out.settings = JSON.stringify(b.settings);
  if (b.templateSlug != null) out.template_slug = String(b.templateSlug).slice(0, 40);
  if (b.meetingAccessMode != null) {
    if (!['host_funded', 'paid_entry'].includes(b.meetingAccessMode)) { const e = new Error('Choose host-funded or paid entry'); e.status = 400; throw e; }
    out.meeting_access_mode = b.meetingAccessMode;
  }
  if (b.meetingDurationMin != null) {
    const duration = Number(b.meetingDurationMin);
    if (!Number.isInteger(duration) || duration < 1 || duration > 720) { const e = new Error('Advertised duration must be 1 to 720 minutes'); e.status = 400; throw e; }
    out.meeting_duration_min = duration;
  }
  if (b.meetingEntryPriceCredits != null) {
    const credits = Number(b.meetingEntryPriceCredits);
    if (!Number.isSafeInteger(credits) || credits < 1 || credits > Math.floor(Number.MAX_SAFE_INTEGER / UNITS_PER_CREDIT)) { const e = new Error('Entry price must be a positive whole number of credits'); e.status = 400; throw e; }
    out.meeting_entry_units = credits * UNITS_PER_CREDIT;
  }
  if ((out.meeting_access_mode === 'paid_entry' || b.meetingAccessMode === 'paid_entry') && (out.category || b.category || 'meeting') !== 'meeting') { const e = new Error('Paid entry is available for meetings'); e.status = 400; throw e; }
  if (b.meetingAccessMode === 'paid_entry' && (out.meeting_duration_min == null || out.meeting_entry_units == null)) { const e = new Error('Paid entry requires an advertised duration and entry price'); e.status = 400; throw e; }
  return out;
}
/** Clamp requested speaker seats to the host's plan (the browser picker is capped too). */
async function clampSeats(userId, v) {
  if (v.speaker_seats == null) return;
  try { const ent = await require('../../lib/plans').entitlements(userId); v.speaker_seats = Math.min(v.speaker_seats, ent.limits.speakerSeats); } catch (_) {}
}
async function createEvent(user, b, opts = {}) {
  const v = validateEventInput(b);
  if (v.speaker_seats == null) v.speaker_seats = 4;
  await clampSeats(user.id, v);
  const code = await uniqueEventCode();
  const r = await one(`INSERT INTO events (slug, code, host_user_id, host_name, title, description, category, tags, language, visibility,
      status, starts_at, ends_at, cover_url, theme, speaker_seats, settings, template_slug, meeting_access_mode, meeting_duration_min, meeting_entry_units)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21) RETURNING id`,
  [slugify(v.title), code, user.id, user.displayName || user.username, v.title, v.description || null, v.category || 'meeting',
    v.tags || [], v.language || 'en', v.visibility || 'public', b.status === 'draft' ? 'draft' : 'scheduled',
    v.starts_at || null, v.ends_at || null, v.cover_url || null, v.theme || '{}', v.speaker_seats || 4, v.settings || '{}', v.template_slug || null,
    v.meeting_access_mode || 'host_funded', v.meeting_duration_min || null, v.meeting_entry_units || null]);
  if (opts.seriesId) await q('UPDATE events SET series_id=$2 WHERE id=$1', [r.id, opts.seriesId]);
  const ev = await getEventById(r.id, user.id);
  if (!opts.quiet && ev.visibility === 'public' && ev.status === 'scheduled') {
    await createPost(user.id, { kind: 'event_scheduled', eventId: ev.id, body: ev.title }).catch(() => {});
  }
  return ev;
}
async function updateEvent(id, userId, b) {
  const v = validateEventInput(b, true);
  const current = await one('SELECT category,meeting_access_mode,meeting_duration_min,meeting_entry_units FROM events WHERE id=$1 AND host_user_id=$2', [id, userId]);
  if (!current) return null;
  const mode = v.meeting_access_mode || current.meeting_access_mode || 'host_funded';
  const category = v.category || current.category;
  const duration = v.meeting_duration_min ?? current.meeting_duration_min;
  const entry = v.meeting_entry_units ?? current.meeting_entry_units;
  if (mode === 'paid_entry' && category !== 'meeting') { const e = new Error('Paid entry is available for meetings'); e.status = 400; throw e; }
  if (mode === 'paid_entry' && (!duration || !entry)) { const e = new Error('Paid entry requires an advertised duration and entry price'); e.status = 400; throw e; }
  await clampSeats(userId, v);
  if (b.status && ['draft', 'scheduled', 'cancelled'].includes(b.status)) v.status = b.status;
  const keys = Object.keys(v);
  if (!keys.length) return getEventById(id, userId);
  const sets = keys.map((k, i) => `${k}=$${i + 3}`).join(', ');
  const r = await q(`UPDATE events SET ${sets}, updated_at=NOW() WHERE id=$1 AND host_user_id=$2`, [id, userId, ...keys.map((k) => v[k])]);
  if (!r.rowCount) return null;
  return getEventById(id, userId);
}
async function deleteEvent(id, userId) {
  return (await q('DELETE FROM events WHERE id=$1 AND host_user_id=$2', [id, userId])).rowCount > 0;
}
async function getEventById(id, viewerId) {
  return eventOut(await one(`${EVENT_SELECT('$2')} WHERE e.id=$1`, [id, viewerId || 0]));
}
async function getEventBySlug(slug, viewerId) {
  return eventOut(await one(`${EVENT_SELECT('$2')} WHERE e.slug=$1 OR e.code=UPPER(REPLACE($1,'-',''))`, [slug, viewerId || 0]));
}
async function getEventByCode(code) {
  return eventOut(await one(`${EVENT_SELECT()} WHERE e.code=$1`, [code]));
}
/**
 * Discovery: full-text + trigram fuzzy search across public events.
 */
async function discover({ q: term, category, status, tag, host, limit = 24, offset = 0, viewerId } = {}) {
  const where = ["e.visibility='public'", "e.status <> 'draft'", "e.status <> 'cancelled'"];
  const params = [viewerId || 0];
  let rank = 'e.started_at DESC NULLS LAST, e.starts_at ASC NULLS LAST';
  if (status === 'live') where.push("e.status='live'");
  else if (status === 'upcoming') where.push("e.status='scheduled'");
  else if (status === 'past') where.push("e.status='ended'");
  if (category && CATEGORIES.includes(category)) { params.push(category); where.push(`e.category=$${params.length}`); }
  if (tag) { params.push(String(tag).toLowerCase()); where.push(USE_PG ? `$${params.length} = ANY(e.tags)` : `EXISTS (SELECT 1 FROM json_each(e.tags) WHERE value=$${params.length})`); }
  if (host) {
    const h = String(host).trim();
    if (/^\d+$/.test(h)) { params.push(Number(h)); where.push(`e.host_user_id=$${params.length}`); }
    else { params.push(h.toLowerCase()); where.push(`LOWER(u.username)=$${params.length}`); }
  }
  if (term && String(term).trim()) {
    const t = String(term).trim().slice(0, 100);
    params.push(t);
    const i = params.length;
    if (USE_PG) {
      where.push(`(e.search @@ plainto_tsquery('simple', $${i}) OR e.title % $${i} OR e.title ILIKE '%' || $${i} || '%' OR e.host_name ILIKE '%' || $${i} || '%')`);
      rank = `(e.status='live') DESC, ts_rank(e.search, plainto_tsquery('simple', $${i})) + similarity(e.title, $${i}) DESC`;
    } else {
      const words = t.toLowerCase().match(/[\p{L}\p{N}]+/gu) || [];
      const fts = words.map((word) => `"${word.replace(/"/g, '')}"*`).join(' ');
      if (fts) params.push(fts);
      where.push(`(${fts ? `e.id IN (SELECT rowid FROM event_search WHERE event_search MATCH $${params.length}) OR ` : ''}e.title LIKE '%' || $${i} || '%' OR e.host_name LIKE '%' || $${i} || '%')`);
      rank = `(e.status='live') DESC, (lower(e.title)=lower($${i})) DESC, e.started_at DESC NULLS LAST`;
    }
  } else {
    rank = `(e.status='live') DESC, (e.status='scheduled') DESC, ${rank}`;
  }
  // Verified hosts get a ranking boost (admin setting platform.verifiedBoost), right after "live now".
  let boost = 1;
  try { boost = require('../../lib/plans').platform(await require('../../lib/plans').getSettings()).verifiedBoost; } catch (_) {}
  if (boost) rank = rank.replace("(e.status='live') DESC", `(e.status='live') DESC, (CASE WHEN ${verifiedSql('u')} THEN 1 ELSE 0 END) DESC`);
  params.push(Math.min(60, limit), Math.max(0, offset));
  const rows = await many(`${EVENT_SELECT('$1')} WHERE ${where.join(' AND ')} ORDER BY ${rank} LIMIT $${params.length - 1} OFFSET $${params.length}`, params);
  return rows.map(eventOut);
}
async function categoryCounts() {
  return many(`SELECT category, COUNT(*)::int AS total, COUNT(*) FILTER (WHERE status='live')::int AS live
    FROM events WHERE visibility='public' AND status IN ('live','scheduled','ended') GROUP BY category ORDER BY live DESC, total DESC`);
}
async function myEvents(userId) {
  return (await many(`${EVENT_SELECT('$1')} WHERE e.host_user_id=$1 ORDER BY COALESCE(e.starts_at, e.created_at) DESC LIMIT 100`, [userId])).map(eventOut);
}
async function rsvpedEvents(userId) {
  return (await many(`${EVENT_SELECT('$1')} JOIN event_rsvps r ON r.event_id=e.id AND r.user_id=$1
    WHERE e.status IN ('scheduled','live') ORDER BY e.starts_at NULLS LAST LIMIT 50`, [userId])).map(eventOut);
}
async function toggleRsvp(eventId, userId) {
  const del = await q('DELETE FROM event_rsvps WHERE event_id=$1 AND user_id=$2', [eventId, userId]);
  if (del.rowCount) return false;
  await q('INSERT INTO event_rsvps (event_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [eventId, userId]);
  setImmediate(() => { confirmRsvp(eventId, userId).catch((e) => console.warn('[events] rsvp mail', e.message)); });
  return true;
}
async function confirmRsvp(eventId, userId) {
  const ev = await getEventById(eventId, userId);
  if (!ev) return;
  const user = await one('SELECT id, email, display_name, username FROM users WHERE id=$1', [userId]);
  const when = require('./invites').when(ev.startsAt);
  const link = require('./invites').eventUrl(ev);
  if (user && user.email && !String(user.email).endsWith('.invalid')) {
    await require('../mail/prefs').sendOpt('rsvpConfirm', user.email, {
      name: user.display_name || user.username, event: ev.title, when, link,
    }, { userId });
  }
  if (user) {
    await require('../messages/notify').send(userId, {
      style: 'compact',
      text: `You’re going to ${ev.title}${when ? ` on ${when}` : ''}.`,
      links: ev.slug ? [{ label: 'Open event', href: `/e/${ev.slug}` }] : [],
      card: ev.slug ? { type: 'event', title: ev.title, link: `/e/${ev.slug}`, eventId: ev.id, when: ev.startsAt } : null,
    });
  }
}
async function markEventLive(eventId, { code, historyId }) {
  const ev = await one(`UPDATE events SET status='live', started_at=NOW(), ended_at=NULL, meeting_history_id=$2, updated_at=NOW()
    WHERE id=$1 RETURNING *`, [eventId, historyId]);
  if (historyId) await q('UPDATE meeting_history SET event_id=$1 WHERE id=$2', [eventId, historyId]);
  if (ev && ev.visibility === 'public') await createPost(ev.host_user_id, { kind: 'event_live', eventId, body: ev.title }).catch(() => {});
  return ev;
}
async function markEventEnded(eventId) {
  await q(`UPDATE events SET status='ended', ended_at=NOW(), live_viewers=0, updated_at=NOW() WHERE id=$1 AND status='live'`, [eventId]);
}
async function updateViewers(eventId, live, joinedDelta = 0) {
  await q(`UPDATE events SET live_viewers=$2, peak_viewers=GREATEST(peak_viewers,$2), total_joins=total_joins+$3 WHERE id=$1`, [eventId, live, joinedDelta]);
}
async function listSpeakers(eventId, viewerIdOrOpts) {
  const opts = viewerIdOrOpts && typeof viewerIdOrOpts === 'object' ? viewerIdOrOpts : { viewerId: viewerIdOrOpts };
  const viewerId = opts.viewerId || 0;
  const params = [eventId];
  let where = 'es.event_id=$1';
  if (opts.isHost || opts.includeAll) {
    /* host editor sees every status */
  } else if (viewerId) {
    params.push(viewerId);
    where += ` AND (es.status='active' OR es.status IS NULL OR (es.user_id=$${params.length} AND es.status IN ('pending','active')))`;
  } else {
    where += " AND (es.status='active' OR es.status IS NULL)";
  }
  return (await many(`SELECT es.*, u.username, u.email AS user_email, u.email_verified_at, u.verified_active, u.is_system
    FROM event_speakers es LEFT JOIN users u ON u.id=es.user_id
    WHERE ${where} ORDER BY es.sort_order, es.id`, params))
    .map((r) => {
      return {
        id: Number(r.id), userId: r.user_id, username: r.username || null, name: r.display_name,
        headline: r.headline, avatarUrl: r.avatar_url, email: r.email || null,
        verified: r.user_id ? isVerified({ email: r.user_email, email_verified_at: r.email_verified_at, verified_active: r.verified_active, is_system: r.is_system }) : false,
        status: r.status || 'active',
        inviteMode: r.invite_mode || null,
        declineComment: (opts.isHost || opts.includeAll) ? (r.decline_comment || null) : undefined,
      };
    });
}
async function setSpeakers(eventId, list, { actor } = {}) {
  const ev = await getEventById(eventId, actor && actor.id);
  const invites = require('./invites');
  const prepared = [];
  for (const s of (list || []).slice(0, 20)) {
    const row = await invites.applyInvite(eventId, s, { actor, ev });
    if (row) prepared.push(row);
  }
  await tx(async (c) => {
    await c.query('DELETE FROM event_speakers WHERE event_id=$1', [eventId]);
    let i = 0;
    for (const s of prepared) {
      const p = s.preserve || {};
      const status = p.status || s.status || 'active';
      const invitedBy = p.invited_by || s.invited_by || (actor && actor.id) || (ev && ev.host && ev.host.id) || null;
      const invitedAt = p.invited_at || null;
      const newInvite = s.isNew && !p.status && s.userId && status !== 'declined';
      await c.query(`INSERT INTO event_speakers (event_id, user_id, display_name, headline, avatar_url, email, sort_order, status, invited_by, invited_at, responded_at, decline_comment, invite_mode)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,${invitedAt ? '$10' : (newInvite ? 'NOW()' : 'NULL')},$${invitedAt ? 11 : 10},$${invitedAt ? 12 : 11},$${invitedAt ? 13 : 12})`,
        [eventId, s.userId || null, s.name, s.headline ? String(s.headline).slice(0, 140) : null, s.avatarUrl || null, s.email ? String(s.email).toLowerCase().slice(0, 200) : null, i++, status, invitedBy,
          ...(invitedAt ? [invitedAt] : []), p.responded_at || null, p.decline_comment || null, p.invite_mode || s.invite_mode || null]);
    }
  });
  await invites.afterSave(eventId, prepared, { actor, ev }).catch((e) => console.warn('[events] invite notify', e.message));
  return listSpeakers(eventId, { viewerId: actor && actor.id, isHost: true });
}

async function syncSpeakerInvites(userId, email) {
  if (!email) return 0;
  const r = await q(
    `UPDATE event_speakers SET user_id=$1, avatar_url=COALESCE(avatar_url, (SELECT avatar_url FROM users WHERE id=$1)), display_name=COALESCE(NULLIF(display_name,''), (SELECT COALESCE(display_name, username) FROM users WHERE id=$1))
     WHERE user_id IS NULL AND lower(email)=lower($2)`,
    [userId, String(email).trim()]
  );
  if (r.rowCount) {
    try { await require('./invites').onSignupLink(userId, email); } catch (e) { console.warn('[events] signup invites', e.message); }
  }
  return r.rowCount || 0;
}

module.exports = { CATEGORIES, slugify, eventOut, EVENT_SELECT, uniqueEventCode, validateEventInput, createEvent, updateEvent, deleteEvent, getEventById, getEventBySlug, getEventByCode, discover, categoryCounts, myEvents, rsvpedEvents, toggleRsvp, markEventLive, markEventEnded, updateViewers, listSpeakers, setSpeakers, syncSpeakerInvites };
