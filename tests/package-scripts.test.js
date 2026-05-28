'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');

test('root package exposes required verification scripts', () => {
  const pkg = require(path.join(root, 'package.json'));
  for (const script of ['build', 'build:extension', 'build:protocol', 'build:daemon', 'build:mcp', 'check:extension-build', 'typecheck', 'test', 'lint', 'e2e:fixture', 'e2e:live']) {
    assert.equal(typeof pkg.scripts[script], 'string', `${script} script is required`);
  }
  assert.match(pkg.scripts.build, /build:extension/);
  assert.match(pkg.scripts.build, /build:protocol/);
  assert.match(pkg.scripts.build, /build:daemon/);
  assert.match(pkg.scripts.build, /build:mcp/);
  assert.match(pkg.scripts['build:extension'], /scripts[\\/]build-extension\.mjs/);
  assert.match(pkg.scripts['build:protocol'], /scripts[\\/]build-protocol\.mjs/);
  assert.match(pkg.scripts['build:daemon'], /scripts[\\/]build-daemon\.mjs/);
  assert.match(pkg.scripts['build:mcp'], /scripts[\\/]build-mcp\.mjs/);
  assert.match(pkg.scripts.lint, /scripts[\\/]lint\.mjs/);
  assert.match(pkg.scripts['e2e:live'], /node tests[\\/]e2e-test\.js/);
  assert.doesNotMatch(pkg.scripts['e2e:live'], /bash|\.sh/);
  assert.equal(pkg.bin['browser-control'], './skills/browser-control/scripts/browser-control.js');
  assert.equal(pkg.bin['browser-control-mcp'], './bin/browser-control-mcp.mjs');
});

test('fixture E2E script exists and is runnable without Chrome extension', () => {
  const result = spawnSync(process.execPath, [path.join(root, 'tests', 'fixture-e2e.test.js')], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /fixture e2e ok/);
});


test('root package points public browser-control bin and tests at the skill layout', () => {
  const pkg = require(path.join(root, 'package.json'));
  assert.equal(pkg.bin['browser-control'], './skills/browser-control/scripts/browser-control.js');
  assert.doesNotMatch(pkg.scripts.test, /daemon\/tests|daemon\\tests/);
});

test('skill-local script package points at browser-control.js', () => {
  const rootPkg = require(path.join(root, 'package.json'));
  const pkg = require(path.join(root, 'skills', 'browser-control', 'scripts', 'package.json'));
  assert.equal(pkg.version, rootPkg.version);
  assert.equal(pkg.bin['browser-control'], './browser-control.js');
  assert.equal(pkg.bin['browser-control-mcp'], './browser-control-mcp.mjs');
  assert.equal(pkg.scripts.cli, 'node browser-control.js');
  assert.match(pkg.scripts.typecheck, /browser-control-mcp\.mjs/);
  assert.equal(pkg.scripts.build, undefined);
  assert.equal(pkg.dependencies, undefined);
  assert.doesNotMatch(JSON.stringify(pkg), /cli\\.js/);
});

test('mcp helper is generated and syntactically valid', () => {
  for (const script of [
    path.join(root, 'bin', 'browser-control-mcp.mjs'),
    path.join(root, 'skills', 'browser-control', 'scripts', 'browser-control-mcp.mjs')
  ]) {
    assert.equal(fs.existsSync(script), true, `${path.relative(root, script)} should exist after npm run build`);
    const syntax = spawnSync(process.execPath, ['--check', script], { encoding: 'utf8' });
    assert.equal(syntax.status, 0, syntax.stderr || syntax.stdout);
    const source = fs.readFileSync(script, 'utf8');
    assert.match(source, /browser_control_command|browser_\w+/);
    assert.match(source, /browser_close_session/);
    assert.match(source, /browser_status/);
    assert.match(source, /browser_doctor/);
    assert.match(source, /McpServer/);
  }
});

test('screenshot helper is syntactically valid and handles artifact-backed responses', () => {
  const script = path.join(root, 'skills', 'browser-control', 'scripts', 'screenshot.js');
  const syntax = spawnSync(process.execPath, ['--check', script], { encoding: 'utf8' });
  assert.equal(syntax.status, 0, syntax.stderr || syntax.stdout);

  const source = fs.readFileSync(script, 'utf8');
  assert.match(source, /command: 'screenshot'/);
  assert.match(source, /data\?\.artifact\?\.path/);
  assert.match(source, /artifacts\?\.\[0\]\?\.path/);
  assert.match(source, /fs\.copyFileSync\(artifactPath, targetPath\)/);
});

test('published helper scripts use JavaScript entrypoints, not shell helpers', () => {
  const scriptsDir = path.join(root, 'skills', 'browser-control', 'scripts');
  for (const helper of ['health-check', 'open-chrome', 'screenshot', 'session-cleanup']) {
    assert.equal(fs.existsSync(path.join(scriptsDir, `${helper}.js`)), true, `${helper}.js should exist`);
    assert.equal(fs.existsSync(path.join(scriptsDir, `${helper}.sh`)), false, `${helper}.sh should not be published`);
  }
  for (const retired of ['artifact-store', 'check-daemon', 'check-extension', 'lint']) {
    assert.equal(fs.existsSync(path.join(scriptsDir, `${retired}.js`)), false, `${retired}.js should not be published`);
  }
});


test('skill package carries self-contained extension and bundled daemon runtime', () => {
  assert.equal(fs.existsSync(path.join(root, 'skills', 'browser-control', 'extension', 'manifest.json')), true);
  const protocol = fs.readFileSync(path.join(root, 'skills', 'browser-control', 'scripts', 'protocol.js'), 'utf8');
  assert.match(protocol, /Generated by scripts\/build-protocol\.mjs/);
  const vendoredWs = path.join(root, 'skills', 'browser-control', 'scripts', 'vendor', 'ws', 'index.js');
  assert.equal(fs.existsSync(vendoredWs), false);
  const daemon = fs.readFileSync(path.join(root, 'skills', 'browser-control', 'scripts', 'daemon.js'), 'utf8');
  assert.match(daemon, /Generated by scripts\/build-daemon\.mjs/);
  assert.match(daemon, /WebSocketServer/);
  assert.doesNotMatch(daemon, /vendor\/ws/);
});
