import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

declare const __BROWSER_CONTROL_MCP_SELF_CONTAINED__: boolean | undefined;

export const MCP_DAEMON_ARG = '--browser-control-daemon';

export interface DaemonProcessOptions {
  host?: string;
  port?: number;
  home?: string;
  daemonEntry?: string;
  env?: NodeJS.ProcessEnv;
}

export interface DaemonProcessResult {
  ok: boolean;
  action: 'alreadyRunning' | 'started' | 'stopped' | 'notRunning' | 'failed';
  pid?: number | null;
  port: number;
  error?: string;
}

interface HttpResponse {
  status: number;
  data: unknown;
}

function optionEnv(options: DaemonProcessOptions): NodeJS.ProcessEnv {
  return options.env || process.env;
}

export function daemonHost(options: DaemonProcessOptions = {}): string {
  return options.host || optionEnv(options).BROWSER_CONTROL_HOST || '127.0.0.1';
}

export function daemonPort(options: DaemonProcessOptions = {}): number {
  return options.port || Number(optionEnv(options).BROWSER_CONTROL_PORT || 10087);
}

export function browserControlHome(options: DaemonProcessOptions = {}): string {
  return options.home || optionEnv(options).BROWSER_CONTROL_HOME || path.join(os.homedir(), '.browser-control');
}

export function daemonPidFile(options: DaemonProcessOptions = {}): string {
  return path.join(browserControlHome(options), 'daemon.pid');
}

function daemonLockFile(options: DaemonProcessOptions = {}): string {
  return path.join(browserControlHome(options), 'daemon.lock');
}

export function readDaemonPid(options: DaemonProcessOptions = {}): number | null {
  try {
    const pid = Number(fs.readFileSync(daemonPidFile(options), 'utf8').trim());
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

export function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function startDaemonProcess(options: DaemonProcessOptions = {}): Promise<DaemonProcessResult> {
  const port = daemonPort(options);
  const current = await currentDaemonResponse(options);
  if (current.browserControl) {
    const data = current.response?.data as Record<string, unknown>;
    return { ok: true, action: 'alreadyRunning', pid: Number(data.pid) || readDaemonPid(options), port };
  }
  if (current.response && !current.browserControl) {
    return { ok: false, action: 'failed', port, error: `Port ${port} is in use by another service` };
  }

  const pid = readDaemonPid(options);
  removeStalePidFile(options, pid);
  if (pid && isProcessRunning(pid)) return { ok: true, action: 'alreadyRunning', pid, port };

  const lockFd = acquireStartLock(options);
  if (lockFd === null) {
    const existing = await waitForExistingDaemon(options);
    if (existing) {
      const data = existing.data as Record<string, unknown>;
      return { ok: true, action: 'alreadyRunning', pid: Number(data.pid) || readDaemonPid(options), port };
    }
    removeLockFile(options);
    return startDaemonProcess(options);
  }

  try {
    const runner = resolveDaemonRunner(options);
    const child = spawn(runner.command, runner.args, {
      detached: true,
      stdio: ['ignore', 'ignore', 'ignore'],
      env: daemonEnv(options)
    });
    child.unref();
    for (let attempts = 0; attempts < 30; attempts += 1) {
      try {
        const health = await httpRequest('/health', options, 1000);
        if (isBrowserControlHttpResponse(health)) {
          return { ok: true, action: 'started', pid: readDaemonPid(options) || child.pid || null, port };
        }
      } catch {
        // Keep polling until the daemon has bound its HTTP listener.
      }
      await sleep(500);
    }
    return { ok: false, action: 'failed', port, error: 'Browser Control daemon failed to start within 15 seconds.' };
  } catch (error) {
    return { ok: false, action: 'failed', port, error: (error as Error).message };
  } finally {
    releaseStartLock(options, lockFd);
  }
}

export async function stopDaemonProcess(options: DaemonProcessOptions = {}): Promise<DaemonProcessResult> {
  const port = daemonPort(options);
  const pid = readDaemonPid(options);
  if (!pid) return { ok: true, action: 'notRunning', pid: null, port };
  if (!isProcessRunning(pid)) {
    removePidFile(options);
    return { ok: true, action: 'notRunning', pid, port };
  }
  try {
    process.kill(pid, 'SIGTERM');
  } catch (error) {
    return { ok: false, action: 'failed', pid, port, error: (error as Error).message };
  }
  for (let attempts = 0; attempts < 20; attempts += 1) {
    if (!isProcessRunning(pid)) {
      removePidFile(options);
      return { ok: true, action: 'stopped', pid, port };
    }
    await sleep(500);
  }
  try {
    process.kill(pid, 'SIGKILL');
    removePidFile(options);
    return { ok: true, action: 'stopped', pid, port };
  } catch (error) {
    return { ok: false, action: 'failed', pid, port, error: (error as Error).message };
  }
}

export async function currentDaemonResponse(options: DaemonProcessOptions = {}): Promise<{ browserControl: boolean; response?: HttpResponse; error?: Error }> {
  try {
    const response = await httpRequest('/status', options, 1000);
    if (isBrowserControlHttpResponse(response)) return { browserControl: true, response };
    return { browserControl: false, response };
  } catch (error) {
    return { browserControl: false, error: error as Error };
  }
}

function isBrowserControlHttpResponse(response: HttpResponse): boolean {
  const data = response.data as Record<string, unknown> | null;
  return Boolean(response.status === 200 && data && (data.running === true || data.status === 'ok') && data.version);
}

async function waitForExistingDaemon(options: DaemonProcessOptions, timeoutMs = 5000): Promise<HttpResponse | null> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const current = await currentDaemonResponse(options);
    if (current.browserControl) return current.response || null;
    await sleep(250);
  }
  return null;
}

