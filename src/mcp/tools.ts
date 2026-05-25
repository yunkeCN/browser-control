import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { DaemonClient, type BrowserControlEnvelope } from './daemon-client.js';
import { COMMANDS, PROTOCOL_VERSION } from './protocol.js';
import {
  assertSchemaRegistryMatchesProtocol,
  closeSessionInputSchema,
  commandArgSchemas,
  diagnosticInputSchema,
  unifiedCommandInputSchema,
  type CommandName
} from './schema.js';
import { riskNoteFor } from './risk-notes.js';
import { ensureDaemon } from './daemon-lifecycle.js';
import { McpSessionManager } from './session-manager.js';

export function browserCommandNames(): CommandName[] {
  return Object.keys(COMMANDS) as CommandName[];
}

export function registerBrowserControlTools(server: McpServer, client = new DaemonClient(), sessions = new McpSessionManager()): void {
  assertSchemaRegistryMatchesProtocol();
  registerCompactTools(server, client, sessions);
  registerDiagnosticTools(server, client, sessions);
}

function registerCompactTools(server: McpServer, client: DaemonClient, sessions: McpSessionManager): void {
  server.registerTool('browser_control_command', {
    title: 'Browser Control command',
    description: [
      'Run any low-level Browser Control protocol command through the local daemon.',
      'Input shape: command, optional args object, optional session, timeoutMs, and id.',
      'Session is managed automatically by this MCP server process. Omit session for normal use; pass session only for advanced isolation.',
      'Before clicking by visible text, call snapshot with args.textIncludes plus maxElements to get a small set of @e references.',
      'Use browser_control_close_session at the end of a task. The MCP server validates command args and returns structured hints, but does not perform user confirmation.'
    ].join('\n\n'),
    inputSchema: unifiedCommandInputSchema
  }, async (input) => {
    return runUnifiedCommand(input as Record<string, unknown>, client, sessions);
  });

  server.registerTool('browser_control_close_session', {
    title: 'Browser Control close current session',
    description: [
      'Close the active Browser Control session and rotate to a new active session.',
      'Session is optional. Omit it to close the current MCP-managed active session.',
      'This is the preferred cleanup tool; browser_control_command with command "close_session" is also accepted.'
    ].join('\n\n'),
    inputSchema: closeSessionInputSchema
  }, async (input) => {
    const record = input as Record<string, unknown>;
    const session = sessions.resolveSession(record.session);
    const result = await executeCommand('close_session', {}, {
      id: record.id,
      timeoutMs: record.timeoutMs,
      session
    }, client);
    if (!result.isError) {
      const nextActiveSession = sessions.rotateSession();
      return appendStructuredFields(result, { closedSession: session, activeSession: nextActiveSession });
    }
    return appendStructuredFields(result, { activeSession: sessions.getActiveSession() });
  });
}

function registerDiagnosticTools(server: McpServer, client: DaemonClient, sessions: McpSessionManager): void {
  server.registerTool('browser_control_status', {
    title: 'Browser Control status',
    description: 'Return Browser Control daemon status, MCP compatibility diagnostics, and the current MCP-managed active session.',
    inputSchema: diagnosticInputSchema
  }, async () => {
    const lifecycle = await ensureDaemon(client);
    return toToolResult({ ...lifecycle, activeSession: sessions.getActiveSession() }, !lifecycle.ok);
  });

  server.registerTool('browser_control_doctor', {
    title: 'Browser Control doctor',
    description: 'Return daemon health/status diagnostics for MCP setup troubleshooting.',
    inputSchema: diagnosticInputSchema
  }, async () => {
    const lifecycle = await ensureDaemon(client);
    const health = lifecycle.ok ? await client.health().then(r => r.data).catch(error => ({ error: (error as Error).message })) : null;
    return toToolResult({ lifecycle, health, activeSession: sessions.getActiveSession() }, !lifecycle.ok);
  });
}

