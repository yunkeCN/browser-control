'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const cli = path.join(__dirname, '..', 'skills', 'browser-control', 'scripts', 'browser-control.js');
const support = require('../skills/browser-control/scripts/support');

function spawnCli(args, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cli, ...args], { encoding: 'utf8', env: { ...process.env, ...env } });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('close', status => resolve({ status, stdout, stderr }));
  });
}

test('cli exposes production commands in help, including doctor and status', () => {
  const result = spawnSync(process.execPath, [cli, '--help'], { encoding: 'utf8' });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /doctor/);
  assert.match(result.stdout, /status/);
  assert.match(result.stdout, /navigate/);
  assert.match(result.stdout, /snapshot/);
});

test('status returns error JSON when daemon is stopped or unreachable', () => {
  const result = spawnSync(process.execPath, [cli, 'status', '--json'], { encoding: 'utf8', env: { ...process.env, BROWSER_CONTROL_PORT: '11999' } });
  assert.equal(result.status, 1);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.ok, false);
  assert.match(parsed.summary, /daemon|ECONNREFUSED/i);
});

test('doctor returns error JSON when daemon is stopped or unreachable', () => {
  const result = spawnSync(process.execPath, [cli, 'doctor', '--json'], { encoding: 'utf8', env: { ...process.env, BROWSER_CONTROL_PORT: '11998' } });
  assert.equal(result.status, 1);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.ok, false);
  assert.match(parsed.summary, /daemon|ECONNREFUSED/i);
});

test('support defaults Chrome user-data paths per operating system', () => {
  assert.match(support.defaultChromeUserDataDir('win32'), /Google[\\/]Chrome[\\/]User Data$/);
  assert.match(support.defaultChromeUserDataDir('darwin'), /Library[\\/]Application Support[\\/]Google[\\/]Chrome$/);
  assert.match(support.defaultChromeUserDataDir('linux'), /\.config[\\/]google-chrome$/);
});

test('support detects Browser Control extension installed in a non-default Chrome profile', () => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-control-chrome-profile-'));
  const defaultProfile = path.join(userData, 'Default');
  const installedProfile = path.join(userData, 'Profile 2');
  const extensionPath = path.join(path.resolve(__dirname, '..'), 'skills', 'browser-control', 'extension');
  fs.mkdirSync(defaultProfile, { recursive: true });
  fs.mkdirSync(installedProfile, { recursive: true });
  fs.writeFileSync(path.join(userData, 'Local State'), JSON.stringify({
    profile: {
      last_used: 'Default',
      last_active_profiles: ['Default', 'Profile 2']
    }
  }));
  fs.writeFileSync(path.join(defaultProfile, 'Secure Preferences'), JSON.stringify({ extensions: { settings: {} } }));
  fs.writeFileSync(path.join(installedProfile, 'Secure Preferences'), JSON.stringify({
    extensions: {
      settings: {
        lalpaaopaejaejbchhlfggfnlafkcldd: {
          state: 1,
          path: extensionPath,
          manifest: { name: 'Browser Control', version: '1.2.0' }
        }
      }
    }
  }));

  const matches = support.detectLoadedExtensions({ userData, sourceDirs: [extensionPath] });
  assert.equal(matches.length, 1);
  assert.equal(matches[0].profileName, 'Profile 2');
  assert.equal(matches[0].loadedFrom, 'source');
  assert.equal(matches[0].matchedBy, 'manifest-or-path');

  const selected = support.detectLoadedExtension({ userData, sourceDirs: [extensionPath] });
  assert.equal(selected.installed, true);
  assert.equal(selected.profileName, 'Profile 2');
});

test('doctor proxies health endpoint from a reachable daemon', async (t) => {
  const healthPayload = { status: 'ok', running: true, version: '0.0.legacy', extension_connected: true };
  const server = http.createServer((req, res) => {
    if (req.url === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(healthPayload));
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end('{}');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const result = await spawnCli(['doctor'], { BROWSER_CONTROL_PORT: String(server.address().port) });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.running, true);
  assert.equal(parsed.version, '0.0.legacy');
  assert.equal(parsed.extension_connected, true);
});

test('doctor proxies health endpoint with runtime metadata from daemon', async (t) => {
  const cliVersion = require('../package.json').version;
  const healthPayload = {
    status: 'ok',
    running: true,
    version: cliVersion,
    extension_connected: true,
    runtimeSchemaVersion: '2026-05-20',
    capabilities: ['actionObservation'],
    runtime: {
      extension: {
        version: '0.0.extension-old',
        capabilities: [],
        build: { channel: 'source' }
      }
    }
  };
  const server = http.createServer((req, res) => {
    if (req.url === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(healthPayload));
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end('{}');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));

  const result = await spawnCli(['doctor'], { BROWSER_CONTROL_PORT: String(server.address().port) });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.running, true);
  assert.equal(parsed.version, cliVersion);
  assert.equal(parsed.extension_connected, true);
  assert.equal(parsed.runtime.extension.version, '0.0.extension-old');
});

test('cli dispatches command directly to controller layer', async (t) => {
  let received = null;
  const server = http.createServer((req, res) => {
    if (req.url === '/command' && req.method === 'POST') {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => {
        received = JSON.parse(body);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, command: received.command, args: received.args }));
      });
      return;
    }
    res.writeHead(404); res.end('{}');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const port = server.address().port;

  const result = await spawnCli([
    'navigate',
    '--args',
    '{"url":"https://example.com"}'
  ], { BROWSER_CONTROL_PORT: String(port) });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.ok(received, 'should have received a POST /command request');
  assert.equal(received.command, 'navigate');
  assert.equal(received.args.url, 'https://example.com');
});

test('cli rejects invalid JSON args', () => {
  const result = spawnSync(process.execPath, [cli, 'snapshot', '--args', '{bad'], { encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  const output = result.stdout || result.stderr;
  const parsed = JSON.parse(output);
  assert.equal(parsed.ok, false);
  assert.match(parsed.summary, /JSON/);
});


test('cli rejects unknown command with helpful error', () => {
  const result = spawnSync(process.execPath, [cli, 'unknown_cmd', '--args', '{}'], { encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.ok, false);
  assert.match(parsed.summary, /unknown_cmd/i);
  assert.ok(Array.isArray(parsed.nextSteps));
});

test('cli passes inline --args JSON to command handler', async (t) => {
  let received = null;
  const server = http.createServer((req, res) => {
    if (req.url === '/command' && req.method === 'POST') {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => {
        received = JSON.parse(body);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, command: received.command, args: received.args }));
      });
      return;
    }
    res.writeHead(404); res.end('{}');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));

  const result = await spawnCli([
    'evaluate', '--args', '{"code":"return document.title"}'
  ], { BROWSER_CONTROL_PORT: String(server.address().port) });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.ok(received);
  assert.equal(received.command, 'evaluate');
  assert.equal(received.args.code, 'return document.title');
});
