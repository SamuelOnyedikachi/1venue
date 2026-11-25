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
export const isRinging = () => !!ringing;

/** The Document PiP window, if the app-wide pop-out is open. */
function pipWin() {
  try {
    const w = window.documentPictureInPicture && window.documentPictureInPicture.window;
    return w && !w.closed ? w : null;
  } catch { return null; }
}
function pipCallSlot() {
  const w = pipWin();
  return (w && w.document && w.document.querySelector('.app-pip-call')) || null;
}
function callHost() {
  const slot = pipCallSlot();
  if (slot) return slot;
  // While the pop-out is opening, the slot may not exist yet. Don't fall back to
  // the PiP body (that docks the bar as an overlay). Retry after the slot is in.
  if (pipWin()) return null;
  return document.body;
}
/** After moving a bar between documents, resume media so video/audio keep playing. */
function resumeMedia(root) {
  if (!root || !root.querySelectorAll) return;
  root.querySelectorAll('video, audio').forEach((m) => {
    if (m.paused && !m.ended) m.play().catch(() => {});
  });
}
/** Move (do not clone) the call/ring UI into the PiP window when it is open, else back to the page. */
export function placeCallUi(el = (cur && cur.el) || (ringing && ringing.el)) {
  if (!el) return;
  const host = callHost();
  if (!host) return;
  const inPip = host.classList && host.classList.contains('app-pip-call');
  el.classList.toggle('in-pip', inPip);
  if (el.parentNode !== host) {
    host.append(el);
    resumeMedia(el);
  }
}
export function placeAllCallUi() {
  if (cur && cur.el) placeCallUi(cur.el);
  if (ringing && ringing.el) placeCallUi(ringing.el);
}
function watchPip() {
  if (typeof window === 'undefined' || !('documentPictureInPicture' in window) || watchPip.done) return;
  watchPip.done = true;
  window.documentPictureInPicture.addEventListener('enter', (e) => {
    placeAllCallUi();
    const w = e.window;
    if (!w) return;
    const leave = () => { w.removeEventListener('pagehide', leave); placeAllCallUi(); };
    w.addEventListener('pagehide', leave);
  });
}
watchPip();

const ringtone = () => startRingtone();
function dismissRing() { if (!ringing) return; ringing.stop(); ringing.el.remove(); stopCallAlert(ringing.call.id); ringing = null; }

/** Incoming call (from the user socket). */
export function incoming(call) {
  if (cur || (ringing && ringing.call.id === call.id)) return;
  dismissRing();
  const from = call.from || {};
  const el = h('div', { class: 'call-ring', role: 'alertdialog', 'aria-label': `Incoming call from ${call.title || from.name}` },
    avatar(from.name || call.title, from.avatarUrl, 'lg'),
    h('div', { class: 'call-ring-txt' }, h('b', null, call.title || from.name || 'Call'), h('span', null, call.ai || call.reason
      ? (call.reason ? `Notification is calling · ${String(call.reason).slice(0, 140)}` : 'Notification is calling you')
      : `Incoming ${call.kind === 'video' ? 'video' : 'audio'} call${call.group && from.name ? ` · ${from.name}` : ''}`)),
    h('div', { class: 'call-ring-act' },
      h('button', { class: 'call-btn decline', type: 'button', 'aria-label': 'Decline', html: icon('phoneOff', { size: 22 }), onclick: () => decline(call) }),
      h('button', { class: 'call-btn accept', type: 'button', 'aria-label': 'Accept', html: icon(call.kind === 'video' ? 'video' : 'phone', { size: 22 }), onclick: () => accept(call) })));
  placeCallUi(el);
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
  try { const r = await api(`/api/messages/calls/${call.id}/accept`, { method: 'POST' }); await join(r, call.title || call.from?.name, { ai: r.ai || r.call }); }
  catch (e) { toastErr(e); }
}

