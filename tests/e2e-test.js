#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const path = require('node:path');

let pass = 0;
let fail = 0;
let skipCount = 0;

const daemonUrl = process.env.BROWSER_CONTROL_DAEMON_URL || 'http://127.0.0.1:10087';
const session = `test-${Date.now()}`;
const repoRoot = path.resolve(__dirname, '..');
const extensionPath = path.join(repoRoot, 'skills', 'browser-control', 'extension');

const color = {
  green: text => process.stdout.isTTY ? `\x1b[0;32m${text}\x1b[0m` : text,
  red: text => process.stdout.isTTY ? `\x1b[0;31m${text}\x1b[0m` : text,
  yellow: text => process.stdout.isTTY ? `\x1b[0;33m${text}\x1b[0m` : text
};

function info(message) {
  console.log(`[TEST] ${message}`);
}

function check(desc, expected, actual) {
  if (actual === expected) {
    console.log(color.green(`  PASS: ${desc}`));
    pass += 1;
  } else {
    console.log(color.red(`  FAIL: ${desc} (expected: ${expected}, got: ${actual})`));
    fail += 1;
  }
}

function checkTrue(desc, actual) {
  check(desc, true, Boolean(actual));
}

function skip(message) {
  console.log(color.yellow(`  SKIP: ${message}`));
  skipCount += 1;
}

function fixtureHtml() {
  return `<!doctype html>
<html>
<head><title>Browser Control Live Fixture</title></head>
<body>
  <h1>Browser Control Live Fixture</h1>
  <form id="fixture-form">
    <input id="email" type="email" placeholder="Enter email">
    <select id="role"><option value="user">User</option><option value="admin">Admin</option></select>
    <label><input id="active" type="checkbox"> Active</label>
    <button id="submit" type="button">Submit</button>
    <button id="probe" type="button">Probe Create</button>
  </form>
  <pre id="state">not-submitted</pre>
  <a id="download" href="/download.txt" download="browser-control-live-download.txt">Download</a>
  <script>
    setTimeout(() => {
      const dynamic = document.createElement('button');
      dynamic.id = 'dynamic';
      dynamic.textContent = 'Dynamic Ready';
      document.body.appendChild(dynamic);
    }, 150);
    document.getElementById('submit').addEventListener('click', async () => {
      const payload = await fetch('/api.json').then(r => r.json());
      document.getElementById('state').textContent = JSON.stringify({
        email: document.getElementById('email').value,
        role: document.getElementById('role').value,
        active: document.getElementById('active').checked,
        api: payload.ok
      });
    });
    document.getElementById('probe').addEventListener('click', async () => {
      try {
        await fetch('/probe-write', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer should-redact' },
          body: JSON.stringify({ name: 'probe draft', token: 'should-redact' })
        });
      } catch (err) {
        document.getElementById('state').textContent = 'probe-blocked';
      }
    });
  </script>
</body>
</html>`;
}

function createLiveFixtureServer() {
  return http.createServer((req, res) => {
    if (req.url === '/api.json') {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ ok: true, source: 'live-fixture' }));
      return;
    }
    if (req.url === '/download.txt') {
      res.setHeader('content-disposition', 'attachment; filename="browser-control-live-download.txt"');
      res.end('browser-control live download\n');
      return;
    }
    if (req.url === '/probe-write') {
      res.writeHead(201, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    res.setHeader('content-type', 'text/html');
    res.end(fixtureHtml());
  });
}

function findFreePort() {
  if (process.env.BROWSER_CONTROL_FIXTURE_PORT) return Promise.resolve(Number(process.env.BROWSER_CONTROL_FIXTURE_PORT));
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}

async function readJson(response) {
  const text = await response.text();
  try { return text ? JSON.parse(text) : null; } catch { return { raw: text }; }
}

async function apiCall(command, args = {}) {
  const response = await fetch(new URL('/command', daemonUrl), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ command, args, session })
  });
  return readJson(response);
}

function firstElementId(snapshot, predicate) {
  const refs = snapshot?.data?.refs || [];
  const match = refs.find(predicate);
  return match?.ref || match?.id || '';
}

function visibleText(element) {
  return element?.text || element?.name || '';
}

