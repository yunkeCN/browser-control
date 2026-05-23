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
const port = 11088;

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

test('fixture E2E: daemon validates commands and dispatches through extension WebSocket backend', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-control-home-'));
  const daemon = spawn(process.execPath, [daemonScript], { cwd: path.join(root, 'skills', 'browser-control', 'scripts'), stdio: ['ignore', 'ignore', 'pipe'], env: { ...process.env, BROWSER_CONTROL_HOME: home, BROWSER_CONTROL_PORT: String(port), BROWSER_CONTROL_ARTIFACT_DIR: path.join(home, 'artifacts') } });
  t.after(async () => {
    daemon.kill('SIGTERM');
    await new Promise(resolve => daemon.once('exit', resolve));
  });
  await waitForHealth();

  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  t.after(() => ws.close());
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  ws.send(JSON.stringify({
    type: 'hello',
    data: {
      layer: 'extension',
      version: 'fixture-extension',
      protocolVersion: '2026-05-19',
      build: { channel: 'source' },
      capabilities: ['navigateFinalMetadata', 'observe_start', 'observe_diff', 'network']
    }
  }));
  await new Promise(resolve => setTimeout(resolve, 25));
  const status = await request('GET', '/status');
  assert.equal(status.json.runtime.extension.version, 'fixture-extension');
  assert.ok(status.json.runtime.extension.capabilities.includes('navigateFinalMetadata'));

  ws.on('message', raw => {
    const msg = JSON.parse(raw.toString());
    if (msg.type !== 'command') return;
    const base = { session: msg.session, tabId: 101 };
    const dataByAction = {
      navigate: { ...base, url: msg.args.url, title: 'Fixture', navigationComplete: true, warnings: [] },
      snapshot: { ...base, totalElements: 2, elements: [{ id: '@e1', tag: 'input', attributes: { type: 'text' } }] },
      select_option: { ...base, selected: true, value: [msg.args.value] },
      set_checked: { ...base, checked: msg.args.checked },
      press: { ...base, pressed: true, key: msg.args.key },
      scroll: { ...base, ok: true, target: 'document', strategyUsed: msg.args.strategy || 'dom', before: { scrollX: 0, scrollY: 0, scrollWidth: 800, scrollHeight: 2000, clientWidth: 800, clientHeight: 600 }, after: { scrollX: 0, scrollY: msg.args.deltaY || 0, scrollWidth: 800, scrollHeight: 2000, clientWidth: 800, clientHeight: 600 }, movedX: 0, movedY: msg.args.deltaY || 0, atBoundary: false },
      wait_for: { ...base, waited: true },
      screenshot: { ...base, format: 'png', data: Buffer.from('fake-png').toString('base64'), dataLength: 12 },
      save_as_pdf: { ...base, format: 'pdf', data: Buffer.from('fake-pdf').toString('base64'), dataLength: 12 },
      get_text: { ...base, text: 'Fixture text', truncated: false, caps: { maxChars: 12000 }, url: 'http://fixture.local', title: 'Fixture' },
      find_tab: { session: msg.session, tab: { id: 101, title: 'Fixture', url: 'http://fixture.local' }, tabs: [{ id: 101, title: 'Fixture' }] },
      list_tabs: { session: msg.session, tabs: [{ id: 101, title: 'Fixture' }] },
      close_session: { closed: msg.session, tabCount: 1 }
    };
    ws.send(JSON.stringify({ type: 'response', requestId: msg.requestId, data: dataByAction[msg.action] || { ...base, action: msg.action } }));
  });

  const navigate = await request('POST', '/command', { command: 'navigate', args: { url: 'http://fixture.local' }, session: 'fixture' });
  assert.equal(navigate.status, 200);
  assert.equal(navigate.json.ok, true);
  assert.equal(navigate.json.command, 'navigate');
  assert.equal(navigate.json.backend, 'extension');
  assert.equal(navigate.json.data.url, 'http://fixture.local');
  assert.notEqual(navigate.json.data.url, 'about:blank');
  assert.equal(navigate.json.data.navigationComplete, true);
  assert.deepEqual(navigate.json.data.warnings, []);

  const invalid = await request('POST', '/command', { command: 'navigate', args: {}, session: 'fixture' });
  assert.equal(invalid.status, 400);
  assert.equal(invalid.json.ok, false);
  assert.equal(invalid.json.error.code, 'VALIDATION_ERROR');

  for (const [command, args] of [
    ['snapshot', {}],
    ['select_option', { selector: '#role', value: 'admin' }],
    ['set_checked', { selector: '#active', checked: true }],
    ['press', { key: 'Enter' }],
    ['scroll', { strategy: 'dom', deltaY: 600 }],
    ['wait_for', { selector: '#done' }],
    ['wait_for', { text: 'Done' }],
    ['get_text', { maxChars: 1000 }],
    ['find_tab', { urlIncludes: 'fixture.local' }],
    ['list_tabs', {}]
  ]) {
    const res = await request('POST', '/command', { command, args, session: 'fixture' });
    assert.equal(res.status, 200, command);
    assert.equal(res.json.ok, true, command);
    assert.equal(res.json.command, command);
  }

  const screenshot = await request('POST', '/command', { command: 'screenshot', args: { format: 'png' }, session: 'fixture' });
  assert.equal(screenshot.json.ok, true);
  assert.equal(screenshot.json.data.data, undefined);
  assert.equal(screenshot.json.artifacts[0].kind, 'screenshot');

  const pdf = await request('POST', '/command', { command: 'save_as_pdf', args: {}, session: 'fixture' });
  assert.equal(pdf.json.ok, true);
  assert.equal(pdf.json.data.data, undefined);
  assert.equal(pdf.json.artifacts[0].kind, 'pdf');
  console.log('fixture e2e ok');
});
