/**
 * Issue attendance certificates once a meeting ends, then email and Notification-DM them.
 */
'use strict';
const crypto = require('node:crypto');
const { q, one, many } = require('../../core/db');
const { certificatePdf } = require('./pdf');
const wording = require('./wording');
const signatures = require('./signatures');
const config = require('../../config');

const { DESIGNS, TITLE_KINDS, TITLES, OPENER_IDS, OPENERS, BODY_IDS, BODIES, pickId, formatDateRange, formatOne, linkedInUrl, catalogue } = wording;
const DEFAULT_MIN = 10;

function asBool(v) { return v === true || v === 1 || v === 'true' || v === 'on'; }
function parseSettings(raw) {
  if (!raw) return {};
  if (typeof raw === 'object') return raw;
  try { return JSON.parse(raw) || {}; } catch { return {}; }
}
function parseSnap(raw) {
  if (!raw) return null;
  if (typeof raw === 'object') return raw;
  try { return JSON.parse(raw) || null; } catch { return null; }
}

function normalizeSignatories(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const s of list.slice(0, 3)) {
    if (!s || typeof s !== 'object') continue;
    const name = String(s.name || '').trim().slice(0, 80);
    const role = String(s.role || '').trim().slice(0, 80);
    if (!name) continue;
    out.push({ name, role });
  }
  return out;
}

function normalizeCerts(input, fallback = {}) {
  const src = input && typeof input === 'object' ? input : {};
  const base = fallback && typeof fallback === 'object' ? fallback : {};
  const design = DESIGNS.includes(src.design) ? src.design : (DESIGNS.includes(base.design) ? base.design : 'classic');
  const minMinutes = Math.min(180, Math.max(1, parseInt(src.minMinutes ?? src.min_minutes ?? base.minMinutes ?? DEFAULT_MIN, 10) || DEFAULT_MIN));
  const enabled = src.enabled != null ? asBool(src.enabled) : asBool(base.enabled);
  const titleKind = pickId(src.titleKind || src.title_kind, TITLE_KINDS, base.titleKind || 'attendance');
  const titleCustom = String(src.titleCustom ?? (titleKind === 'custom' ? src.title : '') ?? base.titleCustom ?? '').trim().slice(0, 120);
  const title = titleKind === 'custom' ? (titleCustom || TITLES.attendance) : (TITLES[titleKind] || TITLES.attendance);
  const openerId = pickId(src.openerId || src.opener_id, OPENER_IDS, base.openerId || 'certify');
  const openerCustom = String(src.openerCustom ?? (openerId === 'custom' ? src.opener : '') ?? base.openerCustom ?? '').trim().slice(0, 160);
  const opener = openerId === 'custom' ? (openerCustom || OPENERS.certify) : (OPENERS[openerId] || OPENERS.certify);
  const bodyId = pickId(src.bodyId || src.body_id, BODY_IDS, base.bodyId || 'attended');
  const bodyCustom = String(src.bodyCustom ?? (bodyId === 'custom' ? src.body : '') ?? base.bodyCustom ?? '').trim().slice(0, 160);
  const body = bodyId === 'custom' ? (bodyCustom || BODIES.attended) : (BODIES[bodyId] || BODIES.attended);
  const description = String(src.description ?? base.description ?? '').trim().slice(0, 280);
  const programme = String(src.programme ?? src.programmeName ?? base.programme ?? '').trim().slice(0, 200);
  const issuerName = String(src.issuerName ?? base.issuerName ?? '').trim().slice(0, 120);
  const issuerLogoUrl = String(src.issuerLogoUrl ?? base.issuerLogoUrl ?? '').trim().slice(0, 500);
  const dateStart = src.dateStart || src.startsAt || base.dateStart || '';
  const dateEnd = src.dateEnd || src.endsAt || base.dateEnd || '';
  const signatories = normalizeSignatories(src.signatories || base.signatories || []);
  return {
    enabled, design, minMinutes,
    titleKind, titleCustom, title,
    openerId, openerCustom, opener,
    bodyId, bodyCustom, body,
    description, programme, issuerName, issuerLogoUrl,
    dateStart: dateStart || '', dateEnd: dateEnd || '',
    signatories,
  };
}

function code() { return crypto.randomBytes(5).toString('hex').toUpperCase(); }

function isUniqueViolation(e) {
  if (!e) return false;
  if (e.code === '23505') return true;
  return /UNIQUE constraint failed|duplicate key value|unique constraint/i.test(String(e.message || e));
}

function dateLabelFrom(snap, cert) {
  if (snap && snap.dateLabel) return snap.dateLabel;
  const label = formatDateRange(snap && (snap.dateStart || snap.startsAt), snap && (snap.dateEnd || snap.endsAt));
  if (label) return label;
  return formatOne(cert && cert.issuedAt ? new Date(cert.issuedAt) : new Date()) || formatOne(new Date());
}

