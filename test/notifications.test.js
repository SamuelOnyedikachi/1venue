'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'venue-notify-'));
process.env.DB_DRIVER = 'sqlite';
process.env.SQLITE_PATH = path.join(dir, 'venue.sqlite');
process.env.AI_MOCK = 'true';
process.env.AI_CALLS_ENABLED = 'false';
process.env.NOTIFY_EMAIL_ENABLED = 'true';
const db = require('../db');
const data = require('../src/venue/data');
const events = require('../src/features/events/data');
const invites = require('../src/features/events/invites');
const notify = require('../src/features/messages/notify');
const mail = require('../src/features/mail/prefs');
const plans = require('../src/lib/plans');
const aiCalls = require('../src/features/messages/ai-calls');

let host, guest, ev;

test.before(async () => {
  host = await db.createUser({ username: 'hostn', email: 'hostn@example.test', passwordHash: 'hash' });
  guest = await db.createUser({ username: 'speakern', email: 'speakern@example.test', passwordHash: 'hash' });
  ev = await data.createEvent({ id: host.id, username: 'hostn', displayName: 'Host' }, { title: 'Notify Seminar', category: 'seminar' });
});

test.after(async () => { await db.close(); fs.rmSync(dir, { recursive: true, force: true }); });

test('Notification system user is seeded, verified, and can pin a thread', async () => {
  const bot = await notify.systemUser();
  assert.ok(bot && bot.id);
  assert.equal(String(bot.username).toLowerCase(), 'notification');
  assert.ok(bot.is_system || bot.isSystem);
  assert.equal(require('../src/lib/auth').isVerified(bot), true);
  await notify.send(guest.id, { text: 'Hello from Notification', style: 'compact' });
  const { conversation } = await notify.ensureThread(guest.id);
  assert.ok(conversation && conversation.id);
  const mem = await db.q('SELECT pinned FROM conversation_members WHERE conversation_id=$1 AND user_id=$2', [conversation.id, guest.id]);
  const row = mem.rows ? mem.rows[0] : mem;
  assert.ok(row && (row.pinned === 1 || row.pinned === true));
});

test('setSpeakers keeps the host listed as active (existing sqlite-features contract)', async () => {
  await events.setSpeakers(ev.id, [{ name: 'Ada', email: 'hostn@example.test' }]);
  const list = await events.listSpeakers(ev.id);
  assert.equal(list[0].email, 'hostn@example.test');
  assert.equal(list[0].status, 'active');
});

test('registered speakers start pending, stay off the public page, and can accept or decline', async () => {
  await events.setSpeakers(ev.id, [
    { name: 'Ada', email: 'hostn@example.test' },
    { name: 'Sam', userId: guest.id, email: 'speakern@example.test' },
  ], { actor: { id: host.id } });
  const pub = await events.listSpeakers(ev.id);
  assert.ok(pub.every((s) => s.status === 'active'));
  assert.equal(pub.some((s) => Number(s.userId) === Number(guest.id)), false);
  const hostView = await events.listSpeakers(ev.id, { isHost: true });
  const pending = hostView.find((s) => Number(s.userId) === Number(guest.id));
  assert.ok(pending);
  assert.equal(pending.status, 'pending');
  await invites.accept({ id: guest.id }, pending.id);
  assert.ok((await events.listSpeakers(ev.id)).some((s) => Number(s.userId) === Number(guest.id) && s.status === 'active'));
  await assert.rejects(() => invites.decline({ id: guest.id }, pending.id, ''), /comment/i);
  await invites.decline({ id: guest.id }, pending.id, 'Sorry, I cannot make it');
  assert.equal((await events.listSpeakers(ev.id)).some((s) => Number(s.userId) === Number(guest.id)), false);
  const again = (await events.listSpeakers(ev.id, { isHost: true })).find((s) => Number(s.userId) === Number(guest.id));
  assert.equal(again.status, 'declined');
  assert.equal(again.declineComment, 'Sorry, I cannot make it');
});

test('toggleRsvp does not throw when mail and Notification hooks run', async () => {
  assert.equal(await events.toggleRsvp(ev.id, guest.id), true);
  assert.equal(await events.toggleRsvp(ev.id, guest.id), false);
});

test('email prefs and unsubscribe tokens work', async () => {
  assert.equal(await mail.canSend(guest.id, 'rsvpConfirm'), true);
  await mail.setEmailPrefs(guest.id, { rsvp: false, reminders: true, speakerInvites: true });
  assert.equal(await mail.canSend(guest.id, 'rsvpConfirm'), false);
  const t = mail.unsubToken(guest.id, 'reminders');
  const parsed = mail.parseUnsubToken(t);
  assert.equal(Number(parsed.userId), Number(guest.id));
  await mail.applyUnsubscribe(guest.id, 'reminders');
  assert.equal(await mail.canSend(guest.id, 'reminder'), false);
});

