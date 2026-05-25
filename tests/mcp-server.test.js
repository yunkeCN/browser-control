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
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          id: envelope.id,
          ok: true,
          command: envelope.command,
          backend: 'extension',
          session: envelope.session,
          tab: null,
          startedAt: '2026-05-25T00:00:00.000Z',
          endedAt: '2026-05-25T00:00:00.000Z',
          durationMs: 0,
          data: { echoedArgs: envelope.args },
          artifacts: [],
          error: null,
          diagnostics: null
        }));
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

test('mcp server registers default tools plus prompts', async (t) => {
  const { client } = await withMcpClient(t);
  const listed = await client.listTools();
  const toolNames = listed.tools.map(tool => tool.name).sort();
  assert.deepEqual(toolNames, [
    'browser_control_close_session',
    'browser_control_command',
    'browser_control_doctor',
    'browser_control_status'
  ]);

  const command = listed.tools.find(tool => tool.name === 'browser_control_command');
  assert.ok(command.description.includes('Run any low-level Browser Control protocol command'));
  assert.ok(command.description.includes('Session is managed automatically'));
  assert.ok(command.inputSchema.required.includes('command'));
  assert.ok(Object.hasOwn(command.inputSchema.properties || {}, 'args'));

  const close = listed.tools.find(tool => tool.name === 'browser_control_close_session');
  assert.ok(close.description.includes('preferred cleanup tool'));

  const prompts = await client.listPrompts();
  const promptNames = prompts.prompts.map(prompt => prompt.name).sort();
  assert.deepEqual(promptNames, ['browser_control_command_reference', 'browser_control_safety', 'browser_control_usage']);
  const reference = await client.getPrompt({ name: 'browser_control_command_reference' });
  assert.match(reference.messages[0].content.text, /navigate/);
  assert.match(reference.messages[0].content.text, /get_text/);
  assert.match(reference.messages[0].content.text, /textIncludes/);
});

test('mcp command forwards protocol envelopes and manages sessions', async (t) => {
  const fake = createFakeDaemon();
  await fake.listen();
  t.after(() => fake.close());
  const port = fake.server.address().port;
  const { client } = await withMcpClient(t, { BROWSER_CONTROL_PORT: String(port) });

  const result = await client.callTool({
    name: 'browser_control_command',
    arguments: {
      command: 'snapshot',
      id: 'mcp-id',
      timeoutMs: 1234,
      args: {
        viewportOnly: true,
        roles: ['button']
      }
    }
  });

  assert.equal(fake.requests.length, 1);
  assert.equal(fake.requests[0].id, 'mcp-id');
  assert.equal(fake.requests[0].version, PROTOCOL_VERSION);
  assert.match(fake.requests[0].session, /^mcp-/);
  assert.equal(fake.requests[0].command, 'snapshot');
  assert.equal(fake.requests[0].timeoutMs, 1234);
  assert.deepEqual(fake.requests[0].args, { viewportOnly: true, roles: ['button'] });
  assert.equal(result.structuredContent.ok, true);
  assert.equal(result.structuredContent.command, 'snapshot');
  assert.equal(result.structuredContent.session, fake.requests[0].session);
  assert.equal(result.structuredContent.activeSession, fake.requests[0].session);
  assert.match(result.content[0].text, /"command": "snapshot"/);

  const explicit = await client.callTool({
    name: 'browser_control_command',
    arguments: {
      command: 'list_tabs',
      session: 'explicit-session',
      args: {}
    }
  });
  assert.equal(explicit.structuredContent.session, 'explicit-session');

  const implicit = await client.callTool({
    name: 'browser_control_command',
    arguments: {
      command: 'snapshot',
      args: {}
    }
  });
  assert.equal(implicit.structuredContent.session, 'explicit-session');

  await client.callTool({
    name: 'browser_control_command',
    arguments: {
      command: 'wait_for',
      args: { text: 'Ready', timeoutMs: 2500 },
      timeoutMs: 9000
    }
  });
  assert.equal(fake.requests.at(-1).timeoutMs, 9000);
  assert.deepEqual(fake.requests.at(-1).args, { text: 'Ready', timeoutMs: 2500 });
});

