/**
 * MCP 工具定义 — 每个命令独立注册为 MCP 工具
 *
 * 每个工具拥有：
 * - 完整的 typed inputSchema（对 LLM 可见）
 * - MCP annotations（readOnlyHint / destructiveHint / openWorldHint）
 * - 针对性的 description
 */

import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import { DaemonClient } from './daemon-client.js';
import {
  assertSchemaRegistryMatchesProtocol,
  toolInputSchemas,
  diagnosticInputSchema,
  closeSessionInputSchema,
} from './schema.js';
import { ensureDaemon } from './daemon-lifecycle.js';
import { McpSessionManager } from './session-manager.js';

// Controller imports
import { navigate } from '../controller/commands/navigate.js';
import { snapshot } from '../controller/commands/snapshot.js';
import { click } from '../controller/commands/click.js';
import { fill } from '../controller/commands/fill.js';
import { press } from '../controller/commands/press.js';
import { scroll } from '../controller/commands/scroll.js';
import { upload } from '../controller/commands/upload.js';
import { getText } from '../controller/commands/get-text.js';
import { capture } from '../controller/commands/capture.js';
import { evaluate } from '../controller/commands/evaluate.js';
import { waitFor } from '../controller/commands/wait-for.js';
import { network } from '../controller/commands/network.js';
import { tabs } from '../controller/commands/tabs.js';
import { closeSession as controllerCloseSession } from '../controller/commands/session.js';
import { download } from '../controller/commands/download.js';
import type { CommandResult } from '../controller/types.js';

// ─── Types ───────────────────────────────────────────────────────

type ControllerFn = (args: Record<string, unknown>, client: DaemonClient) => Promise<CommandResult<unknown>>;

interface ToolDef {
  command: string;
  title: string;
  description: string;
  annotations?: ToolAnnotations;
  controller: ControllerFn;
}

// ─── Tool definitions ────────────────────────────────────────────

const TOOL_DEFS: ToolDef[] = [
  {
    command: 'navigate',
    title: 'Navigate to URL',
    description:
      'Navigate the browser to a URL.\n'
      + 'Returns the final URL, page title, and tab ID after navigation completes.',
    annotations: { openWorldHint: true },
    controller: navigate,
  },
  {
    command: 'tabs',
    title: 'Manage browser tabs',
    description:
      'List, switch, or close browser tabs.\n'
      + 'action: "list" (default) returns all tabs. "switch" finds and activates a tab by URL/title. "close" closes a tab (destructive).',
    annotations: { destructiveHint: true },
    controller: tabs,
  },
  {
    command: 'snapshot',
    title: 'Capture page snapshot',
    description:
      'Capture the page accessibility tree with @e element references.\n'
      + 'Use @e refs as target for browser_click/browser_fill/browser_press/browser_scroll.\n'
      + 'Filter with roles, tags, textIncludes, hasVisibleText, viewportOnly to narrow results.\n'
      + 'diff_to is a two-step mechanism: first call with an ID stores the baseline (returns a normal snapshot); second call with the same ID returns the structured diff (added/removed/changed elements). Do not expect diff output on the first call.\n'
      + '@e refs become stale after page changes — always re-snapshot before the next interaction.',
    annotations: { readOnlyHint: true },
    controller: snapshot,
  },
  {
    command: 'get_text',
    title: 'Get page text',
    description:
      'Extract text content from the page.\n'
      + 'scope: "viewport" (default, visible text), "full" (all rendered text excluding hidden), "document" (raw innerText).',
    annotations: { readOnlyHint: true },
    controller: getText,
  },
  {
    command: 'click',
    title: 'Click element',
    description:
      'Click a page element. Three modes:\n'
      + 'Prefer target mode with @e refs from browser_snapshot whenever possible; use text + position only as a fallback when no reliable ref is available.\n'
      + '1. By @e ref: { target: "@eabc_1" } — recommended; use refs from browser_snapshot.\n'
      + '2. Intercept requests: { target: "@eabc_1", interceptRequests: { filter: "/api/", includeBody: true } } — use when you need to inspect API requests and request parameters triggered by a click, but do not want matching requests to actually reach the server.\n'
      + '3. By text + position: { text: "Submit", x: 200, y: 300 } — x and y are required in text mode.\n'
      + 'target and text are mutually exclusive; provide one.',
    annotations: { destructiveHint: true },
    controller: click,
  },
  {
    command: 'fill',
    title: 'Fill form field',
    description:
      'Type a value into a form field.\n'
      + 'strategy: "native_setter" (default). "text_input" and "paste_like" are accepted for forward compatibility but currently behave as native_setter.\n'
      + 'commit: "change" (default, triggers change event), "blur", "enter" (submits), "none" (value only).\n'
      + 'If value not applied, try a different commit mode ("blur", "enter") or use browser_evaluate as fallback.\n'
      + 'Set expectChange: true to get post-action observation diagnostics.',
    annotations: { destructiveHint: true },
    controller: fill,
  },
  {
    command: 'press',
    title: 'Press keyboard key',
    description:
      'Press a keyboard key, optionally on a specific element.\n'
      + 'Common keys: Enter, Tab, Escape, ArrowDown, Backspace.\n'
      + 'modifiers: ["Control", "Shift", "Alt", "Meta"] for shortcuts.\n'
      + 'Set expectChange: true to get post-action observation diagnostics.',
    annotations: { destructiveHint: true },
    controller: press,
  },
  {
    command: 'scroll',
    title: 'Scroll page',
    description:
      'Scroll the page or a specific element.\n'
      + 'deltaY: positive scrolls down, negative scrolls up. deltaX for horizontal.\n'
      + 'strategy: "auto" (default), "dom" (element.scrollBy), "wheel" (wheel events).',
    controller: scroll,
  },
  {
    command: 'wait_for',
    title: 'Wait for condition',
    description:
      'Wait for an element or text to appear/disappear on the page.\n'
      + 'Provide selector, text, and/or expression. state: "visible" (default), "attached", "hidden", "detached".',
    annotations: { readOnlyHint: true },
    controller: waitFor,
  },
  {
    command: 'capture',
    title: 'Capture page visually',
    description:
      'Take a screenshot or save page as PDF.\n'
      + 'format: "png" (default), "jpeg", "pdf".\n'
      + 'For jpeg: quality (0-100). For pdf: paperFormat, landscape, scale, printBackground.',
    controller: capture,
  },
  {
    command: 'evaluate',
    title: 'Execute JavaScript',
    description:
      'Execute JavaScript code in the page context.\n'
      + 'Returns the evaluation result. Can access DOM, cookies, localStorage.',
    annotations: { destructiveHint: true },
    controller: evaluate,
  },
  {
    command: 'network',
    title: 'Query network requests',
    description:
      'Query captured network requests. Monitoring starts automatically on navigate.\n'
      + 'action: "list" (show captured same-origin API requests), "detail" (inspect one request by requestId).\n'
      + 'Only same-origin xhr/fetch requests are captured. Each tab keeps last 100 requests.',
    annotations: { readOnlyHint: true },
    controller: network,
  },
  {
    command: 'upload',
    title: 'Upload files',
    description:
      'Upload local files to a file input element.\n'
      + 'target: @e ref or css= selector for the file input. files: array of absolute file paths.',
    annotations: { destructiveHint: true },
    controller: upload,
  },
  {
    command: 'download',
    title: 'Download file',
    description:
      'Download a file from a URL through Chrome.\n'
      + 'Returns the local file path after download completes.',
    controller: download,
  },
  {
    command: 'close_session',
    title: 'Close browser session',
    description:
      'Close the active Browser Control session and rotate to a new active session.',
    controller: controllerCloseSession,
  },
];

