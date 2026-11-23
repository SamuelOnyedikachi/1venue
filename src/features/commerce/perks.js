/**
 * Ticket-tier perks. Suggested from the tier name and price rank; the host can toggle each one.
 */
const KEYS = ['badge', 'skipWaitingRoom', 'priorityQa', 'earlyEntry', 'backstage'];
const LABELS = {
  badge: 'Badge and coloured name',
  skipWaitingRoom: 'Skip the waiting room',
  priorityQa: 'Priority questions',
  earlyEntry: 'Early entry (15 minutes)',
  backstage: 'Backstage room',
};
const EARLY_MS = 15 * 60 * 1000;
const VIP = /\b(vip|premium|gold|platinum|vvip|backstage)\b/i;

function parsePerks(raw) {
  if (!raw) return {};
  let o = raw;
  if (typeof raw === 'string') { try { o = JSON.parse(raw); } catch { return {}; } }
  if (!o || typeof o !== 'object') return {};
  const out = {};
  for (const k of KEYS) if (o[k]) out[k] = true;
  return out;
}

function normalizePerks(raw) {
  const p = parsePerks(raw);
  const out = {};
  for (const k of KEYS) out[k] = !!p[k];
  return out;
}

function isVipName(name) { return VIP.test(String(name || '')); }

/** Suggest perks for a list of {name, priceKobo}. Highest paid / VIP names get the full set; other paid tiers get a badge. */
function suggestPerks(tiers) {
  const list = Array.isArray(tiers) ? tiers : [];
  const paid = list
    .map((t, i) => ({ i, price: Number(t.priceKobo || t.price_kobo || 0) }))
    .filter((t) => t.price > 0)
    .sort((a, b) => b.price - a.price);
  const top = paid[0];
  return list.map((t, i) => {
    const price = Number(t.priceKobo || t.price_kobo || 0);
    const vip = isVipName(t.name) || (top && top.i === i && price > 0);
    if (vip) return { badge: true, skipWaitingRoom: true, priorityQa: true, earlyEntry: true, backstage: true };
    if (price > 0) return { badge: true, skipWaitingRoom: false, priorityQa: false, earlyEntry: false, backstage: false };
    return { badge: false, skipWaitingRoom: false, priorityQa: false, earlyEntry: false, backstage: false };
  });
}

function formatStart(at) {
  try {
    return new Date(at).toLocaleString('en-NG', { dateStyle: 'medium', timeStyle: 'short' });
  } catch { return 'the official start time'; }
}

/**
 * Before official start, only hosts, speakers and early-entry holders may join.
 * Returns null if the window is open, or a reason string if it is not.
 */
function earlyEntryBlock(ev, { isHost, isSpeaker, perks } = {}) {
  if (!ev || !ev.starts_at) return null;
  const start = new Date(ev.starts_at).getTime();
  if (!Number.isFinite(start)) return null;
  const now = Date.now();
  if (now >= start) return null;
  if (isHost || isSpeaker) return null;
  if (now >= start - EARLY_MS && perks && perks.earlyEntry) return null;
  if (now >= start - EARLY_MS) {
    return `Doors open at ${formatStart(ev.starts_at)}. Ticket types with early entry can join 15 minutes before.`;
  }
  return `This event opens at ${formatStart(ev.starts_at)}. Ticket types with early entry can join 15 minutes before.`;
}

module.exports = { KEYS, LABELS, EARLY_MS, parsePerks, normalizePerks, suggestPerks, isVipName, earlyEntryBlock };
