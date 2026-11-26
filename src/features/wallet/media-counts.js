/**
 * Count LiveKit-connected publishers (cam, mic or screen on) vs viewers for meeting rates.
 * Tests can pin counts with setCountsForTest(code, { publishers, viewers }).
 */
const countsOverride = new Map();
function setCountsForTest(code, counts) {
  if (!code) { countsOverride.clear(); return; }
  if (!counts) countsOverride.delete(code);
  else countsOverride.set(code, { publishers: Number(counts.publishers) || 0, viewers: Number(counts.viewers) || 0 });
}

function trackIsPublisher(t) {
  if (!t || t.muted || t.isMuted) return false;
  const src = t.source;
  if (src === 1 || src === 2 || src === 3 || src === 4) return true; // camera, mic, screen, screen audio
  const name = String(src || t.type || t.kind || '').toLowerCase();
  return /camera|microphone|screen|audio|video/.test(name) && !/data/.test(name);
}

function participantIsPublisher(p) {
  if (!p) return false;
  if (p.media && (p.media.cam || p.media.mic || p.media.sharing)) return true;
  if (p.sharing || p.cam || p.mic) return true;
  const tracks = p.tracks || (p.trackPublications && (typeof p.trackPublications.values === 'function' ? [...p.trackPublications.values()] : Object.values(p.trackPublications))) || [];
  return tracks.some(trackIsPublisher);
}

function fromList(list) {
  let publishers = 0, viewers = 0;
  for (const p of list || []) {
    if (participantIsPublisher(p)) publishers += 1;
    else viewers += 1;
  }
  return { publishers, viewers };
}

async function countsFor(meeting) {
  const code = meeting?.code;
  if (code && countsOverride.has(code)) return countsOverride.get(code);
  const room = meeting?.mediaRoom || meeting?.code;
  try {
    const { roomClient } = require('../../livekit/cleanup');
    const client = roomClient();
    if (client && room) {
      const list = await client.listParticipants(room);
      if (Array.isArray(list)) return fromList(list);
    }
  } catch (e) {
    if (!(e && (e.status === 404 || e.code === 'not_found' || e.statusCode === 404))) {
      console.warn('[billing] media counts', code, e.message);
    }
  }
  const list = [];
  if (meeting?.participants) {
    for (const p of meeting.participants.values()) {
      if (p && p.status === 'ACTIVE') list.push(p);
    }
  }
  if (!list.length) return { publishers: 1, viewers: 0 };
  return fromList(list);
}

module.exports = { countsFor, fromList, participantIsPublisher, setCountsForTest };
