const data = require('./data');
const gateway = require('./paystack');
const rules = require('./rules');
const { quote } = rules;
module.exports = function routes(route, { requireUser, httpError, rateLimit }) {
  route('GET', '/api/wallet', async (ctx) => {
    const u = await requireUser(ctx.req, ctx.res);
    const spend = require('./spend');
    let usage = null;
    try { usage = spend.usageView(await spend.syncPlan(u.id)); } catch (_) {}
    const cur = await require('./billing-data').current(u.id);
    return { userId:u.id, ...cur, usage, meetingEarnings: await require('./paid-entry').earnings(u.id), pricePerCreditKobo: rules.PRICE_PER_CREDIT_KOBO, currency: 'NGN', feePercent: require('../../lib/money').feePercent(), bundles: rules.BUNDLES, purchasesEnabled: gateway.enabled(), expires: false };
  });
  route('POST', '/api/wallet/meeting-earnings/transfer', async (ctx) => {
    const u = await requireUser(ctx.req, ctx.res);
    const body = await ctx.body();
    return require('./paid-entry').transfer(u.id, body.credits);
  });
  route('POST', '/api/wallet/welcome-notice', async (ctx) => {
    const u = await requireUser(ctx.req, ctx.res);
    return data.claimWelcomeNotice(u.id);
  });
  route('POST', '/api/wallet/quote', async (ctx) => {
    await requireUser(ctx.req, ctx.res);
    return { ...quote((await ctx.body()).credits), feeNotice: 'The processing fee is shown above and included in the total. Fees do not buy additional credits.' };
  });
  route('POST', '/api/wallet/checkout', async (ctx) => {
    const u = await requireUser(ctx.req, ctx.res);
    if (!rateLimit('wallet-checkout:' + u.id, 10)) throw httpError(429, 'Please wait before starting another purchase');
    return { $status: 201, $body: await gateway.initialize(u, (await ctx.body()).credits) };
  });
  route('GET', '/api/wallet/payments', async (ctx) => {
    const u = await requireUser(ctx.req, ctx.res);
    return data.payments(u.id, ctx.url.searchParams.get('before'));
  });
  route('POST', '/api/wallet/payments/([A-Za-z0-9-]{1,80})/verify', async (ctx, [reference]) => {
    const u = await requireUser(ctx.req, ctx.res);
    const payment = await data.getPayment(reference);
    if (!payment || Number(payment.user_id) !== Number(u.id)) throw httpError(404, 'Payment not found');
    if (!rateLimit('wallet-verify:' + u.id, 40)) throw httpError(429, 'Please wait before checking again');
    return gateway.confirm(payment);
  });
  // Auto top-up (accounts without a paid plan). The card is added through hosted checkout; only a gateway token is kept.
  const auto = () => require('./autotopup');
  route('GET', '/api/wallet/auto-topup', async (ctx) => auto().get((await requireUser(ctx.req, ctx.res)).id));
  route('PUT', '/api/wallet/auto-topup', async (ctx) => auto().save((await requireUser(ctx.req, ctx.res)).id, await ctx.body()));
  route('POST', '/api/wallet/auto-topup/card', async (ctx) => {
    const u = await requireUser(ctx.req, ctx.res);
    if (!rateLimit('wallet-checkout:' + u.id, 10)) throw httpError(429, 'Please wait before starting another purchase');
    return { $status: 201, $body: await auto().startCardSetup(u) };
  });
  route('DELETE', '/api/wallet/auto-topup/card', async (ctx) => auto().removeCard((await requireUser(ctx.req, ctx.res)).id));
  route('GET', '/api/wallet/transactions', async (ctx) => {
    const u = await requireUser(ctx.req, ctx.res);
    return data.history(u.id, ctx.url.searchParams.get('before'));
  });
};
