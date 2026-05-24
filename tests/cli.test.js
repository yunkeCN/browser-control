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

test('cli exposes production commands in help, including doctor/diagnose/e2e', () => {
  const result = spawnSync(process.execPath, [cli, '--help'], { encoding: 'utf8' });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /doctor/);
  assert.match(result.stdout, /diagnose/);
  assert.match(result.stdout, /command <name>/);
  assert.match(result.stdout, /e2e/);
});

test('status --json returns stable shape when daemon is stopped or unreachable', () => {
  const result = spawnSync(process.execPath, [cli, 'status', '--json'], { encoding: 'utf8', env: { ...process.env, BROWSER_CONTROL_PORT: '11999' } });
  assert.equal(result.status, 0);
  const parsed = JSON.parse(result.stdout);
  assert.equal(typeof parsed.running, 'boolean');
  assert.equal(parsed.host, '127.0.0.1');
  assert.equal(parsed.port, 11999);
});

test('doctor --json returns daemon/chrome/extension sections', () => {
  const result = spawnSync(process.execPath, [cli, 'doctor', '--json'], { encoding: 'utf8', env: { ...process.env, BROWSER_CONTROL_PORT: '11998' } });
  assert.equal(result.status, 0);
  const parsed = JSON.parse(result.stdout);
  assert.ok(parsed.daemon);
  assert.ok(parsed.chrome);
  assert.ok(parsed.extension);
  assert.ok(parsed.cli);
  assert.ok(parsed.runtimeDiagnostics);
  assert.equal(typeof parsed.ok, 'boolean');
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

test('doctor warns when reachable daemon has old health/status shape', async (t) => {
  const server = http.createServer((req, res) => {
    if (req.url === '/status') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ running: true, version: '0.0.legacy', extension_connected: true }));
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end('{}');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-control-chrome-profile-'));
  const profile = path.join(userData, 'Default');
  fs.mkdirSync(profile, { recursive: true });
  fs.writeFileSync(path.join(userData, 'Local State'), JSON.stringify({ profile: { last_used: 'Default' } }));
  fs.writeFileSync(path.join(profile, 'Secure Preferences'), JSON.stringify({
    extensions: {
      settings: {
        lalpaaopaejaejbchhlfggfnlafkcldd: {
          state: 1,
          path: path.join(path.resolve(__dirname, '..'), 'skills', 'browser-control', 'extension'),
          manifest: { name: 'Browser Control', version: '1.0.0' }
        }
      }
    }
  }));
  const result = await spawnCli(['doctor', '--json'], { BROWSER_CONTROL_PORT: String(server.address().port), CODEX_CHROME_USER_DATA_DIR: userData });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const parsed = JSON.parse(result.stdout);
  assert.match(parsed.runtimeDiagnostics.warnings.join(' '), /daemon may be old/i);
  assert.match(parsed.runtimeDiagnostics.warnings.join(' '), /Daemon version .* differs from CLI version/i);
  assert.match(parsed.nextSteps.join(' '), /browser-control restart/);
  assert.equal(parsed.extension.loaded.extensionId, 'lalpaaopaejaejbchhlfggfnlafkcldd');
  assert.equal(parsed.extension.loaded.loadedFrom, 'source');
  assert.equal(parsed.extension.loaded.matchedBy, 'manifest-or-path');
  assert.equal(parsed.extension.loadedProfiles.length, 1);
});

test('doctor warns when extension runtime version differs from cli', async (t) => {
  const server = http.createServer((req, res) => {
    if (req.url === '/status') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        running: true,
        version: require('../package.json').version,
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
      }));
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end('{}');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-control-chrome-profile-'));
  const profile = path.join(userData, 'Default');
  fs.mkdirSync(profile, { recursive: true });
  fs.writeFileSync(path.join(userData, 'Local State'), JSON.stringify({ profile: { last_used: 'Default' } }));
  fs.writeFileSync(path.join(profile, 'Secure Preferences'), JSON.stringify({ extensions: { settings: {} } }));

  const result = await spawnCli(['doctor', '--json'], { BROWSER_CONTROL_PORT: String(server.address().port), CODEX_CHROME_USER_DATA_DIR: userData });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const parsed = JSON.parse(result.stdout);
  assert.match(parsed.runtimeDiagnostics.warnings.join(' '), /Extension runtime version .* differs from CLI version/i);
  assert.match(parsed.nextSteps.join(' '), /reload the Chrome extension/i);
});

test('command helper posts a typed envelope to /command', async (t) => {
  let received = null;
  const server = http.createServer((req, res) => {
    assert.equal(req.method, 'POST');
    assert.equal(req.url, '/command');
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      received = JSON.parse(body);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, id: received.id, command: received.command, session: received.session, args: received.args }));
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const port = server.address().port;

  const result = await spawnCli([
    'command',
    'snapshot',
    '--session',
    'cli-test',
    '--args',
    '{}',
    '--id',
    'test-id'
  ], { BROWSER_CONTROL_PORT: String(port) });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(received.id, 'test-id');
  assert.equal(received.version, '2026-05-19');
  assert.equal(received.command, 'snapshot');
  assert.equal(received.session, 'cli-test');
  assert.deepEqual(received.args, {});
  assert.equal(received.timeoutMs, 30000);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.command, 'snapshot');
});

test('command helper rejects invalid JSON args', () => {
  const result = spawnSync(process.execPath, [cli, 'command', 'snapshot', '--args', '{bad'], { encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /--args must be valid JSON/);
});


test('command helper accepts --args-file and evaluate --code-file', async (t) => {
  let received = null;
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      received = JSON.parse(body);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, command: received.command, args: received.args }));
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-control-cli-'));
  const argsFile = path.join(dir, 'args.json');
  const codeFile = path.join(dir, 'code.js');
  fs.writeFileSync(argsFile, JSON.stringify({ tabId: 42 }), 'utf8');
  fs.writeFileSync(codeFile, 'return { title: document.title, path: location.pathname }', 'utf8');

  const result = await spawnCli([
    'command', 'evaluate', '--args-file', argsFile, '--code-file', codeFile
  ], { BROWSER_CONTROL_PORT: String(server.address().port) });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(received.command, 'evaluate');
  assert.equal(received.args.tabId, 42);
  assert.match(received.args.code, /document\.title/);
});

test('command helper rejects invalid --args-file JSON object and non-evaluate --code-file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-control-cli-invalid-'));
  const arrayFile = path.join(dir, 'array.json');
  const codeFile = path.join(dir, 'code.js');
  fs.writeFileSync(arrayFile, '[]', 'utf8');
  fs.writeFileSync(codeFile, 'return 1', 'utf8');

  const invalidArgs = spawnSync(process.execPath, [cli, 'command', 'snapshot', '--args-file', arrayFile], { encoding: 'utf8' });
  assert.notEqual(invalidArgs.status, 0);
  assert.match(invalidArgs.stderr, /--args-file must be a JSON object/);

  const invalidCode = spawnSync(process.execPath, [cli, 'command', 'snapshot', '--code-file', codeFile], { encoding: 'utf8' });
  assert.notEqual(invalidCode.status, 0);
  assert.match(invalidCode.stderr, /--code-file is only supported for the evaluate command/);
});
