/**
 * Reminder scheduler: an in-process tick (every REMINDER_TICK_MS, default 60 s) that emails, and
 * optionally WhatsApps, people before scheduled events and meetings start.
 *
 * Idempotent across restarts and replicas: before anything is sent, a row is INSERTed into
 * reminder_sends with a UNIQUE (target, lead, channel, recipient) key. Only the process whose
 * insert succeeds sends; everyone else skips. A crash between claim and send loses at most that
 * one message (at-most-once, never duplicates).
 *
 * Lead times come from /admin (platform.reminderLeadA / reminderLeadB, minutes; default 24 h and
 * 1 h). If the server was down and a bigger lead was missed, only the nearest due lead is sent.
 * Who gets them: event host, RSVPs and ticket holders; meeting host and invitees.
 * Hosts need a plan with "reminders" (WhatsApp also needs "whatsapp"); per event they can turn
 * reminders off with settings.reminders=false.
 */
const { q, many } = require('../../core/db');
const plans = require('../../lib/plans');
const whatsapp = require('./whatsapp');

/** Pure: which lead (minutes) is due now, or null. The smallest lead whose window has opened. */
function dueLead(startMs, nowMs, leads) {
  if (!(startMs > nowMs)) return null;
  const mins = (startMs - nowMs) / 60000;
  const open = leads.filter((l) => l > 0 && mins <= l).sort((a, b) => a - b);
  return open.length ? open[0] : null;
}
function leadsFrom(settings) { const p = plans.platform(settings); return [p.reminderLeadA, p.reminderLeadB].filter((x) => x > 0); }
const label = (l) => (l % 1440 === 0 ? `${l / 1440 === 1 ? '24 hours' : l / 1440 + ' days'}` : l % 60 === 0 ? `${l / 60} hour${l === 60 ? '' : 's'}` : `${l} minutes`);
function when(d) {
  const tz = process.env.REMINDER_TIMEZONE || 'Africa/Lagos';
  try { return new Date(d).toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: tz, timeZoneName: 'short' }); } catch (_) { return new Date(d).toUTCString(); }
}

/** Claim one (target, lead, channel, recipient). True only for the first claimer, ever. */
async function claim(r) {
  const res = await q(`INSERT INTO reminder_sends (target_type, target_id, lead_min, channel, recipient, user_id) VALUES ($1,$2,$3,$4,$5,$6)
    ON CONFLICT (target_type, target_id, lead_min, channel, recipient) DO NOTHING`, [r.type, r.id, r.lead, r.channel, r.recipient, r.userId || null]);
  return res.rowCount === 1;
}
const done = (r, status, error = null) => q(`UPDATE reminder_sends SET status=$6, error=$7, sent_at=NOW() WHERE target_type=$1 AND target_id=$2 AND lead_min=$3 AND channel=$4 AND recipient=$5`,
  [r.type, r.id, r.lead, r.channel, r.recipient, status, error]);

async function deliver(r, msg, counts) {
  if (!(await claim(r))) { counts.skipped++; return; }
  try {
    if (r.channel === 'email') {
      const mail = require('../mail/prefs');
      if (r.userId && !(await mail.canSend(r.userId, 'reminders'))) { await done(r, 'sent', 'opted-out'); counts.sent++; return; }
      const data = { title: msg.title, intro: msg.intro, button: msg.button, link: msg.link };
      if (r.userId) data.unsubUrl = mail.unsubUrl(r.userId, 'reminders');
      const out = await require('../mail/mailer').send('reminder', r.recipient, data);
      await done(r, out.sent || out.reason === 'not-configured' ? 'sent' : 'failed', out.sent ? null : out.reason);
    } else {
      await whatsapp.send({ to: r.recipient, params: [msg.name, msg.when, msg.link] });
      await done(r, 'sent');
    }
    counts.sent++;
  } catch (e) { counts.failed++; await done(r, 'failed', String(e.message || e).slice(0, 200)).catch(() => {}); }
}

