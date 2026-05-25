import { DAEMON_CAPABILITIES, PROTOCOL_VERSION, RUNTIME_SCHEMA_VERSION } from './protocol.js';
import { DaemonClient } from './daemon-client.js';
import { loadScriptPackageVersion } from './runtime-paths.js';
import { startDaemonProcess, stopDaemonProcess } from '../daemon/process-manager.js';

export interface LifecycleResult {
  ok: boolean;
  action: 'reused' | 'started' | 'restarted' | 'failed';
  compatible: boolean;
  status?: Record<string, unknown>;
  warnings: string[];
  errors: string[];
  nextSteps: string[];
}

export function isBrowserControlStatus(data: unknown): data is Record<string, unknown> {
  return Boolean(data && typeof data === 'object' &&
    ((data as Record<string, unknown>).running === true || (data as Record<string, unknown>).status === 'ok') &&
    typeof (data as Record<string, unknown>).version === 'string');
}

export function assessCompatibility(status: Record<string, unknown>): { compatible: boolean; warnings: string[]; errors: string[]; nextSteps: string[] } {
  const warnings: string[] = [];
  const errors: string[] = [];
  const nextSteps: string[] = [];
  const expectedVersion = loadScriptPackageVersion();
  const runtime = status.runtime as Record<string, unknown> | undefined;
  const daemonRuntime = runtime?.daemon as Record<string, unknown> | undefined;
  const daemonProtocol = daemonRuntime?.protocolVersion || status.protocolVersion;
  const daemonSchema = daemonRuntime?.runtimeSchemaVersion || status.runtimeSchemaVersion;
  const rawCapabilities = Array.isArray(status.capabilities)
    ? status.capabilities
    : Array.isArray(daemonRuntime?.capabilities)
      ? daemonRuntime.capabilities
      : [];
  const capabilities = new Set(rawCapabilities);

  if (expectedVersion && status.version !== expectedVersion) {
    errors.push(`Daemon version ${String(status.version)} does not match MCP package version ${expectedVersion}.`);
  }
  if (daemonProtocol !== PROTOCOL_VERSION) {
    errors.push(`Daemon protocolVersion ${String(daemonProtocol)} does not match ${PROTOCOL_VERSION}.`);
  }
  if (daemonSchema !== RUNTIME_SCHEMA_VERSION) {
    errors.push(`Daemon runtimeSchemaVersion ${String(daemonSchema)} does not match ${RUNTIME_SCHEMA_VERSION}.`);
  }
  for (const capability of DAEMON_CAPABILITIES) {
    if (!capabilities.has(capability)) errors.push(`Daemon is missing required capability ${capability}.`);
  }

  if (status.extension_connected !== true) {
    warnings.push('Chrome extension is not connected. Browser commands will return BACKEND_UNAVAILABLE until the extension is loaded.');
    nextSteps.push('Load or reload the Browser Control Chrome extension, then run browser_control_status or browser_control_doctor.');
  }
  const extension = (runtime?.extension || null) as Record<string, unknown> | null;
  if (extension?.version && expectedVersion && extension.version !== expectedVersion) {
    warnings.push(`Chrome extension runtime version ${String(extension.version)} differs from MCP package version ${expectedVersion}. Reload the extension.`);
    nextSteps.push('Reload the Browser Control Chrome extension from the bundled extension directory.');
  }

  return {
    compatible: errors.length === 0,
    warnings,
    errors,
    nextSteps
  };
}

export async function ensureDaemon(client = new DaemonClient()): Promise<LifecycleResult> {
  let currentStatus: Record<string, unknown> | null = null;
  let statusError: Error | null = null;
  try {
    const current = await client.status();
    currentStatus = current.data;
    if (!isBrowserControlStatus(current.data)) {
      return {
        ok: false,
        action: 'failed',
        compatible: false,
        status: current.data,
        warnings: [],
        errors: [`Port ${client.port} is reachable but does not look like Browser Control.`],
        nextSteps: ['Stop the process using the Browser Control port or set BROWSER_CONTROL_PORT to a free port.']
      };
    }
    const compatibility = assessCompatibility(current.data);
    if (compatibility.compatible) {
      return { ok: true, action: 'reused', status: current.data, ...compatibility };
    }
  } catch (error) {
    statusError = error instanceof Error ? error : new Error(String(error));
  }

  const action = currentStatus ? 'restarted' : 'started';
  const commandOk = currentStatus
    ? await stopManagedDaemon(client).then(stop => stop.ok ? startManagedDaemon(client) : stop)
    : await startManagedDaemon(client);
  if (!commandOk.ok) {
    return {
      ok: false,
      action: 'failed',
      compatible: false,
      status: currentStatus || undefined,
      warnings: [],
      errors: [commandOk.error || `Failed to ${action} Browser Control daemon.${statusError ? ` Previous status error: ${statusError.message}` : ''}`],
      nextSteps: ['Run browser-control doctor --json for diagnostics.']
    };
  }

  const after = await client.status();
  if (!isBrowserControlStatus(after.data)) {
    return {
      ok: false,
      action: 'failed',
      compatible: false,
      status: after.data,
      warnings: [],
      errors: ['Browser Control daemon did not expose the expected status shape after startup.'],
      nextSteps: ['Run browser-control restart and browser-control doctor --json.']
    };
  }
  const compatibility = assessCompatibility(after.data);
  return { ok: compatibility.compatible, action, status: after.data, ...compatibility };
}

async function startManagedDaemon(client: DaemonClient): Promise<{ ok: boolean; error?: string }> {
  const result = await startDaemonProcess({ host: client.host, port: client.port });
  return { ok: result.ok, error: result.error };
}

async function stopManagedDaemon(client: DaemonClient): Promise<{ ok: boolean; error?: string }> {
  const result = await stopDaemonProcess({ host: client.host, port: client.port });
  return { ok: result.ok, error: result.error };
}
