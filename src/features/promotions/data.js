/**
 * Promotions: admin-picked events / posts shown as "Promoted" cards (sidebar on wide screens,
 * one inline card on phones). Views and clicks are simple counters.
 */
const { q, one, many } = require('../../core/db');
const { postOut, POST_SELECT } = require('../social/data');

const PLACEMENTS = ['discover', 'feed', 'venues', 'books'];
const EVENT_COLS = `e.id, e.slug, e.code, e.title, e.category, e.status, e.starts_at, e.cover_url, e.theme, e.host_name, e.visibility,
  u.username AS host_username, u.avatar_url AS host_avatar`;

function promoOut(r) {
  return {
    id: Number(r.id), type: r.target_type, placements: r.placements || [], startsAt: r.starts_at, endsAt: r.ends_at,
    active: r.active, weight: r.weight, note: r.note, views: r.views, clicks: r.clicks, createdAt: r.created_at,
  };
}
function eventCardOut(r) {
  return {
    id: Number(r.id), slug: r.slug, code: r.code, title: r.title, category: r.category, status: r.status, startsAt: r.starts_at,
    coverUrl: r.cover_url, theme: r.theme || {}, host: { name: r.host_name, username: r.host_username, avatarUrl: r.host_avatar },
  };
}
const cleanPlacements = (v) => {
  const list = (Array.isArray(v) ? v : String(v || '').split(',')).map((x) => String(x).trim().toLowerCase()).filter((x) => PLACEMENTS.includes(x));
  return list.length ? [...new Set(list)] : PLACEMENTS.slice();
};
const bad = (msg) => { const e = new Error(msg); e.status = 400; return e; };

/** Live promotions for one placement: active, inside their dates, target still public. */
async function live(placement, { limit = 3, viewerId = 0 } = {}) {
  if (!PLACEMENTS.includes(placement)) return [];
  const rows = await many(`SELECT p.*, ${EVENT_COLS}, p.id AS id
      FROM promotions p
      LEFT JOIN events e ON e.id = p.event_id
      LEFT JOIN users u ON u.id = e.host_user_id
      LEFT JOIN posts po ON po.id = p.post_id
     WHERE p.active AND p.starts_at <= NOW() AND (p.ends_at IS NULL OR p.ends_at > NOW())
       AND $1 = ANY(p.placements)
       AND ((p.target_type = 'event' AND e.visibility = 'public' AND e.status IN ('scheduled','live','ended'))
         OR (p.target_type = 'post' AND po.id IS NOT NULL))
     ORDER BY p.weight DESC, random()
     LIMIT $2`, [placement, Math.min(6, Math.max(1, limit))]);
  const out = [];
  for (const r of rows) {
    const base = { id: Number(r.id), type: r.target_type };
    if (r.target_type === 'event') out.push({ ...base, event: eventCardOut({ ...r, id: r.event_id }) });
    else {
      const post = await one(`${POST_SELECT} WHERE p.id = $2`, [viewerId || 0, r.post_id]);
      if (post) out.push({ ...base, post: postOut(post) });
    }
  }
  return out;
}

async function list() {
  const rows = await many(`SELECT p.*, e.slug AS ev_slug, e.title AS ev_title, e.status AS ev_status, po.body AS post_body,
      COALESCE(pu.display_name, pu.username) AS post_author
      FROM promotions p LEFT JOIN events e ON e.id = p.event_id LEFT JOIN posts po ON po.id = p.post_id LEFT JOIN users pu ON pu.id = po.user_id
     ORDER BY p.active DESC, p.created_at DESC LIMIT 200`);
  return rows.map((r) => ({
    ...promoOut(r),
    target: r.target_type === 'event'
      ? { id: Number(r.event_id), slug: r.ev_slug, title: r.ev_title, status: r.ev_status }
      : { id: Number(r.post_id), title: String(r.post_body || '(photo post)').slice(0, 90), author: r.post_author },
    live: r.active && new Date(r.starts_at) <= new Date() && (!r.ends_at || new Date(r.ends_at) > new Date()),
  }));
}

