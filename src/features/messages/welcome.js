/**
 * Notification welcome (once, on signup) and welcome-back messages after a
 * stretch away. Push follows prefs and quiet hours; the inbox message always lands.
 */
const db = require('../../../db');
const { one, many } = require('../../core/db');
const config = require('../../config');
const notify = require('./notify');

const WELCOME_KEY = 'notifyWelcomeAt';
const RETURN_KEY = 'notifyReturnAt';
const SEEN_KEY = 'notifyLastSeenAt';
const LOW_CREDITS = 15;
const U = 60000;

function nameOf(user) {
  return String((user && (user.display_name || user.displayName || user.username)) || 'there').trim() || 'there';
}

function firstName(user) {
  const n = nameOf(user);
  if (n === 'there') return n;
  return n.split(/\s+/)[0];
}

function parseExtra(raw) {
  let x = raw;
  if (typeof x === 'string') { try { x = JSON.parse(x); } catch (_) { x = {}; } }
  return x && typeof x === 'object' && !Array.isArray(x) ? x : {};
}

function parseTime(v) {
  if (!v) return 0;
  const t = new Date(v).getTime();
  return Number.isFinite(t) ? t : 0;
}

function returnAfterMs() {
  const days = Math.max(0.01, Number(config.NOTIFY.returnAfterDays) || 3);
  return days * 24 * 60 * 60 * 1000;
}

function abs(path) {
  return config.siteUrl(path, { fallback: process.env.PUBLIC_URL });
}

/** Push only (the DM itself is always delivered). Uses notification/call quiet hours, not call opt-out. */
function shouldPush(extra, now = new Date()) {
  const n = (extra && extra.notifications && typeof extra.notifications === 'object') ? extra.notifications : {};
  if (n.push === false || n.enabled === false) return false;
  const calls = (extra && extra.calls && typeof extra.calls === 'object') ? extra.calls : {};
  const prefs = {
    optOut: false,
    enabled: true,
    quietStart: n.quietStart || calls.quietStart || '23:00',
    quietEnd: n.quietEnd || calls.quietEnd || '07:00',
  };
  return !notify.inQuietHours(prefs, now);
}

async function claim(userId, { kind, minGapMs = 0, touchSeen = true } = {}) {
  return db.tx(async (c) => {
    await c.query(`INSERT INTO user_prefs (user_id, extra, updated_at) VALUES ($1,$2,NOW())
      ON CONFLICT (user_id) DO NOTHING`, [userId, JSON.stringify({})]);
    const row = (await c.query('SELECT extra FROM user_prefs WHERE user_id=$1' + (db.USE_PG ? ' FOR UPDATE' : ''), [userId])).rows[0];
    const extra = parseExtra(row && row.extra);
    const now = Date.now();
    const iso = new Date(now).toISOString();
    if (kind) {
      const prev = parseTime(extra[kind]);
      if (prev && (minGapMs <= 0 || now - prev < minGapMs)) return { ok: false, extra };
      extra[kind] = iso;
    }
    if (touchSeen) extra[SEEN_KEY] = iso;
    await c.query('UPDATE user_prefs SET extra=$2, updated_at=NOW() WHERE user_id=$1', [userId, JSON.stringify(extra)]);
    return { ok: true, extra };
  });
}

async function touchSeen(userId, extra) {
  const last = parseTime(extra && extra[SEEN_KEY]);
  if (last && Date.now() - last < 60 * 60 * 1000) return;
  try { await claim(userId, { touchSeen: true }); } catch (_) {}
}

async function loadUser(userOrId) {
  if (userOrId && typeof userOrId === 'object' && userOrId.id) return userOrId;
  return one('SELECT id, username, display_name, bio, avatar_url, created_at FROM users WHERE id=$1', [userOrId]);
}

function templateWelcome(user, links) {
  const name = firstName(user);
  const lines = [
    `Welcome to 1venue, ${name}. This is where you host and join live events, instant meetings, and conversations with your community.`,
    'A few quick links to get you started:',
    ...links.map((l) => `${l.label}: ${l.href}`),
    'I’m Notification — write back here anytime you need a hand.',
  ];
  return lines.join('\n\n');
}

