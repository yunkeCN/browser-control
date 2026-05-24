#!/usr/bin/env node
// Browser Control Daemon — Lifecycle and diagnostics CLI

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const {
  PROTOCOL_VERSION,
  RUNTIME_SCHEMA_VERSION,
  CLI_CAPABILITIES
} = require('./protocol');
const {
  defaultChromeUserDataDir,
  detectLoadedExtension: detectLoadedExtensionPortable,
  detectLoadedExtensions: detectLoadedExtensionsPortable,
  findChrome: findChromePortable
} = require('./support');

const BROWSER_CONTROL_HOME = process.env.BROWSER_CONTROL_HOME || path.join(os.homedir(), '.browser-control');
const LOG_DIR = BROWSER_CONTROL_HOME;
const PID_FILE = path.join(LOG_DIR, 'daemon.pid');
const LOCK_FILE = path.join(LOG_DIR, 'daemon.lock');
const LOG_FILE = path.join(LOG_DIR, 'daemon.log');
const DAEMON_SCRIPT = path.join(__dirname, 'daemon.js');
const HOST = process.env.BROWSER_CONTROL_HOST || '127.0.0.1';
const PORT = Number(process.env.BROWSER_CONTROL_PORT || 10087);
const SKILL_ROOT = path.resolve(__dirname, '..');
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const SKILL_EXTENSION_DIR = path.join(SKILL_ROOT, 'extension');
const SOURCE_EXTENSION_DIR = resolveExtensionDir();
const CHROME_EXTENSION_ID = process.env.CODEX_CHROME_EXTENSION_ID || 'jfmjfhklogoienhpfnppmbcbjfjnkonk';
const CHROME_USER_DATA = process.env.CODEX_CHROME_USER_DATA_DIR || defaultChromeUserDataDir();

function wantsJson(args) { return args.includes('--json'); }
function printJson(data) { console.log(JSON.stringify(data, null, 2)); }

function hasExtensionManifest(dir) {
  return Boolean(dir && fs.existsSync(path.join(dir, 'manifest.json')));
}
function resolveExtensionDir() {
  if (process.env.BROWSER_CONTROL_EXTENSION_DIR) return path.resolve(process.env.BROWSER_CONTROL_EXTENSION_DIR);
  return SKILL_EXTENSION_DIR;
}

function readPid() {
  try { const pid = parseInt(fs.readFileSync(PID_FILE, 'utf8').trim(), 10); if (Number.isInteger(pid) && pid > 0) return pid; } catch {}
  return null;
}
function isProcessRunning(pid) { try { process.kill(pid, 0); return true; } catch { return false; } }
function httpRequest(urlPath, timeout = 3000) {
  return new Promise((resolve, reject) => {
    const req = http.get(`http://${HOST}:${PORT}${urlPath}`, { timeout }, (res) => {
      let body = ''; res.on('data', c => body += c); res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(body) }); }
        catch { resolve({ status: res.statusCode, data: body }); }
      });
    });
    req.on('error', reject); req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
  });
}
function httpPostJson(urlPath, body, timeout = 30000) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request({
      hostname: HOST,
      port: PORT,
      path: urlPath,
      method: 'POST',
      timeout,
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(payload)
      }
    }, (res) => {
      let text = '';
      res.on('data', c => text += c);
      res.on('end', () => {
        let data = text;
        try { data = text ? JSON.parse(text) : null; } catch {}
        resolve({ status: res.statusCode, data });
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
    req.write(payload);
    req.end();
  });
}
async function statusData() {
  const pid = readPid();
  const pidRunning = pid ? isProcessRunning(pid) : false;
  try {
    const response = await httpRequest('/status');
    return { ok: response.status === 200, reachable: true, host: HOST, port: PORT, pidFile: pid, pidRunning, ...response.data };
  } catch (err) {
    return { ok: false, reachable: false, host: HOST, port: PORT, pidFile: pid, pidRunning, error: err.message, running: pidRunning };
  }
}
function isBrowserControlResponse(response) {
  const data = response && response.data;
  return Boolean(response && response.status === 200 && data && (data.running === true || data.status === 'ok') && data.version);
}

