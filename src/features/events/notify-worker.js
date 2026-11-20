/**
 * Idempotent scheduler for speaker-invite follow-ups, event-live reach-outs, and
 * (when enabled) urgent Notification AI call prompts. Uses reminder_sends.claim()
 * so rolling deploys never double-send.
 */
const { many, one } = require('../../core/db');
const { claim } = require('../recurring/reminders');
const config = require('../../config');

const when = (d) => {
  const tz = process.env.REMINDER_TIMEZONE || 'Africa/Lagos';
  try { return new Date(d).toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: tz, timeZoneName: 'short' }); } catch (_) { return new Date(d).toUTCString(); }
};

function done(r, status, error = null) {
  const { q } = require('../../core/db');
  return q(`UPDATE reminder_sends SET status=$6, error=$7, sent_at=NOW()
    WHERE target_type=$1 AND target_id=$2 AND lead_min=$3 AND channel=$4 AND recipient=$5`,
    [r.type, r.id, r.lead, r.channel, r.recipient, status, error]);
}

async function deliver(r, fn, counts) {
  if (!(await claim(r))) { counts.skipped++; return; }
  try {
    await fn();
    await done(r, 'sent');
    counts.sent++;
  } catch (e) {
    counts.failed++;
    await done(r, 'failed', String(e.message || e).slice(0, 200)).catch(() => {});
  }
}

async function maybeCall(userId, reason, ev, inviteId) {
  if (!userId) return;
  const start = ev && ev.starts_at ? new Date(ev.starts_at).getTime() : 0;
  const urgent = start && start - Date.now() <= config.NOTIFY.urgentWindowMin * 60000 && start > Date.now();
  if (!urgent) return;
  try {
    await require('../messages/ai-calls').requestCall(userId, {
      reason,
      requested: false,
      dedupe: { type: 'speaker_invite', id: Number(inviteId), recipient: `user:${userId}`, userId },
    });
  } catch (e) { console.warn('[notify-worker] call', e.message); }
}


let running = false;
async function tick(now = new Date()) {
  if (running) return { busy: true };
  running = true;
  const counts = { sent: 0, skipped: 0, failed: 0 };
  try {
    const notify = require('../messages/notify');
    const mail = require('../mail/prefs');
    const site = (config.PUBLIC_URL || 'https://1venue.live').replace(/\/$/, '');

    const invites = await many(`SELECT es.*, e.title, e.slug, e.starts_at, e.status AS event_status, e.host_user_id,
        u.email AS user_email, u.display_name AS user_name
      FROM event_speakers es
      JOIN events e ON e.id=es.event_id
      LEFT JOIN users u ON u.id=es.user_id
      WHERE es.status='pending' AND e.status='scheduled' AND e.starts_at IS NOT NULL AND e.starts_at > $1
      ORDER BY es.id LIMIT 200`, [now]).catch(() => []);

    for (const row of invites) {
      const invitedAt = row.invited_at ? new Date(row.invited_at).getTime() : 0;
      const startAt = new Date(row.starts_at).getTime();
      const leads = [];
      if (invitedAt && now.getTime() >= invitedAt + 86400000) leads.push(1);
      if (invitedAt && now.getTime() >= invitedAt + 3 * 86400000) leads.push(3);
      if (startAt - now.getTime() <= 1440 * 60000 && startAt > now.getTime()) leads.push(1440);
      const to = row.user_email || row.email;
      const name = row.user_name || row.display_name;
      const link = `${site}/e/${row.slug}`;
      const intro = `Reminder: you’re invited to speak at ${row.title}${row.starts_at ? ` on ${when(row.starts_at)}` : ''}.`;
      for (const lead of leads) {
        if (row.user_id) {
          await deliver({ type: 'speaker_invite', id: row.id, lead, channel: 'inapp', recipient: `user:${row.user_id}`, userId: row.user_id }, async () => {
            await notify.send(row.user_id, {
              style: 'compact',
              text: intro,
              links: [{ label: 'Open event', href: `/e/${row.slug}` }],
              card: { type: 'speaker_invite', title: row.title, eventId: Number(row.event_id), inviteId: Number(row.id), slug: row.slug, when: row.starts_at },
            });
          }, counts);
          if (lead === 1440) await maybeCall(row.user_id, `Your speaker invite for ${row.title} is coming up soon.`, row, row.id);
        }
        if (to) {
          await deliver({ type: 'speaker_invite', id: row.id, lead, channel: 'email', recipient: String(to).toLowerCase(), userId: row.user_id || null }, async () => {
            const out = await mail.sendOpt('speakerInviteReminder', to, {
              name, event: row.title, when: when(row.starts_at), link: `${link}?invite=${row.id}`,
            }, { userId: row.user_id || null });
            if (out && !out.sent && out.reason && out.reason !== 'not-configured' && out.reason !== 'opted-out') {
              throw new Error(out.reason);
            }
          }, counts);
        }
      }
    }

    const live = await many(`SELECT id, slug, title, host_user_id, started_at FROM events
      WHERE status='live' AND started_at IS NOT NULL AND started_at >= $1 ORDER BY started_at DESC LIMIT 50`,
      [new Date(now.getTime() - 6 * 3600000)]).catch(() => []);
    for (const ev of live) {
      const people = await many(`SELECT DISTINCT u.id, u.email FROM users u
        WHERE u.id=$1
           OR u.id IN (SELECT user_id FROM event_rsvps WHERE event_id=$2)
           OR u.id IN (SELECT user_id FROM event_speakers WHERE event_id=$2 AND status='active' AND user_id IS NOT NULL)
           OR u.id IN (SELECT user_id FROM tickets WHERE event_id=$2 AND status='valid')`, [ev.host_user_id, ev.id]).catch(() => []);
      for (const p of people) {
        if (Number(p.id) === Number(ev.host_user_id)) continue;
        await deliver({ type: 'event_live', id: ev.id, lead: 0, channel: 'inapp', recipient: `user:${p.id}`, userId: p.id }, async () => {
          await notify.send(p.id, {
            style: 'compact',
            text: `${ev.title} is live now.`,
            links: [{ label: 'Join event', href: `/e/${ev.slug}` }],
            card: { type: 'event_live', title: ev.title, eventId: Number(ev.id), slug: ev.slug, link: `/e/${ev.slug}` },
          });
        }, counts);
      }
    }

    if (counts.sent || counts.failed) console.log(`[notify-worker] sent ${counts.sent}, failed ${counts.failed}, already sent ${counts.skipped}`);
    return counts;
  } finally { running = false; }
}

let timer = null;
function startWorker() {
  if (timer || process.env.NOTIFY_WORKER === 'false') return null;
  const every = Math.max(15000, Number(process.env.NOTIFY_TICK_MS) || 60000);
  timer = setInterval(() => { tick().catch((e) => console.error('[notify-worker] tick', e.message)); }, every);
  timer.unref();
  return timer;
}

module.exports = { tick, startWorker };