let running = false;
/** One scheduler pass. Returns counts (used by tests and logs). */
async function tick(now = new Date()) {
  if (running) return { busy: true };
  running = true;
  const counts = { sent: 0, skipped: 0, failed: 0 };
  try {
    const settings = await plans.getSettings();
    const leads = leadsFrom(settings);
    if (!leads.length) return counts;
    const platform = plans.platform(settings);
    const horizon = new Date(now.getTime() + Math.max(...leads) * 60000);
    const config = require('../../config');
    const site = config.PUBLIC_URL || 'https://1venue.live';
    const entCache = new Map();
    const ent = async (uid) => { if (!entCache.has(uid)) entCache.set(uid, await plans.entitlements(uid)); return entCache.get(uid); };
    const waOn = whatsapp.enabled(platform);

    const events = await many("SELECT id, slug, title, starts_at, host_user_id, settings FROM events WHERE status='scheduled' AND starts_at > $1 AND starts_at <= $2 ORDER BY starts_at LIMIT 200", [now, horizon]);
    for (const ev of events) {
      const lead = dueLead(new Date(ev.starts_at).getTime(), now.getTime(), leads);
      if (!lead) continue;
      let st = ev.settings; if (typeof st === 'string') { try { st = JSON.parse(st); } catch (_) { st = {}; } }
      if (st && st.reminders === false) continue;
      const e = await ent(ev.host_user_id);
      if (!e.features.reminders) continue;
      const people = await many(`SELECT id, email, phone FROM users WHERE id=$1 OR id IN (SELECT user_id FROM event_rsvps WHERE event_id=$2)
        OR id IN (SELECT user_id FROM tickets WHERE event_id=$2 AND status='valid')`, [ev.host_user_id, ev.id]);
      const msg = { name: ev.title, when: when(ev.starts_at), link: new URL(`/e/${ev.slug}`, site).href, title: `${ev.title} starts in ${label(lead)}`, intro: `${ev.title} starts ${when(ev.starts_at)}.`, button: 'Open event' };
      for (const p of people) {
        if (p.email) await deliver({ type: 'event', id: ev.id, lead, channel: 'email', recipient: String(p.email).toLowerCase(), userId: p.id }, msg, counts);
        if (waOn && e.features.whatsapp && p.phone) await deliver({ type: 'event', id: ev.id, lead, channel: 'whatsapp', recipient: p.phone, userId: p.id }, msg, counts);
      }
    }

    const meetings = await many(`SELECT m.id, m.code, m.name, m.scheduled_start, m.host_user_id, m.invitees, u.email, u.phone FROM scheduled_meetings m JOIN users u ON u.id=m.host_user_id
      WHERE m.status='scheduled' AND m.reminders AND m.scheduled_start > $1 AND m.scheduled_start <= $2 ORDER BY m.scheduled_start LIMIT 200`, [now, horizon]);
    for (const m of meetings) {
      const lead = dueLead(new Date(m.scheduled_start).getTime(), now.getTime(), leads);
      if (!lead) continue;
      const e = await ent(m.host_user_id);
      if (!e.features.reminders) continue;
      let inv = []; try { inv = JSON.parse(m.invitees || '[]'); } catch (_) {}
      const msg = { name: m.name, when: when(m.scheduled_start), link: new URL(`/${m.code}`, site).href, title: `${m.name} starts in ${label(lead)}`, intro: `${m.name} starts ${when(m.scheduled_start)}.`, button: 'Join meeting' };
      const emails = [...new Set([m.email, ...inv].filter(Boolean).map((x) => String(x).toLowerCase()))];
      for (const em of emails) await deliver({ type: 'meeting', id: m.id, lead, channel: 'email', recipient: em, userId: em === String(m.email).toLowerCase() ? m.host_user_id : null }, msg, counts);
      if (waOn && e.features.whatsapp && m.phone) await deliver({ type: 'meeting', id: m.id, lead, channel: 'whatsapp', recipient: m.phone, userId: m.host_user_id }, msg, counts);
    }
    if (counts.sent || counts.failed) console.log(`[reminders] sent ${counts.sent}, failed ${counts.failed}, already sent ${counts.skipped}`);
    return counts;
  } finally { running = false; }
}

let timer = null;
function startWorker() {
  if (timer || process.env.REMINDER_WORKER === 'false') return null;
  const every = Math.max(15000, Number(process.env.REMINDER_TICK_MS) || 60000);
  timer = setInterval(() => { tick().catch((e) => console.error('[reminders] tick', e.message)); }, every);
  timer.unref();
  return timer;
}
module.exports = { dueLead, leadsFrom, tick, claim, startWorker };
