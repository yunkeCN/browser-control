'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadSourceModule } = require('./helpers/load-source-module');
const { ArtifactStore, extractArtifacts } = loadSourceModule('src/daemon/artifact-store.ts');

test('artifact store writes base64 and strips screenshot data from response', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-control-artifacts-'));
  const store = new ArtifactStore(dir);
  const result = extractArtifacts('screenshot', { data: Buffer.from('png-bytes').toString('base64'), format: 'png' }, store);
  assert.equal(result.artifacts.length, 1);
  assert.equal(result.artifacts[0].kind, 'screenshot');
  assert.equal(result.artifacts[0].mimeType, 'image/png');
  assert.ok(fs.existsSync(result.artifacts[0].path));
  assert.equal(result.data.data, undefined);
  assert.equal(result.data.artifact.path, result.artifacts[0].path);
});

test('large network bodies are artifacted by default', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-control-network-'));
  const body = 'x'.repeat(20 * 1024);
  const result = extractArtifacts('network_detail', { requestId: 'abc', body }, new ArtifactStore(dir));
  assert.equal(result.artifacts[0].kind, 'network');
  assert.equal(result.data.body, undefined);
  assert.ok(result.data.bodyArtifact.path.endsWith('.txt'));
});

test('truncated get_text full output is artifacted and stripped from response', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-control-get-text-'));
  const result = extractArtifacts('get_text', {
    text: 'Short capped text',
    artifactText: 'Short capped text\nLong below-fold text',
    truncated: true,
    caps: { maxChars: 16, scope: 'full' }
  }, new ArtifactStore(dir));
  assert.equal(result.artifacts.length, 1);
  assert.equal(result.artifacts[0].kind, 'observation');
  assert.equal(result.data.artifactText, undefined);
  assert.equal(result.data.artifactPath, result.artifacts[0].path);
  assert.ok(fs.existsSync(result.artifacts[0].path));
});
