'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { cliScript } = require('./helpers/browser-control-paths');

function runCli(args, env) {
  const result = spawnSync(process.execPath, [cliScript, ...args], { encoding: 'utf8', env: { ...process.env, ...env } });
  let json = null;
  if (result.stdout.trim()) json = JSON.parse(result.stdout);
  return { ...result, json };
}

test('daemon start is idempotent and reuses an existing singleton on the configured port', (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-control-home-'));
  const port = String(13000 + Math.floor(Math.random() * 1000));
  const env = {
    HOME: home,
    BROWSER_CONTROL_HOME: home,
    BROWSER_CONTROL_HOST: '127.0.0.1',
    BROWSER_CONTROL_PORT: port,
    BROWSER_CONTROL_ARTIFACT_DIR: path.join(home, 'artifacts')
  };
  t.after(() => runCli(['stop', '--json'], env));

  const first = runCli(['start', '--json'], env);
  assert.equal(first.status, 0, first.stderr || first.stdout);
  assert.equal(first.json.ok, true);
  assert.ok(first.json.started || first.json.pid, 'first start should report a started daemon');

  const second = runCli(['start', '--json'], env);
  assert.equal(second.status, 0, second.stderr || second.stdout);
  assert.equal(second.json.ok, true);
  assert.equal(second.json.alreadyRunning, true);
  assert.equal(Number(second.json.port), Number(port));
});
