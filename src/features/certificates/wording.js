/**
 * Certificate wording catalogue and date formatting.
 */
'use strict';

const DESIGNS = ['classic', 'modern', 'minimal', 'elegant'];

const TITLE_KINDS = ['attendance', 'completion', 'participation', 'achievement', 'appreciation', 'custom'];
const TITLES = {
  attendance: 'Certificate of Attendance',
  completion: 'Certificate of Completion',
  participation: 'Certificate of Participation',
  achievement: 'Certificate of Achievement',
  appreciation: 'Certificate of Appreciation',
};

const OPENER_IDS = ['certify', 'presented', 'recognition', 'awarded', 'custom'];
const OPENERS = {
  certify: 'This is to certify that',
  presented: 'This certificate is proudly presented to',
  recognition: 'In recognition of',
  awarded: 'Awarded to',
};

const BODY_IDS = ['attended', 'completed', 'participation', 'custom'];
const BODIES = {
  attended: 'has successfully attended',
  completed: 'has completed',
  participation: 'for active participation in',
};

function catalogue() {
  return {
    designs: DESIGNS.map((id) => ({ id, label: id[0].toUpperCase() + id.slice(1) })),
    titles: TITLE_KINDS.map((id) => ({ id, label: id === 'custom' ? 'Custom title' : TITLES[id] })),
    openers: OPENER_IDS.map((id) => ({ id, label: id === 'custom' ? 'Custom wording' : OPENERS[id] })),
    bodies: BODY_IDS.map((id) => ({ id, label: id === 'custom' ? 'Custom wording' : BODIES[id] })),
  };
}

function pickId(val, allowed, fallback) {
  const v = String(val || '').trim();
  return allowed.includes(v) ? v : fallback;
}

function sameDay(a, b) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

function formatOne(d) {
  if (!d || Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString('en-NG', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'Africa/Lagos' });
}

function formatDateRange(start, end) {
  const s = start ? new Date(start) : null;
  const e = end ? new Date(end) : null;
  const a = s && !Number.isNaN(s.getTime()) ? s : null;
  const b = e && !Number.isNaN(e.getTime()) ? e : null;
  if (!a && !b) return '';
  if (a && !b) return formatOne(a);
  if (!a && b) return formatOne(b);
  if (sameDay(a, b)) return formatOne(a);
  if (a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth()) {
    const day = a.toLocaleDateString('en-NG', { day: 'numeric', timeZone: 'Africa/Lagos' });
    return `${day}–${formatOne(b)}`;
  }
  return `${formatOne(a)} – ${formatOne(b)}`;
}

function linkedInUrl(cert) {
  const d = cert.issuedAt ? new Date(cert.issuedAt) : new Date();
  const params = new URLSearchParams({
    startTask: 'CERTIFICATION_NAME',
    name: cert.title || 'Certificate of Attendance',
    organizationName: cert.issuerName || cert.hostName || '1venue',
    issueYear: String(d.getFullYear()),
    issueMonth: String(d.getMonth() + 1),
    certUrl: cert.url || '',
    certId: cert.code || '',
  });
  return `https://www.linkedin.com/profile/add?${params}`;
}

module.exports = {
  DESIGNS, TITLE_KINDS, TITLES, OPENER_IDS, OPENERS, BODY_IDS, BODIES,
  catalogue, pickId, formatOne, formatDateRange, linkedInUrl,
};