function resolveDaemonRunner(options: DaemonProcessOptions): { command: string; args: string[] } {
  if (options.daemonEntry) return { command: process.execPath, args: [options.daemonEntry] };
  if (optionEnv(options).BROWSER_CONTROL_DAEMON_ENTRY) {
    return { command: process.execPath, args: [optionEnv(options).BROWSER_CONTROL_DAEMON_ENTRY as string] };
  }
  if (typeof __BROWSER_CONTROL_MCP_SELF_CONTAINED__ !== 'undefined' && __BROWSER_CONTROL_MCP_SELF_CONTAINED__) {
    return { command: process.execPath, args: [process.argv[1], MCP_DAEMON_ARG] };
  }
  const found = findBuiltDaemonEntry();
  if (found) return { command: process.execPath, args: [found] };
  throw new Error('Unable to locate Browser Control daemon entry. Run npm run build:daemon or set BROWSER_CONTROL_DAEMON_ENTRY.');
}

function findBuiltDaemonEntry(): string | null {
  const here = currentModuleDir();
  const candidates = [
    resolve(process.cwd(), 'skills/browser-control/scripts/daemon.js'),
    ...(here ? [
      resolve(here, '../../skills/browser-control/scripts/daemon.js'),
      resolve(here, '../skills/browser-control/scripts/daemon.js')
    ] : [])
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function currentModuleDir(): string | null {
  try {
    if (typeof import.meta !== 'undefined' && import.meta.url) {
      return dirname(fileURLToPath(import.meta.url));
    }
  } catch {
    // CommonJS bundles may not have import.meta.url.
  }
  try {
    if (typeof __dirname === 'string') return __dirname;
  } catch {
    // ESM runtimes do not expose __dirname.
  }
  return null;
}

function daemonEnv(options: DaemonProcessOptions): NodeJS.ProcessEnv {
  return {
    ...process.env,
    ...options.env,
    BROWSER_CONTROL_HOST: daemonHost(options),
    BROWSER_CONTROL_PORT: String(daemonPort(options)),
    BROWSER_CONTROL_HOME: browserControlHome(options)
  };
}

function httpRequest(urlPath: string, options: DaemonProcessOptions, timeout = 3000): Promise<HttpResponse> {
  return new Promise((resolveRequest, reject) => {
    const req = http.get(`http://${daemonHost(options)}:${daemonPort(options)}${urlPath}`, { timeout }, (res) => {
      let body = '';
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => {
        try {
          resolveRequest({ status: res.statusCode || 0, data: JSON.parse(body) });
        } catch {
          resolveRequest({ status: res.statusCode || 0, data: body });
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Timeout'));
    });
  });
}

function acquireStartLock(options: DaemonProcessOptions): number | null {
  fs.mkdirSync(browserControlHome(options), { recursive: true });
  try {
    const fd = fs.openSync(daemonLockFile(options), 'wx');
    fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }));
    return fd;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    return null;
  }
}

function releaseStartLock(options: DaemonProcessOptions, fd: number | null): void {
  if (fd === null) return;
  try {
    fs.closeSync(fd);
  } catch {
    // Best effort.
  }
  removeLockFile(options);
}

function removeLockFile(options: DaemonProcessOptions): void {
  try {
    fs.unlinkSync(daemonLockFile(options));
  } catch {
    // Best effort.
  }
}

function removeStalePidFile(options: DaemonProcessOptions, pid: number | null): void {
  if (pid && !isProcessRunning(pid)) removePidFile(options);
}

function removePidFile(options: DaemonProcessOptions): void {
  try {
    fs.unlinkSync(daemonPidFile(options));
  } catch {
    // Best effort.
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolveSleep => setTimeout(resolveSleep, ms));
}
