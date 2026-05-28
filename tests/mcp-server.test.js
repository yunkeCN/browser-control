'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { COMMANDS, PROTOCOL_VERSION, RUNTIME_SCHEMA_VERSION, DAEMON_CAPABILITIES } = require('../skills/browser-control/scripts/protocol');
const rootPkg = require('../package.json');

const root = path.resolve(__dirname, '..');
const mcpServer = path.join(root, 'bin', 'browser-control-mcp.mjs');
const skillMcpServer = path.join(root, 'skills', 'browser-control', 'scripts', 'browser-control-mcp.mjs');

/**
 * Expected tool names: 15 command tools + browser_status + browser_doctor = 17 total.
 * Each command from TOOL_DEFS is registered as `browser_<command>`.
 */
const EXPECTED_TOOL_NAMES = [
  'browser_capture',
  'browser_click',
  'browser_close_session',
  'browser_doctor',
  'browser_download',
  'browser_evaluate',
  'browser_fill',
  'browser_get_text',
  'browser_navigate',
  'browser_network',
  'browser_press',
  'browser_scroll',
  'browser_snapshot',
  'browser_status',
  'browser_tabs',
  'browser_upload',
  'browser_wait_for',
].sort();

function createFakeDaemon(handler = {}) {
  const requests = [];
  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && (req.url === '/status' || req.url === '/health')) {
      const body = handler.status || {
        running: true,
        status: 'ok',
        version: rootPkg.version,
        port: server.address().port,
        extension_connected: false,
        runtimeSchemaVersion: RUNTIME_SCHEMA_VERSION,
        protocolVersion: PROTOCOL_VERSION,
        capabilities: DAEMON_CAPABILITIES,
        runtime: {
          daemon: {
            layer: 'daemon',
            version: rootPkg.version,
            protocolVersion: PROTOCOL_VERSION,
            runtimeSchemaVersion: RUNTIME_SCHEMA_VERSION,
            capabilities: DAEMON_CAPABILITIES
          }
        }
      };
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
      return;
    }
    if (req.method === 'POST' && req.url === '/command') {
      let text = '';
      req.on('data', chunk => { text += chunk; });
      req.on('end', () => {
        const envelope = JSON.parse(text);
        requests.push(envelope);

        // Build response based on command type
        const responseData = buildFakeResponse(envelope, handler);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(responseData));
      });
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end('{}');
  });
  return {
    server,
    requests,
    listen: () => new Promise(resolve => server.listen(0, '127.0.0.1', resolve)),
    close: () => new Promise(resolve => server.close(resolve))
  };
}

/**
 * Build a fake daemon response envelope.
 * Controllers call daemon.command() which returns { status, data }.
 * The data is the full daemon response body.
 * Each controller's execute() returns response.data, then toResult() processes it.
 */
function buildFakeResponse(envelope, handler = {}) {
  if (handler.commandResponse) return handler.commandResponse(envelope);

  // Default: return a standard daemon envelope with ok=true
  // Each controller expects specific fields in data; provide minimal defaults.
  const commandDataMap = {
    snapshot: {
      title: 'Test Page',
      url: 'https://example.com',
      snapshot: '- button "Submit" [ref=e1]',
      refs: ['e1'],
      stats: { emitted: 1 }
    },
    navigate: {
      url: envelope.args.url || 'https://example.com',
      title: 'Test Page',
      tabId: 1
    },
    tabs: {
      tabs: [{ tabId: 1, url: 'https://example.com', title: 'Test', active: true }]
    },
    click: { clicked: true },
    fill: { filled: true },
    press: { pressed: true },
    scroll: { scrolled: true },
    wait_for: { matched: true },
    capture: { filePath: '/tmp/capture.png', format: 'png' },
    evaluate: { result: 'evaluated' },
    network: { requests: [] },
    upload: { uploaded: true },
    download: { filePath: '/tmp/downloaded.txt' },
    get_text: { text: 'page text', scope: 'viewport' },
    close_session: { closed: true, activeSession: envelope.session }
  };

  return {
    id: envelope.id,
    ok: true,
    command: envelope.command,
    backend: 'extension',
    session: envelope.session,
    tab: null,
    startedAt: '2026-05-25T00:00:00.000Z',
    endedAt: '2026-05-25T00:00:00.000Z',
    durationMs: 0,
    data: commandDataMap[envelope.command] || {},
    artifacts: [],
    error: null,
    diagnostics: null
  };
}

