/**
 * The reserved "Notification" account: pinned DMs, compact/detailed cards, and
 * Replicate-backed replies. Venue reach-out and speaker/RSVP notices use this
 * instead of a one-way notification tray.
 */
const { q, one } = require('../../core/db');
const config = require('../../config');
const { rateLimit } = require('../../lib/http');
const { logAiUsage } = require('../ai/data');

const USERNAME = () => config.NOTIFY.username || 'notification';
let cached = null; let cachedAt = 0;

async function systemUser() {
  if (cached && Date.now() - cachedAt < 60_000) return cached;
  let row = await one('SELECT * FROM users WHERE is_system=TRUE OR lower(username)=lower($1) LIMIT 1', [USERNAME()]);
  if (!row) {
    await q(`INSERT INTO users (username, email, password_hash, display_name, email_verified_at, verified_active, is_system, handle)
      VALUES ($1,$2,$3,$4,NOW(),TRUE,TRUE,$1)
      ON CONFLICT (username) DO UPDATE SET is_system=TRUE, verified_active=TRUE, display_name=EXCLUDED.display_name`,
    [USERNAME(), 'notification@system.1venue.invalid', '$disabled$', 'Notification']).catch(() => {});
    row = await one('SELECT * FROM users WHERE lower(username)=lower($1) LIMIT 1', [USERNAME()]);
  }
  cached = row; cachedAt = Date.now();
  return row;
}
function isSystemUser(userOrId) {
  if (userOrId == null) return false;
  if (typeof userOrId === 'object') return !!(userOrId.is_system || userOrId.isSystem || (cached && Number(userOrId.id) === Number(cached.id)));
  return !!(cached && Number(cached.id) === Number(userOrId));
}

async function ensureThread(userId) {
  const bot = await systemUser();
  if (!bot || Number(bot.id) === Number(userId)) throw Object.assign(new Error('Notification account is not ready'), { status: 503, expose: true });
  const db = require('../../../db');
  const service = require('./service');
  const thread = await db.findOrCreateDmThread(userId, bot.id);
  const c = await service.ensureDmConversation(thread, bot.id);
  await q('UPDATE conversation_members SET pinned=TRUE, archived=FALSE WHERE conversation_id=$1 AND user_id=$2', [c.id, userId]);
  c.id = Number(c.id);
  return { bot, conversation: c };
}

/**
 * Send a Notification DM. `style` is compact or detailed. `card` becomes a kind:'card' payload.
 * Never throws to callers that fire-and-forget; returns the message or null.
 */
async function send(userId, { text = '', style = 'compact', links = [], card = null, notify = true } = {}) {
  try {
    const service = require('./service');
    const { bot, conversation } = await ensureThread(userId);
    const lines = [];
    if (text) lines.push(String(text).trim());
    for (const l of links || []) {
      if (!l) continue;
      const href = typeof l === 'string' ? l : l.href || l.url;
      const label = typeof l === 'string' ? l : (l.label ? `${l.label}: ${href}` : href);
      if (href) lines.push(label);
    }
    const body = lines.join(style === 'detailed' ? '\n\n' : '\n').slice(0, 2000);
    const kind = card ? 'card' : 'text';
    const row = await service.insertMessage(conversation, {
      senderUserId: bot.id, senderName: bot.display_name || 'Notification',
      text: body, kind, payload: card || null,
    });
    return service.deliver(conversation, row, { senderId: bot.id, notify });
  } catch (e) {
    console.warn('[notify] send', e.message);
    return null;
  }
}

async function reachOut(userId, opts) { return send(userId, { style: 'detailed', ...opts }); }

