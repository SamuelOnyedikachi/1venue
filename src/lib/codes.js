/** Meeting codes (6 lowercase alnum, e.g. y5yi87) and venue slug rules shared across the server. */
const crypto = require('crypto');
const CODE_CH = 'abcdefghjkmnpqrstuvwxyz23456789';
const CODE_RE = /^[a-z0-9]{6}$/;
const normCode = (c) => String(c || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const isCode = (c) => CODE_RE.test(normCode(c));
const randCode = (n = 6) => Array.from(crypto.randomBytes(n), (b) => CODE_CH[b % CODE_CH.length]).join('');
const codeLink = (c) => `/${normCode(c)}`;

// Subscription plans live in src/lib/plans.js. Link rights: free 5 + "-venue"; paid (premium/organisation) 5+ clean;
// a venue's slug3 add-on allows 3+, slug2 allows 2+ (add-ons only work on a paid plan).
const PLANS = ['free', 'premium', 'organisation'];
const LEGACY_RANK = { free: 0, premium: 1, organisation: 1, slug3: 2, slug2: 3 };
const planRank = (p) => LEGACY_RANK[String(p || 'free')] || 0;
/** Rights object { clean, tier } or a plan / legacy tier name. */
function rankOf(rights) {
  if (rights && typeof rights === 'object') return !rights.clean ? 0 : rights.tier === 'slug2' ? 3 : rights.tier === 'slug3' ? 2 : 1;
  return planRank(rights);
}
const RESERVED = new Set(['api', 'www', 'new', 'login', 'signup', 'logout', 'venues', 'venue', 'v', 'r', 'j', 'm', 'e', 'u', 'me', 'admin', 'settings', 'discover', 'feed', 'bible', 'dashboard', 'create', 'session', 'sessions', 'whiteboard', 'static', 'files', 'ws', 'profile', 'home', 'help', 'css', 'js', 'brand', 'icons', 'plan', 'plans', 'wallet', 'payments', 'billing', 'upgrade', 'pricing']);
const slugifyBase = (s) => String(s || '').toLowerCase().replace(/-venue$/, '').replace(/[^a-z0-9]/g, '');
const SLUG_ROUTE_RE = /^(?:[a-z0-9]{2,16}|[a-z0-9]{5,16}-venue)$/;

/** Resolve a requested custom slug for these link rights. Returns { slug } or throws {status,message}. */
function customSlug(input, rights, { suffix } = {}) {
  const base = slugifyBase(input);
  const r = rankOf(rights);
  const err = (m) => { const e = new Error(m); e.status = 400; throw e; };
  if (!base) err('Enter letters or numbers for your custom link');
  if (RESERVED.has(base)) err('That link is reserved — try another');
  if (base.length > 16) err('Custom links can be at most 16 characters');
  // Free tier, or premium+ explicitly asking for the -venue style
  if (r === 0 || suffix === true) {
    if (base.length < 5) err('Free custom links need at least 5 letters/numbers (we add -venue)');
    return { slug: `${base}-venue`, base };
  }
  if (base.length < 2) err('Custom links need at least 2 characters');
  if (base.length === 2 && r < 3) err('2-character links need the slug2 add-on for this venue (paid plans)');
  if (base.length === 3 && r < 2) err('3-character links need the slug3 add-on for this venue (paid plans)');
  if (base.length === 4 && r < 2) err('Clean links need at least 5 characters (4 needs the slug3 add-on)');
  return { slug: base, base };
}

module.exports = { CODE_CH, CODE_RE, normCode, isCode, randCode, codeLink, PLANS, planRank, rankOf, RESERVED, slugifyBase, customSlug, SLUG_ROUTE_RE };
