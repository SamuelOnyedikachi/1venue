/**
 * Organisations. One organisation per owner (the account that pays for the Organisation plan).
 * Org venues are owned by the org owner (so the owner's plan limits apply to them) and carry org_id.
 *
 * Roles and permissions:
 *   moderator  view the org, open and co-host org venues, use the shared library
 *   admin      + manage org venues (create, branding), manage the library, invite/remove moderators
 *   owner      + invite/remove admins, change roles, rename and delete the org
 */
const crypto = require('node:crypto');
const { q, tx, one, many } = require('../../core/db');
const plans = require('../../lib/plans');
const fail = (status, message) => Object.assign(new Error(message), { status, expose: true });

const RANK = { moderator: 1, admin: 2, owner: 3 };
const PERMS = {
  'org.view': 'moderator', 'venue.open': 'moderator', 'library.use': 'moderator',
  'venue.manage': 'admin', 'venue.create': 'admin', 'library.manage': 'admin', 'members.invite': 'admin', 'members.view': 'admin',
  'members.admin': 'owner', 'org.manage': 'owner', 'org.delete': 'owner',
};
/** Pure permission check: does `role` allow `perm`? */
function can(role, perm) { const need = PERMS[perm]; return !!(need && RANK[role] && RANK[role] >= RANK[need]); }
/** Can `actor` invite, remove or assign someone with role `target`? Admins manage moderators only; the owner manages everyone but cannot remove themselves. */
function canManageRole(actor, target) {
  if (target === 'owner') return false;
  if (actor === 'owner') return true;
  return actor === 'admin' && target === 'moderator';
}

const orgOut = (r) => r && ({ id: r.id, name: r.name, ownerUserId: r.owner_user_id, createdAt: r.created_at, role: r.role || undefined });
async function roleOf(orgId, userId) {
  if (!orgId || !userId) return null;
  const r = await one('SELECT role FROM org_members WHERE org_id=$1 AND user_id=$2', [orgId, userId]);
  return r ? r.role : null;
}
async function requireRole(orgId, userId, perm) {
  const org = await one('SELECT * FROM organisations WHERE id=$1', [orgId]);
  if (!org) throw fail(404, 'Organisation not found');
  const role = await roleOf(orgId, userId);
  if (!role) throw fail(404, 'Organisation not found');
  if (!can(role, perm)) throw fail(403, `Your role (${role}) cannot do that`);
  return { org, role };
}
/** Owner, or an org admin of the venue's organisation. Used for branding and other venue settings. */
async function canManageVenue(userId, venue) {
  if (!venue || !userId) return false;
  if (venue.ownerUserId === userId) return true;
  if (!venue.orgId) return false;
  return can(await roleOf(venue.orgId, userId), 'venue.manage');
}
async function memberLimit(org) {
  const ent = await plans.entitlements(org.owner_user_id);
  return plans.featuresFor(await plans.getSettings(), ent.plan).orgMembers;
}