/** Start a call in a conversation. */
export async function startCall(conversationId, kind, title) {
  if (cur) return toast('You are already in a call', { icon: 'phone' });
  const r = await api(`/api/messages/conversations/${conversationId}/calls`, { method: 'POST', body: { kind } });
  await join(r, title, { outgoing: true, ai: r.ai || r.call });
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
async function join(r, title, { outgoing = false, ai = null } = {}) {
  const video = r.call.kind === 'video';
  const isAi = !!(ai && (ai.ai || ai.greeting || r.call?.ai));
  const el = h('div', { class: 'call-bar' + (isAi ? ' is-ai' : ''), role: 'region', 'aria-label': 'Call' },
    h('div', { class: 'call-media' }),
    h('div', { class: 'call-head' }, h('span', { class: 'call-dot' }), h('b', { class: 'ellipsis' }, title || (isAi ? 'Notification' : 'Call')), h('span', { class: 'call-state' }, '')),
    isAi ? h('div', { class: 'call-ai' },
      h('span', { class: 'call-level', title: 'Microphone level', 'aria-hidden': 'true' }, h('i')),
      h('span', { class: 'call-ai-state' }, 'Connecting…')) : null,
    h('div', { class: 'call-ctl' },
      h('span', { 'data-k': 'mute' }), isAi ? null : h('span', { 'data-k': 'cam' }),
      isAi ? null : ib('users', 'Make it a meeting (screen share, more people)', toMeeting),
      h('button', { class: 'call-btn decline sm', type: 'button', 'aria-label': 'Hang up', 'data-tip': 'Hang up', html: icon('phoneOff', { size: 20 }), onclick: hangUp })));
  placeCallUi(el);
  cur = { call: r.call, el, title, outgoing, muted: false, camOn: video, t0: 0, timer: null, room: null, ai: isAi ? (r.ai || ai) : null };
  paint();
  try {
    cur.room = await connect(r, video && !isAi);
    if (isAi) await startAiAgent(r.ai || ai, r.call);
  } catch (e) { await api(`/api/messages/calls/${r.call.id}/leave`, { method: 'POST' }).catch(() => {}); teardown(); toastErr(e); }
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
  const pip = (() => { try { return window.documentPictureInPicture && window.documentPictureInPicture.window; } catch { return null; } })();
  const { bringMainToFront } = await import('../bring-main.js');
  bringMainToFront(pip && !pip.closed ? pip.document : null);
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
  try { c.stopAi && c.stopAi(); } catch { /* ignore */ }
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


async function playUrl(url, text) {
  if (!cur) return;
  cur.player && cur.player.pause();
  if (url) {
    const a = new Audio(url);
    cur.player = a;
    try { await a.play(); await new Promise((res) => { a.onended = res; a.onerror = res; }); } catch { /* blocked */ }
    return;
  }
  if (text && window.speechSynthesis) {
    await new Promise((res) => {
      const u = new SpeechSynthesisUtterance(text);
      u.onend = res; u.onerror = res;
      cur.player = { paused: false, pause() { this.paused = true; try { speechSynthesis.cancel(); } catch { /* */ } res(); } };
      speechSynthesis.speak(u);
    });
  }
}

async function startAiAgent(ai, call) {
  if (!cur) return;
  connected();
  const settings = ai && (ai.silenceMs || ai.silenceQuestionMs) ? ai : await api('/api/messages/ai-calls/settings').catch(() => ({ silenceMs: 1500, silenceQuestionMs: 800 }));
  let silenceMs = Math.min(4000, Math.max(800, Number(settings.silenceMs) || 1500));
  const extraQ = Math.max(0, Number(settings.silenceQuestionMs) || 0);
  const callId = call.id;
  const aiId = (ai && ai.aiCallId) || callId;
  const setAi = (state, err, { toastError = false } = {}) => {
    if (!cur || cur.call.id !== callId) return;
    cur.aiState = state;
    const label = err || ({ listening: 'Listening', thinking: 'Thinking…', speaking: 'Speaking' }[state] || '');
    const el = cur.el.querySelector('.call-ai-state');
    if (el) el.textContent = label;
    cur.el.dataset.aiState = state;
    if (err && toastError) toast(err, { icon: 'mic' });
  };
  const setLevel = (lvl) => {
    if (!cur) return;
    const bar = cur.el.querySelector('.call-level i');
    if (bar) bar.style.transform = `scaleX(${Math.min(1, Math.max(0.04, lvl * 8))})`;
  };
  setAi('speaking');
  if (ai && (ai.audioUrl || ai.greeting)) {
    const asked = /\?\s*$/.test(ai.greeting || '');
    if (asked) silenceMs = Math.min(4000, silenceMs + extraQ);
    await playUrl(ai.audioUrl, ai.greeting);
  }
  let stream, ctx, rec, speaking = false, lastVoice = 0, voiceSince = 0, chunks = [], sending = false, stopped = false, ignoreUntil = 0, reuseLk = false;
  try {
    const lkTrack = [...(cur.room?.localParticipant?.audioTrackPublications?.values?.() || [])][0]?.track?.mediaStreamTrack;
    if (lkTrack && lkTrack.readyState === 'live') { stream = new MediaStream([lkTrack]); reuseLk = true; }
    else stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false });
  } catch (e) {
    setAi('listening', 'Microphone is needed so Notification can hear you. You can also type in the chat.', { toastError: true });
    return;
  }
  const AC = window.AudioContext || window.webkitAudioContext;
  ctx = new AC();
  try { await ctx.resume(); } catch { /* */ }
  const src = ctx.createMediaStreamSource(stream);
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 2048;
  src.connect(analyser);
  const data = new Uint8Array(analyser.fftSize);
  const mime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : (MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm' : '');
  const startRec = () => {
    chunks = [];
    try {
      rec = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream);
      rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
      rec.start(200);
    } catch (e) { console.warn('ai-call recorder', e); }
  };
  startRec();
  const rms = () => {
    analyser.getByteTimeDomainData(data);
    let s = 0;
    for (let i = 0; i < data.length; i++) { const v = (data[i] - 128) / 128; s += v * v; }
    return Math.sqrt(s / data.length);
  };
  const playing = () => {
    if (!cur || !cur.player) return false;
    if (typeof cur.player.paused === 'boolean') return cur.player.paused === false;
    return true;
  };
  const flush = async () => {
    if (sending || stopped || !cur || cur.call.id !== callId) return;
    sending = true;
    setAi('thinking');
    try {
      const recRef = rec;
      if (recRef && recRef.state === 'recording') recRef.stop();
      const blob = await new Promise((res) => {
        const t = setTimeout(() => res(new Blob(chunks, { type: recRef && recRef.mimeType || mime || 'audio/webm' })), 800);
        if (recRef) recRef.onstop = () => { clearTimeout(t); res(new Blob(chunks, { type: recRef.mimeType || mime || 'audio/webm' })); };
      });
      startRec();
      if (blob.size < 400) { setAi('listening'); return; }
      const buf = await blob.arrayBuffer();
      const bytes = new Uint8Array(buf);
      let bin = '';
      for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
      const b64 = btoa(bin);
      const filler = setTimeout(() => {
        setAi('thinking', 'One moment…');
        try {
          if (window.speechSynthesis) {
            const u = new SpeechSynthesisUtterance('One moment');
            u.rate = 1.05;
            speechSynthesis.cancel();
            speechSynthesis.speak(u);
            ignoreUntil = Date.now() + 1600;
          }
        } catch { /* */ }
      }, 2800);
      let r;
      try {
        r = await api(`/api/messages/ai-calls/${aiId}/turn`, { method: 'POST', body: { audio: b64, mime: blob.type || mime || 'audio/webm' }, timeoutMs: 25000 });
      } finally {
        clearTimeout(filler);
        try { speechSynthesis.cancel(); } catch { /* */ }
      }
      if (!cur || cur.call.id !== callId) return;
      if (r && r.silenceMs) silenceMs = Math.min(4000, Math.max(800, Number(r.silenceMs) || silenceMs));
      if (!r || r.wait) { setAi('listening', r && r.wait ? 'Didn’t catch that, try again' : null); return; }
      if (r.audioUrl || r.text) {
        setAi('speaking');
        ignoreUntil = Date.now() + 400;
        await playUrl(r.audioUrl, r.text);
        ignoreUntil = Date.now() + 350;
      }
      setAi('listening');
    } catch (e) {
      console.warn('ai-call turn', e);
      setAi('listening', e.message || 'Could not send what you said', { toastError: true });
    } finally { sending = false; speaking = false; }
  };
  setAi('listening');
  const tick = () => {
    if (stopped || !cur || cur.call.id !== callId) return;
    if (ctx && ctx.state === 'suspended') ctx.resume().catch(() => {});
    const lvl = rms();
    setLevel(lvl);
    const now = Date.now();
    const ttsOn = playing();
    const thresh = ttsOn ? 0.12 : 0.02;
    const voice = !cur.muted && lvl > thresh && now >= ignoreUntil;
    if (ttsOn && !voice) { lastVoice = 0; voiceSince = 0; speaking = false; }
    else if (voice) {
      if (!voiceSince) voiceSince = now;
      lastVoice = now;
      if (now - voiceSince >= 80) {
        if (cur.player) { try { cur.player.pause(); } catch { /* */ } cur.player = null; }
        speaking = true;
        if (cur.aiState !== 'thinking') setAi('listening');
      }
    } else {
      voiceSince = 0;
      if (speaking && now - lastVoice >= silenceMs) {
        speaking = false;
        flush();
      }
    }
    cur.aiTick = requestAnimationFrame(tick);
  };
  cur.aiTick = requestAnimationFrame(tick);
  cur.stopAi = () => {
    stopped = true;
    if (cur.aiTick) cancelAnimationFrame(cur.aiTick);
    try { rec && rec.state !== 'inactive' && rec.stop(); } catch { /* */ }
    try { if (!reuseLk && stream) stream.getTracks().forEach((tr) => tr.stop()); } catch { /* */ }
    try { ctx && ctx.close(); } catch { /* */ }
    try { cur.player && cur.player.pause(); } catch { /* */ }
  };
}

