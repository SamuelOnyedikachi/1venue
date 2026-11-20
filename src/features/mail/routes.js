/**
 * Email preference and unsubscribe routes.
 *   GET/POST /unsubscribe?t=   HMAC token from mail footers (POST is List-Unsubscribe one-click)
 *   GET/PUT  /api/account/notifications   signed-in email, invite and call prefs
 */
const prefs = require('./prefs');
const notify = require('../messages/notify');

module.exports = function routes(route, { requireUser, getAuthUser, httpError }) {
  const apply = async (ctx, body) => {
    const t = ctx.url.searchParams.get('t') || (body && (body.t || body.token));
    const r = prefs.parseUnsubToken(t);
    if (!r) throw httpError(400, 'This unsubscribe link is invalid or has expired');
    await prefs.applyUnsubscribe(r.userId, r.kind);
    return r;
  };
  const page = (msg) => ({
    raw: `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Email settings</title><p style="font:16px/1.5 system-ui;max-width:36rem;margin:3rem auto;padding:0 1rem">${msg} <a href="/settings#email">Manage email settings</a>.</p>`,
    type: 'text/html; charset=utf-8',
    headers: { 'Cache-Control': 'no-store' },
  });

  route('GET', '/unsubscribe', async (ctx) => {
    try {
      const r = await apply(ctx);
      const kind = r.kind === 'all' ? 'these emails' : r.kind.replace(/([A-Z])/g, ' $1').toLowerCase();
      return page(`You’ve been unsubscribed from ${kind}.`);
    } catch (e) {
      if (e && e.status === 400) return { ...page(e.message), $status: 400 };
      throw e;
    }
  });
  route('POST', '/unsubscribe', async (ctx) => {
    await apply(ctx, await ctx.body().catch(() => ({})));
    return { raw: 'OK', type: 'text/plain; charset=utf-8', headers: { 'Cache-Control': 'no-store' } };
  });

  route('GET', '/api/account/notifications', async (ctx) => {
    const u = await requireUser(ctx.req, ctx.res);
    const [email, extra] = await Promise.all([prefs.getEmailPrefs(u.id), notify.extraOf(u.id)]);
    return {
      email,
      speakerInvites: notify.speakerInviteMode(extra),
      calls: notify.callPrefs(extra),
      callsAvailable: !!(require('../../config').NOTIFY.callsEnabled),
    };
  });
  route('PUT', '/api/account/notifications', async (ctx) => {
    const u = await requireUser(ctx.req, ctx.res);
    const b = await ctx.body();
    if (b.email) await prefs.setEmailPrefs(u.id, b.email);
    const patch = {};
    if (b.speakerInvites === 'active' || b.speakerInvites === 'pending') patch.speakerInvites = b.speakerInvites;
    if (b.calls && typeof b.calls === 'object') {
      const cur = notify.callPrefs(await notify.extraOf(u.id));
      patch.calls = {
        enabled: b.calls.enabled != null ? !!b.calls.enabled : cur.enabled,
        optOut: b.calls.optOut != null ? !!b.calls.optOut : cur.optOut,
        quietStart: b.calls.quietStart || cur.quietStart,
        quietEnd: b.calls.quietEnd || cur.quietEnd,
      };
    }
    if (Object.keys(patch).length) await notify.patchExtra(u.id, patch);
    const [email, extra] = await Promise.all([prefs.getEmailPrefs(u.id), notify.extraOf(u.id)]);
    return { email, speakerInvites: notify.speakerInviteMode(extra), calls: notify.callPrefs(extra), callsAvailable: !!(require('../../config').NOTIFY.callsEnabled) };
  });
};