async function main() {
  info('Test 1: Daemon health check');
  let health;
  try {
    const response = await fetch(new URL('/health', daemonUrl));
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    health = await response.json();
  } catch (err) {
    console.log(color.red(`Daemon not running at ${daemonUrl}.`));
    console.log(color.red(`Start it with: cd ${repoRoot} && node skills/browser-control/scripts/browser-control.js start`));
    process.exit(1);
  }
  check('daemon running', true, health.running === true);

  info('Test 2: Extension connection');
  const extensionConnected = health.extensionConnected === true || health.extension_connected === true;
  if (!extensionConnected) {
    console.log(color.red('Extension not connected. Load the extension in Chrome, then rerun this command.'));
    console.log(color.red('Chrome handoff:'));
    console.log(color.red('  1. Open chrome://extensions'));
    console.log(color.red('  2. Enable Developer mode'));
    console.log(color.red(`  3. Load unpacked: ${extensionPath}`));
    console.log(color.red(`  4. Confirm ${daemonUrl}/health reports extensionConnected=true`));
    process.exit(2);
  }
  check('extension connected', true, extensionConnected);

  const fixturePort = await findFreePort();
  const fixtureUrl = `http://127.0.0.1:${fixturePort}`;
  const fixtureServer = createLiveFixtureServer();
  await new Promise(resolve => fixtureServer.listen(fixturePort, '127.0.0.1', resolve));
  try {
    info('Test 3: Navigate to local fixture page');
    const nav = await apiCall('navigate', { url: `${fixtureUrl}/index.html`, newTab: true });
    check('navigate ok', true, nav?.ok === true);
    info(`  Tab ID: ${nav?.data?.tabId || ''}`);

    info('Test 4: Take accessibility snapshot');
    const snapshot = await apiCall('snapshot', {});
    check('snapshot ok', true, snapshot?.ok === true);
    info(`  Refs found: ${snapshot?.data?.refs?.length || snapshot?.data?.stats?.returned || 0}`);

    const inputRef = firstElementId(snapshot, element => element.tag === 'input' && element.attributes?.type === 'email');
    const buttonRef = firstElementId(snapshot, element => element.tag === 'button' && visibleText(element).includes('Submit'));
    const probeRef = firstElementId(snapshot, element => element.tag === 'button' && visibleText(element).includes('Probe Create'));
    info(`  Input @ref: ${inputRef}`);
    info(`  Button @ref: ${buttonRef}`);
    info(`  Probe @ref: ${probeRef}`);
    if (inputRef) check('input element found', inputRef, inputRef);
    else { console.log(color.red('  FAIL: Could not find input element.')); fail += 1; }

    if (inputRef) {
      info('Test 5: Fill in the email input');
      const fill = await apiCall('fill', { selector: inputRef, value: 'test@agentbrowser.dev' });
      check('fill ok', true, fill?.ok === true);
      info(`  Fill mode: ${fill?.data?.mode || 'unknown'}`);
    }

    if (probeRef) {
      info('Test 5b: Probe click captures and blocks API request');
      const probe = await apiCall('click_probe', { selector: probeRef, filter: '/probe-write', waitMs: 500 });
      check('click_probe ok', true, probe?.ok === true);
      check('click_probe intercepted one request', 1, probe?.data?.probe?.interceptedCount || 0);
      check('click_probe method', 'POST', probe?.data?.probe?.requests?.[0]?.method || '');
      const headers = probe?.data?.probe?.requests?.[0]?.requestHeaders || {};
      check('click_probe redacts authorization', '[REDACTED]', headers.Authorization || headers.authorization || '');
      check('click_probe redacts body token', '[REDACTED]', probe?.data?.probe?.requests?.[0]?.requestBody?.token || '');
    }

    info('Test 6: Interact with form controls');
    check('checkbox click ok', true, (await apiCall('click', { selector: '#active' }))?.ok === true);
    check('wait_for ok', true, (await apiCall('wait_for', { selector: '#dynamic', timeoutMs: 5000 }))?.ok === true);
    check('press ok', true, (await apiCall('press', { selector: '#email', key: 'Enter' }))?.ok === true);

    if (buttonRef) {
      info('Test 7: Click the submit button and trigger fixture API request');
      check('network_start ok', true, (await apiCall('network_start', { filter: `${fixtureUrl}/api.json` }))?.ok === true);
      check('click ok', true, (await apiCall('click', { selector: buttonRef }))?.ok === true);
      await new Promise(resolve => setTimeout(resolve, 1000));
    } else {
      console.log(color.red('  FAIL: submit button element missing'));
      fail += 1;
    }

    info('Test 8: Evaluate JavaScript in page');
    const code = 'return fetch("/api.json").then(r => r.json()).then(api => { const state = { title: document.title, email: document.getElementById("email").value, role: document.getElementById("role").value, active: document.getElementById("active").checked, api: api.ok }; document.getElementById("state").textContent = JSON.stringify(state); return state; });';
    const evaluated = await apiCall('evaluate', { code });
    check('evaluate ok', true, evaluated?.ok === true);
    checkTrue('evaluated fixture state includes API result', evaluated?.data?.result?.api);

    info('Test 9: Take screenshot and verify artifact metadata');
    const screenshot = await apiCall('screenshot', { format: 'png' });
    check('screenshot ok', true, screenshot?.ok === true);
    check('screenshot raw base64 stripped', undefined, screenshot?.data?.data);
    check('screenshot artifact kind', 'screenshot', screenshot?.artifacts?.[0]?.kind || '');
    const screenshotPath = screenshot?.artifacts?.[0]?.path || '';
    if (screenshotPath && fs.existsSync(screenshotPath)) checkTrue('screenshot artifact file exists', true);
    else { console.log(color.red(`  FAIL: screenshot artifact file missing: ${screenshotPath}`)); fail += 1; }

    info('Test 10: Save PDF and verify artifact metadata when available');
    const pdf = await apiCall('save_as_pdf', { file_name: 'browser-control-live.pdf' });
    if (pdf?.ok === true) {
      check('pdf raw base64 stripped', undefined, pdf?.data?.data);
      check('pdf artifact kind', 'pdf', pdf?.artifacts?.[0]?.kind || '');
      const pdfPath = pdf?.artifacts?.[0]?.path || '';
      if (pdfPath && fs.existsSync(pdfPath)) checkTrue('pdf artifact file exists', true);
      else { console.log(color.red(`  FAIL: pdf artifact file missing: ${pdfPath}`)); fail += 1; }
    } else {
      skip(`PDF generation unavailable in this Chrome/permission state: ${pdf?.error?.message || pdf?.error || 'unknown'}`);
    }

    info('Test 11: Network capture list/detail');
    const networkList = await apiCall('network_list', { filter: `${fixtureUrl}/api.json` });
    check('network_list ok', true, networkList?.ok === true);
    const requestId = networkList?.data?.requests?.[0]?.id || '';
    if (requestId) {
      const networkDetail = await apiCall('network_detail', { requestId });
      check('network_detail ok', true, networkDetail?.ok === true);
      check('network_detail preserves request id', requestId, networkDetail?.data?.id || networkDetail?.data?.requestId || '');
    } else {
      console.log(color.red('  FAIL: network request id missing'));
      fail += 1;
    }
    check('network_stop ok', true, (await apiCall('network_stop', {}))?.ok === true);

    info('Test 12: Download fixture artifact');
    if (process.env.BROWSER_CONTROL_LIVE_TEST_DOWNLOAD === '1') {
      const download = await apiCall('download', { url: `${fixtureUrl}/download.txt`, filename: 'browser-control-live-download.txt' });
      if (download?.ok === true) {
        const kind = download?.artifacts?.[0]?.kind || download?.data?.artifacts?.[0]?.kind || '';
        if (kind === 'download') check('download artifact kind', 'download', kind);
        else skip(`download completed without local artifact path in this Chrome state (state=${download?.data?.state || ''})`);
      } else {
        skip(`download unavailable in this Chrome/permission state: ${download?.error?.message || download?.error || 'unknown'}`);
      }
    } else {
      skip('download test disabled by default to avoid Chrome save dialogs; set BROWSER_CONTROL_LIVE_TEST_DOWNLOAD=1 to enable');
    }

    info('Test 13: Multi-tab session metadata');
    check('second tab navigate ok', true, (await apiCall('navigate', { url: `${fixtureUrl}/index.html?tab=2`, newTab: true }))?.ok === true);
    const tabs = await apiCall('list_tabs', {});
    check('list_tabs ok', true, tabs?.ok === true);
    const tabCount = tabs?.data?.tabs?.length || 0;
    if (tabCount >= 2) checkTrue('session has multiple tabs', true);
    else { console.log(color.red(`  FAIL: expected at least 2 session tabs, got ${tabCount}`)); fail += 1; }
    info(`  Tabs in session: ${tabCount}`);

    info('Test 14: Close session');
    check('close_session ok', true, (await apiCall('close_session', {}))?.ok === true);
  } finally {
    await new Promise(resolve => fixtureServer.close(resolve));
  }

  console.log('');
  console.log('==========================');
  console.log(' Test Results');
  console.log('==========================');
  console.log(` Passed: ${color.green(String(pass))}`);
  console.log(` Failed: ${color.red(String(fail))}`);
  console.log(` Skipped: ${color.yellow(String(skipCount))}`);
  console.log(` Total:  ${pass + fail + skipCount}`);
  console.log('');

  if (fail === 0) {
    console.log(color.green('All tests passed!'));
  } else {
    console.log(color.red(`${fail} test(s) failed.`));
    process.exit(1);
  }
}

main().catch(err => {
  console.error(err.stack || err.message);
  process.exit(1);
});