async function runUnifiedCommand(input: Record<string, unknown>, client: DaemonClient, sessions: McpSessionManager): Promise<CallToolResult> {
  const command = typeof input.command === 'string' ? input.command : '';
  const args = input.args === undefined ? {} : input.args;
  const session = sessions.resolveSession(input.session);

  if (!isCommandName(command)) {
    return toToolResult(unknownCommandResult(command, session), true);
  }
  if (!isPlainRecord(args)) {
    return toToolResult(validationErrorResult(command, session, ['args must be an object.'], ['Pass command-specific fields inside args, for example {"args":{"viewportOnly":true}}.']), true);
  }

  const validation = validateCommandArgs(command, args);
  if (!validation.ok) {
    return toToolResult(validationErrorResult(command, session, validation.issues, validation.hints), true);
  }

  const result = await executeCommand(command, validation.data, {
    id: input.id,
    timeoutMs: input.timeoutMs,
    session
  }, client);
  const withActiveSession = appendStructuredFields(result, { activeSession: sessions.getActiveSession() });
  if (command === 'close_session' && !withActiveSession.isError) {
    const nextActiveSession = sessions.rotateSession();
    return appendStructuredFields(withActiveSession, { closedSession: session, activeSession: nextActiveSession });
  }
  return withActiveSession;
}

