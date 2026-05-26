/**
 * MCP 工具定义
 *
 * 所有命令通过 Controller 层执行，确保统一的 CommandResult 输出格式。
 */

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
  type CommandName,
} from './schema.js';
import { riskNoteFor } from './risk-notes.js';
import { ensureDaemon } from './daemon-lifecycle.js';
import { McpSessionManager } from './session-manager.js';

// Controller 层导入
import { navigate } from '../controller/commands/navigate.js';
import { snapshot } from '../controller/commands/snapshot.js';
import { click } from '../controller/commands/click.js';
import { fill } from '../controller/commands/fill.js';
import { press } from '../controller/commands/press.js';
import { scroll } from '../controller/commands/scroll.js';
import { upload } from '../controller/commands/upload.js';
import { getText } from '../controller/commands/get-text.js';
import { screenshot } from '../controller/commands/screenshot.js';
import { evaluate } from '../controller/commands/evaluate.js';
import { waitFor } from '../controller/commands/wait-for.js';
import { observeStart, observeDiff } from '../controller/commands/observe.js';
import { networkStart, networkList, networkDetail, networkStop } from '../controller/commands/network.js';
import { listTabs, findTab, closeTab } from '../controller/commands/tabs.js';
import { closeSession as controllerCloseSession } from '../controller/commands/session.js';
import type { CommandResult } from '../controller/types.js';

export function browserCommandNames(): CommandName[] {
  return Object.keys(COMMANDS) as CommandName[];
}

/**
 * Controller 命令分发表
 * 命令名 → Controller 处理函数
 */
const CONTROLLER_DISPATCH: Record<
  string,
  (args: Record<string, unknown>, client: DaemonClient) => Promise<CommandResult<unknown>>
> = {
  navigate: (args, client) => navigate(args, client),
  snapshot: (args, client) => snapshot(args, client),
  click: (args, client) => click(args, client),
  fill: (args, client) => fill(args, client),
  press: (args, client) => press(args, client),
  scroll: (args, client) => scroll(args, client),
  upload: (args, client) => upload(args, client),
  get_text: (args, client) => getText(args, client),
  screenshot: (args, client) => screenshot(args, client),
  evaluate: (args, client) => evaluate(args, client),
  wait_for: (args, client) => waitFor(args, client),
  observe_start: (args, client) => observeStart(args, client),
  observe_diff: (args, client) => observeDiff(args, client),
  network_start: (args, client) => networkStart(args, client),
  network_list: (args, client) => networkList(args, client),
  network_detail: (args, client) => networkDetail(args, client),
  network_stop: (args, client) => networkStop(args, client),
  list_tabs: (args, client) => listTabs(args, client),
  find_tab: (args, client) => findTab(args, client),
  close_tab: (args, client) => closeTab(args, client),
  close_session: (args, client) => controllerCloseSession(args, client),
};

/** 未使用 Controller 的命令（回落方案：直连 daemon） */
const FALLBACK_COMMANDS = new Set<CommandName>([
  'click_probe', 'save_as_pdf', 'download',
]);

export function registerBrowserControlTools(
  server: McpServer,
  client = new DaemonClient(),
  sessions = new McpSessionManager(),
): void {
  assertSchemaRegistryMatchesProtocol();
  registerControllerTools(server, client, sessions);
  registerDiagnosticTools(server, client, sessions);
}

function registerControllerTools(
  server: McpServer,
  client: DaemonClient,
  sessions: McpSessionManager,
): void {
  server.registerTool(
    'browser_control_command',
    {
      title: 'Browser Control command',
      description: [
        'Run any Browser Control protocol command.',
        'Input: command, optional args object, optional session, timeoutMs, and id.',
        'Output: CommandResult format with ok, summary, data, optional nextSteps.',
        'Session is managed automatically by this MCP server process.',
        'Before acting, call snapshot with filters (textIncludes, roles, viewportOnly) to get focused @e references.',
        'Use browser_control_close_session at the end of a task.',
      ].join('\n\n'),
      inputSchema: unifiedCommandInputSchema,
    },
    async (input) => {
      return runControllerCommand(
        input as Record<string, unknown>,
        client,
        sessions,
      );
    },
  );

  server.registerTool(
    'browser_control_close_session',
    {
      title: 'Browser Control close current session',
      description: [
        'Close the active Browser Control session and rotate to a new active session.',
        'Session is optional. Omit it to close the current MCP-managed active session.',
      ].join('\n\n'),
      inputSchema: closeSessionInputSchema,
    },
    async (input) => {
      const record = input as Record<string, unknown>;
      const session = sessions.resolveSession(record.session);
      const result = await controllerCloseSession(
        { session },
        client,
      );
      if (!result.ok) {
        return toCommandToolResult(result);
      }
      const nextActiveSession = sessions.rotateSession();
      return toCommandToolResult({
        ...result,
        data: {
          closed: true,
          activeSession: nextActiveSession,
          closedSession: session,
        },
        summary: `会话已关闭 | 当前活跃会话: ${nextActiveSession}`,
      });
    },
  );
}