async function create(user, name) {
  const n = String(name || '').trim().slice(0, 80);
  if (n.length < 2) throw fail(400, 'Organisation name must be at least 2 characters');
  const ent = await plans.entitlements(user.id);
  if (!plans.featuresFor(await plans.getSettings(), ent.plan).orgMembers) throw Object.assign(fail(403, 'Organisations need the Organisation plan. Upgrade to create one.'), { upgrade: true });
  if (await one('SELECT 1 FROM organisations WHERE owner_user_id=$1', [user.id])) throw fail(409, 'You already own an organisation');
  return tx(async (c) => {
    const org = (await c.query('INSERT INTO organisations (name, owner_user_id) VALUES ($1,$2) RETURNING *', [n, user.id])).rows[0];
    await c.query("INSERT INTO org_members (org_id, user_id, role, added_by) VALUES ($1,$2,'owner',$2)", [org.id, user.id]);
    return orgOut({ ...org, role: 'owner' });
  });
}
async function mine(userId) {
  return (await many('SELECT o.*, m.role FROM org_members m JOIN organisations o ON o.id=m.org_id WHERE m.user_id=$1 ORDER BY o.id', [userId])).map(orgOut);
}
async function detail(orgId, userId) {
  const { org, role } = await requireRole(orgId, userId, 'org.view');
  const [members, invites, venues, library, limit] = await Promise.all([
    many('SELECT m.user_id, m.role, m.created_at, u.username, u.display_name, u.email FROM org_members m JOIN users u ON u.id=m.user_id WHERE m.org_id=$1 ORDER BY m.created_at', [orgId]),
    can(role, 'members.view') ? many('SELECT id, email, role, expires_at, created_at FROM org_invites WHERE org_id=$1 AND accepted_at IS NULL AND expires_at > NOW() ORDER BY id DESC', [orgId]) : [],
    many('SELECT id, slug, name, code, archived_at FROM venues WHERE org_id=$1 ORDER BY created_at', [orgId]),
    many('SELECT id, title, kind, owner_user_id, updated_at FROM materials WHERE org_id=$1 ORDER BY updated_at DESC LIMIT 200', [orgId]),
    memberLimit(org),
  ]);
  const showEmail = can(role, 'members.view');
  return {
    org: orgOut({ ...org, role }), role, memberLimit: limit,
    permissions: Object.fromEntries(Object.keys(PERMS).map((p) => [p, can(role, p)])),
    members: members.map((m) => ({ userId: m.user_id, role: m.role, username: m.username, name: m.display_name || m.username, email: showEmail ? m.email : undefined, since: m.created_at })),
    invites: invites.map((i) => ({ id: Number(i.id), email: i.email, role: i.role, expiresAt: i.expires_at })),
    venues: venues.map((v) => ({ id: v.id, slug: v.slug, name: v.name, code: v.code, archived: !!v.archived_at })),
    library: library.map((m) => ({ id: m.id, title: m.title, kind: m.kind, ownerUserId: m.owner_user_id, updatedAt: m.updated_at })),
  };
}
async function rename(orgId, userId, name) {
  await requireRole(orgId, userId, 'org.manage');
  const n = String(name || '').trim().slice(0, 80);
  if (n.length < 2) throw fail(400, 'Organisation name must be at least 2 characters');
  await q('UPDATE organisations SET name=$2 WHERE id=$1', [orgId, n]);
  return detail(orgId, userId);
}
async function remove(orgId, userId) {
  await requireRole(orgId, userId, 'org.delete');
  // Venues and materials stay with their owners (org_id becomes NULL via ON DELETE SET NULL).
  await q('DELETE FROM organisations WHERE id=$1', [orgId]);
  return { ok: true };
}