function detectLoadedExtension() {
  return detectLoadedExtensionPortable({
    extensionId: CHROME_EXTENSION_ID,
    userData: CHROME_USER_DATA,
    sourceDirs: [SOURCE_EXTENSION_DIR, SKILL_EXTENSION_DIR]
  });
}

function detectLoadedExtensions() {
  return detectLoadedExtensionsPortable({
    extensionId: CHROME_EXTENSION_ID,
    userData: CHROME_USER_DATA,
    sourceDirs: [SOURCE_EXTENSION_DIR, SKILL_EXTENSION_DIR]
  });
}

function cliRuntimeMetadata() {
  let packageVersion = null;
  try { packageVersion = require(path.join(REPO_ROOT, 'package.json')).version; } catch {}
  if (!packageVersion) {
    try { packageVersion = require(path.join(__dirname, 'package.json')).version; } catch {}
  }
  return {
    layer: 'cli',
    version: packageVersion,
    protocolVersion: PROTOCOL_VERSION,
    runtimeSchemaVersion: RUNTIME_SCHEMA_VERSION,
    capabilities: CLI_CAPABILITIES,
    expectedDaemonFields: ['runtime', 'runtimeSchemaVersion', 'capabilities'],
    expectedExtensionFields: ['version', 'capabilities', 'build']
  };
}

function buildRuntimeWarnings(daemon, cli = cliRuntimeMetadata()) {
  const warnings = [];
  if (daemon.reachable && !daemon.runtimeSchemaVersion && !daemon.runtime) {
    warnings.push('Daemon health/status shape lacks runtime metadata; daemon may be old. Run: browser-control restart');
  }
  if (daemon.reachable && Array.isArray(daemon.capabilities) && !daemon.capabilities.includes('actionObservation')) {
    warnings.push('Daemon capabilities do not include actionObservation; expectChange/observe may be unsupported. Run: browser-control restart');
  }
  if (daemon.extension_connected && !daemon.runtime?.extension) {
    warnings.push('Connected extension has not sent runtime metadata; reload the extension from the current source path for full diagnostics.');
  }
  if (daemon.reachable && cli?.version && daemon.version && daemon.version !== cli.version) {
    warnings.push(`Daemon version (${daemon.version}) differs from CLI version (${cli.version}); restart daemon after upgrade. Run: browser-control restart`);
  }
  const extensionVersion = daemon.runtime?.extension?.version;
  if (daemon.extension_connected && cli?.version && extensionVersion && extensionVersion !== cli.version) {
    warnings.push(`Extension runtime version (${extensionVersion}) differs from CLI version (${cli.version}); reload the Chrome extension from the current source path.`);
  }
  return warnings;
}

function removeStalePidFile(pid) {
  if (pid && !isProcessRunning(pid)) {
    try { fs.unlinkSync(PID_FILE); } catch {}
  }
}

function acquireStartLock() {
  fs.mkdirSync(LOG_DIR, { recursive: true });
  try {
    const fd = fs.openSync(LOCK_FILE, 'wx');
    fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }));
    return fd;
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
    return null;
  }
}

function releaseStartLock(fd) {
  if (fd !== null) {
    try { fs.closeSync(fd); } catch {}
    try { fs.unlinkSync(LOCK_FILE); } catch {}
  }
}

async function currentDaemonResponse() {
  try {
    const response = await httpRequest('/status', 1000);
    if (isBrowserControlResponse(response)) return { browserControl: true, response };
    return { browserControl: false, response };
  } catch (err) {
    return { browserControl: false, error: err };
  }
}