function registerDiagnosticTools(
  server: McpServer,
  client: DaemonClient,
  sessions: McpSessionManager,
): void {
  server.registerTool(
    'browser_control_status',
    {
      title: 'Browser Control status',
      description:
        'Return Browser Control daemon status, compatibility diagnostics, and the current MCP-managed active session.',
      inputSchema: diagnosticInputSchema,
    },
    async () => {
      const lifecycle = await ensureDaemon(client);
      return toRawToolResult(
        { ...lifecycle, activeSession: sessions.getActiveSession() },
        !lifecycle.ok,
      );
    },
  );

  server.registerTool(
    'browser_control_doctor',
    {
      title: 'Browser Control doctor',
      description:
        'Return daemon health/status diagnostics for MCP setup troubleshooting.',
      inputSchema: diagnosticInputSchema,
    },
    async () => {
      const lifecycle = await ensureDaemon(client);
      const health = lifecycle.ok
        ? await client
            .health()
            .then((r) => r.data)
            .catch((error) => ({ error: (error as Error).message }))
        : null;
      return toRawToolResult(
        { lifecycle, health, activeSession: sessions.getActiveSession() },
        !lifecycle.ok,
      );
    },
  );
}

/**
 * 通过 Controller 层执行命令
 * 如果命令有 Controller 实现则使用 Controller，否则回落直连 daemon
 */
async function runControllerCommand(
  input: Record<string, unknown>,
  client: DaemonClient,
  sessions: McpSessionManager,
): Promise<CallToolResult> {
  const command = typeof input.command === 'string' ? input.command : '';
  const args = input.args === undefined ? {} : input.args;
  const session = sessions.resolveSession(input.session);

  if (!command) {
    return toCommandToolResult({
      ok: false,
      summary: '命令名不能为空',
    });
  }

  const controller = CONTROLLER_DISPATCH[command];
  if (controller) {
    // 注入 session 和 timeoutMs 到 args（Controller 的 buildEnvelope 会提取）
    const controllerArgs = {
      ...(args as Record<string, unknown>),
      session,
      timeoutMs:
        typeof input.timeoutMs === 'number' ? input.timeoutMs : undefined,
      id: typeof input.id === 'string' ? input.id : undefined,
    };
    const result = await controller(controllerArgs, client);

    // 如果是 close_session，需要轮换 session
    if (command === 'close_session' && result.ok) {
      const nextSession = sessions.rotateSession();
      return toCommandToolResult({
        ...result,
        data: {
          ...(result.data as Record<string, unknown>),
          activeSession: nextSession,
        },
        summary: `${result.summary} | 当前活跃会话: ${nextSession}`,
      });
    }

    return toCommandToolResult(result);
  }

  // 回落：未使用 Controller 的命令，直连 daemon
  if (!isCommandName(command)) {
    return toRawToolResult(unknownCommandResult(command, session), true);
  }
  return executeCommand(
    command,
    args as Record<string, unknown>,
    { id: input.id, timeoutMs: input.timeoutMs, session },
    client,
  );
}

/**
 * 将 CommandResult 转换为 MCP CallToolResult
 * content[0].text: summary（LLM 直接可读）
 * structuredContent: 完整结果（含 summary + data）
 */
function toCommandToolResult<T>(
  result: CommandResult<T>,
): CallToolResult {
  return {
    content: [
      {
        type: 'text',
        text: result.ok
          ? result.summary
          : `${result.summary}${result.nextSteps ? '\n\n下一步建议:\n' + result.nextSteps.map((s, i) => `${i + 1}. ${s}`).join('\n') : ''}`,
      },
    ],
    structuredContent: result as unknown as Record<string, unknown>,
    isError: !result.ok,
  };
}

