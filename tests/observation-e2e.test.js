'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { WebSocket } = require('ws');

const root = path.resolve(__dirname, '..');
const daemonScript = path.join(root, 'skills', 'browser-control', 'scripts', 'daemon.js');
const port = 11089;

function request(method, route, body) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const req = http.request({ hostname: '127.0.0.1', port, path: route, method, headers: payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {} }, res => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, json: data ? JSON.parse(data) : null }));
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function waitForHealth() {
  for (let i = 0; i < 40; i++) {
    try {
      const res = await request('GET', '/health');
      if (res.json?.running) return res.json;
    } catch {}
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error('daemon did not start');
}

test('observation lifecycle captures baseline, diffs visible text, filters network, and invalidates on navigation', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-control-observe-'));
  const daemon = spawn(process.execPath, [daemonScript], { cwd: path.join(root, 'skills', 'browser-control', 'scripts'), stdio: ['ignore', 'ignore', 'pipe'], env: { ...process.env, BROWSER_CONTROL_HOME: home, BROWSER_CONTROL_PORT: String(port), BROWSER_CONTROL_ARTIFACT_DIR: path.join(home, 'artifacts') } });
  t.after(async () => {
    daemon.kill('SIGTERM');
    await new Promise(resolve => daemon.once('exit', resolve));
  });
  await waitForHealth();

  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  t.after(() => ws.close());
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });

  let captureCount = 0;
  let lastSinceTimestampMs = null;
  ws.on('message', raw => {
    const msg = JSON.parse(raw.toString());
    if (msg.type !== 'command') return;
    if (msg.action === 'observe_capture') {
      captureCount += 1;
      const states = [
        observation(['Submitting'], { truncated: false }),
        observation(['Saved successfully'], { truncated: true }),
        observation(['Before navigation'], { url: 'http://fixture.local/task' })
      ];
      ws.send(JSON.stringify({ type: 'response', requestId: msg.requestId, data: states[captureCount - 1] || states[2] }));
      return;
    }
    if (msg.action === 'network') {
      lastSinceTimestampMs = msg.args.sinceTimestampMs;
      ws.send(JSON.stringify({
        type: 'response',
        requestId: msg.requestId,
        data: {
          requests: [
            { id: 'old', method: 'GET', url: '/api/poll', status: 'complete', statusCode: 200, timestampMs: lastSinceTimestampMs - 10 },
            { id: 'new', method: 'POST', url: '/api/save', status: 'complete', statusCode: 200, timestampMs: lastSinceTimestampMs + 10 }
          ]
        }
      }));
      return;
    }
    if (msg.action === 'navigate') {
      ws.send(JSON.stringify({ type: 'response', requestId: msg.requestId, data: { tabId: 201, session: msg.session, url: msg.args.url, title: 'Navigated' } }));
      return;
    }
    ws.send(JSON.stringify({ type: 'response', requestId: msg.requestId, data: { session: msg.session, tabId: 201 } }));
  });

  const start = await request('POST', '/command', { command: 'observe_start', args: { includeNetworkMarker: true }, session: 'observe' });
  assert.equal(start.status, 200);
  assert.equal(start.json.ok, true);
  assert.equal(start.json.command, 'observe_start');
  assert.equal(start.json.data.summary.textRunCount, 1);
  assert.equal(start.json.data.visibleText, undefined, 'observe_start should not return full baseline text');
  assert.ok(start.json.data.networkMarker.timestampMs);

  const diff = await request('POST', '/command', { command: 'observe_diff', args: { baselineId: start.json.data.baselineId, includeNetwork: true }, session: 'observe' });
  assert.equal(diff.status, 200);
  assert.equal(diff.json.ok, true);
  assert.deepEqual(diff.json.data.textDiff.addedText, ['Saved successfully']);
  assert.deepEqual(diff.json.data.textDiff.removedText, ['Submitting']);
  assert.match(diff.json.data.summary, /Saved successfully/);
  assert.equal(diff.json.data.network.requestCount, 1);
  assert.equal(diff.json.data.network.requests[0].requestId, 'new');
  assert.match(diff.json.data.network.label, /not proof of causation/);
  assert.equal(lastSinceTimestampMs, start.json.data.networkMarker.timestampMs);
  assert.equal(diff.json.artifacts[0].kind, 'observation', 'truncated observations should create local artifacts');
  assert.equal(diff.json.data.current, undefined, 'current observation is omitted unless includeCurrent is true');

  const staleStart = await request('POST', '/command', { command: 'observe_start', args: {}, session: 'observe' });
  assert.equal(staleStart.status, 200);
  const nav = await request('POST', '/command', { command: 'navigate', args: { url: 'http://fixture.local/next' }, session: 'observe' });
  assert.equal(nav.status, 200);
  const staleDiff = await request('POST', '/command', { command: 'observe_diff', args: { baselineId: staleStart.json.data.baselineId }, session: 'observe' });
  assert.equal(staleDiff.json.ok, false);
  assert.equal(staleDiff.json.error.code, 'NOT_FOUND');
  assert.match(staleDiff.json.error.details.nextSteps.join(' '), /observe_start/);
});

function observation(texts, overrides = {}) {
  const textRuns = texts.map((text, index) => ({
    id: `t${index + 1}`,
    text,
    normalizedText: text,
    rect: { x: 10, y: 20 + index * 20, width: 120, height: 18 },
    element: `@e${index + 1}`,
    role: 'status',
    selector: 'div.status'
  }));
  return {
    tabId: 201,
    url: overrides.url || 'http://fixture.local/task',
    title: 'Fixture task',
    viewport: { width: 800, height: 600, scrollX: 0, scrollY: 0 },
    visibleText: texts.join('\n'),
    textRuns,
    truncated: Boolean(overrides.truncated),
    caps: { maxTextChars: 12000, maxTextRuns: 300, textRunCount: textRuns.length, visibleTextChars: texts.join('\n').length }
  };
}