async function waitForExistingDaemon(timeoutMs = 5000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const current = await currentDaemonResponse();
    if (current.browserControl) return current.response;
    await new Promise(r => setTimeout(r, 250));
  }
  return null;
}

async function startDaemon(json = false) {
  const current = await currentDaemonResponse();
  if (current.browserControl) {
    const data = current.response.data;
    if (json) printJson({ ok: true, alreadyRunning: true, pid: data.pid || readPid(), port: data.port || PORT });
    else console.log(`Daemon is already running on ${HOST}:${PORT}${data.pid ? ` (PID: ${data.pid})` : ''}`);
    return true;
  }
  if (current.response && !current.browserControl) {
    const message = `Port ${PORT} is in use by another service`;
    if (json) printJson({ ok: false, code: 'PORT_IN_USE_BY_OTHER', port: PORT, message }); else console.error(message);
    return false;
  }

  const pid = readPid();
  removeStalePidFile(pid);
  if (pid && isProcessRunning(pid)) {
    if (json) printJson({ ok: true, alreadyRunning: true, pid, port: PORT }); else console.log(`Daemon is already running (PID: ${pid})`);
    return true;
  }

  const lockFd = acquireStartLock();
  if (lockFd === null) {
    const existing = await waitForExistingDaemon();
    if (existing) {
      if (json) printJson({ ok: true, alreadyRunning: true, startedByAnotherProcess: true, pid: existing.data.pid || readPid(), port: existing.data.port || PORT });
      else console.log(`Daemon is already running on ${HOST}:${PORT}`);
      return true;
    }
    try { fs.unlinkSync(LOCK_FILE); } catch {}
    return startDaemon(json);
  }

  try {
    if (!json) console.log('Starting Browser Control Daemon...');
    const daemon = spawn(process.execPath, [DAEMON_SCRIPT], { detached: true, stdio: ['ignore', 'ignore', 'ignore'], env: { ...process.env } });
    daemon.unref();
    for (let attempts = 0; attempts < 30; attempts++) {
      try {
        const health = await httpRequest('/health', 1000);
        if (isBrowserControlResponse(health)) {
          const newPid = readPid() || daemon.pid;
          if (json) printJson({ ok: true, started: true, pid: newPid, port: PORT });
          return true;
        }
      } catch {}
      await new Promise(r => setTimeout(r, 500));
    }
    if (json) printJson({ ok: false, error: 'Daemon failed to start within 15 seconds' }); else console.error('Daemon failed to start within 15 seconds');
    return false;
  } finally {
    releaseStartLock(lockFd);
  }
}
async function stopDaemon(json = false) {
  const pid = readPid();
  if (!pid) { const data = await statusData(); if (json) printJson({ ok: !data.reachable, message: data.reachable ? 'running without pid file' : 'not running' }); else console.log(data.reachable ? 'Daemon is running but no PID file found.' : 'Daemon is not running.'); return !data.reachable; }
  if (!isProcessRunning(pid)) { try { fs.unlinkSync(PID_FILE); } catch {}; if (json) printJson({ ok: true, stalePid: pid }); else console.log(`Daemon is not running (stale PID: ${pid})`); return true; }
  if (!json) console.log(`Stopping daemon (PID: ${pid})...`);
  try { process.kill(pid, 'SIGTERM'); } catch (err) { if (json) printJson({ ok: false, error: err.message }); else console.error(`Failed to stop daemon: ${err.message}`); return false; }
  for (let i = 0; i < 20; i++) { if (!isProcessRunning(pid)) { try { fs.unlinkSync(PID_FILE); } catch {}; if (json) printJson({ ok: true, stopped: pid }); else console.log('Daemon stopped.'); return true; } await new Promise(r => setTimeout(r, 500)); }
  try { process.kill(pid, 'SIGKILL'); } catch {}; try { fs.unlinkSync(PID_FILE); } catch {}; if (json) printJson({ ok: true, killed: pid }); else console.error('Daemon did not stop gracefully. Sent SIGKILL.'); return true;
}
async function showStatus(json = false) {
  const data = await statusData();
  if (json) return printJson(data);
  if (!data.reachable) {
    console.log(data.pidRunning ? `Daemon process ${data.pidFile} is running but HTTP is not reachable.` : 'Daemon is not running.');
    return;
  }
  console.log('Browser Control Daemon Status');
  console.log('============================');
  console.log(`Version:         ${data.version}`);
  console.log(`Running:         ${data.running ? 'yes' : 'no'}`);
  console.log(`Port:            ${data.port}`);
  console.log(`PID:             ${data.pid}`);
  console.log(`Uptime:          ${Math.floor(data.uptime_seconds || 0)}s`);
  console.log(`Extension:       ${data.extension_connected ? 'connected' : 'disconnected'}`);
  if (data.runtimeSchemaVersion) console.log(`Runtime schema:  ${data.runtimeSchemaVersion}`);
  if (data.runtime?.extension?.version) console.log(`Ext version:     ${data.runtime.extension.version}`);
  for (const warning of data.warnings || []) console.log(`Warning:         ${warning}`);
  console.log(`Active Sessions: ${data.sessions?.length || 0}`);
  console.log(`Artifact dir:    ${data.artifactDir || 'n/a'}`);
  console.log(`Log file:        ${data.logFile || LOG_FILE}`);
}

