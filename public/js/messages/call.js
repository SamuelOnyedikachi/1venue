// 1:1 and small-group calls from Messages. Short-lived LiveKit rooms; ringing arrives over the user
// socket (live.js). One call at a time per tab. Calls never touch wallet credits.
import { h, api, toast, toastErr, avatar } from '../ui.js';
import { icon } from '../icons.js';
import { loadLiveKit } from '../room/media.js';
import { startRingtone } from './tones.js';
import { startCallAlert, stopCallAlert } from './call-alert.js';

let cur = null;      // { call, room, el, video, muted, camOn, t0, timer, title }
let ringing = null;  // { call, el, stop }
const ib = (ic, label, run, cls = '') => h('button', { class: `icon-btn ${cls}`, type: 'button', 'aria-label': label, 'data-tip': label, onclick: run, html: icon(ic, { size: 20 }) });
const me = () => import('../app.js').then((a) => a.state.user);
export const inCall = () => !!cur;

const ringtone = () => startRingtone();
function dismissRing() { if (!ringing) return; ringing.stop(); ringing.el.remove(); stopCallAlert(ringing.call.id); ringing = null; }

/** Incoming call (from the user socket). */
export function incoming(call) {
  if (cur || (ringing && ringing.call.id === call.id)) return;
  dismissRing();
  const from = call.from || {};
  const el = h('div', { class: 'call-ring', role: 'alertdialog', 'aria-label': `Incoming call from ${call.title || from.name}` },
    avatar(from.name || call.title, from.avatarUrl, 'lg'),
    h('div', { class: 'call-ring-txt' }, h('b', null, call.title || from.name || 'Call'), h('span', null, `Incoming ${call.kind === 'video' ? 'video' : 'audio'} call${call.group && from.name ? ` · ${from.name}` : ''}`)),
    h('div', { class: 'call-ring-act' },
      h('button', { class: 'call-btn decline', type: 'button', 'aria-label': 'Decline', html: icon('phoneOff', { size: 22 }), onclick: () => decline(call) }),
      h('button', { class: 'call-btn accept', type: 'button', 'aria-label': 'Accept', html: icon(call.kind === 'video' ? 'video' : 'phone', { size: 22 }), onclick: () => accept(call) })));
  document.body.append(el);
  ringing = { call, el, stop: ringtone() };
  startCallAlert(call, { onAnswer: () => accept(call), onDecline: () => decline(call) }); // background tab: notification, title, PiP
}
/** Answer straight away (from the notification's Answer button). */
export function answerCall(call) { return accept(call); }

// Answer / Decline / click on the system notification (relayed by the service worker).
if (typeof navigator !== 'undefined' && navigator.serviceWorker) {
  navigator.serviceWorker.addEventListener('message', (e) => {
    const d = e.data || {};
    if (d.type !== 'call-action' || !ringing || ringing.call.id !== d.callId) return;
    if (d.action === 'answer') accept(ringing.call);
    else if (d.action === 'decline') decline(ringing.call);
    else stopCallAlert(d.callId); // a plain click focused the tab: the ring sheet takes over
  });
}
async function decline(call) { dismissRing(); await api(`/api/messages/calls/${call.id}/decline`, { method: 'POST' }).catch(() => {}); }
async function accept(call) {
  dismissRing();
  try { const r = await api(`/api/messages/calls/${call.id}/accept`, { method: 'POST' }); await join(r, call.title || call.from?.name); }
  catch (e) { toastErr(e); }
}

/** Start a call in a conversation. */
export async function startCall(conversationId, kind, title) {
  if (cur) return toast('You are already in a call', { icon: 'phone' });
  const r = await api(`/api/messages/conversations/${conversationId}/calls`, { method: 'POST', body: { kind } });
  await join(r, title, { outgoing: true });
}

