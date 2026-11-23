/** In-call material offers: host pushes a buy card to chat or a corner overlay. */
module.exports = {
  id: 'materials',
  register(ctx) {
    const { broadcast } = ctx;

    async function offerPayload(meeting, materialId) {
      const { one } = require('../../core/db');
      const data = require('./data');
      const row = await one('SELECT * FROM materials WHERE id=$1', [Number(materialId)]);
      if (!row) return null;
      const m = await data.withAccess(data.materialOut(row), null, { eventId: meeting.eventId, live: true });
      return {
        id: m.id,
        title: m.title,
        kind: m.kind,
        forSale: m.forSale,
        priceKobo: m.priceKobo,
        promoPriceKobo: m.promoPriceKobo || null,
        callDiscountPct: m.callDiscountLive ? m.callDiscountPct : 0,
        eventId: meeting.eventId || null,
        code: meeting.code,
      };
    }

    ctx.onWs('material-offer', async ({ msg, participantId, meeting, meetingCode }) => {
      const actor = meeting.participants.get(participantId);
      if (!actor || (actor.role !== 'host' && actor.role !== 'cohost')) return;
      const material = await offerPayload(meeting, msg.materialId || msg.id).catch(() => null);
      if (!material || !material.forSale) return;
      broadcast(meetingCode, {
        type: 'material-offer',
        material,
        from: { id: actor.id, name: actor.name },
        at: Date.now(),
      });
    });

    ctx.onWs('material-overlay', async ({ msg, participantId, meeting, meetingCode }) => {
      const actor = meeting.participants.get(participantId);
      if (!actor || (actor.role !== 'host' && actor.role !== 'cohost')) return;
      const material = await offerPayload(meeting, msg.materialId || msg.id).catch(() => null);
      if (!material || !material.forSale) return;
      broadcast(meetingCode, { type: 'material-overlay', material, at: Date.now() });
    });

    ctx.onWs('material-overlay-dismiss', ({ meeting, meetingCode }) => {
      broadcast(meetingCode, { type: 'material-overlay', material: null });
    });
  },
};
