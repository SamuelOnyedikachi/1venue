/**
 * Issue attendance certificates once a meeting ends, then email and Notification-DM them.
 */
'use strict';
const crypto = require('node:crypto');
const { q, one, many } = require('../../core/db');
const { certificatePdf } = require('./pdf');
const config = require('../../config');

const DESIGNS = ['classic', 'modern', 'minimal'];
const DEFAULT_MIN = 10;

function asBool(v) { return v === true || v === 1 || v === 'true' || v === 'on'; }
function parseSettings(raw) {
  if (!raw) return {};
  if (typeof raw === 'object') return raw;
  try { return JSON.parse(raw) || {}; } catch { return {}; }
}
function normalizeCerts(input, fallback = {}) {
  const src = input && typeof input === 'object' ? input : {};
  const base = fallback && typeof fallback === 'object' ? fallback : {};
  const design = DESIGNS.includes(src.design) ? src.design : (DESIGNS.includes(base.design) ? base.design : 'classic');
  const minMinutes = Math.min(180, Math.max(1, parseInt(src.minMinutes ?? src.min_minutes ?? base.minMinutes ?? DEFAULT_MIN, 10) || DEFAULT_MIN));
  const enabled = src.enabled != null ? asBool(src.enabled) : asBool(base.enabled);
  return { enabled, design, minMinutes };
}

function code() { return crypto.randomBytes(5).toString('hex').toUpperCase(); }

function certOut(r) {
  if (!r) return null;
  const c = r.code;
  const path = `/cert/${c}`;
  return {
    code: c,
    historyId: Number(r.history_id),
    eventId: r.event_id ? Number(r.event_id) : null,
    userId: Number(r.user_id),
    attendeeName: r.attendee_name,
    eventTitle: r.event_title,
    hostName: r.host_name,
    design: r.design,
    accent: r.accent || '#2563eb',
    issuedAt: r.issued_at,
    url: config.siteUrl(path, { fallback: 'https://1venue.live' }),
    pdfUrl: config.siteUrl(`/api/certs/${c}/pdf`, { fallback: 'https://1venue.live' }),
  };
}

async function getByCode(codeValue) {
  return certOut(await one('SELECT * FROM certificates WHERE code=$1', [String(codeValue || '').toUpperCase()]));
}

function pdfFor(cert) {
  const issued = cert.issuedAt ? new Date(cert.issuedAt) : new Date();
  const date = issued.toLocaleDateString('en-NG', { year: 'numeric', month: 'long', day: 'numeric' });
  return certificatePdf({
    name: cert.attendeeName, title: cert.eventTitle, date, host: cert.hostName,
    code: cert.code, url: cert.url, accent: cert.accent, design: cert.design,
  });
}

