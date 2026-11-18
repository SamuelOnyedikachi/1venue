/**
 * social queries (PostgreSQL, parameterised). Split out of src/venue/data.js;
 * src/venue/data.js still re-exports everything for older call sites.
 */
const { USE_PG } = require('../../../db');
const { q, tx, one, many } = require('../../core/db');
const { normalizeProfilePatch, socialsOut } = require('./profile-fields');

// ---------------------------------------------------------------- prefs
const PREF_DEFAULTS = { theme: 'system', accent: '#2563eb', accent2: null, fontScale: 1, reduceMotion: false, bibleTranslation: 'eng_kjv', captionLang: null, extra: {} };
function prefsOut(r) {
  if (!r) return { ...PREF_DEFAULTS };
  return {
    theme: r.theme, accent: r.accent, accent2: r.accent2, fontScale: Number(r.font_scale),
    reduceMotion: r.reduce_motion, bibleTranslation: r.bible_translation, captionLang: r.caption_lang,
    extra: r.extra || {},
  };
}
async function getPrefs(userId) {
  return prefsOut(await one('SELECT * FROM user_prefs WHERE user_id=$1', [userId]));
}
async function setPrefs(userId, p = {}) {
  const cur = await getPrefs(userId);
  const n = { ...cur, ...p };
  const hex = (v, d) => (typeof v === 'string' && /^#[0-9a-fA-F]{6}$/.test(v) ? v : d);
  n.theme = ['system', 'light', 'dark'].includes(n.theme) ? n.theme : 'system';
  n.accent = hex(n.accent, '#2563eb');
  n.accent2 = n.accent2 ? hex(n.accent2, null) : null;
  n.fontScale = Math.min(1.5, Math.max(0.8, Number(n.fontScale) || 1));
  n.extra = n.extra && typeof n.extra === 'object' ? n.extra : {};
  const r = await one(`INSERT INTO user_prefs (user_id, theme, accent, accent2, font_scale, reduce_motion, bible_translation, caption_lang, extra, updated_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW())
    ON CONFLICT (user_id) DO UPDATE SET theme=EXCLUDED.theme, accent=EXCLUDED.accent, accent2=EXCLUDED.accent2,
      font_scale=EXCLUDED.font_scale, reduce_motion=EXCLUDED.reduce_motion, bible_translation=EXCLUDED.bible_translation,
      caption_lang=EXCLUDED.caption_lang, extra=EXCLUDED.extra, updated_at=NOW()
    RETURNING *`, [userId, n.theme, n.accent, n.accent2, n.fontScale, !!n.reduceMotion, String(n.bibleTranslation || 'eng_kjv').slice(0, 40), n.captionLang ? String(n.captionLang).slice(0, 12) : null, JSON.stringify(n.extra)]);
  return prefsOut(r);
}

// ---------------------------------------------------------------- users
function userCard(r) {
  if (!r) return null;
  const uname = r.username || null;
  return {
    id: r.id,
    username: uname,
    name: r.display_name || uname || (r.email ? r.email.split('@')[0] : 'User'),
    handle: r.handle || uname || null,
    avatarUrl: r.avatar_url || null, bio: r.bio || null,
    location: r.location || null, website: r.website || null, socials: socialsOut(r.socials),
    createdAt: r.created_at || null,
    followers: r.followers != null ? Number(r.followers) : undefined,
    following: r.following != null ? Number(r.following) : undefined,
    eventCount: r.events != null ? Number(r.events) : undefined,
    isFollowing: r.is_following != null ? !!r.is_following : undefined,
  };
}
async function getUserProfile(id, viewerId) {
  return userCard(await one(`SELECT u.*,
      (SELECT COUNT(*) FROM follows WHERE followee_id=u.id) AS followers,
      (SELECT COUNT(*) FROM follows WHERE follower_id=u.id) AS following,
      (SELECT COUNT(*) FROM events WHERE host_user_id=u.id AND visibility='public') AS events,
      EXISTS(SELECT 1 FROM follows WHERE follower_id=$2 AND followee_id=u.id) AS is_following
    FROM users u WHERE u.id=$1`, [id, viewerId || 0]));
}
async function updateProfile(id, body = {}) {
  const patch = normalizeProfilePatch(body);
  if (patch.handle != null && patch.handle !== '' && !/^[a-z0-9_.]{3,30}$/i.test(patch.handle)) {
    const e = new Error('Handle must be 3–30 letters, numbers, dots or underscores'); e.status = 400; throw e;
  }
  const sets = []; const vals = [];
  const add = (col, v) => { vals.push(v); sets.push(`${col}=$${vals.length + 1}`); };
  if (patch.displayName !== undefined) add('display_name', patch.displayName || null);
  if (patch.bio !== undefined) add('bio', patch.bio || null);
  if (patch.handle !== undefined) {
    vals.push(patch.handle == null ? null : String(patch.handle));
    sets.push(`handle=CASE WHEN $${vals.length + 1}::text IS NULL THEN handle WHEN $${vals.length + 1}='' THEN NULL ELSE $${vals.length + 1} END`);
  }
  if (patch.avatarUrl !== undefined) add('avatar_url', patch.avatarUrl || null);
  if (patch.location !== undefined) add('location', patch.location);
  if (patch.website !== undefined) add('website', patch.website);
  if (patch.socials !== undefined) {
    vals.push(JSON.stringify(patch.socials));
    sets.push(`socials=$${vals.length + 1}::jsonb`);
  }
  if (!sets.length) return getUserProfile(id, id);
  vals.unshift(id);
  try {
    await q(`UPDATE users SET ${sets.join(', ')}, updated_at=NOW() WHERE id=$1`, vals);
  } catch (e) {
    if (e.code === '23505') { const x = new Error('That handle is taken'); x.status = 409; throw x; }
    throw e;
  }
  return getUserProfile(id, id);
}

async function upcomingForUser(userId, viewerId, limit = 3) {
  const { eventOut, EVENT_SELECT } = require('../events/data');
  const lim = Math.min(6, Math.max(1, limit));
  const rows = await many(`${EVENT_SELECT('$2')} WHERE e.host_user_id=$1 AND e.visibility='public'
      AND e.status IN ('scheduled','live')
    ORDER BY (e.status='live') DESC, e.starts_at ASC NULLS LAST LIMIT $3`, [userId, viewerId || 0, lim]);
  return rows.map(eventOut);
}

async function profileStats(userId) {
  const r = await one(`SELECT
      (SELECT COUNT(*) FROM events WHERE host_user_id=$1 AND visibility='public') AS events_hosted,
      (SELECT COALESCE(SUM(total_joins),0) FROM events WHERE host_user_id=$1 AND visibility='public') AS attendees_reached,
      (SELECT COUNT(*) FROM follows WHERE followee_id=$1) AS followers`, [userId]);
  return {
    eventsHosted: Number(r.events_hosted || 0),
    attendeesReached: Number(r.attendees_reached || 0),
    followers: Number(r.followers || 0),
  };
}

async function venuesForUser(userId) {
  const rows = await many(`SELECT v.id, v.slug, v.name, v.owner_user_id, v.brand_logo_url, v.brand_cover_url
      FROM venues v
     WHERE v.archived_at IS NULL
       AND (v.owner_user_id=$1 OR EXISTS (SELECT 1 FROM venue_admins a WHERE a.venue_id=v.id AND a.user_id=$1))
     ORDER BY (v.owner_user_id=$1) DESC, v.created_at ASC`, [userId]);
  return rows.map((r) => ({
    id: Number(r.id), slug: r.slug, name: r.name, logoUrl: r.brand_logo_url || null, coverUrl: r.brand_cover_url || null,
    role: Number(r.owner_user_id) === Number(userId) ? 'owner' : 'admin',
  }));
}

async function similarHosts(userId, viewerId, limit = 3) {
  const rows = await many(`SELECT u.*,
      (SELECT COUNT(*) FROM follows WHERE followee_id=u.id) AS followers,
      EXISTS(SELECT 1 FROM follows WHERE follower_id=$2 AND followee_id=u.id) AS is_following,
      (SELECT COUNT(*) FROM events e
        WHERE e.host_user_id=u.id AND e.visibility='public'
          AND e.category IN (SELECT DISTINCT category FROM events WHERE host_user_id=$1 AND visibility='public')) AS shared
    FROM users u
    WHERE u.id <> $1
      AND EXISTS (SELECT 1 FROM events WHERE host_user_id=u.id AND visibility='public')
    ORDER BY shared DESC, followers DESC, u.id DESC
    LIMIT $3`, [userId, viewerId || 0, Math.min(6, Math.max(1, limit))]);
  return rows.map(userCard);
}

async function profileRail(userId, viewerId) {
  const [upcoming, stats, venues, similar] = await Promise.all([
    upcomingForUser(userId, viewerId, 3),
    profileStats(userId),
    venuesForUser(userId),
    similarHosts(userId, viewerId, 3),
  ]);
  return { upcoming, stats, venues, similarHosts: similar };
}
async function searchUsers(term, limit = 8) {
  const t = `%${String(term).toLowerCase()}%`;
  return (await many(`SELECT * FROM users WHERE LOWER(COALESCE(display_name,'')) LIKE $1 OR LOWER(COALESCE(handle,'')) LIKE $1
     OR LOWER(username) LIKE $1 ORDER BY id DESC LIMIT $2`, [t, limit])).map(userCard);
}

// ---------------------------------------------------------------- follows / posts
async function follow(followerId, followeeId, on = true) {
  if (followerId === followeeId) { const e = new Error('You cannot follow yourself'); e.status = 400; throw e; }
  if (on) await q('INSERT INTO follows (follower_id, followee_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [followerId, followeeId]);
  else await q('DELETE FROM follows WHERE follower_id=$1 AND followee_id=$2', [followerId, followeeId]);
  return on;
}
async function suggestedPeople(userId, limit = 6) {
  return (await many(`SELECT u.*, (SELECT COUNT(*) FROM follows WHERE followee_id=u.id) AS followers
    FROM users u WHERE u.id <> $1 AND NOT EXISTS (SELECT 1 FROM follows WHERE follower_id=$1 AND followee_id=u.id)
    AND EXISTS (SELECT 1 FROM events WHERE host_user_id=u.id AND visibility='public')
    ORDER BY followers DESC, u.id DESC LIMIT $2`, [userId || 0, limit])).map(userCard);
}
function postOut(r) {
  const authorU = r.author_username || r.author_handle || null;
  return {
    id: Number(r.id), kind: r.kind, body: r.body, media: r.media || [], likeCount: r.like_count, commentCount: r.comment_count,
    liked: !!r.liked, createdAt: r.created_at,
    author: { id: r.user_id, username: authorU, name: r.author_name, avatarUrl: r.author_avatar, handle: r.author_handle || authorU },
    event: r.event_id ? { id: Number(r.event_id), slug: r.ev_slug, title: r.ev_title, status: r.ev_status, category: r.ev_category, startsAt: r.ev_starts_at, theme: r.ev_theme || {}, coverUrl: r.ev_cover_url || null } : null,
  };
}
const POST_SELECT = `SELECT p.*, COALESCE(u.display_name, split_part(u.email,'@',1), u.username) AS author_name, u.avatar_url AS author_avatar, u.handle AS author_handle, u.username AS author_username,
  e.slug AS ev_slug, e.title AS ev_title, e.status AS ev_status, e.category AS ev_category, e.starts_at AS ev_starts_at, e.theme AS ev_theme, e.cover_url AS ev_cover_url,
  EXISTS(SELECT 1 FROM post_likes l WHERE l.post_id=p.id AND l.user_id=$1) AS liked
  FROM posts p JOIN users u ON u.id=p.user_id LEFT JOIN events e ON e.id=p.event_id`;
async function createPost(userId, { kind = 'post', body, eventId, media }) {
  const b = body == null ? null : String(body).trim().slice(0, 4000);
  if (kind === 'post' && !b && !(media && media.length)) { const e = new Error('Write something first'); e.status = 400; throw e; }
  const r = await one('INSERT INTO posts (user_id, event_id, kind, body, media) VALUES ($1,$2,$3,$4,$5) RETURNING id',
    [userId, eventId || null, kind, b, JSON.stringify((media || []).slice(0, 4))]);
  return postOut(await one(`${POST_SELECT} WHERE p.id=$2`, [userId, r.id]));
}
const FEED_FILTERS = ['all', 'following', 'events', 'verses', 'live'];

async function feed(userId, { before, limit = 20, filter = 'all' } = {}) {
  const f = FEED_FILTERS.includes(String(filter || '').toLowerCase()) ? String(filter).toLowerCase() : 'all';
  const uid = userId || 0;
  const lim = Math.min(50, limit);
  // Private events stay hidden unless the viewer hosts them or has RSVPed.
  const visible = `(e.id IS NULL OR e.visibility='public' OR e.host_user_id=$1
    OR EXISTS (SELECT 1 FROM event_rsvps r WHERE r.event_id=e.id AND r.user_id=$1))`;
  let scope;
  if (f === 'following') {
    scope = uid
      ? `(p.user_id=$1 OR p.user_id IN (SELECT followee_id FROM follows WHERE follower_id=$1))`
      : 'FALSE';
  } else if (f === 'events') {
    scope = `(p.event_id IS NOT NULL OR p.kind LIKE 'event_%')`;
  } else if (f === 'verses') {
    scope = USE_PG ? `p.media @> '[{"type":"passage"}]'::jsonb`
      : `EXISTS (SELECT 1 FROM json_each(p.media) WHERE json_extract(value,'$.type')='passage')`;
  } else if (f === 'live') {
    scope = `(p.kind='event_live' OR e.status='live')`;
  } else {
    // all: every visible post (a broader public feed than "following")
    scope = 'TRUE';
  }
  const rows = await many(`${POST_SELECT}
    WHERE ${visible} AND ${scope}
      AND ($2::timestamptz IS NULL OR p.created_at < $2)
    ORDER BY p.created_at DESC LIMIT $3`, [uid, before || null, lim]);
  return rows.map(postOut);
}
async function userTimeline(userId, viewerId, { before, limit = 20 } = {}) {
  const rows = await many(`${POST_SELECT} WHERE p.user_id=$2 AND ($3::timestamptz IS NULL OR p.created_at < $3)
    ORDER BY p.created_at DESC LIMIT $4`, [viewerId || 0, userId, before || null, Math.min(50, limit)]);
  return rows.map(postOut);
}
async function togglePostLike(postId, userId) {
  return tx(async (c) => {
    const d = await c.query('DELETE FROM post_likes WHERE post_id=$1 AND user_id=$2', [postId, userId]);
    if (d.rowCount) {
      const r = await c.query('UPDATE posts SET like_count=GREATEST(0, like_count-1) WHERE id=$1 RETURNING like_count', [postId]);
      return { liked: false, likeCount: r.rows[0] ? r.rows[0].like_count : 0 };
    }
    await c.query('INSERT INTO post_likes (post_id, user_id) VALUES ($1,$2)', [postId, userId]);
    const r = await c.query('UPDATE posts SET like_count=like_count+1 WHERE id=$1 RETURNING like_count', [postId]);
    return { liked: true, likeCount: r.rows[0] ? r.rows[0].like_count : 0 };
  });
}
async function deletePost(postId, userId) {
  return (await q('DELETE FROM posts WHERE id=$1 AND user_id=$2', [postId, userId])).rowCount > 0;
}

module.exports = { PREF_DEFAULTS, FEED_FILTERS, prefsOut, getPrefs, setPrefs, userCard, getUserProfile, updateProfile, searchUsers, follow, suggestedPeople, postOut, POST_SELECT, createPost, feed, userTimeline, togglePostLike, deletePost, upcomingForUser, profileStats, venuesForUser, similarHosts, profileRail };
