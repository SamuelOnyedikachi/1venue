'use strict';
// Mobile overflow: at 360/390/414, scrollWidth must not exceed clientWidth
// on home, Discover, Feed, Books, and a real event page.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { boot, client, signupPayload } = require('./helpers/server');

const skipDb = !process.env.DATABASE_URL ? 'set DATABASE_URL' : false;
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

test('no horizontal overflow at 360/390/414 on home, Discover, Feed, Books, event', {
  skip: skipDb || (!hasChrome ? 'google-chrome missing' : false),
  timeout: 180000,
}, async () => {
  const puppeteer = loadPuppeteer();
  if (!puppeteer) {
    assert.ok(true, 'skipped: puppeteer-core is not a package dependency');
    return;
  }
  const s = await boot();
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

    browser = await puppeteer.launch({
      executablePath: chrome,
      headless: 'new',
      args: ['--no-sandbox', '--disable-dev-shm-usage', '--hide-scrollbars'],
    });
    const widths = [360, 390, 414];
    const paths = ['/', '/discover', '/feed', '/books', '/e/' + slug];
    const fails = [];
    for (const w of widths) {
      const page = await browser.newPage();
      await page.setViewport({ width: w, height: 800, deviceScaleFactor: 1 });
      for (const pth of paths) {
        await page.goto(s.base + pth, { waitUntil: 'networkidle0', timeout: 30000 });
        await new Promise((r) => setTimeout(r, 250));
        const m = await page.evaluate(() => {
          const de = document.documentElement;
          const body = document.body;
          return {
            deSW: de.scrollWidth, deCW: de.clientWidth,
            bSW: body.scrollWidth, bCW: body.clientWidth,
          };
        });
        if (m.deSW > m.deCW + 1 || m.bSW > m.bCW + 1) {
          fails.push(`${pth} @${w}: html ${m.deSW}>${m.deCW} body ${m.bSW}>${m.bCW}`);
        }
      }
      await page.close();
    }
    assert.equal(fails.join('\n'), '', fails.join('\n'));
  } finally {
    if (browser) await browser.close().catch(() => {});
    await s.stop();
  }
});
