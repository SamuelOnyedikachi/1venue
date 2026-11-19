/**
 * venues queries (PostgreSQL, parameterised). Split out of src/venue/data.js;
 * src/venue/data.js still re-exports everything for older call sites.
 */
const crypto = require('crypto');
const { q, one, many } = require('../../core/db');

// ---------------------------------------------------------------- venues (permanent /v/{slug} rooms)
const SLUG_CH = 'abcdefghjkmnpqrstuvwxyz23456789';
const randSlug = () => Array.from(crypto.randomBytes(7), (b) => SLUG_CH[b % SLUG_CH.length]).join('');
const codes = require('../../lib/codes');
const randCode = () => codes.randCode(6); // same 6-char lowercase format as meeting codes
const venueOut = (r) => r && ({ id: r.id, slug: r.slug, code: r.code, name: r.name, ownerUserId: r.owner_user_id, createdAt: r.created_at, meetings: r.meetings != null ? Number(r.meetings) : undefined, lastHeld: r.last_held || null, openedAt: r.opened_at || null, activeHistoryId: r.active_history_id || null, isCustom: !!r.is_custom,
  slugTier: effectiveTier(r), reservedSlug: r.reserved_slug || null, linkReleaseAt: r.reserved_slug && r.link_parked_at ? require('../billing/shortlinks').releaseAt(r.link_parked_at).toISOString() : null, archivedAt: r.archived_at || null, archived: !!r.archived_at,
  orgId: r.org_id || null, brand: { logoUrl: r.brand_logo_url || null, coverUrl: r.brand_cover_url || null, accent: r.brand_accent || null, accent2: r.brand_accent2 || null, about: r.brand_about || null } });
const plans = require('../../lib/plans');
const httpErr = (status, message) => Object.assign(new Error(message), { status });
/** Effective subscription plan (free | premium | organisation). */
async function getUserPlan(userId) { return (await plans.entitlements(userId)).plan; }
async function slugTaken(slug, exceptId) {
  return !!(await one('SELECT 1 FROM venues WHERE (lower(slug)=lower($1) OR lower(reserved_slug)=lower($1)) AND id IS DISTINCT FROM $2 LIMIT 1', [slug, exceptId || null]));
}
/** Validate a requested custom slug for this user's plan (and the venue's add-on); throws 400/409. */
/** A venue's short-link tier: slug_addon, else the original slug_tier column. */
const effectiveTier = (r) => (r && plans.SLUG_TIERS.includes(r.slug_addon) ? r.slug_addon : r && plans.SLUG_TIERS.includes(r.slug_tier) ? r.slug_tier : 'none');
async function resolveCustomSlug(userId, input, opts = {}, exceptId, slugTier = 'none') {
  const { slug } = codes.customSlug(input, plans.slugRights(await getUserPlan(userId), slugTier), opts);
  if (await slugTaken(slug, exceptId)) { const e = new Error(`/v/${slug} is taken - try another`); e.status = 409; throw e; }
  return slug;
}
async function activeVenueCount(userId) {
  const r = await one('SELECT COUNT(*) AS n FROM venues WHERE owner_user_id=$1 AND archived_at IS NULL', [userId]);
  return Number(r ? r.n : 0);
}
async function createVenue(userId, name, customInput, opts = {}) {
  const ent = await plans.entitlements(userId);
  if (await activeVenueCount(userId) >= ent.limits.venues) {
    const label = ent.plan[0].toUpperCase() + ent.plan.slice(1);
    throw Object.assign(httpErr(403, `Your ${label} plan includes ${ent.limits.venues} venue${ent.limits.venues === 1 ? '' : 's'}. Upgrade to add more.`), { upgrade: true });
  }
  const custom = customInput ? await resolveCustomSlug(userId, customInput, opts) : null;
  for (let i = 0; i < 8; i++) {
    const slug = custom || randSlug(), code = randCode();
    const clash = await one(`SELECT 1 FROM venues WHERE lower(slug)=$1 OR lower(code)=$2 UNION ALL SELECT 1 FROM events WHERE lower(code)=$2 LIMIT 1`, [slug, code]).catch(() => null);
    if (clash) continue;
    return venueOut(await one('INSERT INTO venues (slug, code, name, owner_user_id, is_custom, org_id) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *', [slug, code, name, userId, !!custom, opts.orgId || null]));
  }
  throw new Error('Could not allocate a venue link');
}
async function myVenues(userId) {
  return (await many(`SELECT v.*, (SELECT COUNT(*) FROM meeting_history h WHERE h.code=v.code) AS meetings,
      (SELECT MAX(h.created_at) FROM meeting_history h WHERE h.code=v.code) AS last_held
    FROM venues v WHERE owner_user_id=$1 ORDER BY created_at DESC`, [userId])).map(venueOut);
}
async function getVenueBySlug(slug) { return venueOut(await one('SELECT * FROM venues WHERE slug=lower($1)', [String(slug || '')])); }
async function getVenueById(id) { return venueOut(await one('SELECT * FROM venues WHERE id=$1', [id])); }
async function getVenueByCode(code) { return venueOut(await one('SELECT * FROM venues WHERE lower(code)=lower($1)', [String(code || '')])); }
async function setVenueSlug(id, userId, input, opts) {
  const v = await one('SELECT slug_tier, slug_addon FROM venues WHERE id=$1 AND owner_user_id=$2', [id, userId]);
  if (!v) return null;
  const slug = await resolveCustomSlug(userId, input, opts, id, effectiveTier(v));
  return venueOut(await one('UPDATE venues SET slug=$3, is_custom=true, reserved_slug=NULL, link_parked_at=NULL, link_notice_days=NULL WHERE id=$1 AND owner_user_id=$2 RETURNING *', [id, userId, slug]));
}

