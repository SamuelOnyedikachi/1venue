/** Room plugin: captions. Turn off with FEATURE_CAPTIONS=false. */
const data = require('../../venue/data');
const { mod, active, voterKey } = require('../../core/room-helpers');

// ------------------------------------------------------------------ captions
// Clients send recognised text (from server STT via /api/stt, or Web Speech).
// The server stamps the speaker name, stores the segment, and relays captions.
const captionsPlugin = {
  id: 'captions',
  register(ctx) {
    const { broadcast } = ctx;
    ctx.onWs('caption', async ({ msg, participantId: pid, meeting, meetingCode }) => {
      const p = active(meeting, pid);
      if (!p) return;
      const text = String(msg.text || '').replace(/\s+/g, ' ').trim().slice(0, 600);
      if (!text) return;
      const final = msg.final !== false;
      broadcast(meetingCode, { type: 'caption', participantId: pid, name: p.name, text, final, lang: msg.lang || null, at: Date.now() }, final ? undefined : pid);
      if (final && meeting.transcribe !== false) {
        await data.addTranscriptSegment({ historyId: meeting.historyId, code: meetingCode, speakerKey: voterKey(p), speakerName: p.name, text, lang: msg.lang, source: msg.source === 'stt' ? 'stt' : 'webspeech' }).catch(() => {});
      }
    });
    ctx.onWs('transcript-toggle', ({ msg, participantId: pid, meeting, meetingCode }) => {
      if (!mod(meeting, pid)) return;
      meeting.transcribe = !!msg.on;
      broadcast(meetingCode, { type: 'transcript-state', on: meeting.transcribe, historyId: meeting.historyId });
    });
    ctx.onWs('local-recording', ({ msg, participantId: pid, meeting, meetingCode }) => {
      const p = active(meeting, pid);
      if (!p || (p.role !== 'host' && p.role !== 'cohost')) return;
      meeting.localRecorders = meeting.localRecorders || new Set();
      if (msg.on) meeting.localRecorders.add(pid);
      else meeting.localRecorders.delete(pid);
      broadcast(meetingCode, { type: 'local-recording', on: meeting.localRecorders.size > 0, count: meeting.localRecorders.size, participantId: pid });
    });
    ctx.onRegister((ws, meeting) => {
      try { ws.send(JSON.stringify({ type: 'transcript-state', on: meeting.transcribe !== false, historyId: meeting.historyId })); } catch (_) {}
      const n = meeting.localRecorders ? meeting.localRecorders.size : 0;
      if (n) { try { ws.send(JSON.stringify({ type: 'local-recording', on: true, count: n })); } catch (_) {} }
    });
  },
};

module.exports = captionsPlugin;
