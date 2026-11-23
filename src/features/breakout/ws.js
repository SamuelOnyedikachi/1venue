/**
 * Phase 2B - breakout rooms (assignment + signaling; media rooms via LiveKit room names)
 */
module.exports = {
  id: 'breakout',
  register(ctx) {
    const { broadcast, sendToParticipant, getParticipantsList } = ctx;

    function emitBreakouts(meeting, meetingCode) {
      broadcast(meetingCode, {
        type: 'breakout-state',
        breakouts: meeting.breakouts || null,
      });
    }

    ctx.onWs('breakout-create', ({ msg, participantId, meeting, meetingCode }) => {
      const actor = meeting.participants.get(participantId);
      if (!actor || actor.role !== 'host') return;
      const count = Math.min(10, Math.max(2, parseInt(msg.count || 2, 10)));
      const active = [...meeting.participants.values()].filter(
        (p) => p.status === 'ACTIVE' && p.role !== 'host'
      );
      const rooms = [];
      for (let i = 0; i < count; i++) {
        rooms.push({
          id: 'bo_' + (i + 1),
          name: 'Room ' + (i + 1),
          participantIds: [],
          livekitRoom: (meeting.mediaRoom || meetingCode) + '-bo-' + (i + 1),
        });
      }
      active.forEach((p, idx) => {
        rooms[idx % count].participantIds.push(p.id);
      });
      meeting.breakouts = {
        open: true,
        rooms,
        createdAt: Date.now(),
        createdBy: participantId,
      };
      emitBreakouts(meeting, meetingCode);
      broadcast(meetingCode, { type: 'toast', message: count + ' breakout rooms opened' });
      // Notify each participant of their room
      rooms.forEach((room) => {
        room.participantIds.forEach((pid) => {
          sendToParticipant(pid, {
            type: 'breakout-assign',
            room,
          });
        });
      });
    });

    ctx.onWs('breakout-close', ({ participantId, meeting, meetingCode }) => {
      const actor = meeting.participants.get(participantId);
      if (!actor || actor.role !== 'host') return;
      meeting.breakouts = { open: false, rooms: [], closedAt: Date.now() };
      emitBreakouts(meeting, meetingCode);
      broadcast(meetingCode, { type: 'toast', message: 'Breakout rooms closed - return to main' });
      broadcast(meetingCode, { type: 'breakout-return' });
    });

    ctx.onWs('breakout-move', ({ msg, participantId, meeting, meetingCode }) => {
      const actor = meeting.participants.get(participantId);
      if (!actor || actor.role !== 'host') return;
      if (!meeting.breakouts?.open) return;
      const { targetId, roomId } = msg;
      meeting.breakouts.rooms.forEach((r) => {
        r.participantIds = r.participantIds.filter((id) => id !== targetId);
      });
      const room = meeting.breakouts.rooms.find((r) => r.id === roomId);
      if (room) {
        room.participantIds.push(targetId);
        sendToParticipant(targetId, { type: 'breakout-assign', room });
      }
      emitBreakouts(meeting, meetingCode);
    });

    function canBackstage(p) {
      if (!p) return false;
      if (p.role === 'host' || p.role === 'cohost') return true;
      return !!(p.ticket && p.ticket.perks && p.ticket.perks.backstage);
    }

    ctx.onWs('breakout-open-backstage', ({ participantId, meeting, meetingCode }) => {
      const actor = meeting.participants.get(participantId);
      if (!actor || actor.role !== 'host') return;
      const rooms = (meeting.breakouts && meeting.breakouts.open && meeting.breakouts.rooms) ? meeting.breakouts.rooms.slice() : [];
      if (!rooms.some((r) => r.backstage)) {
        rooms.push({
          id: 'bo_backstage',
          name: 'Backstage',
          backstage: true,
          participantIds: [],
          livekitRoom: (meeting.mediaRoom || meetingCode) + '-bo-backstage',
        });
      }
      meeting.breakouts = { open: true, rooms, createdAt: (meeting.breakouts && meeting.breakouts.createdAt) || Date.now(), createdBy: participantId };
      emitBreakouts(meeting, meetingCode);
      broadcast(meetingCode, { type: 'toast', message: 'Backstage is open for ticket holders with access' });
    });

    ctx.onWs('breakout-join', ({ msg, participantId, meeting, meetingCode }) => {
      const actor = meeting.participants.get(participantId);
      if (!actor || actor.status !== 'ACTIVE') return;
      if (!meeting.breakouts?.open) return;
      const room = meeting.breakouts.rooms.find((r) => r.id === msg.roomId);
      if (!room) return;
      if (room.backstage && !canBackstage(actor)) {
        sendToParticipant(participantId, { type: 'toast', message: 'Backstage is for ticket types with that perk' });
        return;
      }
      meeting.breakouts.rooms.forEach((r) => { r.participantIds = r.participantIds.filter((id) => id !== participantId); });
      room.participantIds.push(participantId);
      sendToParticipant(participantId, { type: 'breakout-assign', room });
      emitBreakouts(meeting, meetingCode);
    });
  },
};
