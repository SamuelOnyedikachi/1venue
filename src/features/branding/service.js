/**
 * Venue branding: logo, two colours, cover image and an about section. Images are uploaded with
 * the normal POST /api/files (purpose=cover/avatar) and their URL is saved here. Branding shows
 * only while the venue owner's plan includes it; Free venues render plain.
 *
 * Verified badge: admins grant it to Premium-and-up hosts. users.verified_active mirrors
 * "granted AND the plan includes the badge", refreshed on every plan change, and Discover ranks
 * events from verified hosts higher.
 */
const { q, one, many } = require('../../core/db');
const plans = require('../../lib/plans');
const config = require('../../config');
const fail = (status, message) => Object.assign(new Error(message), { status, expose: true });

const hex = (v) => (v == null || v === '' ? null : /^#[0-9a-fA-F]{6}$/.test(String(v)) ? String(v).toLowerCase() : undefined);
/** Accept our own file URLs (/files/...), the S3/R2 public base, or any https image URL. */
function imageUrl(v) {
  if (v == null || v === '') return null;
  const s = String(v).trim();
  if (s.length > 500) return undefined;
  if (/^\/files\/[\w-]+\/[^\s"'<>]+$/.test(s)) return s;
  try { const u = new URL(s); if (u.protocol === 'https:' && !u.username && !u.password) return u.href; } catch (_) {}
  const base = config.STORAGE && config.STORAGE.s3 && config.STORAGE.s3.publicBaseUrl;
  if (base && s.startsWith(base + '/')) return s;
  return undefined;
}
/** Validate a branding patch. Pure (unit tested). Unknown keys are ignored; bad values throw 400. */
function cleanBranding(b = {}) {
  const out = {};
  const set = (key, col, fn, label) => {
    if (b[key] === undefined) return;
    const v = fn(b[key]);
    if (v === undefined) throw fail(400, `${label} is not valid`);
    out[col] = v;
  };
  set('logoUrl', 'brand_logo_url', imageUrl, 'Logo');
  set('coverUrl', 'brand_cover_url', imageUrl, 'Cover image');
  set('accent', 'brand_accent', hex, 'Main colour');
  set('accent2', 'brand_accent2', hex, 'Second colour');
  set('about', 'brand_about', (v) => (v == null ? null : String(v).trim().slice(0, 2000) || null), 'About');
  return out;
}
/** Public branding for a venue, or null when the owner's plan does not include branding. */
async function publicBranding(venue) {
  if (!venue) return null;
  const ent = await plans.entitlements(venue.ownerUserId);
  if (!ent.features.branding) return null;
  const b = venue.brand || {};
  return Object.values(b).some(Boolean) ? b : null;
}
async function saveBranding(user, venue, patch) {
  const orgs = require('../orgs/service');
  if (!venue || !(await orgs.canManageVenue(user.id, venue))) throw fail(404, 'Venue not found');
  if (venue.archived) throw fail(403, 'This venue is archived on the current plan');
  const ent = await plans.entitlements(venue.ownerUserId);
  if (!ent.features.branding) throw Object.assign(fail(403, 'Branding is part of Premium. Upgrade to add a logo, colours and a cover.'), { upgrade: true });
  const v = cleanBranding(patch);
  const keys = Object.keys(v);
  if (keys.length) await q(`UPDATE venues SET ${keys.map((k, i) => `${k}=$${i + 2}`).join(', ')} WHERE id=$1`, [venue.id, ...keys.map((k) => v[k])]);
  return require('../venues/data').getVenueById(venue.id);
}

// ---------------------------------------------------------------- verified badge
async function refreshVerified(userId) {
  const ent = await plans.entitlements(userId);
  await q('UPDATE users SET verified_active=$2 WHERE id=$1', [userId, !!ent.features.badge]);
  await q('UPDATE users SET verified_active=$2 WHERE id=$1 AND verified_at IS NULL', [userId, false]);
}
async function setVerified(actorId, userId, on, note) {
  const u = await one('SELECT id, verified_at FROM users WHERE id=$1', [userId]);
  if (!u) throw fail(404, 'User not found');
  if (on) {
    const ent = await plans.entitlements(userId);
    if (!ent.features.badge) throw fail(409, 'The verified badge is for Premium and Organisation hosts. Give them a plan first.');
    await q('UPDATE users SET verified_at=NOW(), verified_by=$2, verified_note=$3, verified_active=$4 WHERE id=$1', [userId, actorId, note ? String(note).slice(0, 200) : null, true]);
  } else {
    await q('UPDATE users SET verified_at=NULL, verified_by=NULL, verified_note=$2, verified_active=$3 WHERE id=$1', [userId, note ? String(note).slice(0, 200) : null, false]);
  }
  await q('INSERT INTO plan_audit (user_id, actor_user_id, action, detail) VALUES ($1,$2,$3,$4)', [userId, actorId, on ? 'verified' : 'unverified', JSON.stringify({ note: note || null })]);
  return { userId, verified: !!on };
}
async function listVerified() {
  return (await many('SELECT id, username, display_name, email, verified_at, verified_active FROM users WHERE verified_at IS NOT NULL ORDER BY verified_at DESC LIMIT 200'))
    .map((r) => ({ id: r.id, username: r.username, name: r.display_name || r.username, email: r.email, verifiedAt: r.verified_at, active: !!r.verified_active }));
}
async function isVerified(userId) {
  const r = await one('SELECT verified_active FROM users WHERE id=$1', [userId]);
  return !!(r && r.verified_active);
}

module.exports = { cleanBranding, imageUrl, publicBranding, saveBranding, refreshVerified, setVerified, listVerified, isVerified };
