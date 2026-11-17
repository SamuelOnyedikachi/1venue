'use strict';
// Public legal pages must be reachable without auth or a database.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { serveStatic } = require('../src/http/static');

test('GET /privacy and /terms return 200 text/html without auth', async () => {
  const srv = http.createServer((req, res) => serveStatic(req, res, new URL(req.url, 'http://127.0.0.1').pathname));
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  try {
    for (const p of ['/privacy', '/terms', '/privacy.html', '/terms.html', '/privacy/']) {
      const r = await fetch(base + p);
      assert.equal(r.status, 200, p);
      assert.match(r.headers.get('content-type') || '', /text\/html/, p);
      const body = await r.text();
      assert.match(body, /1venue/, p);
      assert.match(body, /legal@1venue\.live/, p);
      assert.doesNotMatch(body, /1venue needs JavaScript to run/, p + ' must not be the SPA shell');
    }
    const privacy = await (await fetch(base + '/privacy')).text();
    const terms = await (await fetch(base + '/terms')).text();
    const privacyText = privacy.replace(/\s+/g, ' ');
    const termsText = terms.replace(/\s+/g, ' ');
    assert.match(privacyText, /Privacy policy/);
    assert.match(privacyText, /Google API Services User Data Policy/);
    assert.match(privacyText, /Effective 15 November 2026/);
    assert.match(privacyText, /We don.t sell your personal data or use your recordings, transcripts, or voice to target ads/);
    assert.match(privacyText, /Promoted events and posts are chosen by 1venue admins and shown to everyone the same way/);
    assert.match(privacyText, /we only count total views and clicks, not who viewed them/);
    assert.doesNotMatch(privacyText, /we do not use it for advertising/);
    assert.match(privacyText, /outside speech provider \(Replicate\)|uploaded to Replicate, an outside speech provider/);
    assert.match(privacyText, /turn it off in Settings/);
    assert.match(privacyText, /about one hour/);
    assert.match(privacyText, /Write it for me/);
    assert.match(privacyText, /AI provider configured for this server/);
    assert.match(termsText, /Terms of service/);
    assert.match(termsText, /Federal Republic of Nigeria/);
    // Extensionless app routes still fall back to the SPA shell
    const spa = await fetch(base + '/discover');
    assert.equal(spa.status, 200);
    assert.match(await spa.text(), /1venue needs JavaScript to run/);
  } finally {
    srv.close();
  }
});