function templateReturn(user, { trending, actions }) {
  const name = firstName(user);
  const parts = [`Welcome back, ${name}.`];
  if (trending && trending.length) {
    parts.push('Trending now:\n' + trending.map((e) => `• ${e.title}: ${e.href}`).join('\n'));
  }
  if (actions && actions.length) {
    parts.push('Waiting on you:\n' + actions.map((a) => `• ${a.text}: ${a.href}`).join('\n'));
  }
  if (parts.length === 1) parts.push('Nothing needs your attention right now. Discover what’s on: ' + abs('/discover'));
  return parts.join('\n\n');
}

async function phrase(kind, user, facts, fallback) {
  const envAi = process.env.NOTIFY_AI_ENABLED;
  if (envAi === 'false' || envAi === '0' || !config.NOTIFY.aiEnabled) return fallback;
  try {
    const r = await notify.runNotifyModel([
      {
        role: 'system',
        content: 'You are Notification, the in-app assistant on 1venue. Write a short, warm message (under 900 characters). Use the person\'s first name. Include every absolute URL from the facts, exactly as given. No markdown fences, no JSON, no invented links.',
      },
      {
        role: 'user',
        content: kind === 'welcome'
          ? `Draft a welcome for a new 1venue user.\nName: ${nameOf(user)}\nFacts:\n${facts}`
          : `Draft a welcome-back message for someone returning after a while.\nName: ${nameOf(user)}\nFacts:\n${facts}`,
      },
    ]);
    const text = notify.sanitizeAssistantText(r && r.text);
    if (text && text.length >= 40 && /https?:\/\/|^\//.test(text)) {
      try { await require('../ai/data').logAiUsage({ useCase: 'notify', provider: r.provider, model: r.model, ok: true }); } catch (_) {}
      return text.slice(0, 1800);
    }
  } catch (e) {
    console.warn('[notify]', kind, 'phrase', e.message);
  }
  return fallback;
}

async function collectActions(userId) {
  const actions = [];
  const now = Date.now();
  const soon = new Date(now + 48 * 60 * 60 * 1000).toISOString();
  const isoNow = new Date(now).toISOString();

  const invites = await require('../events/invites').listMine({ id: userId }).catch(() => ({ invites: [] }));
  const pending = (invites.invites || []).filter((i) => i.status === 'pending');
  if (pending.length) {
    actions.push({
      key: 'invites',
      text: pending.length === 1
        ? `Pending speaker invite: ${pending[0].title}`
        : `${pending.length} pending speaker invites`,
      href: abs('/dashboard'),
    });
  }

  const unread = await require('./service').unreadSummary(userId).catch(() => ({ total: 0 }));
  if (Number(unread.total) > 0) {
    actions.push({
      key: 'unread',
      text: Number(unread.total) === 1 ? '1 unread chat' : `${unread.total} unread chats`,
      href: abs('/messages'),
    });
  }

  const upcoming = await many(
    `SELECT e.id, e.slug, e.title, e.starts_at
       FROM events e
       LEFT JOIN event_rsvps r ON r.event_id=e.id AND r.user_id=$1
       LEFT JOIN event_speakers s ON s.event_id=e.id AND s.user_id=$1 AND s.status='active'
      WHERE e.status IN ('scheduled','live')
        AND e.starts_at IS NOT NULL AND e.starts_at >= $2 AND e.starts_at < $3
        AND (e.host_user_id=$1 OR r.user_id IS NOT NULL OR s.user_id IS NOT NULL)
      GROUP BY e.id, e.slug, e.title, e.starts_at
      ORDER BY e.starts_at ASC
      LIMIT 5`,
    [userId, isoNow, soon],
  ).catch(() => []);
  for (const ev of upcoming) {
    actions.push({
      key: 'upcoming',
      text: `Upcoming: ${ev.title}`,
      href: abs(`/e/${ev.slug}`),
    });
  }

  const earn = await require('../wallet/paid-entry').earnings(userId).catch(() => ({ availableCredits: 0 }));
  if (Number(earn.availableCredits) > 0) {
    const n = Number(earn.availableCredits);
    const label = Number.isInteger(n) ? String(n) : n.toFixed(2);
    actions.push({
      key: 'earnings',
      text: `${label} credit${n === 1 ? '' : 's'} ready to move to your wallet`,
      href: abs('/wallet'),
    });
  }

  const profile = await one('SELECT display_name, bio, avatar_url, username FROM users WHERE id=$1', [userId]).catch(() => null);
  if (profile && (!profile.avatar_url || !String(profile.bio || '').trim() || !String(profile.display_name || '').trim())) {
    actions.push({
      key: 'profile',
      text: 'Your profile is missing a photo, name, or bio',
      href: abs(profile.username ? `/u/${profile.username}` : '/settings'),
    });
  }

  const wallet = await one('SELECT balance_units FROM credit_wallets WHERE user_id=$1', [userId]).catch(() => null);
  const credits = Number(wallet && wallet.balance_units || 0) / U;
  if (credits < LOW_CREDITS) {
    actions.push({
      key: 'credits',
      text: `Your credit balance is low (${credits < 0.01 ? '0' : credits.toFixed(credits < 1 ? 2 : 0)})`,
      href: abs('/wallet'),
    });
  }

  return actions;
}