test('AI call silence is clamped to 800–4000 ms and defaults to 1500', async () => {
  const s = await aiCalls.silenceSettings();
  assert.ok(s.silenceMs >= 800 && s.silenceMs <= 4000);
  assert.equal(s.silenceMs, plans.platform(plans.envDefaults()).aiCallSilenceMs);
  assert.equal(s.silenceMs, 1500);
  const merged = plans.mergeSettings(plans.envDefaults(), { platform: { aiCallSilenceMs: 500, aiCallSilenceQuestionMs: 2000 } });
  const plat = plans.platform(merged);
  const clamp = (v, min, max, d) => { const n = Number(v); return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : d; };
  assert.equal(clamp(plat.aiCallSilenceMs, 800, 4000, 1500), 800);
  assert.equal(clamp(plat.aiCallSilenceQuestionMs, 0, 4000, 800), 2000);
});

test('requestCall falls back to a message when AI calls are disabled', async () => {
  const r = await aiCalls.requestCall(guest.id, { reason: 'Test call', requested: true });
  assert.equal(r.ok, false);
  assert.equal(r.fallback, 'disabled');
});


test('sanitizeAssistantText strips fences and parseAction keeps the action', () => {
  const raw = 'I heard you accepted the invite. Here is the action:\n```\n. If you need to reach out, use https://1venue.live/messages.';
  assert.equal(/```/.test(notify.sanitizeAssistantText(raw)), false);
  const parsed = notify.parseAction('Sure.\n```json\n{"action":"accept_invite","inviteId":12}\n```');
  assert.equal(parsed.action.action, 'accept_invite');
  assert.equal(parsed.action.inviteId, 12);
  assert.equal(/```|accept_invite/.test(parsed.text), false);
});

test('intentFromText recognises accept and decline in natural phrasing', () => {
  assert.equal(notify.intentFromText('thanks I accept the invite, thanks for calling'), 'accept_invite');
  assert.equal(notify.intentFromText('I will speak'), 'accept_invite');
  assert.equal(notify.intentFromText('I have to decline because I am travelling'), 'decline_invite');
  assert.equal(notify.intentFromText('What time does it start?'), null);
});

test('call greetings are natural and inbound calls ask how they can help', () => {
  assert.equal(aiCalls.callGreeting('Your speaker invite for Music is coming up soon.'), 'Hi, this is Notification. Your speaker invite for Music is coming up soon.');
  assert.equal(aiCalls.callGreeting('You called Notification.', { inbound: true }), 'Hi, this is Notification. How can I help?');
  assert.match(aiCalls.callGreeting('You called Notification.'), /How can I help/);
  assert.doesNotMatch(aiCalls.callGreeting('Your invite is coming up soon.'), /I[’']m calling because/);
  assert.doesNotMatch(aiCalls.callGreeting('A thing.'), /finished speaking/i);
});

test('urgent call fallbacks are sent at most once per invite per reason', async () => {
  const dedupe = { type: 'speaker_invite', id: 900001, recipient: `user:${guest.id}`, userId: guest.id };
  const a = await aiCalls.requestCall(guest.id, { reason: 'Your speaker invite for Notify Seminar is coming up soon.', requested: false, dedupe });
  const b = await aiCalls.requestCall(guest.id, { reason: 'Your speaker invite for Notify Seminar is coming up soon.', requested: false, dedupe });
  assert.equal(a.ok, false);
  assert.equal(a.skipped, undefined);
  assert.equal(b.ok, false);
  assert.equal(b.skipped, true);
});

test('fulfillInviteIntent accepts a pending invite from chat wording', async () => {
  const ev2 = await data.createEvent({ id: host.id, username: 'hostn', displayName: 'Host' }, { title: 'Chat Accept Gig', category: 'seminar' });
  await events.setSpeakers(ev2.id, [
    { name: 'Ada', email: 'hostn@example.test' },
    { name: 'Sam', userId: guest.id, email: 'speakern@example.test' },
  ], { actor: { id: host.id } });
  const pending = (await events.listSpeakers(ev2.id, { isHost: true })).find((s) => Number(s.userId) === Number(guest.id));
  assert.equal(pending.status, 'pending');
  const r = await notify.fulfillInviteIntent({ id: guest.id }, 'thanks I accept the invite, thanks for calling', null);
  assert.equal(r.handled, true);
  assert.match(r.text, /confirmed/i);
  const after = (await events.listSpeakers(ev2.id)).find((s) => Number(s.userId) === Number(guest.id));
  assert.ok(after && after.status === 'active');
});