/**
 * 将原始值转换为 MCP CallToolResult（保留原有行为）
 */
function toRawToolResult(
  value: unknown,
  isError = false,
): CallToolResult {
  const sc: Record<string, unknown> =
    value && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, unknown>
      : { result: value };
  return {
    content: [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    structuredContent: sc,
    isError,
  };
}

// ─── 以下为原有的回落逻辑（直连 daemon），未改动 ────────────────

async function executeCommand(
  command: CommandName,
  args: Record<string, unknown>,
  controls: { id?: unknown; timeoutMs?: unknown; session: string },
  client: DaemonClient,
): Promise<CallToolResult> {
  const envelope: BrowserControlEnvelope = {
    id:
      typeof controls.id === 'string' && controls.id
        ? controls.id
        : `mcp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    version: PROTOCOL_VERSION,
    session: controls.session,
    command,
    args,
    timeoutMs:
      typeof controls.timeoutMs === 'number' &&
      Number.isFinite(controls.timeoutMs) &&
      controls.timeoutMs > 0
        ? controls.timeoutMs
        : 30000,
  };
  return executeEnvelope(command, envelope, client);
}

async function executeEnvelope(
  command: CommandName,
  envelope: BrowserControlEnvelope,
  client: DaemonClient,
): Promise<CallToolResult> {
  const lifecycle = await ensureDaemon(client);
  if (!lifecycle.ok)
    return toRawToolResult(
      { ok: false, command, session: envelope.session, lifecycle },
      true,
    );
  const response = await client.command(envelope);
  const result = withCommandMetadata(command, envelope.session, response.data);
  return toRawToolResult(result, isErrorEnvelope(result));
}

const TARGET_COMMANDS = new Set<CommandName>([
  'click',
  'click_probe',
  'fill',
  'press',
  'scroll',
  'upload',
]);

function unknownCommandResult(
  command: string,
  session: string,
): Record<string, unknown> {
  const suggestions = commandSuggestions(command);
  return {
    ok: false,
    command,
    session,
    error: {
      code: 'UNKNOWN_COMMAND',
      message: command
        ? `Unknown Browser Control command "${command}".`
        : 'Browser Control command is required.',
      availableCommands: browserCommandNames(),
      suggestions,
    },
  };
}

function commandSuggestions(command: string): string[] {
  if (!command) return [];
  const normalized = command
    .replace(/([a-z])([A-Z])/g, '$1_$2')
    .replace(/[-\s]+/g, '_')
    .toLowerCase();
  const names = browserCommandNames();
  const exactNormalized = names.find((name) => name === normalized);
  if (exactNormalized) return [exactNormalized];
  return names
    .map((name) => ({ name, distance: levenshtein(normalized, name) }))
    .filter((candidate) => candidate.distance <= 4)
    .sort(
      (a, b) =>
        a.distance - b.distance || a.name.localeCompare(b.name),
    )
    .slice(0, 3)
    .map((candidate) => candidate.name);
}

function levenshtein(a: string, b: string): number {
  const previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    let diagonal = previous[0];
    previous[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const insert = previous[j] + 1;
      const remove = previous[j - 1] + 1;
      const replace =
        diagonal + (a[i - 1] === b[j - 1] ? 0 : 1);
      diagonal = previous[j];
      previous[j] = Math.min(insert, remove, replace);
    }
  }
  return previous[b.length];
}

function isCommandName(command: string): command is CommandName {
  return Object.prototype.hasOwnProperty.call(commandArgSchemas, command);
}

function withCommandMetadata(
  command: CommandName,
  session: string,
  value: Record<string, unknown>,
): Record<string, unknown> {
  const risk = riskNoteFor(command);
  return {
    ...value,
    command: typeof value.command === 'string' ? value.command : command,
    session: typeof value.session === 'string' ? value.session : session,
    ...(risk ? { riskNotes: [risk] } : {}),
  };
}

function isErrorEnvelope(value: unknown): boolean {
  return Boolean(
    value &&
      typeof value === 'object' &&
      (value as Record<string, unknown>).ok === false,
  );
}
