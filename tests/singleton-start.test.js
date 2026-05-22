'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const cli = path.join(__dirname, '..', 'skills', 'browser-control', 'scripts', 'browser-control.js');
const port = 12187;
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-control-home-'));
const env = { ...process.env, HOME: home, BROWSER_CONTROL_HOME: home, BROWSER_CONTROL_PORT: String(port), BROWSER_CONTROL_ARTIFACT_DIR: path.join(home, 'artifacts') };

function run(args) {
  return spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', env, timeout: 20000 });
}

test('start is idempotent and reuses an already healthy daemon', (t) => {
  t.after(() => run(['stop', '--json']));
  const first = run(['start', '--json']);
  assert.equal(first.status, 0, first.stderr || first.stdout);
  const firstJson = JSON.parse(first.stdout);
  assert.equal(firstJson.ok, true);
  assert.equal(firstJson.port, port);
  const second = run(['start', '--json']);
  assert.equal(second.status, 0, second.stderr || second.stdout);
  const secondJson = JSON.parse(second.stdout);
  assert.equal(secondJson.ok, true);
  assert.equal(secondJson.alreadyRunning, true);
  assert.equal(secondJson.port, port);
});
