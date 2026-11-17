/**
 * Money settings.
 *   GET  /api/money                     currencies, FX rates, my preferred currency, processing fee %  (public)
 *   GET  /api/me/billing-profile        my billing address + preferred currency
 *   PUT  /api/me/billing-profile        { country, line1, line2, city, state, postalCode, currency }
 *   GET  /api/admin/fx | PUT { rates }  admin FX rates (units per 1 base unit); DELETE resets to env/placeholders
 */
const money = require('../../lib/money');
const fx = async () => ({ ...(await money.rates({ fresh: true })), feePercent: money.feePercent() });

const clip = (v, n) => (v == null ? null : String(v).replace(/[\u0000-\u001f\u007f<>]/g, ' ').trim().slice(0, n) || null);
function profileOut(r) {
  return { country: r?.country || null, line1: r?.line1 || null, line2: r?.line2 || null, city: r?.city || null, state: r?.state || null, postalCode: r?.postal_code || null, currency: r && money.isCurrency(r.currency) ? r.currency : money.base() };
}
module.exports = function routes(route, { requireUser, httpError, getAuthUser }) {
  const { q } = require('../../../db');
  const me = (ctx) => getAuthUser(ctx.req, ctx.res).catch(() => null);
  route('GET', '/api/money', async (ctx) => { const u = await me(ctx); return money.publicConfig(u ? u.id : null); });
  route('GET', '/api/me/billing-profile', async (ctx) => {
    const u = await requireUser(ctx.req, ctx.res);
    return profileOut((await q('SELECT * FROM billing_profiles WHERE user_id=$1', [u.id])).rows[0]);
  });
  route('PUT', '/api/me/billing-profile', async (ctx) => {
    const u = await requireUser(ctx.req, ctx.res);
    const b = await ctx.body();
    const currency = String(b.currency || money.base()).toUpperCase();
    if (!money.isCurrency(currency)) throw httpError(400, 'Choose a supported currency');
    const country = clip(b.country, 8);
    if (country && !/^[A-Z]{2}$/.test(country.toUpperCase())) throw httpError(400, 'Choose a country');
    const v = [u.id, country ? country.toUpperCase() : null, clip(b.line1, 120), clip(b.line2, 120), clip(b.city, 80), clip(b.state, 80), clip(b.postalCode, 20), currency];
    await q(`INSERT INTO billing_profiles (user_id, country, line1, line2, city, state, postal_code, currency, updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW())
      ON CONFLICT (user_id) DO UPDATE SET country=EXCLUDED.country, line1=EXCLUDED.line1, line2=EXCLUDED.line2, city=EXCLUDED.city, state=EXCLUDED.state, postal_code=EXCLUDED.postal_code, currency=EXCLUDED.currency, updated_at=NOW()`, v);
    return profileOut((await q('SELECT * FROM billing_profiles WHERE user_id=$1', [u.id])).rows[0]);
  });
  const admin = async (ctx) => {
    const u = await requireUser(ctx.req, ctx.res);
    if (!u.isAdmin) throw httpError(403, 'Admins only');
    return u;
  };
  route('GET', '/api/admin/fx', async (ctx) => { await admin(ctx); return fx(); });
  route('PUT', '/api/admin/fx', async (ctx) => { const u = await admin(ctx); await money.saveRates(u.id, (await ctx.body()).rates || {}); return fx(); });
  route('DELETE', '/api/admin/fx', async (ctx) => {
    await admin(ctx);
    await q("DELETE FROM app_settings WHERE key='fx'"); money.clearCache();
    return fx();
  });
};
