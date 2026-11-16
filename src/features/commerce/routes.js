/**
 * Commerce routes.
 * Hosts:
 *   GET  /api/promote/quote?days=7          price for a self-serve promotion
 *   POST /api/promote   { eventId, days, placements }   Paystack checkout
 *   GET  /api/promote/mine                  my promotions with views, clicks, CTR
 *   GET/PUT /api/events/:id/tickets/tiers   manage ticket tiers (Organisation plan by default)
 *   GET  /api/earnings                      balance, ledger, payouts      POST /api/earnings/payouts { amountKobo, bankDetails, note }
 * Buyers:
 *   GET  /api/events/:id/tickets            tiers, my tickets, donations on/off
 *   POST /api/events/:id/tickets { tierId, quantity }   free tier = instant; paid = Paystack checkout
 *   POST /api/events/:id/donate  { amountKobo }
 *   GET  /api/commerce/payments             my purchases      POST /api/commerce/payments/:ref/verify
 * Admin:
 *   GET /api/admin/commerce/payments?status&kind   POST /api/admin/commerce/payments/:ref/refund { note }
 *   GET /api/admin/payouts?status                  POST /api/admin/payouts/:id { action: paid|rejected, reference, note }
 *   POST /api/admin/promotions/:id/review { decision: approve|reject }
 */
const svc = require('./service');

module.exports = function routes(route, { requireUser, getAuthUser, httpError, rateLimit, int }) {
  const admin = async (ctx) => { const u = await requireUser(ctx.req, ctx.res); if (!u.isAdmin) throw httpError(403, 'Admins only'); return u; };
  const limited = (u) => { if (!rateLimit('commerce:' + u.id, 15)) throw httpError(429, 'Please wait before starting another payment'); };

  route('GET', '/api/promote/quote', async (ctx) => svc.quotePromotion(ctx.url.searchParams.get('days') || 7));
  route('POST', '/api/promote', async (ctx) => { const u = await requireUser(ctx.req, ctx.res); limited(u); return { $status: 201, $body: await svc.startPromotion(u, await ctx.body()) }; });
  route('GET', '/api/promote/mine', async (ctx) => ({ promotions: await svc.myPromotions((await requireUser(ctx.req, ctx.res)).id) }));

  route('GET', '/api/events/(\\d+)/tickets/tiers', async (ctx, [id]) => {
    const u = await requireUser(ctx.req, ctx.res);
    const ev = await require('../../core/db').one('SELECT host_user_id FROM events WHERE id=$1', [int(id)]);
    if (!ev || ev.host_user_id !== u.id) throw httpError(404, 'Event not found or not yours');
    return { tiers: await svc.tiers(int(id), { all: true }) };
  });
  route('PUT', '/api/events/(\\d+)/tickets/tiers', async (ctx, [id]) => { const u = await requireUser(ctx.req, ctx.res); return { tiers: await svc.saveTiers(u, int(id), (await ctx.body(32 * 1024)).tiers) }; });
  route('GET', '/api/events/(\\d+)/tickets', async (ctx, [id]) => { const u = await getAuthUser(ctx.req, ctx.res); return svc.publicTickets(int(id), u && u.id); });
  route('POST', '/api/events/(\\d+)/tickets', async (ctx, [id]) => {
    const u = await requireUser(ctx.req, ctx.res); limited(u);
    const b = await ctx.body();
    return { $status: 201, $body: await svc.getTicket(u, int(id), { tierId: int(b.tierId), quantity: b.quantity }) };
  });
  route('POST', '/api/events/(\\d+)/donate', async (ctx, [id]) => { const u = await requireUser(ctx.req, ctx.res); limited(u); return { $status: 201, $body: await svc.donate(u, int(id), (await ctx.body()).amountKobo) }; });
  route('GET', '/api/commerce/payments', async (ctx) => ({ payments: await svc.myPayments((await requireUser(ctx.req, ctx.res)).id) }));
  route('POST', '/api/commerce/payments/([A-Za-z0-9-]{1,80})/verify', async (ctx, [ref]) => {
    const u = await requireUser(ctx.req, ctx.res);
    const p = await svc.getPayment(ref);
    if (!p || Number(p.user_id) !== Number(u.id)) throw httpError(404, 'Payment not found');
    if (!rateLimit('commerce-verify:' + u.id, 40)) throw httpError(429, 'Please wait before checking again');
    return svc.confirm(p);
  });
  route('GET', '/api/earnings', async (ctx) => svc.earnings((await requireUser(ctx.req, ctx.res)).id));
  route('POST', '/api/earnings/payouts', async (ctx) => { const u = await requireUser(ctx.req, ctx.res); return { $status: 201, $body: await svc.requestPayout(u.id, await ctx.body()) }; });

  route('GET', '/api/admin/commerce/payments', async (ctx) => { await admin(ctx); const s = ctx.url.searchParams; return { payments: await svc.adminPayments({ status: s.get('status') || null, kind: s.get('kind') || null }) }; });
  route('POST', '/api/admin/commerce/payments/([A-Za-z0-9-]{1,80})/refund', async (ctx, [ref]) => { const u = await admin(ctx); return svc.markRefunded(u.id, ref, (await ctx.body()).note); });
  route('GET', '/api/admin/payouts', async (ctx) => { await admin(ctx); return { payouts: await svc.listPayouts(ctx.url.searchParams.get('status') || null) }; });
  route('POST', '/api/admin/payouts/(\\d+)', async (ctx, [id]) => { const u = await admin(ctx); return svc.decidePayout(u.id, int(id), await ctx.body()); });
  route('POST', '/api/admin/promotions/(\\d+)/review', async (ctx, [id]) => { const u = await admin(ctx); return svc.reviewPromotion(u.id, int(id), (await ctx.body()).decision); });
};