async function withMcpClient(t, env = {}, options = {}) {
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [options.server || mcpServer],
    cwd: options.cwd || root,
    stderr: 'pipe',
    env: {
      ...process.env,
      ...env
    }
  });
  const stderr = [];
  transport.stderr?.on('data', chunk => { stderr.push(String(chunk)); });
  const client = new Client({ name: 'browser-control-mcp-test', version: '1.0.0' });
  await client.connect(transport);
  t.after(async () => {
    await client.close();
  });
  return { client, stderr };
}

function freePort() {
  const server = http.createServer();
  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}

async function stopDaemonFromHome(home) {
  const pidFile = path.join(home, 'daemon.pid');
  if (!fs.existsSync(pidFile)) return;
  const pid = Number(fs.readFileSync(pidFile, 'utf8').trim());
  if (!Number.isInteger(pid) || pid <= 0) return;
  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    return;
  }
  for (let attempts = 0; attempts < 20; attempts += 1) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  try {
    process.kill(pid, 'SIGKILL');
  } catch {}
}

// ─── Tests ──────────────────────────────────────────────────────────

test('mcp server registers 17 independent browser_* tools plus prompts', async (t) => {
  const { client } = await withMcpClient(t);
  const listed = await client.listTools();
  const toolNames = listed.tools.map(tool => tool.name).sort();
  assert.deepEqual(toolNames, EXPECTED_TOOL_NAMES);
  assert.equal(toolNames.length, 17);

  // Every tool is prefixed browser_
  for (const name of toolNames) {
    assert.ok(name.startsWith('browser_'), `tool ${name} should start with browser_`);
  }

  // Spot-check: browser_snapshot has typed inputSchema with viewportOnly
  const snapshot = listed.tools.find(tool => tool.name === 'browser_snapshot');
  assert.ok(snapshot.description.includes('accessibility tree'));
  assert.ok(Object.hasOwn(snapshot.inputSchema.properties || {}, 'viewportOnly'));

  // Spot-check: browser_navigate has url in required
  const navigate = listed.tools.find(tool => tool.name === 'browser_navigate');
  assert.ok(navigate.inputSchema.required.includes('url'));

  // Spot-check: browser_close_session exists
  const close = listed.tools.find(tool => tool.name === 'browser_close_session');
  assert.ok(close.description.includes('Close'));

  // Spot-check: browser_status is read-only
  const status = listed.tools.find(tool => tool.name === 'browser_status');
  assert.ok(status.description.includes('status'));

  // Prompts still registered
  const prompts = await client.listPrompts();
  const promptNames = prompts.prompts.map(prompt => prompt.name).sort();
  assert.deepEqual(promptNames, ['browser_control_command_reference', 'browser_control_safety', 'browser_control_usage']);
  const reference = await client.getPrompt({ name: 'browser_control_command_reference' });
  assert.match(reference.messages[0].content.text, /navigate/);
});

test('mcp tools forward commands to daemon via controller layer', async (t) => {
  const fake = createFakeDaemon();
  await fake.listen();
  t.after(() => fake.close());
  const port = fake.server.address().port;
  const { client } = await withMcpClient(t, { BROWSER_CONTROL_PORT: String(port) });

  // Call browser_snapshot with typed args
  const result = await client.callTool({
    name: 'browser_snapshot',
    arguments: {
      viewportOnly: true,
      roles: ['button']
    }
  });

  assert.equal(fake.requests.length, 1);
  assert.equal(fake.requests[0].version, PROTOCOL_VERSION);
  assert.match(fake.requests[0].session, /^mcp-/);
  assert.equal(fake.requests[0].command, 'snapshot');
  assert.equal(fake.requests[0].args.viewportOnly, true);
  assert.deepEqual(fake.requests[0].args.roles, ['button']);
  assert.equal(result.structuredContent.ok, true);

  // Call browser_navigate
  const navResult = await client.callTool({
    name: 'browser_navigate',
    arguments: { url: 'https://example.com' }
  });
  assert.equal(fake.requests.length, 2);
  assert.equal(fake.requests[1].command, 'navigate');
  assert.equal(fake.requests[1].args.url, 'https://example.com');
  assert.equal(navResult.structuredContent.ok, true);

  const clickResult = await client.callTool({
    name: 'browser_click',
    arguments: { target: '@eabc_1' }
  });
  assert.equal(fake.requests.length, 3);
  assert.equal(fake.requests[2].command, 'click');
  assert.equal(fake.requests[2].session, fake.requests[1].session);
  assert.equal(clickResult.structuredContent.ok, true);
});

