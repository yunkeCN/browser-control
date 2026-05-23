'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createFixtureServer } = require('../test-fixtures/server');

async function withServer(t) {
  const server = createFixtureServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  return `http://127.0.0.1:${server.address().port}`;
}

test('shared fixture server exposes stable HTML controls and SPA update hook', async (t) => {
  const baseUrl = await withServer(t);
  const response = await fetch(baseUrl);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /text\/html/);
  const html = await response.text();
  assert.match(html, /<title>Browser Control Fixture<\/title>/);
  assert.match(html, /<form id="form">/);
  assert.match(html, /<input id="email" name="email">/);
  assert.match(html, /<select id="role">/);
  assert.match(html, /<input id="enabled" type="checkbox">/);
  assert.match(html, /<button id="submit">Submit<\/button>/);
  assert.match(html, /document\.getElementById\('spa'\)\.textContent='SPA ready'/);
  assert.match(html, /document\.body\.dataset\.submitted='yes'/);
});

test('shared fixture server exposes deterministic API and download routes', async (t) => {
  const baseUrl = await withServer(t);
  const api = await fetch(`${baseUrl}/api/data`);
  assert.equal(api.status, 200);
  assert.deepEqual(await api.json(), { ok: true, value: 42 });

  const download = await fetch(`${baseUrl}/download.txt`);
  assert.equal(download.status, 200);
  assert.equal(download.headers.get('content-disposition'), 'attachment; filename="download.txt"');
  assert.equal(await download.text(), 'fixture download');
});