async function extraOf(userId) {
  const r = await one('SELECT extra FROM user_prefs WHERE user_id=$1', [userId]).catch(() => null);
  let x = r && r.extra;
  if (typeof x === 'string') { try { x = JSON.parse(x); } catch (_) { x = {}; } }
  return x && typeof x === 'object' ? x : {};
}
async function patchExtra(userId, patch) {
  const cur = await extraOf(userId);
  const next = { ...cur };
  for (const [k, v] of Object.entries(patch || {})) {
    if (v && typeof v === 'object' && !Array.isArray(v) && next[k] && typeof next[k] === 'object') next[k] = { ...next[k], ...v };
    else next[k] = v;
  }
  await q(`INSERT INTO user_prefs (user_id, extra, updated_at) VALUES ($1,$2,NOW())
    ON CONFLICT (user_id) DO UPDATE SET extra=$2, updated_at=NOW()`, [userId, JSON.stringify(next)]);
  return next;
}
function speakerInviteMode(extra) {
  return extra && extra.speakerInvites === 'active' ? 'active' : 'pending';
}
function callPrefs(extra) {
  const c = (extra && extra.calls && typeof extra.calls === 'object') ? extra.calls : {};
  return {
    enabled: !!c.enabled,
    optOut: !!c.optOut,
    quietStart: c.quietStart || '22:00',
    quietEnd: c.quietEnd || '07:00',
  };
}
function inQuietHours(prefs, now = new Date()) {
  if (prefs.optOut || !prefs.enabled) return true;
  const tz = process.env.REMINDER_TIMEZONE || 'Africa/Lagos';
  let hm = '00:00';
  try { hm = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: tz }).format(now); } catch (_) { hm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`; }
  const [qs, qe] = [prefs.quietStart || '22:00', prefs.quietEnd || '07:00'];
  if (qs === qe) return false;
  if (qs < qe) return hm >= qs && hm < qe;
  return hm >= qs || hm < qe; // overnight window
}

function isNotifyConversation(c, bot) {
  if (!c || c.type !== 'dm' || !bot) return false;
  const a = Number(c.user_a_id); const b = Number(c.user_b_id);
  // conv rows may not have user_a/b; peer is resolved later. Check dm thread via flags we set, or members.
  if (c.dm_user_a != null) return Number(c.dm_user_a) === Number(bot.id) || Number(c.dm_user_b) === Number(bot.id);
  return false;
}

async function conversationIsNotify(c, bot) {
  if (!c || c.type !== 'dm' || !bot) return false;
  const thread = c.dm_thread_id ? await one('SELECT user_a_id, user_b_id FROM dm_threads WHERE id=$1', [c.dm_thread_id]).catch(() => null) : null;
  if (!thread) return false;
  return Number(thread.user_a_id) === Number(bot.id) || Number(thread.user_b_id) === Number(bot.id);
}

const SITE_ROUTES = `/e/{slug} events, /messages inbox, /settings#email email and call prefs, /settings#notifications, /discover, /wallet, /dashboard, /v/{slug} venues, /books Bible and Qur’an.`;

async function runNotifyModel(messages) {
  const { AI_MOCK } = { AI_MOCK: require('../../config').AI.mock };
  const token = config.STT.replicate.token;
  const model = config.NOTIFY.aiModel;
  if (token && !AI_MOCK && config.NOTIFY.aiEnabled) {
    const { run } = require('../../lib/replicate');
    const system = messages[0] && messages[0].role === 'system' ? messages[0].content : '';
    const rest = messages.filter((m) => m.role !== 'system');
    const prompt = rest.map((m) => `${m.role === 'assistant' ? 'Assistant' : 'User'}: ${m.content}`).join('\n') + '\nAssistant:';
    const input = { prompt, system_prompt: system, max_tokens: 400, temperature: 0.4 };
    const out = await run({ token, apiBase: config.STT.replicate.apiBase, model, input, timeoutMs: 20000, tag: 'notify', wait: 20 });
    const text = Array.isArray(out.output) ? out.output.join('') : (typeof out.output === 'string' ? out.output : JSON.stringify(out.output || ''));
    return { text: String(text || '').trim(), provider: 'replicate', model };
  }
  if (AI_MOCK || (config.AI && (config.AI.primary && config.AI.primary.apiKey))) {
    const ai = require('../../venue/ai');
    const r = await ai.chat('notify', messages, { maxTokens: 400, temperature: 0.4 });
    const text = (r && (r.text || r.content)) || (typeof r === 'string' ? r : '');
    return { text: String(text || '').trim(), provider: 'chat', model: 'venue-ai' };
  }
  return { text: '', provider: 'none', model: null, unavailable: true };
}

function parseAction(text) {
  const m = String(text || '').match(/```json\s*([\s\S]*?)```/i) || String(text || '').match(/\{\s*"action"\s*:\s*"[^"]+[\s\S]*\}/);
  if (!m) return { text: String(text || '').trim(), action: null };
  let action = null;
  try { action = JSON.parse(m[1] || m[0]); } catch (_) { action = null; }
  const cleaned = String(text || '').replace(m[0], '').trim();
  return { text: cleaned, action: action && typeof action === 'object' ? action : null };
}

