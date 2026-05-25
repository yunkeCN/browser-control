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
const port = 11090;

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

test('click after attaches changes and fill expectChange warns on no-delta actions', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-control-action-observe-'));
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
  ws.on('message', raw => {
    const msg = JSON.parse(raw.toString());
    if (msg.type !== 'command') return;
    if (msg.action === 'observe_capture') {
      captureCount += 1;
      const states = [
        observation(['Menu']),
        observation(['Menu', 'Drawer opened']),
        observation(['Menu', 'Drawer opened']),
        observation(['Stable form']),
        observation(['Stable form'])
      ];
      ws.send(JSON.stringify({ type: 'response', requestId: msg.requestId, data: states[captureCount - 1] || states.at(-1) }));
      return;
    }
    if (msg.action === 'snapshot') {
      ws.send(JSON.stringify({ type: 'response', requestId: msg.requestId, data: { schemaVersion: 3, snapshot: '- dialog "Drawer opened" [ref=@e1_1]', refs: [{ id: '@e1_1' }], tabId: 301 } }));
      return;
    }
    if (msg.action === 'click') {
      ws.send(JSON.stringify({ type: 'response', requestId: msg.requestId, data: { clicked: true, strategyUsed: msg.args.strategy || 'auto', tabId: 301 } }));
      return;
    }
    if (msg.action === 'fill') {
      ws.send(JSON.stringify({ type: 'response', requestId: msg.requestId, data: { filled: true, strategyUsed: 'native_setter', tabId: 301 } }));
      return;
    }
    ws.send(JSON.stringify({ type: 'response', requestId: msg.requestId, data: { session: msg.session, tabId: 301 } }));
  });

  const changed = await request('POST', '/command', {
    command: 'click',
    args: { target: '@e1abc_1' },
    session: 'action-observe'
  });
  assert.equal(changed.status, 200);
  assert.equal(changed.json.ok, true);
  assert.deepEqual(changed.json.data.changes.textDiff.addedText, ['Drawer opened']);
  assert.deepEqual(changed.json.data.changes.warnings, []);
  assert.equal(changed.json.data.after, 'auto');
  assert.match(changed.json.data.postSnapshot.snapshot, /Drawer opened/);
  assert.match(changed.json.diagnostics.warnings.join(' '), /runtime metadata/);

  const noDelta = await request('POST', '/command', {
    command: 'fill',
    args: { target: '@e2abc_1', value: 'draft', expectChange: true, observe: { includeNetwork: false, waitMs: 0 } },
    session: 'action-observe'
  });
  assert.equal(noDelta.status, 200);
  assert.equal(noDelta.json.ok, true);
  assert.match(noDelta.json.data.actionObservation.summary, /No added or removed visible text/);
  assert.match(noDelta.json.data.actionObservation.warnings.join(' '), /expectChange/);

  ws.send(JSON.stringify({
    type: 'hello',
    data: {
      layer: 'extension',
      version: 'legacy-fixture',
      capabilities: ['network']
    }
  }));
  await new Promise(resolve => setTimeout(resolve, 25));
  const unsupported = await request('POST', '/command', {
    command: 'click',
    args: { target: '@e3abc_1' },
    session: 'action-observe'
  });
  assert.equal(unsupported.status, 502);
  assert.equal(unsupported.json.error.code, 'UNSUPPORTED');
  assert.match(unsupported.json.error.message, /click after observation/);
});

function observation(texts) {
  const textRuns = texts.map((text, index) => ({
    id: `a${index + 1}`,
    text,
    normalizedText: text,
    rect: { x: 10, y: 20 + index * 20, width: 120, height: 18 },
    element: `@e${index + 1}`,
    role: 'status',
    selector: 'div.status'
  }));
  return {
    tabId: 301,
    url: 'http://fixture.local/action',
    title: 'Action fixture',
    viewport: { width: 800, height: 600, scrollX: 0, scrollY: 0 },
    visibleText: texts.join('\n'),
    textRuns,
    truncated: false,
    caps: { maxTextChars: 12000, maxTextRuns: 300, textRunCount: textRuns.length, visibleTextChars: texts.join('\n').length }
  };
}

test('action observation warning considers lightweight non-structural deltas', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-control-action-observe-light-'));
  const daemon = spawn(process.execPath, [daemonScript], { cwd: path.join(root, 'skills', 'browser-control', 'scripts'), stdio: ['ignore', 'ignore', 'pipe'], env: { ...process.env, BROWSER_CONTROL_HOME: home, BROWSER_CONTROL_PORT: String(port + 10), BROWSER_CONTROL_ARTIFACT_DIR: path.join(home, 'artifacts') } });
  t.after(async () => {
    daemon.kill('SIGTERM');
    await new Promise(resolve => daemon.once('exit', resolve));
  });
  async function localRequest(method, route, body) {
    return new Promise((resolve, reject) => {
      const payload = body ? JSON.stringify(body) : null;
      const req = http.request({ hostname: '127.0.0.1', port: port + 10, path: route, method, headers: payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {} }, res => {
        let data = '';
        res.on('data', chunk => { data += chunk; });
        res.on('end', () => resolve({ status: res.statusCode, json: data ? JSON.parse(data) : null }));
      });
      req.on('error', reject);
      if (payload) req.write(payload);
      req.end();
    });
  }
  for (let i = 0; i < 40; i++) {
    try { if ((await localRequest('GET', '/health')).json?.running) break; } catch {}
    await new Promise(r => setTimeout(r, 100));
  }
  const ws = new WebSocket(`ws://127.0.0.1:${port + 10}/ws`);
  t.after(() => ws.close());
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  let captureCount = 0;
  ws.on('message', raw => {
    const msg = JSON.parse(raw.toString());
    if (msg.type !== 'command') return;
    if (msg.action === 'observe_capture') {
      captureCount += 1;
      const state = observation(['Stable']);
      state.caps.visibleTextChars = captureCount === 1 ? 6 : 12;
      ws.send(JSON.stringify({ type: 'response', requestId: msg.requestId, data: state }));
      return;
    }
    if (msg.action === 'fill') {
      ws.send(JSON.stringify({ type: 'response', requestId: msg.requestId, data: { filled: true, tabId: 301 } }));
      return;
    }
    ws.send(JSON.stringify({ type: 'response', requestId: msg.requestId, data: { session: msg.session, tabId: 301 } }));
  });
  const changed = await localRequest('POST', '/command', {
    command: 'fill',
    args: { target: '@e1abc_1', value: 'draft', expectChange: true, observe: { includeNetwork: false, waitMs: 0 } },
    session: 'lightweight-delta'
  });
  assert.equal(changed.status, 200);
  assert.deepEqual(changed.json.data.actionObservation.warnings, []);
  assert.equal(changed.json.data.actionObservation.textDiff.visibleTextCharsDelta, 6);
});
