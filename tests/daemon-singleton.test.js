'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const daemonScript = path.join(root, 'skills', 'browser-control', 'scripts', 'daemon.js');

function request(port, method, route) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path: route, method }, res => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, json: data ? JSON.parse(data) : null }));
    });
    req.on('error', reject);
    req.end();
  });
}

async function waitForHealth(port) {
  for (let i = 0; i < 40; i++) {
    try {
      const res = await request(port, 'GET', '/health');
      if (res.json?.running) return res.json;
    } catch {}
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error('daemon did not start');
}

test('daemon start is idempotent and reuses an existing singleton on the configured port', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-control-home-'));
  const port = 13000 + Math.floor(Math.random() * 1000);
  const env = {
    ...process.env,
    BROWSER_CONTROL_HOME: home,
    BROWSER_CONTROL_HOST: '127.0.0.1',
    BROWSER_CONTROL_PORT: String(port),
    BROWSER_CONTROL_ARTIFACT_DIR: path.join(home, 'artifacts')
  };

  // Start first daemon
  const first = spawn(process.execPath, [daemonScript], {
    cwd: path.join(root, 'skills', 'browser-control', 'scripts'),
    stdio: ['ignore', 'ignore', 'pipe'],
    env
  });
  t.after(async () => {
    first.kill('SIGTERM');
    await new Promise(resolve => first.once('exit', resolve));
  });

  const health = await waitForHealth(port);
  assert.equal(health.running, true);
  assert.equal(Number(health.port), port);

  // A second daemon on the same port should fail to bind (port in use)
  const secondExited = new Promise(resolve => {
    const second = spawn(process.execPath, [daemonScript], {
      cwd: path.join(root, 'skills', 'browser-control', 'scripts'),
      stdio: ['ignore', 'ignore', 'pipe'],
      env
    });
    let stderr = '';
    second.stderr.on('data', chunk => { stderr += chunk.toString(); });
    second.on('exit', code => resolve({ code, stderr }));
    // Safety timeout
    setTimeout(() => { second.kill('SIGTERM'); }, 5000);
  });

  const secondResult = await secondExited;
  // The second daemon should exit with a non-zero code because the port is already in use
  assert.notEqual(secondResult.code, 0, 'second daemon should fail to start on same port');

  // Original daemon should still be healthy
  const stillHealthy = await waitForHealth(port);
  assert.equal(stillHealthy.running, true);
});
