'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createYoutubeLikeFixture, RESULT_COUNT, INITIAL_VIRTUAL_COUNT } = require('./helpers/youtube-like-fixture');

test('YouTube-like fixture encodes P0 scroll/get_text regression conditions', () => {
  const fixture = createYoutubeLikeFixture();
  assert.equal(fixture.cardTitles.length, RESULT_COUNT);
  assert.equal(fixture.virtualTitles.length, RESULT_COUNT);
  assert.match(fixture.html, /id="player" tabindex="0" role="application"/);
  assert.match(fixture.html, /event\.code === 'Space' \|\| event\.code === 'PageDown'/);
  assert.match(fixture.html, /event\.preventDefault\(\)/);
  assert.match(fixture.html, /id="results-region"[^>]*data-testid="results-region"/);
  assert.match(fixture.html, /#results-region \{ height: 520px; overflow: auto;/);
  assert.equal((fixture.html.match(/data-testid="result-card"/g) || []).length, RESULT_COUNT);
  assert.equal((fixture.html.match(/<article class="virtual-card" data-testid="virtual-card"/g) || []).length, INITIAL_VIRTUAL_COUNT);
  assert.match(fixture.html, /region\.addEventListener\('scroll'/);
  assert.match(fixture.html, /virtual\.appendChild\(card\)/);
});

test('YouTube-like fixture includes below-fold text and filtered decoys', () => {
  const fixture = createYoutubeLikeFixture();
  assert.ok(fixture.html.indexOf('Fixture Video Result 1') < fixture.html.indexOf('Fixture Video Result 10'));
  assert.match(fixture.html, /Fixture Video Result 12/);
  for (const decoy of Object.values(fixture.decoyTexts)) {
    assert.match(fixture.html, new RegExp(decoy));
  }
  assert.match(fixture.html, /class="hidden-decoy"/);
  assert.match(fixture.html, /class="zero-size-decoy"/);
  assert.match(fixture.html, /class="off-layout-decoy"/);
  assert.match(fixture.html, /aria-hidden="true"/);
});

test('YouTube-like fixture can be served as an e2e page artifact', async (t) => {
  const http = require('node:http');
  const fixture = createYoutubeLikeFixture();
  const server = http.createServer((req, res) => {
    if (req.url !== '/youtube-like') {
      res.statusCode = 404;
      res.end('not found');
      return;
    }
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.end(fixture.html);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const { port } = server.address();
  const response = await fetch(`http://127.0.0.1:${port}/youtube-like`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /text\/html/);
  const html = await response.text();
  assert.match(html, /Focused media area intercepts Space and PageDown/);
  assert.match(html, /Fixture Video Result 12/);
  assert.match(html, /Virtualized Fixture Result 1/);
});
