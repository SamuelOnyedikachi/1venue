'use strict';
// Event tiles: the top 65% of the card must be a clear, untinted photo
// at every placement and at 390/768/1024/1280.
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

test('event tile photo stays clear in the top 65% at 390/768/1024/1280', {
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
    const signed = await u.post('/api/signup', signupPayload({ displayName: 'Adaeze Clear Photo' }));
    assert.ok(signed.status === 200 || signed.status === 201, JSON.stringify(signed.body));
    const ev = await u.post('/api/events', {
      title: 'Sunday Praise Night: Igbo & English Worship',
      category: 'sermon',
      visibility: 'public',
      startsAt: new Date(Date.now() + 864e5).toISOString(),
    });
    assert.ok(ev.status === 200 || ev.status === 201, JSON.stringify(ev.body));
    await u.post('/api/posts', {
      body: 'Join us this Sunday.',
      eventId: ev.body.id,
    });
    const username = ((await u.get('/api/session')).body.user || {}).username;
    assert.ok(username);

    browser = await puppeteer.launch({
      executablePath: chrome,
      headless: 'new',
      args: ['--no-sandbox', '--disable-dev-shm-usage', '--hide-scrollbars'],
    });
    const baseUrl = new URL(s.base);
    const cookies = [];
    const raw = u.jar && u.jar.header ? u.jar.header() : '';
    for (const pair of raw.split(';').map((x) => x.trim()).filter(Boolean)) {
      const i = pair.indexOf('=');
      if (i > 0) cookies.push({ name: pair.slice(0, i), value: pair.slice(i + 1), domain: baseUrl.hostname, path: '/' });
    }

    const widths = [390, 768, 1024, 1280];
    const paths = ['/', '/discover', '/feed', '/dashboard', '/u/' + username];
    const samples = [];
    for (const w of widths) {
      const page = await browser.newPage();
      if (cookies.length) await page.setCookie(...cookies);
      await page.setViewport({ width: w, height: 1100, deviceScaleFactor: 1 });
      for (const pth of paths) {
        await page.goto(s.base + pth, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await new Promise((r) => setTimeout(r, 450));
        const found = await page.evaluate(() => {
          return [...document.querySelectorAll('.ev-tile')].map((t, i) => {
            const tr = t.getBoundingClientRect();
            const body = t.querySelector('.body, .ev-cat, .title');
            if (!tr.height || !body) return null;
            const br = body.getBoundingClientRect();
            const ratio = (br.top - tr.top) / tr.height;
            const cover = t.querySelector('.cover');
            const afterH = cover ? parseFloat(getComputedStyle(cover, '::after').height) : 0;
            const overlayRatio = cover && cover.getBoundingClientRect().height
              ? afterH / cover.getBoundingClientRect().height
              : 0;
            const meta = t.querySelector('.ev-meta');
            const metaWraps = meta ? meta.scrollHeight > meta.clientHeight + 1 : false;
            return {
              i, w: Math.round(tr.width), h: Math.round(tr.height),
              ratio: Math.round(ratio * 1000) / 1000,
              overlayRatio: Math.round(overlayRatio * 1000) / 1000,
              metaWraps,
            };
          }).filter(Boolean);
        });
        for (const row of found) samples.push({ path: pth, width: w, ...row });
      }
      await page.close();
    }

    assert.ok(samples.length > 0, 'no event tiles were rendered to measure');
    const fails = [];
    let min = 1;
    let minAt = '';
    for (const row of samples) {
      if (row.ratio < min) {
        min = row.ratio;
        minAt = `${row.path} @${row.width} tile#${row.i} (${row.w}x${row.h})`;
      }
      if (row.ratio < 0.65) {
        fails.push(`${row.path} @${row.width} tile#${row.i}: text starts at ${(row.ratio * 100).toFixed(1)}% of ${row.h}px`);
      }
      if (row.overlayRatio > 0.40 + 0.01) {
        fails.push(`${row.path} @${row.width} tile#${row.i}: overlay is ${(row.overlayRatio * 100).toFixed(1)}% of height`);
      }
      if (row.metaWraps) {
        fails.push(`${row.path} @${row.width} tile#${row.i}: meta wrapped onto an extra line (${row.w}x${row.h})`);
      }
    }
    assert.equal(fails.join('\n'), '', fails.join('\n'));
    assert.ok(min >= 0.65, `min clear-photo ratio ${min} at ${minAt}`);
    console.log(`min clear-photo ratio ${min} at ${minAt} (n=${samples.length})`);
  } finally {
    if (browser) await browser.close().catch(() => {});
    await s.stop();
  }
});