test('mcp session management: consecutive calls share the same active session', async (t) => {
  const fake = createFakeDaemon();
  await fake.listen();
  t.after(() => fake.close());
  const { client } = await withMcpClient(t, { BROWSER_CONTROL_PORT: String(fake.server.address().port) });

  // First call — establishes active session
  await client.callTool({
    name: 'browser_snapshot',
    arguments: {}
  });
  const firstSession = fake.requests[0].session;
  assert.match(firstSession, /^mcp-/);

  // Second call — should reuse the same session
  await client.callTool({
    name: 'browser_get_text',
    arguments: {}
  });
  assert.equal(fake.requests[1].session, firstSession);

  // Explicit session — overrides and becomes the new active session
  await client.callTool({
    name: 'browser_snapshot',
    arguments: { session: 'explicit-session' }
  });
  assert.equal(fake.requests[2].session, 'explicit-session');

  // Next implicit call uses the last-set session (explicit-session)
  await client.callTool({
    name: 'browser_snapshot',
    arguments: {}
  });
  assert.equal(fake.requests[3].session, 'explicit-session');
});

test('mcp timeoutMs forwarded to daemon envelope', async (t) => {
  const fake = createFakeDaemon();
  await fake.listen();
  t.after(() => fake.close());
  const { client } = await withMcpClient(t, { BROWSER_CONTROL_PORT: String(fake.server.address().port) });

  await client.callTool({
    name: 'browser_wait_for',
    arguments: { text: 'Ready', timeoutMs: 9000 }
  });
  assert.equal(fake.requests[0].timeoutMs, 9000);

  // Default timeout is 30000
  await client.callTool({
    name: 'browser_snapshot',
    arguments: {}
  });
  assert.equal(fake.requests[1].timeoutMs, 30000);
});

test('mcp close_session rotates active session', async (t) => {
  const fake = createFakeDaemon();
  await fake.listen();
  t.after(() => fake.close());
  const { client } = await withMcpClient(t, { BROWSER_CONTROL_PORT: String(fake.server.address().port) });

  // Establish a session
  const first = await client.callTool({
    name: 'browser_snapshot',
    arguments: {}
  });
  const firstSession = fake.requests[0].session;

  // Close the session
  const closed = await client.callTool({ name: 'browser_close_session', arguments: {} });
  assert.equal(closed.structuredContent.ok, true);
  assert.ok(closed.structuredContent.activeSession);
  assert.notEqual(closed.structuredContent.activeSession, firstSession);

  // Next call uses the rotated session
  await client.callTool({
    name: 'browser_snapshot',
    arguments: {}
  });
  const nextSession = fake.requests.at(-1).session;
  assert.equal(nextSession, closed.structuredContent.activeSession);
});

test('mcp Zod schema validation returns isError for invalid arguments', async (t) => {
  const fake = createFakeDaemon();
  await fake.listen();
  t.after(() => fake.close());
  const { client } = await withMcpClient(t, { BROWSER_CONTROL_PORT: String(fake.server.address().port) });

  // browser_click without target or text — Zod schema allows both optional,
  // but the controller validation should catch it.
  // Actually, Zod schema has target and text both optional, so it passes Zod.
  // Let's test with browser_fill missing required 'target' and 'value'
  const missingRequired = await client.callTool({
    name: 'browser_fill',
    arguments: {}
  });
  assert.equal(missingRequired.isError, true);

  // browser_navigate with empty url (min(1) fails)
  const emptyUrl = await client.callTool({
    name: 'browser_navigate',
    arguments: { url: '' }
  });
  assert.equal(emptyUrl.isError, true);

  // browser_fill with wrong field name ('text' instead of 'value') — strict schema rejects unknown keys
  const wrongField = await client.callTool({
    name: 'browser_fill',
    arguments: { target: '@eabc_1', text: 'wrong' }
  });
  assert.equal(wrongField.isError, true);

  // No requests should have been forwarded to the daemon
  assert.equal(fake.requests.length, 0);
});

test('mcp status reports compatible daemon', async (t) => {
  const fake = createFakeDaemon();
  await fake.listen();
  t.after(() => fake.close());
  const { client } = await withMcpClient(t, { BROWSER_CONTROL_PORT: String(fake.server.address().port) });

  const result = await client.callTool({ name: 'browser_status', arguments: {} });
  assert.equal(result.structuredContent.ok, true);
  assert.equal(result.structuredContent.action, 'reused');
  assert.equal(result.structuredContent.compatible, true);
  assert.match(result.structuredContent.activeSession, /^mcp-/);
  assert.match(JSON.stringify(result.structuredContent.warnings), /extension is not connected/i);
});