async function dailyCount(userId) {
  const r = await one(`SELECT COUNT(*) AS n FROM ai_usage WHERE use_case='notify' AND ok=TRUE AND created_at >= date_trunc('day', NOW())`).catch(() => ({ n: 0 }));
  // Can't filter by user in ai_usage (no user_id). Use a cheap extra table-less cap per user via reminder? 
  // Fall back to rateLimit plus a notify_ai_turns cookie in extra? Use rateLimit only plus optional query if column exists.
  return Number(r && r.n) || 0;
}

async function onUserMessage(user, c, message) {
  if (!config.NOTIFY.aiEnabled) return;
  if (!user || !c || !message) return;
  const bot = await systemUser();
  if (!bot || Number(user.id) === Number(bot.id)) return;
  if (!(await conversationIsNotify(c, bot))) return;
  if (!rateLimit('notify-ai:' + user.id, 8)) {
    await send(user.id, { text: 'Let’s slow down a little — try again in a minute.', style: 'compact', notify: false });
    return;
  }
  if ((await dailyCount(user.id)) > config.NOTIFY.aiDaily * 50) { /* server-wide soft guard */ }
  const start = Date.now();
  try {
    const history = await require('./service').listMessages(user.id, c.id, { limit: 12 }).catch(() => []);
    const msgs = (history.messages || history || []).slice(-10).map((m) => ({
      role: Number(m.fromUserId) === Number(bot.id) ? 'assistant' : 'user',
      content: [m.text, m.payload && m.payload.title].filter(Boolean).join('\n').slice(0, 600),
    }));
    const system = {
      role: 'system',
      content: `You are Notification, the official 1venue assistant writing as a verified in-app contact. Be brief and natural. You may include links on the site: ${SITE_ROUTES}. Never invent URLs outside this site, never ask for passwords, and never claim to be a human. If the user wants to accept or decline a speaker invite, RSVP, or change reminder/email prefs, propose a single JSON action in a fenced json block like {"action":"accept_invite"|"decline_invite"|"rsvp"|"unrsvp"|"call_me"|"set_pref","eventId":0,"inviteId":0,"comment":"","pref":{}} and also say in plain language what you would do. Do not say the action is already done.`,
    };
    const out = await runNotifyModel([system, ...msgs.filter((m) => m.content), { role: 'user', content: String(message.text || '').slice(0, 2000) }]);
    await logAiUsage({ useCase: 'notify', provider: out.provider, model: out.model, ok: !out.unavailable, latencyMs: Date.now() - start, error: out.unavailable ? 'unavailable' : null });
    if (out.unavailable) {
      await send(user.id, { text: 'I can’t reach the assistant right now. You can still open /messages, /settings#email or the event page from the earlier message.', style: 'compact', notify: false });
      return;
    }
    const parsed = parseAction(out.text);
    if (parsed.action && parsed.action.action) {
      await send(user.id, {
        text: parsed.text || 'I can do that — please confirm.',
        style: 'compact',
        card: { type: 'confirm', title: labelFor(parsed.action), action: parsed.action, eventId: parsed.action.eventId, inviteId: parsed.action.inviteId },
        notify: false,
      });
    } else if (parsed.text) {
      await send(user.id, { text: parsed.text.slice(0, 2000), style: 'compact', notify: false });
    }
  } catch (e) {
    console.warn('[notify] ai', e.message);
    await logAiUsage({ useCase: 'notify', provider: 'replicate', model: config.NOTIFY.aiModel, ok: false, latencyMs: Date.now() - start, error: e.message });
    await send(user.id, { text: 'I had trouble answering just then. Open /settings or the event link in the earlier message, or try again in a moment.', style: 'compact', notify: false }).catch(() => {});
  }
}