const hash = (t) => crypto.createHash('sha256').update(String(t)).digest('hex');
async function invite(orgId, actor, { email, role } = {}) {
  const { org, role: actorRole } = await requireRole(orgId, actor.id, 'members.invite');
  const e = String(email || '').trim().toLowerCase();
  if (!/^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/.test(e)) throw fail(400, 'Enter a valid email address');
  if (!['admin', 'moderator'].includes(role)) throw fail(400, 'Choose admin or moderator');
  if (!canManageRole(actorRole, role)) throw fail(403, 'Only the owner can invite admins');
  const limit = await memberLimit(org);
  const used = Number((await one('SELECT (SELECT COUNT(*) FROM org_members WHERE org_id=$1) + (SELECT COUNT(*) FROM org_invites WHERE org_id=$1 AND accepted_at IS NULL AND expires_at > NOW()) AS n', [orgId])).n);
  if (used >= limit) throw Object.assign(fail(403, `Your plan allows ${limit} members (including pending invites)`), { upgrade: true });
  if (await one('SELECT 1 FROM org_members m JOIN users u ON u.id=m.user_id WHERE m.org_id=$1 AND lower(u.email)=$2', [orgId, e])) throw fail(409, 'That person is already a member');
  const token = crypto.randomBytes(24).toString('hex');
  await q("DELETE FROM org_invites WHERE org_id=$1 AND lower(email)=$2 AND accepted_at IS NULL", [orgId, e]);
  await q('INSERT INTO org_invites (org_id, email, role, token_hash, invited_by, expires_at) VALUES ($1,$2,$3,$4,$5,$6)', [orgId, e, role, hash(token), actor.id, new Date(Date.now() + 7 * 86400000)]);
  const config = require('../../config');
  const link = new URL(`/host?invite=${token}`, config.PUBLIC_URL || 'https://1venue.live').href;
  require('../mail/mailer').sendLater('orgInvite', e, { org: org.name, inviter: actor.displayName || actor.username, role, link });
  return { ok: true, email: e, role };
}
async function revokeInvite(orgId, actorId, inviteId) {
  const { role } = await requireRole(orgId, actorId, 'members.invite');
  const inv = await one('SELECT * FROM org_invites WHERE id=$1 AND org_id=$2', [inviteId, orgId]);
  if (!inv) throw fail(404, 'Invite not found');
  if (!canManageRole(role, inv.role)) throw fail(403, 'Only the owner can cancel admin invites');
  await q('DELETE FROM org_invites WHERE id=$1', [inviteId]);
  return { ok: true };
}
async function accept(user, token) {
  const inv = await one('SELECT * FROM org_invites WHERE token_hash=$1', [hash(token || '')]);
  if (!inv || inv.accepted_at || new Date(inv.expires_at) <= new Date()) throw fail(404, 'This invite has expired or was already used');
  if (String(user.email || '').toLowerCase() !== inv.email) throw fail(403, `This invite was sent to ${inv.email}. Sign in with that email to accept it.`);
  await tx(async (c) => {
    await c.query('INSERT INTO org_members (org_id, user_id, role, added_by) VALUES ($1,$2,$3,$4) ON CONFLICT (org_id, user_id) DO NOTHING', [inv.org_id, user.id, inv.role, inv.invited_by]);
    await c.query('UPDATE org_invites SET accepted_at=NOW(), accepted_by=$2 WHERE id=$1', [inv.id, user.id]);
  });
  try { require('../../lib/auth').forgetUser(user.id); } catch (_) {}
  return orgOut({ ...(await one('SELECT * FROM organisations WHERE id=$1', [inv.org_id])), role: inv.role });
}
async function setRole(orgId, actorId, targetId, role) {
  const { role: actorRole } = await requireRole(orgId, actorId, 'members.invite');
  const cur = await roleOf(orgId, targetId);
  if (!cur) throw fail(404, 'Member not found');
  if (!['admin', 'moderator'].includes(role)) throw fail(400, 'Choose admin or moderator');
  if (!canManageRole(actorRole, cur) || !canManageRole(actorRole, role)) throw fail(403, 'Only the owner can change admins');
  await q('UPDATE org_members SET role=$3 WHERE org_id=$1 AND user_id=$2', [orgId, targetId, role]);
  return detail(orgId, actorId);
}
async function removeMember(orgId, actorId, targetId) {
  const cur = await roleOf(orgId, targetId);
  if (!cur) throw fail(404, 'Member not found');
  if (actorId === targetId && cur !== 'owner') { await q('DELETE FROM org_members WHERE org_id=$1 AND user_id=$2', [orgId, targetId]); return { ok: true, left: true }; }
  const { role } = await requireRole(orgId, actorId, 'members.invite');
  if (!canManageRole(role, cur)) throw fail(403, cur === 'owner' ? 'The owner cannot be removed' : 'Only the owner can remove admins');
  await q('DELETE FROM org_members WHERE org_id=$1 AND user_id=$2', [orgId, targetId]);
  return { ok: true };
}

// ---------------------------------------------------------------- venues and library
async function createVenue(orgId, actor, { name, customSlug } = {}) {
  const { org } = await requireRole(orgId, actor.id, 'venue.create');
  const n = String(name || '').trim().slice(0, 60);
  if (n.length < 2) throw fail(400, 'Venue name must be at least 2 characters');
  // Org venues belong to the org owner, so the owner's plan venue limit applies.
  return require('../venues/data').createVenue(org.owner_user_id, n, customSlug || null, { orgId });
}
async function attachVenue(orgId, actorId, venueId, attach = true) {
  const { org } = await requireRole(orgId, actorId, 'org.manage');
  const r = await q(`UPDATE venues SET org_id=$3 WHERE id=$1 AND owner_user_id=$2`, [venueId, org.owner_user_id, attach ? orgId : null]);
  if (!r.rowCount) throw fail(404, 'Venue not found');
  return { ok: true };
}
async function shareMaterial(orgId, actorId, materialId, share = true) {
  await requireRole(orgId, actorId, 'library.manage');
  const r = share
    ? await q('UPDATE materials SET org_id=$3 WHERE id=$1 AND owner_user_id=$2', [materialId, actorId, orgId])
    : await q('UPDATE materials SET org_id=NULL WHERE id=$1 AND org_id=$2', [materialId, orgId]);
  if (!r.rowCount) throw fail(404, share ? 'Only your own materials can be added to the library' : 'Material not in this library');
  return { ok: true };
}

module.exports = { RANK, PERMS, can, canManageRole, roleOf, requireRole, canManageVenue, create, mine, detail, rename, remove, invite, revokeInvite, accept, setRole, removeMember, createVenue, attachVenue, shareMaterial };