function showE2eHelp() {
  console.log('Browser Control E2E');
  console.log('=================');
  console.log('Automated fixture smoke: npm run e2e:fixture');
  console.log('Live Chrome extension E2E: npm run e2e:live');
  console.log(`Precondition for live E2E: load ${SOURCE_EXTENSION_DIR} in chrome://extensions, then ensure daemon status shows connected.`);
}

function formatLogLine(line) {
  try {
    const entry = JSON.parse(line);
    return `${(entry.timestamp || '?').replace('T', ' ').slice(0, 19)} [${(entry.level || '?').padEnd(5)}] ${entry.message}`;
  } catch {
    return line;
  }
}

function readLastLogLines(lines) {
  return fs.readFileSync(LOG_FILE, 'utf8').trim().split('\n').filter(Boolean).slice(-lines);
}

async function showLogs(lines = 100, follow = false) {
  if (!fs.existsSync(LOG_FILE)) { console.log('No log file found.'); return; }
  for (const line of readLastLogLines(lines)) console.log(formatLogLine(line));
  if (!follow) return;
  let offset = fs.statSync(LOG_FILE).size;
  fs.watchFile(LOG_FILE, { interval: 500 }, (current, previous) => {
    if (current.size < previous.size) offset = 0;
    if (current.size <= offset) return;
    const stream = fs.createReadStream(LOG_FILE, { start: offset, end: current.size - 1, encoding: 'utf8' });
    offset = current.size;
    let buffer = '';
    stream.on('data', chunk => { buffer += chunk; });
    stream.on('end', () => {
      for (const line of buffer.split('\n').filter(Boolean)) console.log(formatLogLine(line));
    });
  });
  return new Promise(() => {});
}
function findChrome() {
  return findChromePortable();
}
async function diagnose(kind, json = false) {
  const daemon = await statusData();
  const chromePath = findChrome();
  const extensionSource = hasExtensionManifest(SOURCE_EXTENSION_DIR) ? SOURCE_EXTENSION_DIR : null;
  const loadedExtensions = detectLoadedExtensions();
  const loadedExtension = loadedExtensions[0] || detectLoadedExtension();
  const cli = cliRuntimeMetadata();
  const runtimeWarnings = buildRuntimeWarnings(daemon, cli);
  const data = {
    ok: Boolean(daemon.reachable && daemon.extension_connected),
    platform: process.platform,
    cli,
    daemon,
    chrome: { installed: !!chromePath, path: chromePath },
    extension: {
      sourcePath: extensionSource,
      connected: !!daemon.extension_connected,
      loaded: loadedExtension,
      loadedProfiles: loadedExtensions,
      runtime: daemon.runtime?.extension || null
    },
    runtimeDiagnostics: {
      schemaVersion: RUNTIME_SCHEMA_VERSION,
      warnings: runtimeWarnings
    },
    nextSteps: []
  };
  if (!daemon.reachable) data.nextSteps.push('Run: browser-control start');
  if (!chromePath) data.nextSteps.push('Install Google Chrome or Chromium');
  if (runtimeWarnings.length) data.nextSteps.push(...runtimeWarnings);
  if (!daemon.extension_connected) data.nextSteps.push(`Load extension from ${extensionSource || '<skill>/extension'} in chrome://extensions`);
  if (loadedExtension.loadedFrom === 'source') data.nextSteps.push('Chrome appears to load the Browser Control extension directory; reload the extension after service-worker/manifest changes; refresh pages after content-script changes.');
  if (daemon.reachable && runtimeWarnings.some(w => /daemon may be old|Run: browser-control restart/i.test(w))) data.nextSteps.push('Run: browser-control restart');
  if (kind && kind !== 'all') {
    const subset = kind === 'daemon' ? { daemon: data.daemon } : kind === 'chrome' ? { chrome: data.chrome } : kind === 'extension' ? { extension: data.extension, nextSteps: data.nextSteps } : data;
    if (json) return printJson(subset);
    console.log(JSON.stringify(subset, null, 2)); return;
  }
  if (json) return printJson(data);
  console.log(JSON.stringify(data, null, 2));
}
function usage() {
  console.log(`Browser Control CLI\n\nUsage: browser-control <command> [options]\n\nCommands:\n  status [--json]           Show daemon status\n  doctor [--json]           Run cross-platform daemon/chrome/extension diagnostics\n  diagnose <target> [--json] Diagnose daemon, chrome, or extension\n  start [--json]            Start the daemon\n  stop [--json]             Stop the daemon\n  restart                   Restart the daemon\n  logs [-n N] [-f]          Show recent logs\n  command <name> [options]  Send a browser command envelope to /command\n  e2e --help                Show live E2E handoff instructions\n\nBrowser command options:\n  --session <name>          Session name (default: default)\n  --args <json>             Command args as JSON object (default: {})
  --args-file <path>        Read command args as a UTF-8 JSON object from a file
  --code-file <path>        For evaluate, read UTF-8 JavaScript source into args.code\n  --timeout-ms <ms>         Command timeout in milliseconds (default: 30000)\n  --id <id>                 Request id (default: generated)\n  --version <version>       Protocol version (default: ${PROTOCOL_VERSION})\n\nDaemon URL: http://${HOST}:${PORT}\nWebSocket:  ws://${HOST}:${PORT}/ws\nLog dir:    ${LOG_DIR}`);
}

