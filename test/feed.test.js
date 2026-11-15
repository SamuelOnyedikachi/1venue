'use strict';
// Feed filters, upcoming RSVPs, suggested hosts, today's verse.
const test = require('node:test');
const assert = require('node:assert/strict');
const { boot, client, signupPayload } = require('./helpers/server');
const { verseOfTheDay, dayOfYear, DAILY } = require('../src/features/social/verse');

const skip = !process.env.DATABASE_URL ? 'set DATABASE_URL' : false;

test('today’s verse rotates by UTC date and stays stable for a given day', () => {
  const a = verseOfTheDay(new Date('2026-11-15T00:30:00Z'));
  const b = verseOfTheDay(new Date('2026-11-15T23:59:00Z'));
  assert.equal(a.ref, b.ref);
  assert.ok(a.text && a.ref);
  assert.match(a.href, /\/books\?ref=/);
  const next = verseOfTheDay(new Date('2026-11-16T00:30:00Z'));
  // 366/365 days vs list length — adjacent days may rarely collide; just check the index math.
  assert.equal(dayOfYear(new Date('2026-01-01T12:00:00Z')), 1);
  assert.equal(dayOfYear(new Date('2026-12-31T12:00:00Z')), 365);
  const i = (dayOfYear(new Date('2026-11-15T12:00:00Z')) % DAILY.length + DAILY.length) % DAILY.length;
  assert.equal(a.ref, DAILY[i].ref);
  assert.ok(next.ref);
});