async function create(userId, b) {
  const type = b.type === 'post' ? 'post' : 'event';
  const id = Number(b.targetId);
  if (!Number.isInteger(id) || id <= 0) throw bad('Pick an event or post to promote');
  if (type === 'event') {
    const ev = await one("SELECT id FROM events WHERE id=$1 AND visibility='public' AND status NOT IN ('draft','cancelled')", [id]);
    if (!ev) throw bad('Only public events can be promoted');
  } else if (!(await one('SELECT id FROM posts WHERE id=$1', [id]))) throw bad('That post no longer exists');
  const starts = b.startsAt ? new Date(b.startsAt) : new Date();
  const ends = b.endsAt ? new Date(b.endsAt) : null;
  if (Number.isNaN(starts.getTime()) || (ends && Number.isNaN(ends.getTime()))) throw bad('Check the dates');
  if (ends && ends <= starts) throw bad('The end date must be after the start');
  const r = await one(`INSERT INTO promotions (target_type, event_id, post_id, placements, starts_at, ends_at, weight, note, created_by)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
  [type, type === 'event' ? id : null, type === 'post' ? id : null, cleanPlacements(b.placements), starts, ends,
    Math.min(100, Math.max(0, parseInt(b.weight, 10) || 0)), b.note ? String(b.note).slice(0, 200) : null, userId]);
  return promoOut(r);
}

async function update(id, b) {
  const sets = []; const vals = [];
  const add = (col, v) => { vals.push(v); sets.push(`${col}=$${vals.length}`); };
  if (b.active != null) add('active', !!b.active);
  if (b.placements != null) add('placements', cleanPlacements(b.placements));
  if (b.startsAt) { const d = new Date(b.startsAt); if (Number.isNaN(d.getTime())) throw bad('Check the dates'); add('starts_at', d); }
  if (b.endsAt !== undefined) { const d = b.endsAt ? new Date(b.endsAt) : null; if (d && Number.isNaN(d.getTime())) throw bad('Check the dates'); add('ends_at', d); }
  if (b.weight != null) add('weight', Math.min(100, Math.max(0, parseInt(b.weight, 10) || 0)));
  if (!sets.length) return null;
  vals.push(id);
  const r = await one(`UPDATE promotions SET ${sets.join(', ')} WHERE id=$${vals.length} RETURNING *`, vals);
  return r ? promoOut(r) : null;
}
async function remove(id) { return (await q('DELETE FROM promotions WHERE id=$1', [id])).rowCount > 0; }

async function countViews(ids) {
  const clean = [...new Set((ids || []).map(Number).filter((n) => Number.isInteger(n) && n > 0))].slice(0, 6);
  if (!clean.length) return 0;
  return (await q('UPDATE promotions SET views = views + 1 WHERE id = ANY($1::bigint[])', [clean])).rowCount;
}
async function countClick(id) { return (await q('UPDATE promotions SET clicks = clicks + 1 WHERE id=$1', [id])).rowCount > 0; }

/** Admin picker: recent public events and posts matching a search. */
async function candidates(type, term) {
  const t = String(term || '').trim().slice(0, 80);
  if (type === 'post') {
    const rows = await many(`SELECT p.id, p.body, p.created_at, COALESCE(u.display_name, u.username) AS author FROM posts p JOIN users u ON u.id=p.user_id
      WHERE p.kind='post' AND ($1 = '' OR p.body ILIKE '%' || $1 || '%' OR u.username ILIKE '%' || $1 || '%') ORDER BY p.created_at DESC LIMIT 12`, [t]);
    return rows.map((r) => ({ id: Number(r.id), title: String(r.body || '(photo post)').slice(0, 90), sub: `${r.author} · post` }));
  }
  const rows = await many(`SELECT id, title, status, starts_at, host_name FROM events
    WHERE visibility='public' AND status NOT IN ('draft','cancelled') AND ($1 = '' OR title ILIKE '%' || $1 || '%' OR host_name ILIKE '%' || $1 || '%' OR slug = $1)
    ORDER BY (status='live') DESC, COALESCE(starts_at, created_at) DESC LIMIT 12`, [t]);
  return rows.map((r) => ({ id: Number(r.id), title: r.title, sub: `${r.host_name || 'host'} · ${r.status}` }));
}

module.exports = { PLACEMENTS, live, list, create, update, remove, countViews, countClick, candidates };