// ---------------------------------------------------------------- plan changes (downgrade / re-upgrade)
/** Free-plan fallback for a clean or short link: base padded to 5 chars + "-venue", unique. */
async function fallbackSlug(base, exceptId) {
  const b = codes.slugifyBase(base).slice(0, 16);
  for (let i = 0; i < 8; i++) {
    let x = b.length >= 5 ? b : b + randSlug().slice(0, 5 - b.length);
    if (i > 0) x = x.slice(0, 12) + randSlug().slice(0, 4);
    const slug = `${x}-venue`;
    if (!(await slugTaken(slug, exceptId))) return slug;
  }
  return `${randSlug()}-venue`;
}
/**
 * Bring a user's venues in line with a plan: keep the oldest `limit` venues open and archive the rest
 * (read-only, hidden, restored later). On Free, clean/short custom links are parked for the owner and
 * the venue switches to a -venue fallback. On a paid plan, archived venues and parked links come back.
 * Short links (3/4-character add-ons) parked longer than SHORT_LINK_RELEASE_DAYS are released by
 * billing/shortlinks.js.
 */
async function applyPlanToVenues(userId, plan, limit) {
  const rows = await many('SELECT * FROM venues WHERE owner_user_id=$1 ORDER BY created_at ASC, id ASC', [userId]);
  const changes = { archived: 0, restored: 0, linksParked: 0, linksRestored: 0 };
  let open = 0;
  for (const r of rows) {
    if (open < limit) {
      open++;
      if (r.archived_at) { await q('UPDATE venues SET archived_at=NULL WHERE id=$1', [r.id]); changes.restored++; }
    } else if (!r.archived_at) {
      await q('UPDATE venues SET archived_at=NOW(), opened_at=NULL, active_history_id=NULL WHERE id=$1', [r.id]); changes.archived++;
    }
    const rights = plans.slugRights(plan, effectiveTier(r));
    if (!rights.clean && r.is_custom && !/-venue$/.test(r.slug)) {
      await q('UPDATE venues SET reserved_slug=$2, slug=$3, link_parked_at=NOW(), link_notice_days=NULL WHERE id=$1', [r.id, r.slug, await fallbackSlug(r.slug, r.id)]); changes.linksParked++;
    } else if (rights.clean && r.reserved_slug) {
      try { codes.customSlug(r.reserved_slug, rights); } catch (_) { continue; } // e.g. short link without its add-on
      await q('UPDATE venues SET slug=$2, reserved_slug=NULL, link_parked_at=NULL, link_notice_days=NULL WHERE id=$1', [r.id, r.reserved_slug]); changes.linksRestored++;
    }
  }
  return changes;
}
async function setVenueSlugTier(venueId, tier) {
  return venueOut(await one("UPDATE venues SET slug_addon=$2, slug_tier=CASE WHEN $2='slug3' THEN 'slug3' ELSE 'none' END WHERE id=$1 RETURNING *", [venueId, tier]));
}
async function renameVenue(id, userId, name) { return venueOut(await one('UPDATE venues SET name=$3 WHERE id=$1 AND owner_user_id=$2 RETURNING *', [id, userId, name])); }
async function deleteVenue(id, userId) { return (await q('DELETE FROM venues WHERE id=$1 AND owner_user_id=$2', [id, userId])).rowCount > 0; }
async function markVenueOpen(code, historyId) { await q('UPDATE venues SET opened_at=now(), active_history_id=$2 WHERE lower(code)=lower($1)', [String(code || ''), historyId || null]); }
async function markVenueClosed(code) { await q('UPDATE venues SET opened_at=NULL, active_history_id=NULL WHERE lower(code)=lower($1)', [String(code || '')]); }
async function venueMeetings(code, limit = 100) {
  return many(`SELECT id, name, host_display_name, created_at AS started_at, ended_at, max_participants FROM meeting_history WHERE code=$1 ORDER BY created_at DESC LIMIT $2`, [code, limit]);
}


