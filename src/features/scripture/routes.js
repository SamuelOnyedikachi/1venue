/**
 * Books: Bible / Qur’an passages (canonical /api/books/*, legacy alias /api/bible/*).
 * JSON API routes (see src/core/router.js for the route() contract).
 */
module.exports = function routes(route, kit) {
  const { config, clientIp, rateLimit, bible, httpError } = kit;

  // ------------------------------------------------------------ Books (Bible + Qur’an)
  // Canonical prefix is /api/books/*. /api/bible/* stays as a permanent alias: installed PWAs
  // and cached clients from before the rename still call it, so both answer identically.
  for (const prefix of ['/api/books', '/api/bible']) {
    route('GET', `${prefix}/translations`, async () => ({ translations: bible().TRANSLATIONS, default: config.BIBLE.defaultTranslation }));
    route('GET', `${prefix}/books`, async () => ({ books: bible().BOOKS }));
    route('GET', `${prefix}/passage`, async (ctx) => {
      if (!rateLimit(`b:${clientIp(ctx.req)}`, 120)) throw httpError(429, 'Too many requests');
      return bible().passage(ctx.url.searchParams.get('ref'), ctx.url.searchParams.get('t'));
    });
    // Book ids: 3-letter USFM (GEN, JHN) or Qur’an Q001–Q114
    route('GET', `${prefix}/([\\w.-]+)/([\\w]{2,8})/(\\d{1,3})`, async (ctx, [t, b, c]) => {
      if (!rateLimit(`b:${clientIp(ctx.req)}`, 120)) throw httpError(429, 'Too many requests');
      return { ...(await bible().chapter(t, b, c)), _cache: true };
    });
  }
};
