import { z } from 'zod/v4';
import { COMMANDS } from './protocol.js';

const envelopeFields = {
  session: z.string().min(1).optional().describe('Optional Browser Control logical session name. Omit to use the MCP-managed active session.'),
  timeoutMs: z.number().positive().optional().describe('Overall command timeout in milliseconds. Defaults to 30000.'),
};

const tabId = z.number().int().positive().optional();
const selector = z.string().min(1);
const elementTarget = z.string().min(1).refine(value => /^@e[^\s_]+_\d+$/.test(value) || (value.startsWith('css=') && value.slice(4).trim().length > 0), {
  message: 'must be an @e<structureId>_<revision> reference from snapshot or an explicit css=<selector> fallback'
});
const observeOptions = z.object({
  baselineId: z.string().optional().describe('Snapshot baseline ID to diff against after the action.'),
  includeNetwork: z.boolean().optional().describe('Include network activity in observation diagnostics.'),
  waitMs: z.number().nonnegative().optional().describe('Milliseconds to wait before observing changes.'),
  maxAdded: z.number().int().positive().optional().describe('Max added elements to report.'),
  maxRemoved: z.number().int().positive().optional().describe('Max removed elements to report.'),
  maxSummaryChars: z.number().int().positive().optional().describe('Max characters for observation summary.')
}).strict().describe('Post-action observation options. Captures DOM/network changes after the action completes.');

/** Per-command argument schemas (without envelope fields) */
export const commandArgSchemas = {
  navigate: z.object({
    url: z.string().min(1),
    newTab: z.boolean().optional(),
    timeoutMs: z.number().positive().optional()
  }).strict(),
  tabs: z.object({
    action: z.enum(['list', 'switch', 'close']).optional().describe('Tab operation. Defaults to "list".'),
    urlIncludes: z.string().optional().describe('URL substring filter for switch.'),
    titleIncludes: z.string().optional().describe('Title substring filter for switch.'),
    active: z.boolean().optional().describe('Filter by active state for switch.'),
    tabId,
  }).strict(),
  snapshot: z.object({
    tabId,
    roles: z.array(z.string()).optional(),
    tags: z.array(z.string()).optional(),
    hasVisibleText: z.boolean().optional(),
    textIncludes: z.string().optional(),
    viewportOnly: z.boolean().optional(),
    boxes: z.boolean().optional(),
    diff_to: z.string().optional().describe('Compare current snapshot against a previous snapshot baseline ID. Returns structured added/removed/changed diff.')
  }).strict(),
  click: z.object({
    target: elementTarget.optional().describe('Element reference (@e ref or css= selector). Mutually exclusive with text.'),
    text: z.string().min(1).optional().describe('Text to match on page. Mutually exclusive with target. Requires x and y.'),
    x: z.number().optional().describe('X viewport coordinate. Required when using text mode.'),
    y: z.number().optional().describe('Y viewport coordinate. Required when using text mode.'),
    roles: z.array(z.string()).optional().describe('ARIA roles filter for text mode.'),
    tabId,
    force: z.boolean().optional().describe('Skip visibility checks.'),
    interceptRequests: z.object({
      filter: z.string().optional().describe('URL substring for matching API requests to intercept.'),
      includeHeaders: z.boolean().optional().describe('Include request headers in intercepted requests.'),
      includeBody: z.boolean().optional().describe('Include request body in intercepted requests.'),
      redactSensitive: z.boolean().optional().describe('Redact sensitive data in intercepted requests.'),
      maxRequests: z.number().int().positive().optional().describe('Maximum number of intercepted requests to return.'),
    }).strict().optional().describe('Use this when you need to inspect the API requests and request parameters triggered by a click, but do not want matching requests to actually reach the server. This is not a dry run: the page click still happens, while matching requests are blocked and returned.'),
  }).strict(),
  fill: z.object({
    target: elementTarget,
    value: z.string(),
    tabId,
    strategy: z.enum(['native_setter', 'text_input', 'paste_like']).optional(),
    clear: z.boolean().optional(),
    commit: z.enum(['change', 'blur', 'enter', 'none']).optional(),
    expectChange: z.boolean().optional().describe('Hint that the action should cause visible page changes. When true, the response includes observation diagnostics.'),
    observe: observeOptions.optional()
  }).strict(),
  press: z.object({
    key: z.string().min(1),
    target: elementTarget.optional(),
    tabId,
    strategy: z.enum(['auto', 'cdp_keyboard', 'dom_keyboard']).optional(),
    modifiers: z.array(z.string()).optional(),
    expectChange: z.boolean().optional().describe('Hint that the action should cause visible page changes. When true, the response includes observation diagnostics.'),
    observe: observeOptions.optional(),
    observeNewTab: z.boolean().optional().describe('Observe changes in a newly opened tab instead of the current tab.'),
    expectNewTab: z.boolean().optional()
  }).strict(),
  scroll: z.object({
    target: elementTarget.optional(),
    tabId,
    strategy: z.enum(['auto', 'dom', 'wheel']).optional(),
    deltaX: z.number().optional(),
    deltaY: z.number().optional(),
    x: z.number().optional(),
    y: z.number().optional(),
    region: z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() }).strict().optional(),
    steps: z.number().int().positive().optional(),
    block: z.enum(['start', 'center', 'end', 'nearest']).optional(),
    behavior: z.enum(['auto', 'instant', 'smooth']).optional(),
    waitMs: z.number().nonnegative().optional()
  }).strict(),
  wait_for: z.object({
    selector: selector.optional(),
    text: z.string().optional(),
    state: z.enum(['visible', 'attached', 'hidden', 'detached']).optional(),
    timeoutMs: z.number().positive().optional(),
    tabId,
    expression: z.string().optional()
  }).strict(),
  evaluate: z.object({ code: z.string().min(1), tabId }).strict(),
  capture: z.object({
    format: z.enum(['png', 'jpeg', 'pdf']).optional().describe('Output format. Defaults to "png".'),
    tabId,
    fileName: z.string().optional().describe('Custom output file name.'),
    quality: z.number().min(0).max(100).optional().describe('JPEG quality 0-100. Only for jpeg format.'),
    paperFormat: z.enum(['A4', 'Letter']).optional().describe('Paper format for PDF.'),
    landscape: z.boolean().optional().describe('Landscape orientation for PDF.'),
    scale: z.number().positive().optional().describe('Scale factor for PDF.'),
    printBackground: z.boolean().optional().describe('Print background for PDF.'),
  }).strict(),
  network: z.object({
    action: z.enum(['list', 'detail']).describe('Network query operation.'),
    filter: z.string().optional().describe('URL substring filter for list.'),
    tabId,
    limit: z.number().int().positive().optional().describe('Max requests for list. Defaults to 100.'),
    method: z.string().optional().describe('HTTP method filter for list.'),
    statusCode: z.number().int().optional().describe('Status code filter for list.'),
    requestId: z.string().min(1).optional().describe('Request ID for detail (required for detail action).'),
  }).strict(),
  upload: z.object({ target: elementTarget, files: z.array(z.string().min(1)), tabId }).strict(),
  download: z.object({ url: z.string().min(1), filename: z.string().optional(), saveAs: z.boolean().optional() }).strict(),
  get_text: z.object({
    tabId,
    scope: z.enum(['viewport', 'document', 'full']).optional(),
    maxChars: z.number().int().positive().optional(),
    includeRuns: z.boolean().optional(),
    selector: selector.optional()
  }).strict(),
  close_session: z.object({}).strict()
} as const;