function certOut(r) {
  if (!r) return null;
  const c = r.code;
  const path = `/cert/${c}`;
  const snap = parseSnap(r.snapshot) || {};
  const title = snap.title || 'Certificate of Attendance';
  const issuerName = snap.issuerName || r.host_name || '';
  const programme = snap.programme || r.event_title;
  const out = {
    code: c,
    historyId: Number(r.history_id),
    eventId: r.event_id ? Number(r.event_id) : null,
    eventSlug: r.event_slug || null,
    userId: Number(r.user_id),
    attendeeName: r.attendee_name,
    eventTitle: r.event_title,
    programme,
    hostName: r.host_name,
    issuerName,
    issuerLogoUrl: snap.issuerLogoUrl || null,
    title,
    opener: snap.opener || 'This is to certify that',
    body: snap.body || 'has successfully attended',
    description: snap.description || '',
    signatories: Array.isArray(snap.signatories) ? snap.signatories : [],
    design: r.design || snap.design || 'classic',
    accent: r.accent || snap.accent || '#2563eb',
    issuedAt: r.issued_at,
    dateLabel: dateLabelFrom(snap, { issuedAt: r.issued_at }),
    url: config.siteUrl(path, { fallback: 'https://1venue.live' }),
    pdfUrl: config.siteUrl(`/api/certs/${c}/pdf`, { fallback: 'https://1venue.live' }),
  };
  out.linkedinUrl = linkedInUrl(out);
  return out;
}

async function getByCode(codeValue) {
  const row = await one(
    `SELECT c.*, e.slug AS event_slug, e.starts_at AS event_starts_at, e.ends_at AS event_ends_at
       FROM certificates c
       LEFT JOIN events e ON e.id = c.event_id
      WHERE c.code=$1`,
    [String(codeValue || '').toUpperCase()]
  );
  return certOut(row);
}

async function userSignatureUrl(userId) {
  if (!userId) return null;
  const row = await one('SELECT image_url FROM user_signatures WHERE user_id=$1', [userId]).catch(() => null);
  return (row && row.image_url) || null;
}

async function resolveSignatories(list) {
  return normalizeSignatories(list || []);
}

function pdfPayload(cert, extras = {}) {
  const snap = cert.snapshot || {};
  return {
    name: extras.name || cert.attendeeName || cert.name || 'Participant',
    certTitle: extras.title || cert.title || snap.title || 'Certificate of Attendance',
    opener: extras.opener || cert.opener || snap.opener,
    body: extras.body || cert.body || snap.body,
    bodyId: extras.bodyId || cert.bodyId || snap.bodyId,
    programme: extras.programme || cert.programme || snap.programme || cert.eventTitle || cert.title,
    description: extras.description != null ? extras.description : (cert.description || snap.description || ''),
    date: extras.date || cert.dateLabel || dateLabelFrom(snap, cert),
    issuerName: extras.issuerName || cert.issuerName || snap.issuerName || cert.hostName,
    issuerLogoUrl: extras.issuerLogoUrl || cert.issuerLogoUrl || snap.issuerLogoUrl || null,
    signatories: extras.signatories || cert.signatories || snap.signatories || [],
    code: cert.code || extras.code || 'PREVIEW000',
    url: cert.url || extras.url || 'https://1venue.live/cert/PREVIEW000',
    accent: extras.accent || cert.accent || '#2563eb',
    design: extras.design || cert.design || 'classic',
  };
}

async function pdfFor(cert) {
  const signatories = await resolveSignatories(cert.signatories || (cert.snapshot && cert.snapshot.signatories) || []);
  return certificatePdf(pdfPayload(cert, { signatories }));
}