test('mcp command covers every protocol command', async (t) => {
  const fake = createFakeDaemon();
  await fake.listen();
  t.after(() => fake.close());
  const { client } = await withMcpClient(t, { BROWSER_CONTROL_PORT: String(fake.server.address().port) });
  const requiredArgs = {
    navigate: { url: 'https://example.com' },
    click: { target: '@e1jm0sbb_1' },
    click_probe: { selector: '@e1jm0sbb_1' },
    fill: { selector: '@e1jm0sbb_1', value: 'hello' },
    press: { key: 'Enter' },
    evaluate: { code: 'return document.title' },
    observe_diff: { baselineId: 'obs_test' },
    network_detail: { requestId: 'req_test' },
    upload: { selector: '@e1jm0sbb_1', files: ['/tmp/example.txt'] },
    download: { url: 'https://example.com/file.txt' }
  };

  for (const command of Object.keys(COMMANDS)) {
    const result = await client.callTool({
      name: 'browser_control_command',
      arguments: {
        command,
        session: 'all-commands',
        args: requiredArgs[command] || {}
      }
    });
    assert.equal(result.structuredContent.ok, true, command);
    assert.equal(result.structuredContent.command, command);
  }

  assert.deepEqual(fake.requests.map(request => request.command), Object.keys(COMMANDS));
  for (const request of fake.requests) {
    assert.equal(request.session, 'all-commands');
    assert.equal(request.version, PROTOCOL_VERSION);
    assert.equal(request.timeoutMs, 30000);
  }
});

test('mcp close_session standalone closes and rotates active session', async (t) => {
  const fake = createFakeDaemon();
  await fake.listen();
  t.after(() => fake.close());
  const { client } = await withMcpClient(t, { BROWSER_CONTROL_PORT: String(fake.server.address().port) });

  const first = await client.callTool({
    name: 'browser_control_command',
    arguments: {
      command: 'snapshot',
      args: {}
    }
  });
  const firstSession = first.structuredContent.session;
  const closed = await client.callTool({ name: 'browser_control_close_session', arguments: {} });
  assert.equal(closed.structuredContent.closedSession, firstSession);
  assert.match(closed.structuredContent.activeSession, /^mcp-/);
  assert.notEqual(closed.structuredContent.activeSession, firstSession);

  const next = await client.callTool({
    name: 'browser_control_command',
    arguments: {
      command: 'snapshot',
      args: {}
    }
  });
  assert.equal(next.structuredContent.session, closed.structuredContent.activeSession);
});

test('mcp command returns structured validation feedback', async (t) => {
  const fake = createFakeDaemon();
  await fake.listen();
  t.after(() => fake.close());
  const { client } = await withMcpClient(t, { BROWSER_CONTROL_PORT: String(fake.server.address().port) });

  const unknown = await client.callTool({
    name: 'browser_control_command',
    arguments: { command: 'networkList', args: {} }
  });
  assert.equal(unknown.isError, true);
  assert.equal(unknown.structuredContent.error.code, 'UNKNOWN_COMMAND');
  assert.ok(unknown.structuredContent.error.availableCommands.includes('network_list'));
  assert.ok(unknown.structuredContent.error.suggestions.includes('network_list'));

  const missing = await client.callTool({
    name: 'browser_control_command',
    arguments: { command: 'click', args: {} }
  });
  assert.equal(missing.isError, true);
  assert.equal(missing.structuredContent.error.code, 'VALIDATION_ERROR');
  assert.match(JSON.stringify(missing.structuredContent.error.issues), /target/);

  const hint = await client.callTool({
    name: 'browser_control_command',
    arguments: { command: 'fill', args: { selector: '@e1', text: 'wrong' } }
  });
  assert.equal(hint.isError, true);
  assert.match(JSON.stringify(hint.structuredContent.error.hints), /value.*text/);

  assert.equal(fake.requests.length, 0);
});

test('mcp status reports compatible daemon without treating extension disconnect as restart proof', async (t) => {
  const fake = createFakeDaemon();
  await fake.listen();
  t.after(() => fake.close());
  const { client } = await withMcpClient(t, { BROWSER_CONTROL_PORT: String(fake.server.address().port) });

  const result = await client.callTool({ name: 'browser_control_status', arguments: {} });
  assert.equal(result.structuredContent.ok, true);
  assert.equal(result.structuredContent.action, 'reused');
  assert.equal(result.structuredContent.compatible, true);
  assert.match(result.structuredContent.activeSession, /^mcp-/);
  assert.match(JSON.stringify(result.structuredContent.warnings), /extension is not connected/i);
});

test('mcp status fails safely for non Browser Control service on port', async (t) => {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ status: 'different-service' }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));

  const { client } = await withMcpClient(t, { BROWSER_CONTROL_PORT: String(server.address().port) });
  const result = await client.callTool({ name: 'browser_control_status', arguments: {} });
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
  assert.ok(listed.tools.some(tool => tool.name === 'browser_control_command'));
  assert.ok(listed.tools.some(tool => tool.name === 'browser_control_close_session'));
  assert.ok(listed.tools.some(tool => tool.name === 'browser_control_status'));

  const result = await client.callTool({ name: 'browser_control_status', arguments: {} });
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
  assert.ok(listed.tools.some(tool => tool.name === 'browser_control_command'));
  const result = await client.callTool({ name: 'browser_control_status', arguments: {} });
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
