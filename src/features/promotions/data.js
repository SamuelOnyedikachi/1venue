const { USE_PG } = require('../../../db');
/**
 * Promotions: admin-picked events / posts shown as "Promoted" cards (sidebar on wide screens,
 * one inline card on phones). Views and clicks are simple counters.
 */
const { q, one, many } = require('../../core/db');
const { postOut, POST_SELECT } = require('../social/data');

const { PROMO_PLACEMENTS: PLACEMENTS } = require('../../lib/plans');
const EVENT_COLS = `e.id, e.slug, e.code, e.title, e.category, e.status, e.starts_at, e.cover_url, e.theme, e.host_name, e.visibility,
  u.username AS host_username, u.avatar_url AS host_avatar`;

function promoOut(r) {
  return {
    id: Number(r.id), type: r.target_type, placements: r.placements || [], startsAt: r.starts_at, endsAt: r.ends_at,
    active: r.active, weight: r.weight, note: r.note, views: r.views, clicks: r.clicks, createdAt: r.created_at,
    review: r.review_status || 'approved', days: r.days || null, ownerUserId: r.owner_user_id || null, selfServe: !!r.owner_user_id,
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
       AND ${USE_PG ? '$1::text = ANY(p.placements)' : 'EXISTS (SELECT 1 FROM json_each(p.placements) WHERE value=$1)'}
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


/** Profile-rail ads: profile-placement first, then other live promos. Skip the profile
 *  owner's own promotions unless nothing else is available. */
async function liveForProfile(profileUserId, { limit = 2, viewerId = 0 } = {}) {
  const cap = Math.min(6, Math.max(1, limit));
  const ownerId = Number(profileUserId) || 0;
  const base = `SELECT p.*, ${EVENT_COLS}, p.id AS id, e.host_user_id AS ev_host, po.user_id AS post_user
      FROM promotions p
      LEFT JOIN events e ON e.id = p.event_id
      LEFT JOIN users u ON u.id = e.host_user_id
      LEFT JOIN posts po ON po.id = p.post_id
     WHERE p.active AND p.starts_at <= NOW() AND (p.ends_at IS NULL OR p.ends_at > NOW())
       AND ((p.target_type = 'event' AND e.visibility = 'public' AND e.status IN ('scheduled','live','ended'))
         OR (p.target_type = 'post' AND po.id IS NOT NULL))`;
  async function fetchRows({ placement, excludeOwn, excludeIds, take }) {
    const params = [];
    const clauses = [base];
    if (placement) {
      params.push(placement);
      clauses.push(USE_PG ? `AND $${params.length}::text = ANY(p.placements)` : `AND EXISTS (SELECT 1 FROM json_each(p.placements) WHERE value=$${params.length})`);
    }
    if (excludeOwn) {
      params.push(ownerId);
      const n = params.length;
      clauses.push(`AND NOT (COALESCE(p.owner_user_id,0) = $${n}::int OR COALESCE(e.host_user_id,0) = $${n}::int OR COALESCE(po.user_id,0) = $${n}::int)`);
    }
    if (excludeIds && excludeIds.length) {
      params.push(excludeIds);
      clauses.push(`AND NOT (p.id = ANY($${params.length}::int[]))`);
    }
    params.push(take);
    const rows = await many(`${clauses.join(' ')} ORDER BY p.weight DESC, random() LIMIT $${params.length}::int`, params);
    return rows;
  }
  async function pack(rows) {
    const out = [];
    for (const r of rows) {
      const baseItem = { id: Number(r.id), type: r.target_type };
      if (r.target_type === 'event') out.push({ ...baseItem, event: eventCardOut({ ...r, id: r.event_id }) });
      else {
        const post = await one(`${POST_SELECT} WHERE p.id = $2`, [viewerId || 0, r.post_id]);
        if (post) out.push({ ...baseItem, post: postOut(post) });
      }
    }
    return out;
  }
  let items = [];
  const fill = async (step) => {
    if (items.length >= cap) return;
    const have = items.map((it) => it.id);
    const rows = await fetchRows({ ...step, excludeIds: have, take: cap - items.length });
    items = items.concat(await pack(rows));
  };
  // Prefer everyone else's ads. Only fall back to the profile owner's own promo
  // when no other live promo exists.
  await fill({ placement: 'profile', excludeOwn: true });
  await fill({ placement: null, excludeOwn: true });
  if (!items.length) {
    await fill({ placement: 'profile', excludeOwn: false });
    await fill({ placement: null, excludeOwn: false });
  }
  return items.slice(0, cap);
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

// ---------------------------------------------------------------- admin search, paging and CSV export
const STATUSES = ['live', 'scheduled', 'ended', 'paused', 'pending'];
/** Clean admin filters from query params: q, status, type, from, to (YYYY-MM-DD, on the start date). */
function adminFilters(sp) {
  const get = (k) => String((sp && sp.get ? sp.get(k) : sp && sp[k]) || '').trim();
  const day = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(new Date(v + 'T00:00:00Z').getTime()) ? v : null);
  const status = get('status').toLowerCase(), type = get('type').toLowerCase();
  return { q: get('q').slice(0, 100), status: STATUSES.includes(status) ? status : null, type: ['event', 'post'].includes(type) ? type : null, from: day(get('from')), to: day(get('to')) };
}
function adminWhere(f, now = new Date()) {
  const where = [], args = [];
  const arg = (v) => { args.push(v); return `$${args.length}`; };
  if (f.q) {
    const like = arg('%' + f.q.toLowerCase().replace(/[\\%_]/g, (c) => '\\' + c) + '%');
    where.push(`(lower(COALESCE(e.title,'')) LIKE ${like} ESCAPE '\\' OR lower(COALESCE(po.body,'')) LIKE ${like} ESCAPE '\\' OR lower(COALESCE(pu.display_name,'')) LIKE ${like} ESCAPE '\\' OR lower(COALESCE(pu.username,'')) LIKE ${like} ESCAPE '\\' OR lower(COALESCE(e.host_name,'')) LIKE ${like} ESCAPE '\\')`);
  }
  if (f.type) where.push(`p.target_type = ${arg(f.type)}`);
  if (f.status === 'paused') where.push(`p.active = ${arg(false)}`);
  if (f.status === 'pending') where.push(`p.review_status = ${arg('pending')}`);
  if (f.status === 'live') { const n = arg(now) + '::timestamptz'; where.push(`p.active = ${arg(true)} AND p.starts_at <= ${n} AND (p.ends_at IS NULL OR p.ends_at > ${n})`); }
  if (f.status === 'scheduled') where.push(`p.active = ${arg(true)} AND p.starts_at > ${arg(now)}::timestamptz`);
  if (f.status === 'ended') where.push(`p.active = ${arg(true)} AND p.ends_at IS NOT NULL AND p.ends_at <= ${arg(now)}::timestamptz`);
  if (f.from) where.push(`p.starts_at >= ${arg(new Date(f.from + 'T00:00:00Z'))}::timestamptz`);
  if (f.to) where.push(`p.starts_at < ${arg(new Date(new Date(f.to + 'T00:00:00Z').getTime() + 86400000))}::timestamptz`);
  return { sql: where.length ? 'WHERE ' + where.join(' AND ') : '', args };
}
const LIST_FROM = `FROM promotions p LEFT JOIN events e ON e.id = p.event_id LEFT JOIN posts po ON po.id = p.post_id LEFT JOIN users pu ON pu.id = po.user_id`;
const LIST_COLS = `p.*, e.slug AS ev_slug, e.title AS ev_title, e.status AS ev_status, e.host_name AS ev_host, po.body AS post_body, COALESCE(pu.display_name, pu.username) AS post_author`;
function listRowOut(r, now = new Date()) {
  const live = !!r.active && new Date(r.starts_at) <= now && (!r.ends_at || new Date(r.ends_at) > now);
  const state = !r.active ? 'paused' : live ? 'live' : new Date(r.starts_at) > now ? 'scheduled' : 'ended';
  return {
    ...promoOut(r),
    target: r.target_type === 'event'
      ? { id: Number(r.event_id), slug: r.ev_slug, title: r.ev_title, status: r.ev_status, host: r.ev_host || null }
      : { id: Number(r.post_id), title: String(r.post_body || '(photo post)').slice(0, 90), author: r.post_author },
    live, state,
  };
}
/** One page of the admin list matching filters: { promotions, total }. */
async function adminList(f, { limit = 5, offset = 0 } = {}) {
  const w = adminWhere(f);
  const total = Number((await one(`SELECT COUNT(*) AS n ${LIST_FROM} ${w.sql}`, w.args)).n);
  const rows = await many(`SELECT ${LIST_COLS} ${LIST_FROM} ${w.sql} ORDER BY p.active DESC, p.created_at DESC, p.id DESC LIMIT ${Math.min(200, Math.max(1, limit | 0))} OFFSET ${Math.max(0, offset | 0)}`, w.args);
  return { promotions: rows.map((r) => listRowOut(r)), total };
}
/** Every matching row, in batches (for the CSV export). */
async function* adminRows(f, batch = 500) {
  const w = adminWhere(f);
  for (let offset = 0; ; offset += batch) {
    const rows = await many(`SELECT ${LIST_COLS} ${LIST_FROM} ${w.sql} ORDER BY p.active DESC, p.created_at DESC, p.id DESC LIMIT ${batch} OFFSET ${offset}`, w.args);
    for (const r of rows) yield listRowOut(r);
    if (rows.length < batch) return;
  }
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
      WHERE p.kind='post' AND ($1::text = '' OR p.body ILIKE '%' || $1::text || '%' OR u.username ILIKE '%' || $1::text || '%') ORDER BY p.created_at DESC LIMIT 12`, [t]);
    return rows.map((r) => ({ id: Number(r.id), title: String(r.body || '(photo post)').slice(0, 90), sub: `${r.author} · post` }));
  }
  const rows = await many(`SELECT id, title, status, starts_at, host_name FROM events
    WHERE visibility='public' AND status NOT IN ('draft','cancelled') AND ($1::text = '' OR title ILIKE '%' || $1::text || '%' OR host_name ILIKE '%' || $1::text || '%' OR slug = $1::text)
    ORDER BY (status='live') DESC, COALESCE(starts_at, created_at) DESC LIMIT 12`, [t]);
  return rows.map((r) => ({ id: Number(r.id), title: r.title, sub: `${r.host_name || 'host'} · ${r.status}` }));
}

module.exports = { PLACEMENTS, STATUSES, adminFilters, adminList, adminRows, live, liveForProfile, list, create, update, remove, countViews, countClick, candidates };