async function previewPdf(settings, { name, url, code: previewCode } = {}) {
  const certs = normalizeCerts(settings || {});
  const signatories = await resolveSignatories(certs.signatories);
  const programme = certs.programme || settings.eventTitle || settings.title || 'Your event title';
  const issuerName = certs.issuerName || settings.hostName || 'Host';
  const date = formatDateRange(certs.dateStart || settings.startsAt, certs.dateEnd || settings.endsAt) || formatOne(new Date());
  return certificatePdf({
    name: name || 'Alex Okonkwo',
    certTitle: certs.title,
    opener: certs.opener,
    body: certs.body,
    bodyId: certs.bodyId,
    programme,
    description: certs.description,
    date,
    issuerName,
    issuerLogoUrl: certs.issuerLogoUrl,
    signatories,
    code: previewCode || 'PREVIEW000',
    url: url || 'https://1venue.live/cert/PREVIEW000',
    accent: settings.accent || certs.accent || '#2563eb',
    design: certs.design,
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

async function lookupUsername(username) {
  const handle = String(username || '').trim().replace(/^@/, '');
  if (!handle) return null;
  return one(
    'SELECT id, username, display_name, avatar_url FROM users WHERE LOWER(username)=LOWER($1)',
    [handle]
  );
}

async function inviteSignatory({ eventId, host, signatory, eventTitle }) {
  const handle = String(signatory.username || '').trim().replace(/^@/, '');
  const u = signatory.userId
    ? await one('SELECT id, username, display_name, avatar_url FROM users WHERE id=$1', [signatory.userId])
    : await lookupUsername(handle);
  if (!u) return { ...signatory, error: 'not_found' };
  const name = signatory.name || u.display_name || u.username;
  const role = signatory.role || '';
  let existing = null;
  if (eventId) {
    existing = await one(
      `SELECT * FROM cert_sign_requests
        WHERE event_id=$1 AND user_id=$2 AND status IN ('pending','signed')
        ORDER BY id DESC LIMIT 1`,
      [eventId, u.id]
    ).catch(() => null);
  }
  if (existing) {
    return {
      ...signatory,
      name, role,
      source: 'account',
      userId: Number(u.id),
      username: u.username,
      requestId: Number(existing.id),
      signatureUrl: existing.signature_url || signatory.signatureUrl || await userSignatureUrl(u.id),
      status: existing.signature_url ? 'signed' : existing.status,
    };
  }
  const token = crypto.randomBytes(18).toString('base64url');
  const row = await one(
    `INSERT INTO cert_sign_requests (token, event_id, requested_by, user_id, name, role, status)
     VALUES ($1,$2,$3,$4,$5,$6,'pending') RETURNING *`,
    [token, eventId || null, host.id, u.id, name, role]
  );
  try {
    await require('../messages/notify').send(u.id, {
      style: 'detailed',
      text: `${host.displayName || host.display_name || 'A host'} has asked you to sign certificates${eventTitle ? ` for ${eventTitle}` : ''}${role ? ` as ${role}` : ''}. Open the link to draw or approve your signature.`,
      links: [{ label: 'Sign the certificate', href: `/cert-sign/${token}` }],
      card: { kind: 'signature', title: 'Signature requested', subtitle: eventTitle || 'Certificate', link: `/cert-sign/${token}` },
    });
  } catch (e) { console.warn('[certs] signatory notify', e.message); }
  return {
    ...signatory,
    name, role,
    source: 'account',
    userId: Number(u.id),
    username: u.username,
    requestId: Number(row.id),
    signatureUrl: await userSignatureUrl(u.id),
    status: 'pending',
  };
}

async function ensureSignatories(list, { eventId, host, eventTitle } = {}) {
  const out = [];
  for (const s of normalizeSignatories(list)) {
    if (s.source === 'account' && (s.username || s.userId) && host && host.id) {
      const invited = await inviteSignatory({ eventId, host, signatory: s, eventTitle });
      if (invited.error === 'not_found') {
        const err = new Error(`No 1venue account named ${s.username || 'that user'}`);
        err.status = 404;
        throw err;
      }
      out.push(invited);
    } else {
      out.push(s);
    }
  }
  return out;
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
  const hostName = certs.issuerName || (ev && ev.host_name) || meeting.hostName || 'Host';
  const accent = themeAccent((ev && ev.theme) || (meeting.settings && meeting.settings.theme));
  const signatories = await resolveSignatories(certs.signatories);
  const dateLabel = formatDateRange(certs.dateStart || (ev && ev.starts_at), certs.dateEnd || (ev && ev.ends_at)) || formatOne(new Date());
  const snapshot = {
    ...certs,
    programme: certs.programme || title,
    issuerName: hostName,
    issuerLogoUrl: certs.issuerLogoUrl || '',
    dateLabel,
    dateStart: certs.dateStart || (ev && ev.starts_at) || null,
    dateEnd: certs.dateEnd || (ev && ev.ends_at) || null,
    signatories,
    accent,
  };
  const snapJson = JSON.stringify(snapshot);
  const issued = [];
  for (const userId of ids) {
    if (attendanceMs(logs, userId) < minMs) continue;
    const u = byId.get(Number(userId));
    const name = (u && u.display_name) || (logs.find((r) => Number(r.user_id) === userId) || {}).display_name || 'Participant';
    let row;
    let skipped = false;
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        row = await one(
          `INSERT INTO certificates (code, history_id, event_id, user_id, attendee_name, event_title, host_name, design, accent, snapshot)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
           ON CONFLICT (history_id, user_id) DO NOTHING RETURNING *`,
          [code(), meeting.historyId, meeting.eventId || (ev && ev.id) || null, userId, String(name).slice(0, 120), String(title).slice(0, 200), String(hostName).slice(0, 120), certs.design, accent, snapJson]
        );
        break;
      } catch (e) {
        if (isUniqueViolation(e) && attempt < 4) continue;
        console.warn('[certs] insert', e.message);
        skipped = true;
        break;
      }
    }
    if (skipped || !row) continue;
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
      card: { kind: 'certificate', title: cert.title || 'Certificate', subtitle: cert.eventTitle, link: `/cert/${cert.code}` },
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

async function saveEventCerts(eventId, user, patch) {
  const userId = typeof user === 'object' ? user.id : user;
  const ev = await one('SELECT * FROM events WHERE id=$1 AND host_user_id=$2', [eventId, userId]);
  if (!ev) return null;
  const settings = parseSettings(ev.settings);
  const certs = normalizeCerts(patch, settings.certs);
  settings.certs = certs;
  await q('UPDATE events SET settings=$2, updated_at=NOW() WHERE id=$1', [eventId, JSON.stringify(settings)]);
  return settings.certs;
}

function applyToMeeting(meeting, patch) {
  if (!meeting) return null;
  meeting.settings = meeting.settings || {};
  meeting.settings.certs = normalizeCerts(patch, meeting.settings.certs);
  return meeting.settings.certs;
}

async function getSignRequest(token) {
  if (!token) return null;
  const row = await one(
    `SELECT r.*, e.title AS event_title, e.slug AS event_slug, u.username, u.display_name, u.avatar_url
       FROM cert_sign_requests r
       LEFT JOIN events e ON e.id = r.event_id
       JOIN users u ON u.id = r.user_id
      WHERE r.token=$1`,
    [String(token)]
  );
  if (!row) return null;
  const saved = await userSignatureUrl(row.user_id);
  return {
    token: row.token,
    requestId: Number(row.id),
    eventId: row.event_id ? Number(row.event_id) : null,
    eventTitle: row.event_title || 'Event',
    eventSlug: row.event_slug || null,
    userId: Number(row.user_id),
    username: row.username,
    displayName: row.display_name,
    avatarUrl: row.avatar_url,
    name: row.name || row.display_name || row.username,
    role: row.role || '',
    status: row.status,
    signatureUrl: row.signature_url || saved || null,
    savedSignatureUrl: saved || null,
    signedAt: row.signed_at,
  };
}

async function applySignedUrl(request, url, { saveToProfile = true } = {}) {
  await q(
    `UPDATE cert_sign_requests SET signature_url=$2, status='signed', signed_at=NOW() WHERE id=$1`,
    [request.requestId || request.id, url]
  );
  if (saveToProfile && request.userId) {
    const existing = await one('SELECT id FROM user_signatures WHERE user_id=$1', [request.userId]).catch(() => null);
    if (existing) await q('UPDATE user_signatures SET image_url=$2, updated_at=NOW() WHERE user_id=$1', [request.userId, url]);
    else await q('INSERT INTO user_signatures (user_id, image_url) VALUES ($1,$2)', [request.userId, url]);
  }
  if (request.eventId) {
    const ev = await one('SELECT id, settings FROM events WHERE id=$1', [request.eventId]).catch(() => null);
    if (ev) {
      const settings = parseSettings(ev.settings);
      const certs = normalizeCerts(settings.certs || {});
      certs.signatories = (certs.signatories || []).map((s) => {
        const match = Number(s.requestId) === Number(request.requestId) || Number(s.userId) === Number(request.userId);
        return match ? { ...s, signatureUrl: url, status: 'signed' } : s;
      });
      settings.certs = certs;
      await q('UPDATE events SET settings=$2, updated_at=NOW() WHERE id=$1', [ev.id, JSON.stringify(settings)]);
    }
  }
  return getSignRequest(request.token);
}

async function saveUserSignature(userId, url) {
  const existing = await one('SELECT id FROM user_signatures WHERE user_id=$1', [userId]).catch(() => null);
  if (existing) await q('UPDATE user_signatures SET image_url=$2, updated_at=NOW() WHERE user_id=$1', [userId, url]);
  else await q('INSERT INTO user_signatures (user_id, image_url) VALUES ($1,$2)', [userId, url]);
  return { url };
}

async function getUserSignature(userId) {
  const row = await one('SELECT image_url, updated_at FROM user_signatures WHERE user_id=$1', [userId]).catch(() => null);
  return row ? { url: row.image_url, updatedAt: row.updated_at } : null;
}

module.exports = {
  DESIGNS, DEFAULT_MIN, catalogue,
  normalizeCerts, getByCode, pdfFor, previewPdf, issueForMeeting,
  saveEventCerts, applyToMeeting, certOut, themeAccent,
  lookupUsername, ensureSignatories, getSignRequest, applySignedUrl,
  saveUserSignature, getUserSignature, resolveSignatories, pdfPayload,
  signatures,
};
