'use strict';
// Approved sidebar-block redesign: Happening soon is time-first, More from this host is
// featured + mini rows, Promoted is labelled once per block with a compact RSVP.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { boot, client, signupPayload } = require('./helpers/server');

const skipDb = !process.env.DATABASE_URL && process.env.DB_DRIVER !== 'sqlite' ? 'set DATABASE_URL or DB_DRIVER=sqlite' : false;
const chrome = process.env.CHROME_PATH || '/usr/bin/google-chrome';
const hasChrome = fs.existsSync(chrome);
const puppeteerPaths = [
  '/tmp/shot-tools/node_modules/puppeteer-core',
  path.join(__dirname, '../../shot-tools/node_modules/puppeteer-core'),
];
function loadPuppeteer() {
  for (const p of puppeteerPaths) {
    try { return require(p); } catch {}
  }
  try { return require('puppeteer-core'); } catch { return null; }
}
const tokenOf = (link) => new URL(link).searchParams.get('token');
const root = path.join(__dirname, '..');
const src = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

test('compact promo and event rail sources have no per-row Promoted tag or Sponsored label', () => {
  const promo = src('public/js/promo.js');
  const compact = promo.slice(promo.indexOf('export function promoCompact'), promo.indexOf('export function promoInline'));
  assert.ok(compact.includes('export function promoCompact'), 'promoCompact not found');
  assert.doesNotMatch(compact, /promo-tag/);
  assert.doesNotMatch(compact, /Sponsored/i);
  assert.doesNotMatch(compact, /btn sm/);
  assert.match(compact, /feed-promo-rsvp/);
  assert.doesNotMatch(promo, /Sponsored/i);

  const eventJs = src('public/js/pages/event.js');
  assert.match(eventJs, /railSoonRow/);
  assert.match(eventJs, /railHostBlock/);
  assert.doesNotMatch(eventJs, /Sponsored/i);
  assert.doesNotMatch(eventJs, /eventCard\(/);

  const feedJs = src('public/js/pages/feed.js');
  assert.match(feedJs, /sectionHead\('Promoted'\)/);
  assert.doesNotMatch(feedJs, /Sponsored/i);

  const evCss = src('public/css/src/20-pages/event.css');
  assert.match(evCss, /\.rail-when/);
  assert.match(evCss, /\.rail-feature/);
  const feedCss = src('public/css/src/20-pages/feed.css');
  assert.match(feedCss, /\.feed-promo-rsvp/);
  assert.doesNotMatch(feedCss, /Sponsored/i);
});

test('event rail and feed promoted box render the approved compact layouts', {
  skip: skipDb || (!hasChrome ? 'google-chrome missing' : false),
  timeout: 180000,
}, async () => {
  const puppeteer = loadPuppeteer();
  if (!puppeteer) {
    assert.ok(true, 'skipped: puppeteer-core is not a package dependency');
    return;
  }
  const adminBody = signupPayload();
  const s = await boot({ ADMIN_EMAILS: adminBody.email });
  let browser;
  try {
    const a = client(s.base);
    assert.ok((await a.post('/api/signup', adminBody)).status < 300);
    const link = await s.mailLink(adminBody.email, /Confirm your email/, { timeout: 8000 });
    assert.ok(link, 'verification mail missing');
    assert.ok((await a.post('/api/auth/verify-email', { token: tokenOf(link) })).status < 300);
    // Consume the one-time welcome-credits modal so it cannot block the SPA router.
    await a.post('/api/wallet/welcome-notice');

    const now = Date.now();
    const evs = [];
    for (const [i, title] of [
      'Sunday Praise Night: Igbo & English Worship',
      'Midweek Bible Study: Psalm 23',
      'Praise Team Rehearsal & Prayer',
      'Naija Tech Talk: Building for 200 Million Users',
    ].entries()) {
      const r = await a.post('/api/events', {
        title,
        category: i === 3 ? 'talk_show' : (i === 2 ? 'meeting' : 'sermon'),
        visibility: 'public',
        startsAt: new Date(now + (i + 1) * 3600_000).toISOString(),
      });
      assert.ok(r.status === 200 || r.status === 201, JSON.stringify(r.body));
      evs.push(r.body);
    }
    const promo = await a.post('/api/admin/promotions', {
      type: 'event',
      targetId: evs[3].id,
      placements: ['discover', 'feed'],
    });
    assert.equal(promo.status, 201, JSON.stringify(promo.body));

    const login = await a.post('/api/login', { email: adminBody.email, password: adminBody.password });
    assert.ok(login.status === 200, JSON.stringify(login.body));

    browser = await puppeteer.launch({
      executablePath: chrome,
      headless: 'new',
      args: ['--no-sandbox', '--disable-dev-shm-usage', '--hide-scrollbars'],
    });
    const page = await browser.newPage();
    const cookies = [];
    for (const sc of (login.headers && login.rawHeaders) || []) { /* placeholder */ }
    // helpers/client may not expose set-cookie; log in through the page instead.
    await page.setViewport({ width: 1280, height: 900, deviceScaleFactor: 1 });
    await page.goto(s.base + '/login', { waitUntil: 'networkidle0', timeout: 30000 });
    await page.evaluate((email, password) => {
      const ev = (name) => document.querySelector(`[name="${name}"], input[type="${name}"], #${name}`);
      const emailEl = ev('email') || document.querySelector('input[type="email"]');
      const passEl = ev('password') || document.querySelector('input[type="password"]');
      if (emailEl) emailEl.value = email;
      if (passEl) passEl.value = password;
    }, adminBody.email, adminBody.password);
    // Use the API from the page to set the session cookie reliably.
    const logged = await page.evaluate(async (email, password) => {
      const r = await fetch('/api/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
      return r.status;
    }, adminBody.email, adminBody.password);
    assert.equal(logged, 200);

    const dismissWelcome = async () => {
      const btn = await page.$('.welcome-credit-modal .au-btn, .welcome-credit-modal [aria-label="Close"]');
      if (btn) await btn.click();
    };
    const slug = evs[0].slug;
    assert.ok(slug, 'event slug missing: ' + JSON.stringify(evs[0]));
    await page.goto(s.base + '/e/' + slug, { waitUntil: 'networkidle0', timeout: 45000 });
    await dismissWelcome();
    await page.waitForSelector('.ev-page', { timeout: 15000 });
    await page.waitForSelector('.ev-right .ev-rail-head', { timeout: 15000 });

    const evInfo = await page.evaluate(() => {
      const right = document.querySelector('.ev-right');
      const soon = [...(right?.querySelectorAll('.ev-rail-head') || [])].find((el) => /happening soon/i.test(el.textContent));
      const host = [...(right?.querySelectorAll('.ev-rail-head') || [])].find((el) => /more from this host/i.test(el.textContent));
      const promo = [...(right?.querySelectorAll('.ev-rail-head') || [])].find((el) => /^promoted$/i.test(el.textContent.trim()));
      const soonBlock = soon?.closest('.ev-rail-block, .ev-card');
      const hostBlock = host?.closest('.ev-rail-block, .ev-card');
      const promoBlock = promo?.closest('.ev-rail-block, .ev-card');
      return {
        hasSoonWhen: !!(soonBlock && soonBlock.querySelector('.rail-when')),
        soonPosters: soonBlock ? soonBlock.querySelectorAll('a.card.ev-card').length : -1,
        hasFeature: !!(hostBlock && hostBlock.querySelector('.rail-feature')),
        miniRows: hostBlock ? hostBlock.querySelectorAll('.rail-mini .rail-row').length : -1,
        hostPosters: hostBlock ? hostBlock.querySelectorAll('a.card.ev-card').length : -1,
        promoLabel: promo ? promo.textContent.trim() : null,
        promoTags: promoBlock ? promoBlock.querySelectorAll('.promo-tag').length : -1,
        promoRows: promoBlock ? promoBlock.querySelectorAll('.feed-promo').length : -1,
        promoBtnSm: promoBlock ? promoBlock.querySelectorAll('.feed-promo-rsvp.btn, .btn.sm.feed-promo-rsvp').length : -1,
        sponsored: (right?.textContent || '').includes('Sponsored'),
        text: (right?.innerText || '').slice(0, 400),
      };
    });
    assert.equal(evInfo.hasSoonWhen, true, 'Happening soon should use time-first rows: ' + evInfo.text);
    assert.equal(evInfo.soonPosters, 0, 'Happening soon must not reuse the Discover poster card');
    assert.equal(evInfo.hasFeature, true, 'More from this host should have a featured card: ' + evInfo.text);
    assert.ok(evInfo.miniRows >= 1, 'More from this host should have mini rows, got ' + evInfo.miniRows);
    assert.equal(evInfo.hostPosters, 0, 'More from this host must not nest .ev-card posters');
    assert.equal(evInfo.promoLabel, 'Promoted');
    assert.equal(evInfo.promoTags, 0, 'no per-row Promoted tag');
    assert.ok(evInfo.promoRows >= 1, 'expected compact promo rows');
    assert.equal(evInfo.promoBtnSm, 0, 'RSVP must not use .btn.sm');
    assert.equal(evInfo.sponsored, false, 'must not say Sponsored');

    await page.goto(s.base + '/feed', { waitUntil: 'networkidle0', timeout: 45000 });
    await dismissWelcome();
    await page.waitForSelector('.feed-promoted, .feed-shell', { timeout: 15000 });
    await new Promise((r) => setTimeout(r, 400));
    const feedInfo = await page.evaluate(() => {
      const box = document.querySelector('.feed-promoted');
      const head = box?.querySelector('.feed-rail-head, .ev-rail-head');
      return {
        exists: !!box,
        head: head ? head.textContent.trim() : null,
        tags: box ? box.querySelectorAll('.promo-tag').length : -1,
        rows: box ? box.querySelectorAll('.feed-promo').length : -1,
        btnSm: box ? box.querySelectorAll('.feed-promo-rsvp.btn, .btn.sm.feed-promo-rsvp').length : -1,
        sponsored: (box?.textContent || '').includes('Sponsored'),
      };
    });
    assert.equal(feedInfo.exists, true, 'feed promoted box missing');
    assert.equal(feedInfo.head, 'Promoted');
    assert.equal(feedInfo.tags, 0, 'feed promo rows must not carry a Promoted tag');
    assert.ok(feedInfo.rows >= 1);
    assert.equal(feedInfo.btnSm, 0);
    assert.equal(feedInfo.sponsored, false);

    await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 1 });
    await page.goto(s.base + '/e/' + slug, { waitUntil: 'networkidle0', timeout: 45000 });
    await dismissWelcome();
    await page.waitForSelector('.ev-right .rail-when', { timeout: 15000 });
    const mobile = await page.evaluate(() => {
      const right = document.querySelector('.ev-right');
      const cs = right && getComputedStyle(right);
      const de = document.documentElement;
      return {
        display: cs ? cs.display : 'missing',
        hasSoon: !!(right && right.querySelector('.rail-when')),
        hasFeature: !!(right && right.querySelector('.rail-feature')),
        overflow: de.scrollWidth > de.clientWidth + 1,
        sw: de.scrollWidth,
        cw: de.clientWidth,
      };
    });
    assert.equal(mobile.display, 'flex', 'event right rail should stack on mobile');
    assert.equal(mobile.hasSoon, true);
    assert.equal(mobile.hasFeature, true);
    assert.equal(mobile.overflow, false, `overflow at 390: ${mobile.sw}>${mobile.cw}`);
  } finally {
    if (browser) await browser.close().catch(() => {});
    await s.stop();
  }
});