async function executeCommand(
  command: CommandName,
  args: Record<string, unknown>,
  controls: { id?: unknown; timeoutMs?: unknown; session: string },
  client: DaemonClient
): Promise<CallToolResult> {
  const envelope: BrowserControlEnvelope = {
    id: typeof controls.id === 'string' && controls.id ? controls.id : `mcp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    version: PROTOCOL_VERSION,
    session: controls.session,
    command,
    args,
    timeoutMs: typeof controls.timeoutMs === 'number' && Number.isFinite(controls.timeoutMs) && controls.timeoutMs > 0 ? controls.timeoutMs : 30000
  };
  return executeEnvelope(command, envelope, client);
}

async function executeEnvelope(command: CommandName, envelope: BrowserControlEnvelope, client: DaemonClient): Promise<CallToolResult> {
  const lifecycle = await ensureDaemon(client);
  if (!lifecycle.ok) return toToolResult({ ok: false, command, session: envelope.session, lifecycle }, true);
  const response = await client.command(envelope);
  const result = withCommandMetadata(command, envelope.session, response.data);
  return toToolResult(result, isErrorEnvelope(result));
}

function validateCommandArgs(command: CommandName, args: Record<string, unknown>): { ok: true; data: Record<string, unknown> } | { ok: false; issues: string[]; hints: string[] } {
  const parsed = commandArgSchemas[command].safeParse(args);
  if (parsed.success) return { ok: true, data: parsed.data as Record<string, unknown> };
  return {
    ok: false,
    issues: parsed.error.issues.map(issue => {
      const field = issue.path.length ? issue.path.join('.') : 'args';
      return `${field}: ${issue.message}`;
    }),
    hints: hintsFor(command, args, parsed.error.issues)
  };
}

function unknownCommandResult(command: string, session: string): Record<string, unknown> {
  const suggestions = commandSuggestions(command);
  return {
    ok: false,
    command,
    session,
    error: {
      code: 'UNKNOWN_COMMAND',
      message: command ? `Unknown Browser Control command "${command}".` : 'Browser Control command is required.',
      availableCommands: browserCommandNames(),
      suggestions
    }
  };
}

function validationErrorResult(command: CommandName | string, session: string, issues: string[], hints: string[]): Record<string, unknown> {
  return {
    ok: false,
    command,
    session,
    error: {
      code: 'VALIDATION_ERROR',
      message: `Invalid arguments for Browser Control command "${command}".`,
      issues,
      hints
    },
    riskNotes: riskNoteFor(command) ? [riskNoteFor(command)] : undefined
  };
}

function hintsFor(command: CommandName, args: Record<string, unknown>, issues: unknown[]): string[] {
  const hints: string[] = [];
  const keys = new Set(Object.keys(args));
  if (command === 'fill' && keys.has('text')) hints.push('fill uses args.value, not args.text.');
  if (command === 'click' && keys.has('text')) hints.push('click uses args.selector. To click visible text, first call snapshot with args.textIncludes and args.maxElements, then click the returned @e selector.');
  if (command === 'get_text' && keys.has('selectors')) hints.push('get_text accepts one optional args.selector for the text extraction scope. To find clickable targets by text, use snapshot with args.textIncludes instead.');
  if (command === 'evaluate' && keys.has('expression')) hints.push('evaluate uses args.code, not args.expression.');
  if (command === 'wait_for' && keys.has('timeMs')) hints.push('wait_for uses args.timeoutMs, not args.timeMs.');
  if (command === 'network_detail' && keys.has('index')) hints.push('network_detail uses args.requestId from network_list.requests[].id, not a numeric index.');
  if (command === 'find_tab' && keys.has('urlContains')) hints.push('find_tab uses args.urlIncludes, not args.urlContains.');
  if (command === 'find_tab' && keys.has('titleContains')) hints.push('find_tab uses args.titleIncludes, not args.titleContains.');
  if (command === 'close_session') hints.push('Prefer the dedicated browser_control_close_session tool for cleanup.');
  if (!hints.length && issues.length) hints.push(`Required args: ${(COMMANDS[command].required || []).join(', ') || 'none'}. Optional args: ${(COMMANDS[command].optional || []).join(', ') || 'none'}.`);
  return hints;
}

function commandSuggestions(command: string): string[] {
  if (!command) return [];
  const normalized = command.replace(/([a-z])([A-Z])/g, '$1_$2').replace(/[-\s]+/g, '_').toLowerCase();
  const names = browserCommandNames();
  const exactNormalized = names.find(name => name === normalized);
  if (exactNormalized) return [exactNormalized];
  return names
    .map(name => ({ name, distance: levenshtein(normalized, name) }))
    .filter(candidate => candidate.distance <= 4)
    .sort((a, b) => a.distance - b.distance || a.name.localeCompare(b.name))
    .slice(0, 3)
    .map(candidate => candidate.name);
}

function levenshtein(a: string, b: string): number {
  const previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    let diagonal = previous[0];
    previous[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const insert = previous[j] + 1;
      const remove = previous[j - 1] + 1;
      const replace = diagonal + (a[i - 1] === b[j - 1] ? 0 : 1);
      diagonal = previous[j];
      previous[j] = Math.min(insert, remove, replace);
    }
  }
  return previous[b.length];
}

function isCommandName(command: string): command is CommandName {
  return Object.prototype.hasOwnProperty.call(commandArgSchemas, command);
}

function withCommandMetadata(command: CommandName, session: string, value: Record<string, unknown>): Record<string, unknown> {
  const risk = riskNoteFor(command);
  return {
    ...value,
    command: typeof value.command === 'string' ? value.command : command,
    session: typeof value.session === 'string' ? value.session : session,
    ...(risk ? { riskNotes: [risk] } : {})
  };
}

function appendStructuredFields(result: CallToolResult, fields: Record<string, unknown>): CallToolResult {
  const structuredContent = isPlainRecord(result.structuredContent) ? { ...result.structuredContent, ...fields } : fields;
  return {
    ...result,
    structuredContent,
    content: [{ type: 'text', text: JSON.stringify(structuredContent, null, 2) }]
  };
}

export function toToolResult(value: unknown, isError = false): CallToolResult {
  const structuredContent = isPlainRecord(value) ? value : { result: value };
  return {
    content: [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    structuredContent,
    isError
  };
}

function isErrorEnvelope(value: unknown): boolean {
  return Boolean(value && typeof value === 'object' && (value as Record<string, unknown>).ok === false);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}
