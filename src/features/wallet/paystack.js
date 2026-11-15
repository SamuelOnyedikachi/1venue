const crypto = require('node:crypto');
const config = require('../../config');
const data = require('./data');
const { quote, fail } = require('./rules');

function settings() {
  const secretKey = process.env.PAYSTACK_SECRET_KEY || '';
  const webhookSecret = process.env.PAYSTACK_WEBHOOK_SECRET || '';
  const mode = secretKey.startsWith('sk_live_') ? 'live' : secretKey.startsWith('sk_test_') ? 'test' : null;
  const publicUrl = config.PUBLIC_URL;
  let callback = null;
  try {
    const url = new URL(publicUrl);
    if (url.protocol === 'https:' || (mode === 'test' && url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) callback = new URL('/wallet', url).href;
  } catch (_) {}
  const enabled = !!(mode && callback && process.env.PAYSTACK_PASS_FEES_CONFIRMED === 'true' && (mode !== 'test' || process.env.NODE_ENV !== 'production'));
  const base = process.env.PAYSTACK_API_URL || 'https://api.paystack.co';
  const url = new URL(base);
  const allowed = url.origin === 'https://api.paystack.co' || (process.env.NODE_ENV === 'test' && mode === 'test' && url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname));
  if (!allowed || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw fail(503, 'Payment service configuration needs attention');
  return { secretKey, webhookSecret, mode, callback, enabled, base: url.origin };
}
function enabled() { try { return settings().enabled; } catch (_) { return false; } }
async function call(path, body) {
  const s = settings();
  if (!s.enabled) throw fail(503, 'Credit purchases are not available yet');
  try {
    const r = await fetch(s.base + path, { method: body ? 'POST' : 'GET', headers: { Authorization: `Bearer ${s.secretKey}`, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(10000) });
    const json = await r.json();
    if (!r.ok || json.status !== true || !json.data) throw new Error('gateway');
    return json.data;
  } catch (_) { throw fail(502, 'Paystack could not confirm this request. Your payment can be checked again.'); }
}
function checkoutUrl(value) {
  try { const u = new URL(value); if (u.origin === 'https://checkout.paystack.com' && !u.username && !u.password) return u.href; } catch (_) {}
  throw fail(502, 'Paystack returned an invalid checkout link');
}
async function initialize(user, amount) {
  const priced = quote(amount);
  const s = settings();
  if (!s.enabled) throw fail(503, 'Credit purchases are not available yet');
  const payment = await data.createPayment(user, priced, s.mode);
  const result = await call('/transaction/initialize', { email: payment.payer_email, amount: payment.price_kobo, currency: 'NGN', reference: payment.reference, callback_url: s.callback, metadata: { wallet_reference: payment.reference, user_id: String(user.id) } });
  if (result.reference !== payment.reference) throw fail(502, 'Paystack returned an unexpected payment reference');
  const url = checkoutUrl(result.authorization_url);
  await data.checkoutReady(payment.reference, url);
  return { ...data.paymentOut(payment), authorizationUrl: url };
}
function metadata(value) { if (typeof value === 'string') { try { return JSON.parse(value); } catch (_) { return {}; } } return value || {}; }
async function confirm(payment) {
  if (payment.status === 'paid') return data.paymentOut(payment);
  const result = await call('/transaction/verify/' + encodeURIComponent(payment.reference));
  if (result.reference !== payment.reference) throw fail(502, 'Paystack returned an unexpected payment reference');
  if (result.status !== 'success') {
    const status = ['failed', 'abandoned', 'reversed'].includes(result.status) ? 'failed' : 'pending';
    await data.mark(payment.reference, status);
    return { ...data.paymentOut(payment), status };
  }
  const meta = metadata(result.metadata);
  const requested = result.requested_amount == null ? result.amount : result.requested_amount;
  const idOk = typeof result.id === 'number' ? Number.isSafeInteger(result.id) && result.id > 0 : typeof result.id === 'string' && /^[1-9]\d{0,29}$/.test(result.id);
  const valid = idOk && Number.isSafeInteger(result.amount) && Number.isSafeInteger(result.fees) && result.fees >= 0
    && requested === Number(payment.price_kobo) && result.amount - result.fees >= Number(payment.price_kobo)
    && result.currency === payment.currency && result.domain === payment.provider_mode
    && typeof result.customer?.email === 'string' && result.customer.email.toLowerCase() === payment.payer_email
    && meta.wallet_reference === payment.reference && String(meta.user_id) === String(payment.user_id);
  if (!valid) {
    await data.mark(payment.reference, 'review', 'verification_mismatch');
    throw fail(409, 'The verified payment details do not match this purchase. No credits were added.');
  }
  try { return await data.settle(payment, result); }
  catch (e) {
    if (e.code === '23505') { await data.mark(payment.reference, 'review', 'duplicate_provider_transaction'); throw fail(409, 'This transaction has already been assigned to another purchase'); }
    throw e;
  }
}
function equalHex(expected, supplied) {
  return typeof supplied === 'string' && /^[a-f0-9]{128}$/.test(supplied) && crypto.timingSafeEqual(expected, Buffer.from(supplied, 'hex'));
}
function verifyWebhook(raw, headers, { secretKey, webhookSecret, now = Date.now() } = {}) {
  const current = headers['paystack-signature'];
  if (webhookSecret || current) {
    if (!webhookSecret || typeof current !== 'string') return false;
    const parts = current.split(',').map((p) => p.trim());
    const times = parts.filter((p) => p.startsWith('t='));
    if (times.length !== 1 || !/^t=\d{1,12}$/.test(times[0])) return false;
    const t = times[0].slice(2);
    if (Math.abs(now / 1000 - Number(t)) > 300) return false;
    const expected = crypto.createHmac('sha512', webhookSecret).update(t + '.').update(raw).digest();
    return parts.filter((p) => p.startsWith('v1=')).some((p) => /^v1=whk_[\w-]+:[a-f0-9]{128}$/.test(p) && equalHex(expected, p.slice(p.indexOf(':') + 1)));
  }
  if (!secretKey) return false;
  return equalHex(crypto.createHmac('sha512', secretKey).update(raw).digest(), headers['x-paystack-signature']);
}
module.exports = { settings, enabled, initialize, confirm, verifyWebhook };
