'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { daemonScript } = require('./helpers/browser-control-paths');

const port = 11087;

function request(method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : undefined;
    const req = http.request({ hostname: '127.0.0.1', port, path: urlPath, method, headers: data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : undefined, timeout: 1000 }, (res) => {
      let text = ''; res.on('data', c => text += c); res.on('end', () => resolve({ status: res.statusCode, data: JSON.parse(text) }));
    });
    req.on('error', reject); req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    if (data) req.write(data); req.end();
  });
}
async function waitHealth() {
  for (let i = 0; i < 30; i++) { try { return await request('GET', '/health'); } catch { await new Promise(r => setTimeout(r, 100)); } }
  throw new Error('daemon did not start');
}

test('daemon exposes health and validates command envelopes without extension', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-control-home-'));
  const child = spawn(process.execPath, [path.resolve(__dirname, '..', 'skills', 'browser-control', 'scripts', 'daemon.js')], { stdio: 'ignore', env: { ...process.env, BROWSER_CONTROL_HOME: home, BROWSER_CONTROL_PORT: String(port), BROWSER_CONTROL_ARTIFACT_DIR: path.join(home, 'artifacts') } });
  t.after(() => child.kill('SIGTERM'));
  const health = await waitHealth();
  assert.equal(health.status, 200);
  assert.equal(health.data.running, true);
  assert.equal(health.data.runtimeSchemaVersion, '2026-05-20');
  assert.ok(health.data.capabilities.includes('actionObservation'));
  assert.equal(health.data.runtime.daemon.layer, 'daemon');
  const invalid = await request('POST', '/command', { command: 'click', args: {}, id: 'bad' });
  assert.equal(invalid.status, 400);
  assert.equal(invalid.data.ok, false);
  assert.equal(invalid.data.error.code, 'VALIDATION_ERROR');
  const unavailable = await request('POST', '/command', { command: 'snapshot', args: {}, id: 'snap', timeoutMs: 100 });
  assert.equal(unavailable.status, 502);
  assert.equal(unavailable.data.error.code, 'BACKEND_UNAVAILABLE');
});
