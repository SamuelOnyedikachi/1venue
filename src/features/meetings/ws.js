const endControl = require('../../rooms/end-control');

module.exports = {
  id: 'meetings',
  register(ctx) {
    ctx.onWs('keep-alive', ({ meeting, meetingCode, participantId }) => {
      const participant = meeting && meeting.participants.get(participantId);
      return endControl.keepAlive(meetingCode, { meeting, participant });
    });
    ctx.onRegister((ws, meeting) => {
      const w = endControl.warningFor(meeting);
      if (!w || w.status !== 'pending') return;
      try {
        ws.send(JSON.stringify({ type: 'end-warning', deadlineMs: w.deadlineMs, remainingMs: w.remainingMs }));
      } catch (_) {}
    });
  },
};