function themeAccent(theme) {
  let t = theme;
  if (typeof t === 'string') { try { t = JSON.parse(t); } catch { t = {}; } }
  const a = t && t.accent;
  return (typeof a === 'string' && /^#[0-9a-fA-F]{6}$/.test(a)) ? a : '#2563eb';
}

function attendanceMs(logs, userId) {
  const rows = (logs || []).filter((r) => Number(r.user_id) === Number(userId));
  if (!rows.length) return 0;
  const joins = rows.map((r) => new Date(r.joined_at).getTime()).filter(Number.isFinite).sort((a, b) => a - b);
  const lefts = rows.map((r) => (r.left_at ? new Date(r.left_at).getTime() : Date.now())).filter(Number.isFinite).sort((a, b) => a - b);
  let ms = 0;
  for (let i = 0; i < joins.length; i++) {
    const end = lefts[i] || Date.now();
    if (end > joins[i]) ms += end - joins[i];
  }
  return ms;
}

async function issueForMeeting(meeting) {
  if (!meeting || !meeting.historyId) return [];
  let ev = null;
  if (meeting.eventId) ev = await one('SELECT * FROM events WHERE id=$1', [meeting.eventId]).catch(() => null);
  const evSettings = parseSettings(ev && ev.settings);
  const certs = normalizeCerts((meeting.settings && meeting.settings.certs) || evSettings.certs || {});
  if (!certs.enabled) return [];
  const minMs = certs.minMinutes * 60 * 1000;
  const db = require('../../../db');
  const logs = await db.getMeetingParticipantsLog(meeting.historyId);
  const ids = [...new Set(logs.map((r) => r.user_id).filter(Boolean).map(Number))];
  if (!ids.length) return [];
  const users = ids.length
    ? await many(`SELECT id, display_name, email FROM users WHERE id IN (${ids.map((_, i) => `$${i + 1}`).join(',')})`, ids)
    : [];
  const byId = new Map(users.map((u) => [Number(u.id), u]));
  const title = (ev && ev.title) || meeting.name || meeting.title || 'Event';
  const hostName = (ev && ev.host_name) || meeting.hostName || 'Host';
  const accent = themeAccent((ev && ev.theme) || (meeting.settings && meeting.settings.theme));
  const issued = [];
  for (const userId of ids) {
    if (attendanceMs(logs, userId) < minMs) continue;
    const u = byId.get(Number(userId));
    const name = (u && u.display_name) || (logs.find((r) => Number(r.user_id) === userId) || {}).display_name || 'Participant';
    let row;
    try {
      row = await one(
        `INSERT INTO certificates (code, history_id, event_id, user_id, attendee_name, event_title, host_name, design, accent)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         ON CONFLICT (history_id, user_id) DO NOTHING RETURNING *`,
        [code(), meeting.historyId, meeting.eventId || (ev && ev.id) || null, userId, String(name).slice(0, 120), String(title).slice(0, 200), String(hostName).slice(0, 120), certs.design, accent]
      );
    } catch (e) {
      console.warn('[certs] insert', e.message);
      continue;
    }
    if (!row) continue;
    const cert = certOut(row);
    issued.push(cert);
    deliver(u, cert).catch((e) => console.warn('[certs] deliver', e.message));
  }
  return issued;
}

async function deliver(user, cert) {
  if (!user || !user.id) return;
  try {
    await require('../messages/notify').send(user.id, {
      style: 'detailed',
      text: `Your certificate for ${cert.eventTitle} is ready. You can download it or share the verification link.`,
      links: [{ label: 'View certificate', href: `/cert/${cert.code}` }, { label: 'Download PDF', href: `/api/certs/${cert.code}/pdf` }],
      card: { kind: 'certificate', title: 'Certificate of attendance', subtitle: cert.eventTitle, link: `/cert/${cert.code}` },
    });
  } catch (e) { console.warn('[certs] notify', e.message); }
  if (user.email) {
    try {
      require('../mail/mailer').sendLater('certificate', user.email, {
        name: cert.attendeeName,
        event: cert.eventTitle,
        link: cert.url,
        pdf: cert.pdfUrl,
      });
    } catch (e) { console.warn('[certs] mail', e.message); }
  }
}

async function saveEventCerts(eventId, userId, patch) {
  const ev = await one('SELECT * FROM events WHERE id=$1 AND host_user_id=$2', [eventId, userId]);
  if (!ev) return null;
  const settings = parseSettings(ev.settings);
  settings.certs = normalizeCerts(patch, settings.certs);
  await q('UPDATE events SET settings=$2, updated_at=NOW() WHERE id=$1', [eventId, JSON.stringify(settings)]);
  return settings.certs;
}

function applyToMeeting(meeting, patch) {
  if (!meeting) return null;
  meeting.settings = meeting.settings || {};
  meeting.settings.certs = normalizeCerts(patch, meeting.settings.certs);
  return meeting.settings.certs;
}

module.exports = { DESIGNS, DEFAULT_MIN, normalizeCerts, getByCode, pdfFor, issueForMeeting, saveEventCerts, applyToMeeting, certOut, themeAccent };
