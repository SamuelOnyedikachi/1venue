/**
 * Notification AI voice calls.
 *
 * There is no LiveKit rtc-node agent in this repo. The call still uses the existing in-app
 * ring + LiveKit room so the user gets a real incoming call, but speech goes over HTTP:
 * the browser measures end-of-turn silence, posts an audio chunk to /turn, and plays the
 * TTS reply (barge-in stops playback). If LiveKit, Replicate, or AI_CALLS_ENABLED is off,
 * we leave a pinned Notification message instead.
 */
const os = require('os');
const { q, one } = require('../../core/db');
const config = require('../../config');
const { fail } = require('./access');
const { isLiveKitConfigured } = require('../../livekit/tokens');

const ownerId = () => `${os.hostname()}:${process.pid}`;

async function silenceSettings() {
  let plat = {};
  try { plat = require('../../lib/plans').platform(await require('../../lib/plans').getSettings()); } catch (_) {}
  const clamp = (v, min, max, d) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : d;
  };
  return {
    silenceMs: clamp(plat.aiCallSilenceMs, 800, 4000, 1500),
    silenceQuestionMs: clamp(plat.aiCallSilenceQuestionMs, 0, 4000, 800),
  };
}

function parseJson(v, fallback) {
  if (v == null) return fallback;
  if (typeof v === 'string') { try { return JSON.parse(v); } catch (_) { return fallback; } }
  return v;
}

async function rowByCall(callId) { return one('SELECT * FROM ai_calls WHERE call_id=$1 ORDER BY id DESC LIMIT 1', [String(callId || '')]); }
async function rowById(id) { return one('SELECT * FROM ai_calls WHERE id=$1', [id]); }

async function recentCount(userId, ms, { requested } = {}) {
  const since = new Date(Date.now() - ms).toISOString();
  const r = requested == null
    ? await one('SELECT COUNT(*) AS n FROM ai_calls WHERE user_id=$1 AND started_at >= $2', [userId, since])
    : await one('SELECT COUNT(*) AS n FROM ai_calls WHERE user_id=$1 AND started_at >= $2 AND requested=$3', [userId, since, requested]);
  return Number(r && r.n) || 0;
}

async function fallbackMessage(userId, reason, detail) {
  const notify = require('./notify');
  await notify.send(userId, {
    style: 'detailed',
    text: detail || `I wanted to call you about this: ${reason || 'a notification'}. I left this message instead — reply here and I’ll help.`,
  });
  return { ok: false, fallback: 'message' };
}

async function requestCall(userId, { reason = 'Notification has an update for you.', requested = false, prompt = '' } = {}) {
  const notify = require('./notify');
  const bot = await notify.systemUser();
  if (!bot) return fallbackMessage(userId, reason, 'I couldn’t place a call just then. Reply here instead.');
  if (!config.NOTIFY.callsEnabled || !isLiveKitConfigured()) {
    return fallbackMessage(userId, reason, `I wanted to call you (${reason}). Voice calls from Notification aren’t on right now, so I’m writing instead. Reply here, or turn calls on in /settings#notifications once they’re enabled.`);
  }
  const prefs = notify.callPrefs(await notify.extraOf(userId));
  if (prefs.optOut) return fallbackMessage(userId, reason, `I was going to call about: ${reason}. You’ve turned Notification calls off, so here is the message instead.`);
  if (!requested && !prefs.enabled) return fallbackMessage(userId, reason, `I was going to call about: ${reason}. Turn on Notification calls in /settings#notifications if you’d like me to ring you for urgent invites and reminders.`);
  if (!requested && notify.inQuietHours(prefs)) {
    return fallbackMessage(userId, reason, `I was going to call about: ${reason}. It’s quiet hours, so I left this instead. Ask me to call you later if you’d like.`);
  }
  if (!requested) {
    if (await recentCount(userId, 3600000, { requested: false }) >= config.NOTIFY.callsPerHour) {
      return fallbackMessage(userId, reason, `${reason} I already called recently, so I’m writing this time.`);
    }
    if (await recentCount(userId, 86400000, { requested: false }) >= config.NOTIFY.callsPerDay) {
      return fallbackMessage(userId, reason, `${reason} That’s all the Notification calls for today — I’ll keep helping here.`);
    }
  }
  const { conversation } = await notify.ensureThread(userId);
  const calls = require('./calls');
  let started;
  try {
    const silence = await silenceSettings();
    started = await calls.start(bot, conversation.id, 'audio', {
      ai: true, reason, silenceMs: silence.silenceMs, silenceQuestionMs: silence.silenceQuestionMs,
    });
  } catch (e) {
    if (e && e.status === 409) return fallbackMessage(userId, reason, `${reason} You’re on another call, so I left this message.`);
    return fallbackMessage(userId, reason, `${reason} I couldn’t start the call (${(e && e.message) || 'unavailable'}).`);
  }
  const callId = started.call && started.call.id;
  const rec = await one(`INSERT INTO ai_calls (user_id, conversation_id, call_id, reason, prompt, state, requested, owner_id)
    VALUES ($1,$2,$3,$4,$5,'ringing',$6,$7) RETURNING *`,
    [userId, conversation.id, callId, String(reason || '').slice(0, 500), String(prompt || '').slice(0, 2000), !!requested, ownerId()]);
  return { ok: true, aiCallId: Number(rec.id), ...started };
}

