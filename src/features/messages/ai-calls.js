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
const crypto = require('crypto');
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

/** lead_min codes reserved for once-per-invite call nudges (channel stays inapp; no migration). */
const NUDGE_LEAD = { call: 9100, busy: 9101, recent: 9102, optin: 9103, quiet: 9104, disabled: 9105, failed: 9106, optout: 9107 };

async function claimNudge(dedupe, kind) {
  if (!dedupe || !dedupe.id) return true;
  const lead = NUDGE_LEAD[kind];
  if (lead == null) return true;
  const { claim } = require('../recurring/reminders');
  return claim({ type: dedupe.type || 'speaker_invite', id: Number(dedupe.id), lead, channel: 'inapp', recipient: dedupe.recipient || `user:${dedupe.userId}`, userId: dedupe.userId || null });
}

function reasonLine(reason) {
  return String(reason || 'an update').trim().replace(/\.+$/, '');
}

function callGreeting(reason, { inbound = false } = {}) {
  if (inbound) return 'Hi, this is Notification. How can I help?';
  const r = reasonLine(reason);
  if (!r || /^you called notification/i.test(r) || /^you asked notification to call you/i.test(r)) {
    return 'Hi, this is Notification. How can I help?';
  }
  return `Hi, this is Notification. ${r}.`;
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
  const about = reasonLine(reason);
  const text = detail || (about ? `${about}. I left this message instead — reply here and I’ll help.` : 'I left this message instead — reply here and I’ll help.');
  await notify.send(userId, { style: 'detailed', text });
  return { ok: false, fallback: 'message' };
}

async function onceFallback(userId, reason, detail, dedupe, kind) {
  if (!(await claimNudge(dedupe, kind))) return { ok: false, fallback: kind, skipped: true };
  const r = await fallbackMessage(userId, reason, detail);
  return { ...r, fallback: kind };
}

function settingsLink() {
  try { return require('../../config').siteUrl('/settings#notifications') || '/settings#notifications'; }
  catch (_) { return '/settings#notifications'; }
}

async function requestCall(userId, { reason = 'Notification has an update for you.', requested = false, prompt = '', dedupe = null } = {}) {
  const notify = require('./notify');
  const about = reasonLine(reason);
  const bot = await notify.systemUser();
  if (!bot) return onceFallback(userId, reason, 'I couldn’t place a call just then. Reply here instead.', dedupe, 'failed');
  if (!config.NOTIFY.callsEnabled || !isLiveKitConfigured()) {
    return onceFallback(userId, reason, `${about}. Voice calls from Notification aren’t on right now, so I’m writing instead. Reply here, or turn calls on in ${settingsLink()} once they’re enabled.`, dedupe, 'disabled');
  }
  const prefs = notify.callPrefs(await notify.extraOf(userId));
  if (prefs.optOut) return onceFallback(userId, reason, `${about}. You’ve turned Notification calls off, so here is the message instead.`, dedupe, 'optout');
  if (!requested && !prefs.enabled) return onceFallback(userId, reason, `${about}. Turn on Notification calls in ${settingsLink()} if you’d like me to ring you for urgent invites and reminders.`, dedupe, 'optin');
  if (!requested && notify.inQuietHours(prefs)) {
    return onceFallback(userId, reason, `${about}. It’s quiet hours, so I left this instead. Ask me to call you later if you’d like.`, dedupe, 'quiet');
  }
  if (!requested) {
    if (await recentCount(userId, 3600000, { requested: false }) >= config.NOTIFY.callsPerHour) {
      return onceFallback(userId, reason, `${about}. I already called recently, so I’m writing this time.`, dedupe, 'recent');
    }
    if (await recentCount(userId, 86400000, { requested: false }) >= config.NOTIFY.callsPerDay) {
      return onceFallback(userId, reason, `${about}. That’s all the Notification calls for today — I’ll keep helping here.`, dedupe, 'recent');
    }
  }
  const { conversation } = await notify.ensureThread(userId);
  const calls = require('./calls');
  let started;
  try {
    const silence = await silenceSettings();
    started = await calls.start(bot, conversation.id, 'audio', {
      ai: true, reason: about, silenceMs: silence.silenceMs, silenceQuestionMs: silence.silenceQuestionMs,
    });
  } catch (e) {
    if (e && e.status === 409) return onceFallback(userId, reason, `${about}. You’re on another call, so I left this message.`, dedupe, 'busy');
    return onceFallback(userId, reason, `${about}. I couldn’t start the call (${(e && e.message) || 'unavailable'}).`, dedupe, 'failed');
  }
  if (!requested) await claimNudge(dedupe, 'call');
  const callId = started.call && started.call.id;
  const rec = await one(`INSERT INTO ai_calls (user_id, conversation_id, call_id, reason, prompt, state, requested, owner_id)
    VALUES ($1,$2,$3,$4,$5,'ringing',$6,$7) RETURNING *`,
    [userId, conversation.id, callId, about.slice(0, 500), String(prompt || '').slice(0, 2000), !!requested, ownerId()]);
  return { ok: true, aiCallId: Number(rec.id), ...started };
}

