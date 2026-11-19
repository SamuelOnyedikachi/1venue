'use strict';
// Check every routed surface at representative phone, tablet, laptop and desktop widths,
// including the app's largest supported text preference.
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
const puppeteer = loadPuppeteer();

test('all routed pages fit across responsive breakpoints at default and largest text size', {
  skip: skipDb || (!hasChrome ? 'google-chrome missing' : false) || (!puppeteer ? 'puppeteer-core missing' : false),
  timeout: 240000,
}, async () => {
  const s = await boot({
    RATE_LIMIT_PER_MIN: '10000',
    SMTP_HOST: '', SMTP_USER: '', SMTP_PASS: '', MAIL_LOG_LINKS: 'false',
  });
  let browser;
  try {
    const u = client(s.base);
    const signed = await u.post('/api/signup', signupPayload());
    assert.ok(signed.status === 200 || signed.status === 201, JSON.stringify(signed.body));
    const ev = await u.post('/api/events', {
      title: 'Overflow check praise night',
      category: 'sermon',
      visibility: 'public',
      description: 'https://example.com/a-very-long-link-that-must-wrap-and-not-stretch-the-page-' + 'x'.repeat(80),
      startsAt: new Date(Date.now() + 864e5).toISOString(),
    });
    assert.ok(ev.status === 200 || ev.status === 201, JSON.stringify(ev.body));
    const slug = ev.body.slug;
    assert.ok(slug);
    const username = signed.body.user.username;
    assert.ok(username);

    const baseUrl = new URL(s.base);
    const raw = u.jar && u.jar.header ? u.jar.header() : '';
    const cookies = raw.split(';').map((x) => x.trim()).filter(Boolean).flatMap((pair) => {
      const i = pair.indexOf('=');
      return i > 0 ? [{ name: pair.slice(0, i), value: pair.slice(i + 1), domain: baseUrl.hostname, path: '/' }] : [];
    });

    browser = await puppeteer.launch({
      executablePath: chrome,
      headless: 'new',
      args: ['--no-sandbox', '--disable-dev-shm-usage', '--hide-scrollbars'],
    });
    const page = await browser.newPage();
    if (cookies.length) await page.setCookie(...cookies);
    await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
    const widths = [320, 360, 375, 390, 414, 430, 480, 600, 640, 768, 820, 821, 834, 900, 960, 1023, 1024, 1100, 1150, 1200, 1280, 1320, 1366, 1400, 1401, 1440, 1600, 1920];
    const routes = [
      '/', '/discover', '/search?q=responsive', '/e/' + slug, '/create', '/materials', '/materials/1',
      '/dashboard', '/a/' + 'a'.repeat(32), '/feed', '/messages', '/messages/1',
      '/u/' + username, '/me', '/wallet', '/upgrade', '/billing', '/host', '/replay/1',
      '/settings', '/books', '/bible', '/sessions', '/session/1', '/whiteboard', '/login', '/admin',
      '/signup', '/forgot-password', '/reset-password', '/verify-email', '/venues', '/v/lagos-venue',
      '/new', '/ABC-234',
    ];
    const fails = [];
    for (const route of routes) {
      await page.goto(s.base + route, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await new Promise((resolve) => setTimeout(resolve, 400));
      for (const scale of [1, 1.4]) {
        await page.evaluate((value) => document.documentElement.style.setProperty('--font-scale', String(value)), scale);
        for (const width of widths) {
          await page.setViewport({ width, height: 900, deviceScaleFactor: 1 });
          const m = await page.evaluate(() => {
            const clippedFields = [...document.querySelectorAll('input, textarea, select')].filter((el) => {
              const rect = el.getBoundingClientRect();
              const style = getComputedStyle(el);
              return rect.width > 0 && rect.height > 0 && style.display !== 'none'
                && (rect.left < -1 || rect.right > innerWidth + 1);
            }).map((el) => `${el.tagName}.${String(el.className || '').replace(/\s+/g, '.')}`);
            return {
              docWidth: document.documentElement.scrollWidth,
              bodyWidth: document.body.scrollWidth,
              clippedFields,
            };
          });
          if (m.docWidth > width + 1 || m.bodyWidth > width + 1 || m.clippedFields.length) {
            fails.push(`${route} @${width} text ${scale}: html ${m.docWidth} body ${m.bodyWidth} fields ${m.clippedFields.join(',')}`);
          }
        }
      }
    }
    assert.equal(fails.join('\n'), '', fails.join('\n'));
  } finally {
    if (browser) await browser.close().catch(() => {});
    await s.stop();
  }
});
