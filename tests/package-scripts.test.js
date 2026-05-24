'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');

test('root package exposes required verification scripts', () => {
  const pkg = require(path.join(root, 'package.json'));
  for (const script of ['build', 'build:extension', 'check:extension-build', 'typecheck', 'test', 'lint', 'e2e:fixture', 'e2e:live']) {
    assert.equal(typeof pkg.scripts[script], 'string', `${script} script is required`);
  }
  assert.match(pkg.scripts.build, /build:extension/);
  assert.match(pkg.scripts['build:extension'], /scripts[\\/]build-extension\.mjs/);
  assert.match(pkg.scripts['e2e:live'], /node tests[\\/]e2e-test\.js/);
  assert.doesNotMatch(pkg.scripts['e2e:live'], /bash|\.sh/);
  assert.equal(pkg.bin['browser-control'], './skills/browser-control/scripts/browser-control.js');
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
  assert.equal(pkg.scripts.cli, 'node browser-control.js');
  assert.equal(pkg.scripts.build, undefined);
  assert.doesNotMatch(JSON.stringify(pkg), /cli\\.js/);
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
  for (const helper of ['health-check', 'check-daemon', 'check-extension', 'open-chrome', 'screenshot', 'session-cleanup']) {
    assert.equal(fs.existsSync(path.join(scriptsDir, `${helper}.js`)), true, `${helper}.js should exist`);
    assert.equal(fs.existsSync(path.join(scriptsDir, `${helper}.sh`)), false, `${helper}.sh should not be published`);
  }
});


test('skill package carries self-contained extension and ws runtime dependency', () => {
  assert.equal(fs.existsSync(path.join(root, 'skills', 'browser-control', 'extension', 'manifest.json')), true);
  const vendoredWs = path.join(root, 'skills', 'browser-control', 'scripts', 'vendor', 'ws', 'index.js');
  assert.equal(fs.existsSync(vendoredWs), true);
  assert.equal(typeof require(vendoredWs).WebSocketServer, 'function');
  const daemon = fs.readFileSync(path.join(root, 'skills', 'browser-control', 'scripts', 'daemon.js'), 'utf8');
  assert.match(daemon, /vendor\/ws/);
});