async function onAccepted(user, call) {
  const row = await rowByCall(call.id);
  if (!row) return null;
  if (Number(user.id) !== Number(row.user_id)) return { ai: true };
  await q("UPDATE ai_calls SET state='active', answered_at=NOW(), owner_id=$2 WHERE id=$1", [row.id, ownerId()]);
  const silence = await silenceSettings();
  const reason = row.reason || '';
  const greeting = callGreeting(reason, { inbound: !!row.requested });
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
          ? `${reasonLine(row.reason) || 'I called'}. You can reply here whenever you’re free.`
          : `${reasonLine(row.reason) || 'I called'}, but I missed you. Reply here and I’ll help, or ask me to call again.`,
        style: 'detailed',
      }).catch(() => {});
    }
    return;
  }
  const transcript = parseJson(row.transcript, []);
  const stripWait = (s) => String(s || '').replace(/\s*When you['’]re ready, tell me what you['’]d like to do\. I['’]ll wait until you['’]ve finished speaking\.?/gi, '').trim();
  const summary = transcript.filter((t) => t && t.text).map((t) => `${t.role === 'user' ? 'You' : 'Notification'}: ${stripWait(t.text)}`).filter((l) => l.replace(/^(You|Notification):\s*/, '')).join('\n').slice(0, 1500);
  const inbound = !!row.requested;
  const heading = inbound ? 'Notification call' : (reasonLine(row.reason) || 'Notification call');
  const text = summary
    ? `Call summary — ${heading}:\n\n${summary}`
    : (inbound ? 'We ended the call. Reply here if you want to continue.' : `We ended the call about: ${reasonLine(row.reason) || 'an update'}. Reply here if you want to continue.`);

  await q("UPDATE ai_calls SET state='ended', ended_at=NOW(), summary=$2 WHERE id=$1", [row.id, summary || null]);
  await require('./notify').send(row.user_id, { text, style: 'detailed' }).catch(() => {});
}


const TURN_BUDGET_MS = 25_000;
const MAX_TURN_AUDIO = 4 * 1048576;
const turnCache = new Map(); // `${aiCallId}:${hash}` -> { said, replyText, audioOut, at }

function sweepTurnCache() {
  const now = Date.now();
  for (const [k, v] of turnCache) if (now - v.at > 30 * 60_000) turnCache.delete(k);
  while (turnCache.size > 200) turnCache.delete(turnCache.keys().next().value);
}

function decodeTurnAudio(audio, mime) {
  if (audio == null || audio === '') return null;
  let buf;
  let kind = mime || 'audio/webm';
  if (Buffer.isBuffer(audio)) buf = audio;
  else {
    const raw = String(audio);
    if (!raw.trim()) return null;
    if (raw.startsWith('data:')) {
      const m = raw.match(/^data:([^;]+);base64,([\s\S]*)$/);
      if (!m) { const e = fail(400, 'The audio clip was not readable'); throw e; }
      kind = mime || m[1] || kind;
      buf = Buffer.from(m[2], 'base64');
    } else {
      buf = Buffer.from(raw, 'base64');
    }
  }
  if (!buf.length) { const e = fail(400, 'The audio clip was empty'); throw e; }
  if (buf.length > MAX_TURN_AUDIO) { const e = fail(413, 'The audio clip is too large'); throw e; }
  return { buf, mime: kind };
}

function cacheGet(key) {
  const row = turnCache.get(key);
  return row || { said: '', replyText: '', audioOut: null, at: Date.now() };
}
function cacheSet(key, patch) {
  const row = { ...cacheGet(key), ...patch, at: Date.now() };
  turnCache.set(key, row);
  sweepTurnCache();
  return row;
}

