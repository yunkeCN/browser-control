import { z } from 'zod/v4';
import { COMMANDS } from './protocol.js';

const envelopeSchema = {
  session: z.string().min(1).optional().describe('Optional Browser Control logical session name. Omit to use the MCP-managed active session.'),
  timeoutMs: z.number().positive().optional().describe('Overall command timeout in milliseconds. Defaults to 30000.'),
  id: z.string().min(1).optional().describe('Optional caller-provided request id.')
};

const tabId = z.number().int().positive().optional();
const selector = z.string().min(1);
const elementTarget = z.string().min(1).refine(value => /^@e[^\s_]+_\d+$/.test(value) || (value.startsWith('css=') && value.slice(4).trim().length > 0), {
  message: 'must be an @e<structureId>_<revision> reference from snapshot or an explicit css=<selector> fallback'
});
const observeOptions = z.object({
  baselineId: z.string().optional(),
  includeNetwork: z.boolean().optional(),
  waitMs: z.number().nonnegative().optional(),
  maxAdded: z.number().int().positive().optional(),
  maxRemoved: z.number().int().positive().optional(),
  maxSummaryChars: z.number().int().positive().optional()
}).strict();

export const commandArgSchemas = {
  navigate: z.object({
    url: z.string().min(1),
    newTab: z.boolean().optional(),
    timeoutMs: z.number().positive().optional()
  }).strict(),
  find_tab: z.object({
    urlIncludes: z.string().optional(),
    titleIncludes: z.string().optional(),
    active: z.boolean().optional(),
    tabId,
    attach: z.boolean().optional()
  }).strict(),
  snapshot: z.object({
    tabId,
    roles: z.array(z.string()).optional(),
    tags: z.array(z.string()).optional(),
    hasVisibleText: z.boolean().optional(),
    textIncludes: z.string().optional(),
    viewportOnly: z.boolean().optional(),
    boxes: z.boolean().optional()
  }).strict(),
  click: z.object({
    target: elementTarget,
    tabId,
    after: z.enum(['auto', 'none', 'changes', 'snapshot']).optional()
  }).strict(),
  click_probe: z.object({
    target: elementTarget,
    tabId,
    strategy: z.enum(['auto', 'cdp_mouse', 'dom_pointer', 'element_click']).optional(),
    force: z.boolean().optional(),
    button: z.enum(['left', 'middle', 'right']).optional(),
    clickCount: z.number().int().positive().optional(),
    modifiers: z.array(z.string()).optional(),
    observeNewTab: z.boolean().optional(),
    expectNewTab: z.boolean().optional(),
    waitMs: z.number().nonnegative().optional(),
    filter: z.string().optional(),
    includeHeaders: z.boolean().optional(),
    includeBody: z.boolean().optional(),
    redactSensitive: z.boolean().optional(),
    maxRequests: z.number().int().positive().optional()
  }).strict(),
  fill: z.object({
    target: elementTarget,
    value: z.string(),
    tabId,
    strategy: z.enum(['native_setter', 'text_input', 'paste_like']).optional(),
    clear: z.boolean().optional(),
    commit: z.enum(['change', 'blur', 'enter', 'none']).optional(),
    expectChange: z.boolean().optional(),
    observe: observeOptions.optional()
  }).strict(),
  press: z.object({
    key: z.string().min(1),
    target: elementTarget.optional(),
    tabId,
    strategy: z.enum(['auto', 'cdp_keyboard', 'dom_keyboard']).optional(),
    modifiers: z.array(z.string()).optional(),
    expectChange: z.boolean().optional(),
    observe: observeOptions.optional(),
    observeNewTab: z.boolean().optional(),
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
  screenshot: z.object({
    tabId,
    format: z.enum(['png', 'jpeg']).optional(),
    quality: z.number().min(0).max(100).optional(),
    fullPage: z.boolean().optional(),
    file_name: z.string().optional(),
    fileName: z.string().optional()
  }).strict(),
  save_as_pdf: z.object({
    tabId,
    paper_format: z.enum(['A4', 'Letter']).optional(),
    landscape: z.boolean().optional(),
    scale: z.number().positive().optional(),
    print_background: z.boolean().optional(),
    file_name: z.string().optional()
  }).strict(),
  observe_start: z.object({
    tabId,
    mode: z.enum(['viewport_text']).optional(),
    baselineId: z.string().optional(),
    includeNetworkMarker: z.boolean().optional(),
    maxTextChars: z.number().int().positive().optional(),
    maxTextRuns: z.number().int().positive().optional()
  }).strict(),
  observe_diff: z.object({
    baselineId: z.string().min(1),
    tabId,
    includeCurrent: z.boolean().optional(),
    includeNetwork: z.boolean().optional(),
    maxAdded: z.number().int().positive().optional(),
    maxRemoved: z.number().int().positive().optional(),
    maxSummaryChars: z.number().int().positive().optional(),
    allowStaleNavigationDiff: z.boolean().optional()
  }).strict(),
  network_start: z.object({ filter: z.string().optional(), tabId, scope: z.enum(['session', 'tab']).optional() }).strict(),
  network_list: z.object({
    filter: z.string().optional(),
    sinceTimestampMs: z.number().nonnegative().optional(),
    limit: z.number().int().positive().optional(),
    tabId,
    method: z.string().optional(),
    statusCode: z.number().int().optional(),
    type: z.string().optional()
  }).strict(),
  network_detail: z.object({ requestId: z.string().min(1) }).strict(),
  network_stop: z.object({}).strict(),
  upload: z.object({ target: elementTarget, files: z.array(z.string().min(1)), tabId }).strict(),
  download: z.object({ url: z.string().min(1), filename: z.string().optional(), saveAs: z.boolean().optional() }).strict(),
  get_text: z.object({
    tabId,
    scope: z.enum(['viewport', 'document', 'full']).optional(),
    maxChars: z.number().int().positive().optional(),
    includeRuns: z.boolean().optional(),
    selector: selector.optional()
  }).strict(),
  list_tabs: z.object({}).strict(),
  close_tab: z.object({ tabId }).strict(),
  close_session: z.object({}).strict()
} as const;

export type CommandName = keyof typeof commandArgSchemas;

export const diagnosticInputSchema = z.object({}).strict();

export const unifiedCommandInputSchema = z.object({
  command: z.string().min(1).describe('Browser Control protocol command name, for example "snapshot", "click", or "get_text".'),
  args: z.record(z.string(), z.unknown()).optional().describe('Command-specific arguments. Defaults to {}.'),
  ...envelopeSchema
}).strict();

export const closeSessionInputSchema = z.object(envelopeSchema).strict();

export function assertSchemaRegistryMatchesProtocol(): void {
  const schemaCommands = Object.keys(commandArgSchemas).sort();
  const protocolCommands = Object.keys(COMMANDS).sort();
  if (schemaCommands.join('\n') !== protocolCommands.join('\n')) {
    throw new Error(`MCP schema registry drift: schema=${schemaCommands.join(',')} protocol=${protocolCommands.join(',')}`);
  }
  for (const command of protocolCommands) {
    const schema = commandArgSchemas[command as CommandName];
    const shape = schema.shape;
    const required = new Set(COMMANDS[command].required || []);
    const optional = new Set(COMMANDS[command].optional || []);
    const requiredOneOf = new Set(COMMANDS[command].requiredOneOf || []);
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