async function connect(r, video) {
  const LK = await loadLiveKit();
  const room = new LK.Room({ adaptiveStream: true, dynacast: true });
  const media = cur.el.querySelector('.call-media');
  room.on(LK.RoomEvent.TrackSubscribed, (track, _pub, p) => {
    const el = track.attach(); el.dataset.p = p.identity;
    if (track.kind === 'video') { el.className = 'call-video'; media.append(el); cur.el.classList.add('has-video'); } else { el.hidden = true; cur.el.append(el); }
  });
  room.on(LK.RoomEvent.TrackUnsubscribed, (track) => { track.detach().forEach((x) => x.remove()); if (!media.querySelector('video')) cur?.el.classList.remove('has-video'); });
  room.on(LK.RoomEvent.ParticipantConnected, () => connected());
  room.on(LK.RoomEvent.Disconnected, () => { if (cur && cur.room === room && !cur.switching) teardown('Call ended'); });
  await room.connect(r.url, r.token);
  await room.localParticipant.setMicrophoneEnabled(!cur.muted).catch(() => toast('Microphone is blocked', { icon: 'micOff' }));
  if (video && cur.camOn) {
    await room.localParticipant.setCameraEnabled(true).catch(() => { cur.camOn = false; toast('Camera is blocked', { icon: 'videoOff' }); });
    const t = [...room.localParticipant.videoTrackPublications.values()][0]?.track;
    if (t) { const v = t.attach(); v.className = 'call-video self'; v.muted = true; media.append(v); cur.el.classList.add('has-video'); }
  }
  if (room.remoteParticipants.size) connected();
  return room;
}
function connected() {
  if (!cur || cur.t0) return;
  cur.t0 = Date.now(); paint();
  cur.timer = setInterval(paint, 1000);
}
function paint() {
  if (!cur) return;
  const s = cur.t0 ? Math.floor((Date.now() - cur.t0) / 1000) : 0;
  cur.el.querySelector('.call-state').textContent = cur.t0 ? `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}` : cur.outgoing ? 'Ringing…' : 'Connecting…';
  cur.el.querySelector('[data-k="mute"]').replaceWith(ib(cur.muted ? 'micOff' : 'mic', cur.muted ? 'Unmute' : 'Mute', toggleMute, cur.muted ? 'on' : ''));
  const v = cur.el.querySelector('[data-k="cam"]'); v && v.replaceWith(ib(cur.camOn ? 'video' : 'videoOff', cur.camOn ? 'Turn camera off' : 'Turn camera on', toggleCam, cur.camOn ? '' : 'on'));
  cur.el.querySelectorAll('.call-ctl .icon-btn').forEach((b, i) => { b.dataset.k = ['mute', 'cam', 'meet', 'hang'][i]; });
}
async function join(r, title, { outgoing = false } = {}) {
  const video = r.call.kind === 'video';
  const el = h('div', { class: 'call-bar', role: 'region', 'aria-label': 'Call' },
    h('div', { class: 'call-media' }),
    h('div', { class: 'call-head' }, h('span', { class: 'call-dot' }), h('b', { class: 'ellipsis' }, title || 'Call'), h('span', { class: 'call-state' }, '')),
    h('div', { class: 'call-ctl' },
      h('span', { 'data-k': 'mute' }), h('span', { 'data-k': 'cam' }),
      ib('users', 'Make it a meeting (screen share, more people)', toMeeting),
      h('button', { class: 'call-btn decline sm', type: 'button', 'aria-label': 'Hang up', 'data-tip': 'Hang up', html: icon('phoneOff', { size: 20 }), onclick: hangUp })));
  document.body.append(el);
  cur = { call: r.call, el, title, outgoing, muted: false, camOn: video, t0: 0, timer: null, room: null };
  paint();
  try { cur.room = await connect(r, video); }
  catch (e) { await api(`/api/messages/calls/${r.call.id}/leave`, { method: 'POST' }).catch(() => {}); teardown(); toastErr(e); }
}
async function toggleMute() { if (!cur) return; cur.muted = !cur.muted; await cur.room?.localParticipant.setMicrophoneEnabled(!cur.muted).catch(() => {}); paint(); }
async function toggleCam() {
  if (!cur) return;
  if (cur.call.kind !== 'video') {
    try { await api(`/api/messages/calls/${cur.call.id}/video`, { method: 'POST' }); } catch (e) { return toastErr(e); }
    return; // call-upgraded arrives over the socket and reconnects everyone with camera rights
  }
  cur.camOn = !cur.camOn;
  await cur.room?.localParticipant.setCameraEnabled(cur.camOn).catch(() => { cur.camOn = false; });
  if (!cur.camOn) cur.el.querySelectorAll('.call-video.self').forEach((v) => v.remove());
  else { const t = [...cur.room.localParticipant.videoTrackPublications.values()][0]?.track; if (t) { const v = t.attach(); v.className = 'call-video self'; v.muted = true; cur.el.querySelector('.call-media').append(v); cur.el.classList.add('has-video'); } }
  paint();
}
async function reconnectWithVideo(call) {
  if (!cur || cur.call.id !== call.id) return;
  try {
    const r = await api(`/api/messages/calls/${call.id}/token`, { method: 'POST' });
    cur.switching = true; await cur.room?.disconnect(); cur.switching = false;
    cur.call = r.call; cur.el.querySelector('.call-media').replaceChildren();
    cur.room = await connect(r, true); paint();
  } catch (e) { toastErr(e); }
}
async function toMeeting() {
  if (!cur) return;
  const { call, title } = cur;
  sessionStorage.setItem('venue.intent', JSON.stringify({ create: true, name: title ? `Call with ${title}` : 'Meeting', thread: call.conversationId }));
  await hangUp();
  (await import('../app.js')).navigate('/new');
}
async function hangUp() {
  if (!cur) return;
  const id = cur.call.id;
  teardown();
  await api(`/api/messages/calls/${id}/leave`, { method: 'POST' }).catch(() => {});
}
function teardown(msg) {
  if (!cur) return;
  const c = cur; cur = null;
  clearInterval(c.timer);
  try { c.room && c.room.disconnect(); } catch { /* ignore */ }
  c.el.remove();
  if (msg) toast(msg, { icon: 'phoneOff' });
}

/** Call events from the user socket. */
export async function onEvent(m) {
  const id = m.callId || m.call?.id;
  if (ringing && ringing.call.id === id && ['call-ended', 'call-declined'].includes(m.type)) dismissRing();
  if (m.type === 'call-accepted' && ringing && ringing.call.id === id && Number(m.userId) === Number((await me())?.id)) dismissRing(); // answered on another device
  if (!cur || cur.call.id !== id) return;
  if (m.type === 'call-accepted') connected();
  else if (m.type === 'call-upgraded') { cur.camOn = true; reconnectWithVideo(m.call); }
  else if (m.type === 'call-ended') teardown(m.reason === 'declined' ? 'Call declined' : m.reason === 'missed' ? 'No answer' : 'Call ended');
}
