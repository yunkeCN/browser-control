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

test('small snapshot responses stay inline without an artifact', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-control-snapshot-'));
  const snapshot = {
    schemaVersion: 3,
    semantics: 'playwright-aria-ai-v1',
    snapshot: '- button "Submit" [ref=@eabc_1]',
    refs: [{ ref: '@eabc_1', tag: 'button', text: 'Submit' }],
    tree: []
  };
  const result = extractArtifacts('snapshot', snapshot, new ArtifactStore(dir));
  assert.equal(result.artifacts.length, 0);
  assert.deepEqual(result.data, snapshot);
});

test('large snapshot text is artifacted and replaced with a compact preview', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-control-snapshot-'));
  const snapshot = {
    schemaVersion: 3,
    semantics: 'playwright-aria-ai-v1',
    snapshot: 'x'.repeat(100_001),
    refs: Array.from({ length: 205 }, (_, index) => ({ ref: `@e${index}_1`, tag: 'button', text: `Button ${index}` })),
    tree: [{ role: 'document', children: [{ text: 'full tree' }] }],
    stats: { returned: 205 },
    guidance: { textReading: 'use get_text' }
  };
  const result = extractArtifacts('snapshot', snapshot, new ArtifactStore(dir));
  assert.equal(result.artifacts.length, 1);
  assert.equal(result.artifacts[0].kind, 'snapshot');
  assert.equal(result.artifacts[0].mimeType, 'application/json');
  assert.equal(result.data.truncated, true);
  assert.equal(result.data.artifact.path, result.artifacts[0].path);
  assert.equal(result.data.snapshot.includes('truncated'), true);
  assert.equal(result.data.snapshot.length < 25_000, true);
  assert.deepEqual(result.data.tree, []);
  assert.equal(result.data.refs.length, 200);
  assert.equal(result.data.guidance.filtering.some(hint => /textIncludes/.test(hint)), true);
  assert.ok(fs.existsSync(result.artifacts[0].path));
  const saved = JSON.parse(fs.readFileSync(result.artifacts[0].path, 'utf8'));
  assert.deepEqual(saved, snapshot);
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