test('feed filters, upcoming RSVPs, and suggested hosts', { skip, timeout: 120000 }, async () => {
  const s = await boot();
  try {
    const host = client(s.base);
    const guest = client(s.base);
    const friend = client(s.base);
    const hostBody = signupPayload();
    const friendBody = signupPayload();
    const hs = await host.post('/api/signup', hostBody);
    const fs_ = await friend.post('/api/signup', friendBody);
    assert.ok(hs.status === 200 || hs.status === 201, JSON.stringify(hs.body));
    assert.ok(fs_.status === 200 || fs_.status === 201, JSON.stringify(fs_.body));
    const hostUser = (await host.get('/api/session')).body.user;
    const friendUser = (await friend.get('/api/session')).body.user;
    assert.ok(hostUser && friendUser);

    const starts = new Date(Date.now() + 2 * 864e5).toISOString();
    const ev = await host.post('/api/events', {
      title: 'Lagos founders breakfast ' + Date.now(),
      category: 'seminar',
      visibility: 'public',
      startsAt: starts,
    });
    assert.ok(ev.status === 200 || ev.status === 201, JSON.stringify(ev.body));

    const thought = await host.post('/api/posts', { body: 'Planning a quiet morning session for founders in Yaba.' });
    assert.equal(thought.status, 200, JSON.stringify(thought.body));

    const verse = await host.post('/api/posts', {
      body: 'A word for the week',
      media: [{ type: 'passage', reference: 'Psalm 23:1', text: 'The LORD is my shepherd; I shall not want.', translation: 'eng_kjv', short: 'KJV' }],
    });
    assert.equal(verse.status, 200, JSON.stringify(verse.body));
    assert.ok((verse.body.media || []).some((m) => m.type === 'passage'));

    const priv = await host.post('/api/events', {
      title: 'Private board check-in ' + Date.now(),
      category: 'meeting',
      visibility: 'private',
      startsAt: new Date(Date.now() + 3 * 864e5).toISOString(),
    });
    assert.ok(priv.status === 200 || priv.status === 201, JSON.stringify(priv.body));
    const secret = await host.post('/api/posts', { body: 'Internal agenda — not for the public feed.', eventId: priv.body.id });
    assert.equal(secret.status, 200, JSON.stringify(secret.body));

    const bad = await guest.get('/api/feed?filter=nope');
    assert.equal(bad.status, 400);

    const allGuest = await guest.get('/api/feed?filter=all');
    assert.equal(allGuest.status, 200, JSON.stringify(allGuest.body));
    const allIds = (allGuest.body.posts || []).map((p) => p.id);
    assert.ok(allIds.includes(thought.body.id), 'public posts appear in All');
    assert.ok(!allIds.includes(secret.body.id), 'private event posts stay hidden from guests');

    const followingGuest = await guest.get('/api/feed?filter=following');
    assert.equal(followingGuest.status, 200);
    assert.equal((followingGuest.body.posts || []).length, 0, 'guests have no following feed');

    const verses = await guest.get('/api/feed?filter=verses');
    assert.ok((verses.body.posts || []).some((p) => p.id === verse.body.id), 'verses filter finds passage posts');
    assert.ok((verses.body.posts || []).every((p) => (p.media || []).some((m) => m.type === 'passage')));

    const events = await friend.get('/api/feed?filter=events');
    assert.ok((events.body.posts || []).every((p) => p.event || p.kind.startsWith('event_')), 'events filter is event-only');
    assert.ok(!(events.body.posts || []).some((p) => p.id === thought.body.id), 'plain thoughts are not events');

    const liveEmpty = await guest.get('/api/feed?filter=live');
    assert.equal(liveEmpty.status, 200);
    assert.ok(!(liveEmpty.body.posts || []).some((p) => p.id === thought.body.id));

    // Mark the public event live and attach an event_live post.
    const db = require('../db');
    await db.q(`UPDATE events SET status='live', started_at=NOW() WHERE id=$1`, [ev.body.id]);
    const social = require('../src/features/social/data');
    const livePost = await social.createPost(hostUser.id, { kind: 'event_live', eventId: ev.body.id, body: ev.body.title });
    const liveFeed = await friend.get('/api/feed?filter=live');
    assert.ok((liveFeed.body.posts || []).some((p) => p.id === livePost.id), 'live filter includes event_live posts');
    // restore so upcoming still counts it as a scheduled RSVP later
    await db.q(`UPDATE events SET status='scheduled', started_at=NULL WHERE id=$1`, [ev.body.id]);

    const beforeFollow = await friend.get('/api/feed?filter=following');
    assert.ok(!(beforeFollow.body.posts || []).some((p) => p.id === thought.body.id), 'unfollowed hosts are not in Following');

    const fol = await friend.post(`/api/users/${hostUser.id}/follow`, { on: true });
    assert.equal(fol.status, 200, JSON.stringify(fol.body));
    const afterFollow = await friend.get('/api/feed?filter=following');
    assert.ok((afterFollow.body.posts || []).some((p) => p.id === thought.body.id), 'followees appear in Following');

    // Suggested hosts: someone who doesn't follow the host should see them.
    // The rails endpoint only returns a short list, ranked by follower count, so
    // give this host enough follows to outrank leftover seed/test accounts.
    const top = await db.q('SELECT COUNT(*)::int AS n FROM follows GROUP BY followee_id ORDER BY n DESC LIMIT 1');
    const need = Number((top.rows[0] && top.rows[0].n) || 0) + 1;
    await db.q(`INSERT INTO follows (follower_id, followee_id)
      SELECT u.id, $1 FROM users u
      WHERE u.id <> $1
        AND NOT EXISTS (SELECT 1 FROM follows f WHERE f.follower_id=u.id AND f.followee_id=$1)
      LIMIT $2`, [hostUser.id, need]);
    const strangerBody = signupPayload();
    const stranger = client(s.base);
    assert.ok([200, 201].includes((await stranger.post('/api/signup', strangerBody)).status));
    const railsStranger = await stranger.get('/api/feed/rails');
    assert.equal(railsStranger.status, 200, JSON.stringify(railsStranger.body));
    assert.ok((railsStranger.body.suggested || []).some((p) => p.id === hostUser.id || p.username === hostUser.username),
      'hosts with public events show up as suggestions');
    assert.ok(railsStranger.body.verse && railsStranger.body.verse.ref && railsStranger.body.verse.text);
    assert.equal((railsStranger.body.upcoming || []).length, 0, 'no RSVPs yet');

    const railsFriendBefore = await friend.get('/api/feed/rails');
    assert.ok(!(railsFriendBefore.body.suggested || []).some((p) => p.id === hostUser.id),
      'already-followed hosts are not suggested');

    const rsvp = await friend.post(`/api/events/${ev.body.id}/rsvp`);
    assert.equal(rsvp.status, 200, JSON.stringify(rsvp.body));
    assert.equal(rsvp.body.going, true);
    const railsFriend = await friend.get('/api/feed/rails');
    const up = railsFriend.body.upcoming || [];
    assert.ok(up.length >= 1 && up.length <= 3);
    assert.ok(up.some((e) => e.id === ev.body.id), 'upcoming includes the next RSVP');

    const railsGuest = await guest.get('/api/feed/rails');
    assert.equal((railsGuest.body.upcoming || []).length, 0);
    assert.ok(railsGuest.body.verse && railsGuest.body.verse.ref);

    // Live now list after we restored the event to scheduled.
    assert.ok(Array.isArray(railsGuest.body.live));
  } finally {
    await s.stop();
  }
});