export type CommandName = keyof typeof commandArgSchemas;

/**
 * Per-tool input schemas: command args + envelope fields (session, timeoutMs).
 * Each tool gets its own fully-typed schema visible to LLM.
 */
export const toolInputSchemas = Object.fromEntries(
  Object.entries(commandArgSchemas).map(([cmd, argSchema]) => [
    cmd,
    argSchema.extend(envelopeFields),
  ])
) as { [K in CommandName]: ReturnType<(typeof commandArgSchemas)[K]['extend']> };

export const diagnosticInputSchema = z.object({}).strict();

export const closeSessionInputSchema = z.object(envelopeFields).strict();

export function assertSchemaRegistryMatchesProtocol(): void {
  const schemaCommands = new Set(Object.keys(commandArgSchemas));
  const protocolCommands = new Set(Object.keys(COMMANDS));
  // Every MCP schema command must exist in the protocol
  for (const cmd of schemaCommands) {
    if (!protocolCommands.has(cmd)) {
      throw new Error(`MCP schema has command "${cmd}" not found in protocol`);
    }
  }
  // Validate field-level consistency for MCP-exposed commands
  for (const command of schemaCommands) {
    const schema = commandArgSchemas[command as CommandName];
    const shape = schema.shape;
    const spec = COMMANDS[command];
    const required = new Set(spec.required || []);
    const optional = new Set(spec.optional || []);
    const requiredOneOf = new Set(spec.requiredOneOf || []);
    const schemaFields = new Set(Object.keys(shape));
    for (const field of required) {
      if (!schemaFields.has(field)) throw new Error(`MCP schema for ${command} missing required field ${field}`);
      const fieldSchema = shape[field as keyof typeof shape] as z.ZodType;
      if (fieldSchema.safeParse(undefined).success) throw new Error(`MCP schema for ${command}.${field} is optional but protocol requires it`);
    }
    for (const field of optional) {
      if (!schemaFields.has(field)) throw new Error(`MCP schema for ${command} missing optional field ${field}`);
    }
    for (const field of requiredOneOf) {
      if (!schemaFields.has(field)) throw new Error(`MCP schema for ${command} missing requiredOneOf field ${field}`);
    }
  }
}