function readUtf8FileOption(filePath, label, maxBytes = 1024 * 1024) {
  if (!filePath) throw new Error(`${label} requires a value`);
  const resolved = path.resolve(process.cwd(), filePath);
  let stat;
  try { stat = fs.statSync(resolved); } catch (err) { throw new Error(`${label} cannot be read: ${err.message}`); }
  if (!stat.isFile()) throw new Error(`${label} must point to a file`);
  if (stat.size > maxBytes) throw new Error(`${label} exceeds ${maxBytes} bytes`);
  try { return fs.readFileSync(resolved, 'utf8'); } catch (err) { throw new Error(`${label} cannot be read: ${err.message}`); }
}

function parseJsonObject(raw, label) {
  let parsed;
  try { parsed = JSON.parse(raw); } catch (err) { throw new Error(`${label} must be valid JSON: ${err.message}`); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(`${label} must be a JSON object`);
  return parsed;
}

function parseBrowserCommandArgs(argv) {
  const parsed = {
    command: argv[0],
    session: 'default',
    args: {},
    timeoutMs: 30000,
    version: PROTOCOL_VERSION,
    id: `cli-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  };
  if (!parsed.command || parsed.command.startsWith('-')) throw new Error('command requires a browser command name');
  for (let i = 1; i < argv.length; i += 1) {
    const arg = argv[i];
    const readValue = (name) => {
      const value = argv[i + 1];
      if (!value || value.startsWith('--')) throw new Error(`${name} requires a value`);
      i += 1;
      return value;
    };
    if (arg === '--session') parsed.session = readValue(arg);
    else if (arg === '--args') {
      const raw = readValue(arg);
      parsed.args = parseJsonObject(raw, '--args');
    } else if (arg === '--args-file') {
      const raw = readUtf8FileOption(readValue(arg), '--args-file');
      parsed.args = parseJsonObject(raw, '--args-file');
    } else if (arg === '--code-file') {
      const code = readUtf8FileOption(readValue(arg), '--code-file');
      if (parsed.command !== 'evaluate') throw new Error('--code-file is only supported for the evaluate command');
      if (parsed.args.code !== undefined && parsed.args.code !== code) throw new Error('--code-file conflicts with args.code; provide code in only one place');
      parsed.args = { ...parsed.args, code };
    } else if (arg === '--timeout-ms') {
      parsed.timeoutMs = Number(readValue(arg));
      if (!Number.isFinite(parsed.timeoutMs) || parsed.timeoutMs <= 0) throw new Error('--timeout-ms must be a positive number');
    } else if (arg === '--id') parsed.id = readValue(arg);
    else if (arg === '--version') parsed.version = readValue(arg);
    else throw new Error(`Unknown command option: ${arg}`);
  }
  return parsed;
}

async function executeBrowserCommand(argv) {
  const parsed = parseBrowserCommandArgs(argv);
  const envelope = {
    id: parsed.id,
    version: parsed.version,
    session: parsed.session,
    command: parsed.command,
    args: parsed.args,
    timeoutMs: parsed.timeoutMs
  };
  const response = await httpPostJson('/command', envelope, parsed.timeoutMs + 1000);
  printJson(response.data);
  return response.status >= 200 && response.status < 300 && response.data && response.data.ok !== false;
}
async function main() {
  const args = process.argv.slice(2); if (args.length === 0 || args.includes('-h') || args.includes('--help') && args[0] !== 'e2e') { usage(); return; }
  const command = args[0].toLowerCase(); const json = wantsJson(args);
  switch (command) {
    case 'status': return showStatus(json);
    case 'doctor': return diagnose('all', json);
    case 'diagnose': return diagnose((args[1] || 'all').toLowerCase(), json);
    case 'start': process.exit(await startDaemon(json) ? 0 : 1); break;
    case 'stop': process.exit(await stopDaemon(json) ? 0 : 1); break;
    case 'restart': await stopDaemon(false); await new Promise(r => setTimeout(r, 1000)); process.exit(await startDaemon(false) ? 0 : 1); break;
    case 'logs': { let n = 100, follow = false; for (let i=1;i<args.length;i++){ if(args[i]==='-n') n=parseInt(args[++i],10)||100; if(args[i]==='-f') follow=true; } return showLogs(n, follow); }
    case 'command': process.exit(await executeBrowserCommand(args.slice(1)) ? 0 : 1); break;
    case 'e2e': {
      const loaded = detectLoadedExtension();
      const pathHint = loaded.loadedPath ? ` Loaded path: ${loaded.loadedPath}.` : '';
      console.log(`Live E2E: run browser-control start, load extension from ${SOURCE_EXTENSION_DIR} in chrome://extensions, reload it, then run npm run e2e:live.${pathHint}`);
      return;
    }
    default: console.error(`Unknown command: ${command}`); usage(); process.exit(2);
  }
}
main().catch(err => { console.error(err.message); process.exit(1); });
