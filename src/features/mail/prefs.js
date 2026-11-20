/**
 * Email notification preferences (user_prefs.extra.email) and unsubscribe tokens.
 * Security / account mail (verify, reset, …) is always allowed.
 */
const crypto = require('crypto');
const { one, q } = require('../../core/db');
const config = require('../../config');

const OPTIONAL = {
  speakerInvite: 'speakerInvites',
  speakerInviteReminder: 'speakerInvites',
  rsvpConfirm: 'rsvp',
  reminder: 'reminders',
};
const DEFAULTS = { speakerInvites: true, rsvp: true, reminders: true };

function parseExtra(raw) {
  let x = raw;
  if (typeof x === 'string') { try { x = JSON.parse(x); } catch (_) { x = {}; } }
  return x && typeof x === 'object' ? x : {};
}
async function extraOf(userId) {
  if (!userId) return {};
  const r = await one('SELECT extra FROM user_prefs WHERE user_id=$1', [userId]).catch(() => null);
  return parseExtra(r && r.extra);
}
function emailPrefsFrom(extra) {
  const e = (extra && extra.email && typeof extra.email === 'object') ? extra.email : {};
  return {
    speakerInvites: e.speakerInvites !== false,
    rsvp: e.rsvp !== false,
    reminders: e.reminders !== false,
  };
}
async function getEmailPrefs(userId) { return emailPrefsFrom(await extraOf(userId)); }

async function setEmailPrefs(userId, patch = {}) {
  const cur = await extraOf(userId);
  const email = { ...emailPrefsFrom(cur), ...patch };
  for (const k of Object.keys(DEFAULTS)) if (email[k] !== undefined) email[k] = !!email[k];
  const next = { ...cur, email };
  await q(`INSERT INTO user_prefs (user_id, extra, updated_at) VALUES ($1,$2,NOW())
    ON CONFLICT (user_id) DO UPDATE SET extra=$2, updated_at=NOW()`, [userId, JSON.stringify(next)]);
  return emailPrefsFrom(next);
}

function allowedKind(kind, prefs) {
  const key = OPTIONAL[kind];
  if (!key) return true;
  return prefs[key] !== false;
}

async function canSend(userId, kind) {
  if (!config.NOTIFY.emailEnabled && OPTIONAL[kind]) return false;
  if (!OPTIONAL[kind]) return true;
  if (!userId) return config.NOTIFY.emailEnabled;
  return allowedKind(kind, await getEmailPrefs(userId));
}

function unsubToken(userId, kind = 'all') {
  const payload = `${Number(userId)}.${kind}.${Date.now()}`;
  const sig = crypto.createHmac('sha256', config.JWT_SECRET).update(payload).digest('base64url');
  return Buffer.from(`${payload}.${sig}`).toString('base64url');
}
function parseUnsubToken(token) {
  try {
    const raw = Buffer.from(String(token || ''), 'base64url').toString('utf8');
    const parts = raw.split('.');
    if (parts.length < 4) return null;
    const [id, kind, ts, ...rest] = parts;
    const sig = rest.join('.');
    const payload = `${id}.${kind}.${ts}`;
    const expect = crypto.createHmac('sha256', config.JWT_SECRET).update(payload).digest('base64url');
    if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expect))) return null;
    if (Date.now() - Number(ts) > 90 * 24 * 3600 * 1000) return null; // 90 days
    return { userId: Number(id), kind };
  } catch (_) { return null; }
}
function unsubUrl(userId, kind) {
  const base = (config.PUBLIC_URL || '').replace(/\/$/, '') || '';
  return `${base}/unsubscribe?t=${unsubToken(userId, kind)}`;
}

async function applyUnsubscribe(tokenOrUserId, kind) {
  const p = kind ? { userId: Number(tokenOrUserId), kind } : parseUnsubToken(tokenOrUserId);
  if (!p || !p.userId) return null;
  const map = { speakerInvites: { speakerInvites: false }, speakerInvite: { speakerInvites: false }, rsvp: { rsvp: false }, rsvpConfirm: { rsvp: false }, reminders: { reminders: false }, reminder: { reminders: false }, all: { speakerInvites: false, rsvp: false, reminders: false } };
  const patch = map[p.kind] || map.all;
  const prefs = await setEmailPrefs(p.userId, patch);
  return { userId: p.userId, prefs };
}

async function sendOpt(kind, to, data = {}, { userId } = {}) {
  if (!(await canSend(userId, kind))) return { sent: false, reason: 'opted-out' };
  const payload = { ...data };
  if (userId && !payload.unsubUrl) payload.unsubUrl = unsubUrl(userId, kind);
  return require('./mailer').send(kind, to, payload);
}
function sendOptLater(kind, to, data, opts) { setImmediate(() => { sendOpt(kind, to, data, opts).catch(() => {}); }); }

module.exports = { OPTIONAL, getEmailPrefs, setEmailPrefs, canSend, unsubToken, parseUnsubToken, unsubUrl, applyUnsubscribe, emailPrefsFrom, sendOpt, sendOptLater };
