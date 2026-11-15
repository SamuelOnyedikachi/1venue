const { readRaw, sendJSON } = require('../../lib/http');
const gateway = require('./paystack');
const data = require('./data');
module.exports = async function handle(req, res, url) {
  if (url.pathname !== '/payments/paystack/webhook' || req.method !== 'POST') return false;
  try {
    const settings = gateway.settings();
    if (!settings.enabled) { sendJSON(res, 503, { error: 'Payments unavailable' }); return true; }
    const raw = await readRaw(req, 64 * 1024);
    if (!gateway.verifyWebhook(raw, req.headers, settings)) { sendJSON(res, 401, { error: 'Invalid payment signature' }); return true; }
    let event;
    try { event = JSON.parse(raw.toString('utf8')); } catch (_) { sendJSON(res, 400, { error: 'Invalid event' }); return true; }
    if (event?.event === 'charge.success' && typeof event.data?.reference === 'string') {
      const payment = await data.getPayment(event.data.reference);
      if (payment) {
        try { await gateway.confirm(payment); }
        catch (e) { if (e.status !== 409) throw e; /* A permanent mismatch is retained for review. */ }
      }
    }
    sendJSON(res, 200, { ok: true });
  } catch (e) {
    console.error('[wallet webhook]', e.status || e.code || 'error');
    sendJSON(res, e.status || 500, { error: e.status ? e.message : 'Payment processing will be retried' });
  }
  return true;
};