async function speak(text) {
  const clean = require('./notify').sanitizeAssistantText(text).slice(0, 800);
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

async function transcribeTurn(buf, mime, timeoutMs) {
  if (!buf || !buf.length) return '';
  if (config.AI.mock) return '';
  const stt = require('../../venue/stt');
  const r = await stt.transcribe(buf, mime || 'audio/webm', null, { timeoutMs: timeoutMs || 15_000 });
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
  const start = Date.now();
  const clip = decodeTurnAudio(audio, mime);
  let said = String(text || '').trim();
  const hash = said ? 't:' + crypto.createHash('sha256').update(said).digest('hex').slice(0, 24)
    : (clip ? 'a:' + crypto.createHash('sha256').update(clip.buf).digest('hex').slice(0, 24) : '');
  const key = `${row.id}:${hash || 'empty'}`;
  const cached = cacheGet(key);
  if (!said) said = cached.said || '';
  if (!said && clip) {
    const left = Math.max(4_000, TURN_BUDGET_MS - (Date.now() - start));
    said = (await transcribeTurn(clip.buf, clip.mime, Math.min(15_000, left))).trim();
    if (said) cacheSet(key, { said });
  }
  if (!said) return { ok: true, heard: '', text: '', wait: true, ...(await silenceSettings()) };
  const transcript = parseJson(row.transcript, []);
  if (!cached.replyText) transcript.push({ role: 'user', text: said, at: Date.now() });
  const notify = require('./notify');
  let replyText = cached.replyText || '';
  let skipTts = !!(cached.audioOut && cached.audioOut.skipTts);
  if (!replyText) {
    try {
      const early = await notify.fulfillInviteIntent(user, said, null);
      if (early && early.handled) {
        replyText = notify.sanitizeAssistantText(early.text || (early.needComment ? 'Please add a short comment so I can decline this invite.' : 'Okay.'));
      } else {
        const history = transcript.slice(-12).map((t) => ({ role: t.role === 'assistant' ? 'assistant' : 'user', content: t.text }));
        const inbound = !!row.requested;
        const system = {
          role: 'system',
          content: `You are Notification on a live phone call. Speak in short, natural sentences. ${inbound ? 'The user called you. Ask how you can help.' : `You called about: ${reasonLine(row.reason) || 'an update'}.`} If the user clearly accepts or declines a speaker invite, the server will carry that out — just confirm briefly in plain language. Never output JSON, code fences, or raw actions. Do not invent URLs outside 1venue.`,
        };
        const model = await callModel(system, history);
        if (model.noTts) skipTts = true;
        replyText = notify.sanitizeAssistantText(model.text || '');
        const acted = await notify.fulfillInviteIntent(user, said, model.action);
        if (acted && acted.handled) replyText = notify.sanitizeAssistantText(acted.text || replyText);
        else if (model.action && model.action.action && model.action.action !== 'accept_invite' && model.action.action !== 'decline_invite') {
          await q('UPDATE ai_calls SET actions=$2 WHERE id=$1', [row.id, JSON.stringify(model.action)]);
          if (!/yes|confirm|go ahead/i.test(replyText)) replyText = `${replyText || 'I can do that.'} Shall I go ahead?`;
        } else {
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
          }
        }
      }
      if (replyText) cacheSet(key, { said, replyText });
    } catch (e) {
      console.error('[ai-calls] llm failed', e.status || '', e.detail || e.message, 'prediction', e.predictionId || '');
      // Keep the call alive. Do not generate TTS for this error (avoids a billed error clip).
      const silence = await silenceSettings();
      return {
        ok: true,
        heard: said,
        text: 'Sorry, I had trouble answering just then. Please say that again.',
        audioUrl: null,
        silenceMs: silence.silenceMs,
        silenceQuestionMs: silence.silenceQuestionMs,
        latencyMs: Date.now() - start,
        error: e.status || 502,
      };
    }
  }
  if (!cached.replyText) {
    transcript.push({ role: 'assistant', text: replyText, at: Date.now() });
    await q('UPDATE ai_calls SET transcript=$2, owner_id=$3 WHERE id=$1', [row.id, JSON.stringify(transcript), ownerId()]);
  }
  let audioOut = cached.audioOut;
  if (!audioOut) {
    if (skipTts || !replyText) audioOut = { url: null, text: replyText, skipTts: true };
    else audioOut = await speak(replyText).catch(() => ({ url: null, text: replyText }));
    cacheSet(key, { said, replyText, audioOut });
  }
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
  if (out.unavailable) return { text: 'I can’t reach the assistant just now. I’ll leave a message in our chat after we hang up, or you can type there.', action: null, noTts: true };
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

module.exports = { requestCall, onAccepted, onEnded, turn, silenceSettings, publicSettings, startWorker, rowByCall, callGreeting, reasonLine, NUDGE_LEAD, claimNudge, decodeTurnAudio };
