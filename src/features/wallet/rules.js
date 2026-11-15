// Integer credit units leave room for exact per-second metering and 80/20 splits later.
const UNITS_PER_CREDIT = 60000;
const PRICE_PER_CREDIT_KOBO = 50000;
const fail = (status, message) => Object.assign(new Error(message), { status });
function quote(credits) {
  if (!Number.isSafeInteger(credits) || credits < 1 || !Number.isSafeInteger(credits * UNITS_PER_CREDIT) || !Number.isSafeInteger(credits * PRICE_PER_CREDIT_KOBO)) {
    throw fail(400, 'Choose a positive whole number of credits within the supported range');
  }
  return { credits, priceKobo: credits * PRICE_PER_CREDIT_KOBO, currency: 'NGN' };
}
const BUNDLES = [10, 30, 60, 120].map(quote);
module.exports = { UNITS_PER_CREDIT, PRICE_PER_CREDIT_KOBO, BUNDLES, quote, fail };
