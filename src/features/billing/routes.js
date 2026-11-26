/**
 * Plans and billing.
 *   GET  /api/plans                                   public plan table (limits + NGN prices)
 *   GET  /api/billing                                 my plan, limits, usage, subscription, payments
 *   POST /api/billing/checkout        { plan, interval }   start Paystack checkout (new plan / upgrade)
 *   POST /api/billing/slug-addon      { venueSlug, tier }  one-off short-link add-on for a venue
 *   POST /api/billing/cancel | /resume                     stop / restart renewal at period end
 *   POST /api/billing/change          { plan, interval }   schedule a downgrade / interval switch at period end
 *   POST /api/billing/payments/:ref/verify                 check a payment again
 *   GET  /api/billing/history                              every payment I made (plan, short links, credits, promotions, tickets, gifts)
 *   GET  /api/billing/receipts/:ref                        printable HTML receipt for a paid one (Print → Save as PDF)
 *   DELETE /api/billing/card                               forget the saved renewal card
 * Admin (/admin):
 *   GET/PUT/DELETE /api/admin/billing/settings             limits, prices, AI weights, grace (DELETE = reset to env defaults)
 *   GET  /api/admin/billing/users?q=                       search users
 *   GET  /api/admin/billing/users/:id                      plan, subscription, overrides, payments, audit, venues
 *   POST /api/admin/billing/users/:id  { plan?, periodEnd?, overrides?, reason }
 *   POST /api/admin/billing/venues/:id { slugTier, reason }
 */
const billing = require('./service');
const plans = require('../../lib/plans');

module.exports = function routes(route, { requireUser, httpError, rateLimit, int }) {
  const admin = async (ctx) => {
    const u = await requireUser(ctx.req, ctx.res);
    if (!u.isAdmin) throw httpError(403, 'Admins only. Add your email to ADMIN_EMAILS and confirm it.');
    return u;
  };
  route('GET', '/api/plans', async () => ({ ...(await billing.publicPlans()), shortLinkReleaseDays: require('./shortlinks').releaseDays() }));
  route('GET', '/api/billing', async (ctx) => billing.summary((await requireUser(ctx.req, ctx.res)).id));
  route('POST', '/api/billing/checkout', async (ctx) => {
    const u = await requireUser(ctx.req, ctx.res);
    if (!rateLimit('billing-checkout:' + u.id, 10)) throw httpError(429, 'Please wait before starting another payment');
    const b = await ctx.body();
    return { $status: 201, $body: await billing.startCheckout(u, { plan: b.plan, interval: b.interval }) };
  });
  route('POST', '/api/billing/slug-addon', async (ctx) => {
    const u = await requireUser(ctx.req, ctx.res);
    if (!rateLimit('billing-checkout:' + u.id, 10)) throw httpError(429, 'Please wait before starting another payment');
    const b = await ctx.body();
    return { $status: 201, $body: await billing.startSlugAddon(u, { venueSlug: b.venueSlug, tier: b.tier }) };
  });
  route('POST', '/api/billing/cancel', async (ctx) => billing.cancel((await requireUser(ctx.req, ctx.res)).id, true));
  route('POST', '/api/billing/resume', async (ctx) => billing.cancel((await requireUser(ctx.req, ctx.res)).id, false));
  route('POST', '/api/billing/change', async (ctx) => {
    const u = await requireUser(ctx.req, ctx.res);
    const b = await ctx.body();
    return billing.scheduleChange(u.id, { plan: b.plan, interval: b.interval });
  });
  route('POST', '/api/billing/payments/([A-Za-z0-9-]{1,80})/verify', async (ctx, [reference]) => {
    const u = await requireUser(ctx.req, ctx.res);
    const p = await billing.getPayment(reference);
    if (!p || Number(p.user_id) !== Number(u.id)) throw httpError(404, 'Payment not found');
    if (!rateLimit('billing-verify:' + u.id, 40)) throw httpError(429, 'Please wait before checking again');
    return billing.confirm(p);
  });

  const hist = () => require('./history');
  route('GET', '/api/billing/history', async (ctx) => hist().history((await requireUser(ctx.req, ctx.res)).id));
  route('GET', '/api/billing/receipts/([A-Za-z0-9-]{1,80})', async (ctx, [ref]) => hist().receipt((await requireUser(ctx.req, ctx.res)).id, ref));
  route('DELETE', '/api/billing/card', async (ctx) => hist().removeCard((await requireUser(ctx.req, ctx.res)).id));

  route('GET', '/api/admin/billing/settings', async (ctx) => { await admin(ctx); return { settings: await plans.getSettings({ fresh: true }), defaults: plans.envDefaults() }; });
  route('PUT', '/api/admin/billing/settings', async (ctx) => {
    const u = await admin(ctx);
    const next = await plans.saveSettings(await ctx.body(16 * 1024), u.id);
    console.log(`[billing] settings changed by user ${u.id}`);
    return { settings: next, defaults: plans.envDefaults() };
  });
  route('DELETE', '/api/admin/billing/settings', async (ctx) => { const u = await admin(ctx); return { settings: await plans.resetSettings(u.id), defaults: plans.envDefaults() }; });
  route('GET', '/api/admin/billing/users', async (ctx) => { await admin(ctx); return { users: await billing.adminSearch(ctx.url.searchParams.get('q')) }; });
  route('GET', '/api/admin/billing/users/(\\d+)', async (ctx, [id]) => { await admin(ctx); return billing.adminUser(int(id)); });
  route('POST', '/api/admin/billing/users/(\\d+)', async (ctx, [id]) => {
    const u = await admin(ctx);
    const b = await ctx.body();
    if (!String(b.reason || '').trim()) throw httpError(400, 'Add a short reason for the audit log');
    return billing.adminSetPlan(u.id, int(id), { plan: b.plan, periodEnd: b.periodEnd || null, overrides: b.overrides, reason: String(b.reason).slice(0, 300) });
  });

  const leads = () => require('./leads');
  route('POST', '/api/sales/enquiry', async (ctx) => {
    const ip = (ctx.req.headers['x-forwarded-for'] || ctx.req.socket?.remoteAddress || 'x').split(',')[0].trim();
    if (!rateLimit('sales-enquiry:' + ip, 5)) throw httpError(429, 'Please wait before sending another enquiry');
    const user = await require('../../lib/auth').getAuthUser(ctx.req, ctx.res);
    return { $status: 201, $body: await leads().create(await ctx.body(), user) };
  });
  route('GET', '/api/admin/sales/leads', async (ctx) => { await admin(ctx); return { leads: await leads().list() }; });
  route('POST', '/api/admin/sales/leads/(\\d+)', async (ctx, [id]) => {
    await admin(ctx);
    const b = await ctx.body();
    return leads().setStatus(int(id), b.status);
  });
  route('POST', '/api/admin/billing/venues/(\\d+)', async (ctx, [id]) => {
    const u = await admin(ctx);
    const b = await ctx.body();
    if (!String(b.reason || '').trim()) throw httpError(400, 'Add a short reason for the audit log');
    return billing.adminSetVenueTier(u.id, int(id), b.slugTier, String(b.reason).slice(0, 300));
  });
};