async function trendingEvents(limit = 3) {
  const rows = await require('../events/data').discover({ limit, status: undefined }).catch(() => []);
  return (rows || []).filter((e) => e && e.slug && e.status !== 'ended' && e.status !== 'cancelled').slice(0, limit).map((e) => ({
    title: e.title,
    href: abs(`/e/${e.slug}`),
    status: e.status,
  }));
}

async function sendWelcome(userOrId) {
  const user = await loadUser(userOrId);
  if (!user) return null;
  const claimed = await claim(user.id, { kind: WELCOME_KEY, minGapMs: 0 });
  if (!claimed.ok) return null;
  const links = [
    { label: 'Create an event', href: abs('/create') },
    { label: 'Discover events', href: abs('/discover') },
    { label: 'Set up your profile', href: abs(user.username ? `/u/${user.username}` : '/settings') },
    { label: 'Notification settings', href: abs('/settings#notifications') },
  ];
  const facts = links.map((l) => `${l.label}: ${l.href}`).join('\n');
  const text = await phrase('welcome', user, facts, templateWelcome(user, links));
  return notify.send(user.id, { text, style: 'detailed', links: [], notify: shouldPush(claimed.extra) });
}

async function sendReturn(userOrId) {
  const user = await loadUser(userOrId);
  if (!user) return null;
  const extra = await notify.extraOf(user.id);
  const now = Date.now();
  const gap = returnAfterMs();
  const last = parseTime(extra[SEEN_KEY]) || parseTime(extra[RETURN_KEY]) || parseTime(extra[WELCOME_KEY]) || parseTime(user.created_at);
  if (last && now - last < gap) {
    await touchSeen(user.id, extra);
    return null;
  }
  const claimed = await claim(user.id, { kind: RETURN_KEY, minGapMs: gap, touchSeen: true });
  if (!claimed.ok) return null;
  const [trending, actions] = await Promise.all([trendingEvents(3), collectActions(user.id)]);
  const facts = [
    trending.length ? `Trending events:\n${trending.map((e) => `${e.title}: ${e.href}`).join('\n')}` : '',
    actions.length ? `Action items:\n${actions.map((a) => `${a.text}: ${a.href}`).join('\n')}` : 'No action items.',
  ].filter(Boolean).join('\n\n');
  const text = await phrase('return', user, facts, templateReturn(user, { trending, actions }));
  return notify.send(user.id, { text, style: 'detailed', links: [], notify: shouldPush(claimed.extra) });
}

function onSignup(user) {
  setImmediate(() => { sendWelcome(user).catch((e) => console.warn('[notify] welcome', e.message)); });
}

function onReturn(user) {
  setImmediate(() => { sendReturn(user).catch((e) => console.warn('[notify] return', e.message)); });
}

module.exports = {
  sendWelcome, sendReturn, onSignup, onReturn, shouldPush, templateWelcome, templateReturn,
  collectActions, trendingEvents, claim, WELCOME_KEY, RETURN_KEY, SEEN_KEY, returnAfterMs,
};