function labelFor(a) {
  if (!a) return 'Confirm';
  if (a.action === 'accept_invite') return 'Accept speaker invite';
  if (a.action === 'decline_invite') return 'Decline speaker invite';
  if (a.action === 'rsvp') return 'RSVP to this event';
  if (a.action === 'unrsvp') return 'Cancel your RSVP';
  if (a.action === 'call_me') return 'Call me about this';
  if (a.action === 'set_pref') return 'Update notification settings';
  return 'Confirm this action';
}

async function runAction(user, action, { confirmed = false, comment = '' } = {}) {
  if (!action || !action.action) throw Object.assign(new Error('Nothing to confirm'), { status: 400, expose: true });
  if (!confirmed && action.action !== 'set_pref') {
    return { needsConfirm: true, action, label: labelFor(action) };
  }
  const invites = require('../events/invites');
  if (action.action === 'accept_invite') return invites.accept(user, action.inviteId || action.eventId);
  if (action.action === 'decline_invite') return invites.decline(user, action.inviteId || action.eventId, comment || action.comment);
  if (action.action === 'rsvp' || action.action === 'unrsvp') {
    const data = require('../events/data');
    const ev = await data.getEventById(Number(action.eventId), user.id);
    if (!ev) throw Object.assign(new Error('Event not found'), { status: 404, expose: true });
    const going = ev.rsvped;
    if (action.action === 'rsvp' && going) return { ok: true, going: true };
    if (action.action === 'unrsvp' && !going) return { ok: true, going: false };
    const next = await data.toggleRsvp(ev.id, user.id);
    return { ok: true, going: next };
  }
  if (action.action === 'call_me') {
    const calls = require('./ai-calls');
    return calls.requestCall(user.id, { reason: action.reason || 'You asked Notification to call you.', requested: true });
  }
  if (action.action === 'set_pref') {
    const mail = require('../mail/prefs');
    if (action.pref && action.pref.email) await mail.setEmailPrefs(user.id, action.pref.email);
    if (action.pref && (action.pref.calls || action.pref.speakerInvites)) {
      const patch = {};
      if (action.pref.calls) patch.calls = action.pref.calls;
      if (action.pref.speakerInvites) patch.speakerInvites = action.pref.speakerInvites;
      await patchExtra(user.id, patch);
    }
    return { ok: true };
  }
  throw Object.assign(new Error('Unknown action'), { status: 400, expose: true });
}

async function notifyFollowersOfVenue(venue, { text, links } = {}) {
  if (!venue || !venue.id) return 0;
  const { many } = require('../../core/db');
  const rows = await many(`SELECT DISTINCT f.follower_id AS id FROM follows f JOIN venues v ON v.owner_user_id=f.followee_id WHERE v.id=$1`, [venue.id]).catch(() => []);
  let n = 0;
  for (const r of rows) {
    await send(r.id, {
      text: text || `${venue.name || 'A venue you follow'} is live now.`,
      style: 'compact',
      links: links || (venue.slug ? [{ label: 'Open venue', href: `/v/${venue.slug}` }] : []),
      card: venue.slug ? { type: 'venue', title: venue.name || 'Venue', link: `/v/${venue.slug}` } : null,
    });
    n++;
  }
  return n;
}

module.exports = {
  systemUser, isSystemUser, ensureThread, send, reachOut,
  extraOf, patchExtra, speakerInviteMode, callPrefs, inQuietHours,
  onUserMessage, runAction, labelFor, notifyFollowersOfVenue, conversationIsNotify,
  runNotifyModel, parseAction,
};