// ---------------------------------------------------------------- venue admins & audit
async function addVenueAdmins(venueId, ownerId, usernames) {
  const names = [...new Set(String(usernames || '').split(/[,\s]+/).map(s => s.trim().toLowerCase().replace(/^@/, '')).filter(Boolean))];
  const added = [];
  const skipped = [];
  for (const uname of names) {
    // Match username or handle
    const u = await one(
      `SELECT id, username, display_name, handle FROM users
       WHERE lower(username)=lower($1)
          OR lower(COALESCE(handle,''))=lower($1)
       LIMIT 1`,
      [uname]
    );
    if (!u) { skipped.push(uname); continue; }
    if (u.id === ownerId) { skipped.push(uname + ' (owner)'); continue; }
    await q('INSERT INTO venue_admins (venue_id, user_id, added_by) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [venueId, u.id, ownerId]);
    const pub = u.username || u.handle;
    added.push({ id: u.id, username: pub, name: u.display_name || pub });
    await logVenueAudit(venueId, ownerId, null, 'admin-add', pub);
  }
  return { added, skipped };
}
async function removeVenueAdmin(venueId, ownerId, userId) {
  const r = await q('DELETE FROM venue_admins WHERE venue_id=$1 AND user_id=$2', [venueId, userId]);
  if (r.rowCount) await logVenueAudit(venueId, ownerId, null, 'admin-remove', String(userId));
  return r.rowCount > 0;
}
async function listVenueAdmins(venueId) {
  return (await many(`SELECT u.id, u.username, u.display_name, u.handle, va.added_at
    FROM venue_admins va JOIN users u ON u.id=va.user_id WHERE va.venue_id=$1 ORDER BY va.added_at`, [venueId]))
    .map(r => {
      const pub = r.username || r.handle;
      return { id: r.id, username: pub, name: r.display_name || pub, addedAt: r.added_at };
    });
}
async function isVenueAdmin(venueId, userId) {
  const r = await one('SELECT 1 FROM venue_admins WHERE venue_id=$1 AND user_id=$2', [venueId, userId]);
  if (r) return true;
  // Organisation venues: every member (owner, admin, moderator) can open and co-host them.
  const o = await one('SELECT 1 FROM venues v JOIN org_members m ON m.org_id=v.org_id WHERE v.id=$1 AND m.user_id=$2', [venueId, userId]).catch(() => null);
  return !!o;
}
async function logVenueAudit(venueId, actorId, actorName, action, detail) {
  await q('INSERT INTO venue_audit (venue_id, actor_user_id, actor_name, action, detail) VALUES ($1,$2,$3,$4,$5)',
    [venueId, actorId || null, actorName || null, action, detail || null]);
}
async function getVenueAudit(venueId, limit = 100) {
  return (await many(`SELECT a.*, u.username, u.display_name FROM venue_audit a
    LEFT JOIN users u ON u.id=a.actor_user_id WHERE a.venue_id=$1 ORDER BY a.created_at DESC LIMIT $2`, [venueId, limit]))
    .map(r => ({ id: r.id, actorId: r.actor_user_id, actorName: r.display_name || r.actor_name || r.username || 'Unknown', action: r.action, detail: r.detail, at: r.created_at }));
}

module.exports = { SLUG_CH, randSlug, codes, randCode, venueOut, getUserPlan, slugTaken, resolveCustomSlug, activeVenueCount, createVenue, myVenues, getVenueBySlug, getVenueById, applyPlanToVenues, setVenueSlugTier, fallbackSlug, getVenueByCode, setVenueSlug, renameVenue, deleteVenue, markVenueOpen, markVenueClosed, venueMeetings, addVenueAdmins, removeVenueAdmin, listVenueAdmins, isVenueAdmin, logVenueAudit, getVenueAudit };