async function onAccepted(user, call) {
  const row = await rowByCall(call.id);
  if (!row) return null;
  if (Number(user.id) !== Number(row.user_id)) return { ai: true };
  await q("UPDATE ai_calls SET state='active', answered_at=NOW(), owner_id=$2 WHERE id=$1", [row.id, ownerId()]);
  const silence = await silenceSettings();
  const reason = row.reason || 'I have an update for you.';
  const greeting = `Hi, this is Notification. I’m calling because ${reason.replace(/^I wanted to call you about:\s*/i, '').replace(/^I’m calling because\s*/i, '')} When you’re ready, tell me what you’d like to do. I’ll wait until you’ve finished speaking.`;
  const audio = await speak(greeting).catch(() => ({ url: null, text: greeting }));
  const transcript = [{ role: 'assistant', text: greeting, at: Date.now() }];
  await q('UPDATE ai_calls SET transcript=$2 WHERE id=$1', [row.id, JSON.stringify(transcript)]);
  return { ai: true, aiCallId: Number(row.id), reason, greeting: audio.text || greeting, audioUrl: audio.url || null, ...silence };
}

async function onEnded(call, reason) {
  const row = await rowByCall(call.id);
  if (!row || row.state === 'ended' || row.state === 'missed' || row.state === 'declined' || row.state === 'failed') {
    if (row && (reason === 'missed' || reason === 'declined') && row.state === 'ringing') {
      await q('UPDATE ai_calls SET state=$2, ended_at=NOW() WHERE id=$1', [row.id, reason === 'declined' ? 'declined' : 'missed']);
      await require('./notify').send(row.user_id, {
        text: reason === 'declined'
          ? `I called about: ${row.reason || 'an update'}. You can reply here whenever you’re free.`
          : `I called about: ${row.reason || 'an update'}, but I missed you. Reply here and I’ll help, or ask me to call again.`,
        style: 'detailed',
      }).catch(() => {});
    }
    return;
  }
  const transcript = parseJson(row.transcript, []);
  const summary = transcript.filter((t) => t && t.text).map((t) => `${t.role === 'user' ? 'You' : 'Notification'}: ${t.text}`).join('\n').slice(0, 1500);
  const text = summary
    ? `Call summary — ${row.reason || 'Notification call'}:\n\n${summary}`
    : `We ended the call about: ${row.reason || 'an update'}. Reply here if you want to continue.`;
  await q("UPDATE ai_calls SET state='ended', ended_at=NOW(), summary=$2 WHERE id=$1", [row.id, summary || null]);
  await require('./notify').send(row.user_id, { text, style: 'detailed' }).catch(() => {});
}

async function speak(text) {
  const clean = String(text || '').replace(/```[\s\S]*?```/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 800);
  if (!clean) return { url: null, text: '' };
  if (config.AI.mock) return { url: null, text: clean };
  const cfg = require('../tts/config').load();
  if (!cfg.token) return { url: null, text: clean };
  const { synthesize } = require('../tts/replicate');
  const storage = require('../../venue/storage');
  const { audio, mime } = await synthesize(cfg, { text: clean, voice: cfg.voice, output_format: cfg.format || 'mp3' });
  const rec = await storage.save(audio, { filename: `ai-call-${Date.now().toString(36)}.${(mime || '').includes('wav') ? 'wav' : 'mp3'}`, mime: mime || 'audio/mpeg', purpose: 'tts' });
  return { url: rec.url || rec.publicUrl || rec, text: clean };
}

async function transcribeTurn(buf, mime) {
  if (!buf || !buf.length) return '';
  if (config.AI.mock) return '';
  const stt = require('../../venue/stt');
  const r = await stt.transcribe(buf, mime || 'audio/webm');
  return stt.clean((r && (r.text || r)) || '');
}