test('mcp doctor returns lifecycle and health info', async (t) => {
  const fake = createFakeDaemon();
  await fake.listen();
  t.after(() => fake.close());
  const { client } = await withMcpClient(t, { BROWSER_CONTROL_PORT: String(fake.server.address().port) });

  const result = await client.callTool({ name: 'browser_doctor', arguments: {} });
  assert.equal(result.structuredContent.lifecycle.ok, true);
  assert.equal(result.structuredContent.lifecycle.compatible, true);
  assert.match(result.structuredContent.activeSession, /^mcp-/);
  // health is fetched from /health endpoint
  assert.ok(result.structuredContent.health);
});

test('mcp status fails safely for non Browser Control service on port', async (t) => {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ status: 'different-service' }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));

  const { client } = await withMcpClient(t, { BROWSER_CONTROL_PORT: String(server.address().port) });
  const result = await client.callTool({ name: 'browser_status', arguments: {} });
  assert.equal(result.isError, true);
  assert.match(JSON.stringify(result.structuredContent.errors), /does not look like Browser Control/);
});

test('copied mcp helper runs with bundled protocol and daemon module runtime', async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-control-mcp-copy-'));
  const copiedServer = path.join(tmp, 'browser-control-mcp.mjs');
  const home = path.join(tmp, 'home');
  fs.copyFileSync(mcpServer, copiedServer);
  fs.chmodSync(copiedServer, 0o755);
  const port = await freePort();
  const { client } = await withMcpClient(t, {
    BROWSER_CONTROL_PORT: String(port),
    BROWSER_CONTROL_HOME: home
  }, { server: copiedServer, cwd: tmp });
  t.after(async () => {
    await stopDaemonFromHome(home);
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  const listed = await client.listTools();
  const toolNames = listed.tools.map(tool => tool.name).sort();
  assert.deepEqual(toolNames, EXPECTED_TOOL_NAMES);

  const result = await client.callTool({ name: 'browser_status', arguments: {} });
  assert.equal(result.structuredContent.ok, true);
  assert.equal(result.structuredContent.compatible, true);
  assert.ok(['started', 'reused'].includes(result.structuredContent.action));
  assert.equal(result.structuredContent.status.version, rootPkg.version);
  assert.equal(fs.existsSync(path.join(home, 'mcp-runtime')), false);
});

test('skill-packaged mcp helper runs with bundled protocol and daemon module runtime', async (t) => {
  assert.equal(fs.existsSync(skillMcpServer), true);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-control-mcp-skill-home-'));
  const port = await freePort();
  const { client } = await withMcpClient(t, {
    BROWSER_CONTROL_PORT: String(port),
    BROWSER_CONTROL_HOME: home
  }, { server: skillMcpServer, cwd: path.dirname(skillMcpServer) });
  t.after(async () => {
    await stopDaemonFromHome(home);
    fs.rmSync(home, { recursive: true, force: true });
  });

  const listed = await client.listTools();
  const toolNames = listed.tools.map(tool => tool.name).sort();
  assert.deepEqual(toolNames, EXPECTED_TOOL_NAMES);

  const result = await client.callTool({ name: 'browser_status', arguments: {} });
  assert.equal(result.structuredContent.ok, true);
  assert.equal(result.structuredContent.compatible, true);
  assert.ok(['started', 'reused'].includes(result.structuredContent.action));
  assert.equal(result.structuredContent.status.version, rootPkg.version);
});

test('root mcp docs describe skill-packaged runtime without adding skill docs', () => {
  const docs = fs.readFileSync(path.join(root, 'docs', 'mcp.md'), 'utf8');
  assert.match(docs, /"mcpServers"/);
  assert.match(docs, /browser-control-mcp/);
  assert.match(docs, /bin\/browser-control-mcp\.mjs/);
  assert.match(docs, /skills\/browser-control\/scripts\/browser-control-mcp\.mjs/);
  assert.match(docs, /self-contained/i);
  assert.match(docs, /stdio MCP server/i);
  assert.match(docs, /installed Skill package/i);
  assert.match(docs, /does not ask the user for confirmation/i);

  assert.equal(fs.existsSync(path.join(root, 'skills', 'browser-control', 'references', 'mcp.md')), false);
  assert.equal(fs.existsSync(path.join(root, 'skills', 'browser-control', 'scripts', 'mcp-server.mjs')), false);
});