// ─── Registration ────────────────────────────────────────────────

export function implementedCommandNames(): string[] {
  return TOOL_DEFS.map(d => d.command);
}

export function registerBrowserControlTools(
  server: McpServer,
  client = new DaemonClient(),
  sessions = new McpSessionManager(),
): void {
  assertSchemaRegistryMatchesProtocol();

  // Register each command as an independent tool
  for (const def of TOOL_DEFS) {
    const schema = toolInputSchemas[def.command as keyof typeof toolInputSchemas];
    server.registerTool(
      `browser_${def.command}`,
      {
        title: def.title,
        description: def.description,
        annotations: def.annotations,
        inputSchema: schema,
      },
      async (input) => {
        return runTool(def.command, input as Record<string, unknown>, def.controller, client, sessions);
      },
    );
  }

  // Diagnostic tools
  server.registerTool(
    'browser_status',
    {
      title: 'Browser Control status',
      description: 'Return Browser Control daemon status, compatibility diagnostics, and the current MCP-managed active session.',
      annotations: { readOnlyHint: true },
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
    'browser_doctor',
    {
      title: 'Browser Control doctor',
      description: 'Return daemon health/status diagnostics for MCP setup troubleshooting.',
      annotations: { readOnlyHint: true },
      inputSchema: diagnosticInputSchema,
    },
    async () => {
      const lifecycle = await ensureDaemon(client);
      const health = lifecycle.ok
        ? await client.health().then(r => r.data).catch(error => ({ error: (error as Error).message }))
        : null;
      return toRawToolResult(
        { lifecycle, health, activeSession: sessions.getActiveSession() },
        !lifecycle.ok,
      );
    },
  );
}

// ─── Execution ───────────────────────────────────────────────────

async function runTool(
  command: string,
  input: Record<string, unknown>,
  controller: ControllerFn,
  client: DaemonClient,
  sessions: McpSessionManager,
): Promise<CallToolResult> {
  const session = sessions.resolveSession(input.session);

  // Inject session and timeoutMs into args for controller's buildEnvelope
  const args = {
    ...input,
    session,
    timeoutMs: typeof input.timeoutMs === 'number' ? input.timeoutMs : undefined,
  };
  // Remove envelope fields from args so they don't leak into command validation
  delete args.session;
  delete args.timeoutMs;

  const controllerArgs = {
    ...args,
    session,
    timeoutMs: typeof input.timeoutMs === 'number' ? input.timeoutMs : undefined,
  };

  const result = await controller(controllerArgs, client);

  // Handle close_session rotation
  if (command === 'close_session' && result.ok) {
    const nextSession = sessions.rotateSession();
    return toCommandToolResult({
      ...result,
      activeSession: nextSession,
      summary: `${result.summary} | Active session: ${nextSession}`,
    });
  }

  return toCommandToolResult(result);
}

// ─── Result conversion ───────────────────────────────────────────

function toRawToolResult(value: unknown, isError = false): CallToolResult {
  const sc = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : { result: value };
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }], structuredContent: sc, isError };
}

function toCommandToolResult<T>(result: CommandResult<T>): CallToolResult {
  return {
    content: [
      {
        type: 'text',
        text: result.ok
          ? result.summary
          : `${result.summary}${result.nextSteps ? '\n\nNext steps:\n' + result.nextSteps.map((s, i) => `${i + 1}. ${s}`).join('\n') : ''}`,
      },
    ],
    structuredContent: result as unknown as Record<string, unknown>,
    isError: !result.ok,
  };
}