async function turn(user, aiCallId, { audio, mime, text, pendingQuestion } = {}) {
  const row = await (String(aiCallId).includes('-') ? rowByCall(aiCallId) : rowById(Number(aiCallId)));
  if (!row || Number(row.user_id) !== Number(user.id)) throw fail(404, 'Call not found');
  if (row.state !== 'active' && row.state !== 'ringing') throw fail(409, 'This call has ended');
  const started = new Date(row.answered_at || row.started_at).getTime();
  if (Date.now() - started > config.NOTIFY.callsMaxMin * 60000) {
    const calls = require('./calls');
    const call = row.call_id ? await one('SELECT * FROM calls WHERE id=$1', [row.call_id]) : null;
    if (call) await calls.end(call, 'completed');
    throw fail(409, 'This call reached its time limit');
  }
  let said = String(text || '').trim();
  if (!said && audio) {
    const buf = Buffer.isBuffer(audio) ? audio : Buffer.from(String(audio).replace(/^data:[^;]+;base64,/, ''), 'base64');
    said = (await transcribeTurn(buf, mime)).trim();
  }
  if (!said) return { ok: true, heard: '', text: '', wait: true, ...(await silenceSettings()) };
  const transcript = parseJson(row.transcript, []);
  transcript.push({ role: 'user', text: said, at: Date.now() });
  const notify = require('./notify');
  const history = transcript.slice(-12).map((t) => ({ role: t.role === 'assistant' ? 'assistant' : 'user', content: t.text }));
  const system = {
    role: 'system',
    content: `You are Notification on a live phone call. Speak in short, natural sentences. You called because: ${row.reason || 'an update'}. Wait until the user has clearly finished a thought before answering. If you need to accept or decline a speaker invite, RSVP, or change a setting, say what you would do and ask them to confirm with a yes. Put any proposed action in a fenced json block {"action":"accept_invite"|"decline_invite"|"rsvp"|"unrsvp"|"set_pref"|"call_me","eventId":0,"inviteId":0,"comment":"","pref":{}}. Never claim you already did it. Do not invent URLs outside 1venue.`,
  };
  const start = Date.now();
  const model = await callModel(system, history);
  let replyText = model.text || '';
  let action = model.action;
  const yes = /^(yes|yeah|yep|ok|okay|please do|go ahead|confirm|i do|sure)\b/i.test(said);
  const pending = parseJson(row.actions, null);
  if (yes && pending && pending.action) {
    try {
      await notify.runAction(user, pending, { confirmed: true, comment: pending.comment || '' });
      replyText = replyText || 'Done. I’ve taken care of that.';
      await q('UPDATE ai_calls SET actions=NULL WHERE id=$1', [row.id]);
    } catch (e) {
      replyText = `I couldn’t complete that: ${e.message}. You can finish it in the app instead.`;
    }
  } else if (action && action.action) {
    await q('UPDATE ai_calls SET actions=$2 WHERE id=$1', [row.id, JSON.stringify(action)]);
    if (!/yes|confirm|go ahead/i.test(replyText)) replyText = `${replyText || 'I can do that.'} Shall I go ahead?`;
  }
  transcript.push({ role: 'assistant', text: replyText, at: Date.now() });
  await q('UPDATE ai_calls SET transcript=$2, owner_id=$3 WHERE id=$1', [row.id, JSON.stringify(transcript), ownerId()]);
  const audioOut = await speak(replyText).catch(() => ({ url: null, text: replyText }));
  const silence = await silenceSettings();
  const asked = /\?\s*$/.test(replyText) || /shall i go ahead/i.test(replyText);
  return {
    ok: true,
    heard: said,
    text: audioOut.text || replyText,
    audioUrl: audioOut.url || null,
    silenceMs: silence.silenceMs + (asked || pendingQuestion ? silence.silenceQuestionMs : 0),
    silenceQuestionMs: silence.silenceQuestionMs,
    latencyMs: Date.now() - start,
  };
}

async function callModel(system, history) {
  const notify = require('./notify');
  const { runNotifyModel, parseAction } = notify;
  const out = await runNotifyModel([system, ...history]);
  if (out.unavailable) return { text: 'I can’t reach the assistant just now. I’ll leave a message in our chat after we hang up, or you can type there.', action: null };
  return parseAction(out.text);
}

async function publicSettings() {
  const s = await silenceSettings();
  return { ...s, enabled: !!(config.NOTIFY.callsEnabled && isLiveKitConfigured()), maxMinutes: config.NOTIFY.callsMaxMin };
}

let timer = null;
async function sweep() {
  const cap = new Date(Date.now() - config.NOTIFY.callsMaxMin * 60000);
  const rows = await require('../../core/db').many("SELECT * FROM ai_calls WHERE state IN ('ringing','active') AND started_at < $1", [cap]).catch(() => []);
  const calls = require('./calls');
  for (const r of rows) {
    if (r.call_id) {
      const call = await one('SELECT * FROM calls WHERE id=$1', [r.call_id]);
      if (call && call.state !== 'ended') await calls.end(call, 'completed');
      else await q("UPDATE ai_calls SET state='ended', ended_at=NOW(), error='time limit' WHERE id=$1 AND state IN ('ringing','active')", [r.id]);
    }
  }
}
function startWorker() {
  if (timer || process.env.AI_CALLS_SWEEP === 'false') return null;
  timer = setInterval(() => { sweep().catch((e) => console.warn('[ai-calls] sweep', e.message)); }, 30000);
  timer.unref();
  return timer;
}

module.exports = { requestCall, onAccepted, onEnded, turn, silenceSettings, publicSettings, startWorker, rowByCall };
