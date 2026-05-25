export const PROTOCOL_VERSION = '2026-05-19' as const;

export type BackendName = 'extension';
export type ArtifactKind = 'screenshot' | 'pdf' | 'download' | 'network' | 'observation' | 'snapshot';
export type ScrollLogicalPosition = 'start' | 'center' | 'end' | 'nearest';
export type ScrollBehavior = 'auto' | 'instant' | 'smooth';
export type ElementRef = `@e${string}_${number}`;
export type ClickTarget = ElementRef | `css=${string}`;
export type ClickAfter = 'auto' | 'none' | 'changes' | 'snapshot';
export type ElementTarget =
  | { elementRef: ElementRef; selector?: string }
  | { selector: string; elementRef?: ElementRef };
export type ErrorCode =
  | 'VALIDATION_ERROR'
  | 'UNKNOWN_COMMAND'
  | 'TIMEOUT'
  | 'BACKEND_UNAVAILABLE'
  | 'BACKEND_ERROR'
  | 'UNSUPPORTED'
  | 'NOT_FOUND';

export interface ArtifactRef {
  id: string;
  kind: ArtifactKind;
  path: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number | null;
  sha256?: string;
}

export interface ProtocolErrorShape {
  code: ErrorCode;
  message: string;
  retryable?: boolean;
  details?: unknown;
}

export interface CommandArgs {
  navigate: { url: string; newTab?: boolean; timeoutMs?: number };
  find_tab: { urlIncludes?: string; titleIncludes?: string; active?: boolean; attach?: boolean; tabId?: number };
  snapshot: { tabId?: number; roles?: string[]; tags?: string[]; hasVisibleText?: boolean; textIncludes?: string; viewportOnly?: boolean; boxes?: boolean };
  click: { target: ClickTarget; tabId?: number; after?: ClickAfter };
  click_probe: ElementTarget & { tabId?: number; strategy?: 'auto' | 'cdp_mouse' | 'dom_pointer' | 'element_click'; force?: boolean; button?: 'left' | 'middle' | 'right'; clickCount?: number; modifiers?: string[]; observeNewTab?: boolean; expectNewTab?: boolean; waitMs?: number; filter?: string; includeHeaders?: boolean; includeBody?: boolean; redactSensitive?: boolean; maxRequests?: number };
  fill: ElementTarget & { value: string; tabId?: number; strategy?: 'native_setter' | 'text_input' | 'paste_like'; clear?: boolean; commit?: 'change' | 'blur' | 'enter' | 'none'; expectChange?: boolean; observe?: ObserveOptions };
  press: { key: string; elementRef?: ElementRef; selector?: string; tabId?: number; strategy?: 'auto' | 'cdp_keyboard' | 'dom_keyboard'; modifiers?: string[]; expectChange?: boolean; observe?: ObserveOptions; observeNewTab?: boolean; expectNewTab?: boolean };
  scroll: { elementRef?: ElementRef; tabId?: number; selector?: string; strategy?: 'auto' | 'dom' | 'wheel'; deltaX?: number; deltaY?: number; x?: number; y?: number; region?: { x: number; y: number; width: number; height: number }; steps?: number; block?: ScrollLogicalPosition; behavior?: ScrollBehavior; waitMs?: number };
  wait_for: { selector?: string; text?: string; state?: 'visible' | 'attached' | 'hidden' | 'detached'; timeoutMs?: number; tabId?: number; expression?: string };
  evaluate: { code: string; tabId?: number };
  screenshot: { tabId?: number; format?: 'png' | 'jpeg'; quality?: number; fullPage?: boolean; file_name?: string; fileName?: string };
  save_as_pdf: { tabId?: number; paper_format?: 'A4' | 'Letter'; landscape?: boolean; scale?: number; print_background?: boolean; file_name?: string };
  observe_start: { tabId?: number; mode?: 'viewport_text'; baselineId?: string; includeNetworkMarker?: boolean; maxTextChars?: number; maxTextRuns?: number };
  observe_diff: { baselineId: string; tabId?: number; includeCurrent?: boolean; includeNetwork?: boolean; maxAdded?: number; maxRemoved?: number; maxSummaryChars?: number; allowStaleNavigationDiff?: boolean };
  network_start: { filter?: string; tabId?: number; scope?: 'session' | 'tab' };
  network_list: { filter?: string; sinceTimestampMs?: number; limit?: number; tabId?: number; method?: string; statusCode?: number; type?: string };
  network_detail: { requestId: string };
  network_stop: Record<string, never>;
  upload: ElementTarget & { files: string[]; tabId?: number };
  download: { url: string; filename?: string; saveAs?: boolean };
  get_text: { tabId?: number; scope?: 'viewport' | 'document' | 'full'; maxChars?: number; includeRuns?: boolean; selector?: string };
  list_tabs: Record<string, never>;
  close_tab: { tabId?: number };
  close_session: Record<string, never>;
}

export interface ObserveOptions {
  baselineId?: string;
  includeNetwork?: boolean;
  waitMs?: number;
  maxAdded?: number;
  maxRemoved?: number;
  maxSummaryChars?: number;
}

export interface NavigateResult {
  tabId: number;
  url: string | null;
  title: string | null;
  navigationComplete: boolean;
  warnings: string[];
  session: string;
  network?: {
    autoStarted: boolean;
    capture: string;
    query: string[];
  };
}

export interface SnapshotBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface SnapshotNode {
  role?: string;
  name?: string;
  ref?: ElementRef;
  tag: string;
  text?: string;
  props?: Record<string, string>;
  state?: Record<string, unknown>;
  box?: SnapshotBox;
  children?: Array<SnapshotNode | { text: string }>;
}

export interface SnapshotRef {
  ref: ElementRef;
  id: ElementRef;
  structureId: string;
  revision: number;
  role: string;
  name: string | null;
  tag: string;
  text: string | null;
  selector: string | null;
  testId: string | null;
  href: string | null;
  box: SnapshotBox;
  state?: Record<string, unknown>;
  attributes: {
    type: string | null;
    value: string | null;
    valueLength?: number | null;
    checked: boolean | null;
    placeholder: string | null;
    redacted?: boolean | null;
  };
}

export interface SnapshotResult {
  schemaVersion: 3;
  semantics: 'playwright-aria-ai-v1';
  snapshot: string;
  tree: SnapshotNode[];
  refs: SnapshotRef[];
  url: string;
  title: string;
  truncated?: boolean;
  artifact?: ArtifactRef | null;
  artifactPath?: string;
  omitted?: {
    fullSnapshot?: boolean;
    tree?: boolean;
    refs?: boolean;
  };
  caps?: {
    snapshotTextArtifactThreshold?: number;
    snapshotPreviewChars?: number;
    refPreviewLimit?: number;
    fullSnapshotChars?: number;
    fullRefs?: number;
  };
  stats: {
    visited: number;
    emitted: number;
    text: number;
    refs: number;
    filtered: number;
    frames: number;
    inaccessibleFrames: number;
    returned: number;
    truncated: boolean;
  };
  filters: {
    roles: string[] | null;
    tags: string[] | null;
    hasVisibleText: boolean;
    textIncludes: string | null;
    viewportOnly: boolean;
    boxes?: boolean;
  };
  guidance: {
    refFormat: string;
    refLifetime: string;
    textReading: string;
    filtering?: string[];
  };
}

export type CommandName = keyof CommandArgs;

export interface CommandEnvelope<C extends CommandName = CommandName> {
  id: string;
  version: typeof PROTOCOL_VERSION | string;
  session: string;
  command: C;
  args: CommandArgs[C];
  timeoutMs: number;
}

export interface ResultEnvelope<TData = unknown> {
  id: string;
  ok: boolean;
  command: CommandName | string;
  backend: BackendName;
  session: string;
  tab: number | null;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  data: TData | null;
  artifacts: ArtifactRef[];
  error: ProtocolErrorShape | null;
  diagnostics: Record<string, unknown> | null;
}


export const COMMAND_NAMES: readonly CommandName[] = [
  'navigate', 'find_tab', 'snapshot', 'click', 'click_probe', 'fill', 'press', 'scroll', 'wait_for',
  'evaluate', 'screenshot', 'save_as_pdf', 'observe_start', 'observe_diff', 'network_start', 'network_list', 'network_detail',
  'network_stop', 'upload', 'download', 'get_text', 'list_tabs', 'close_tab', 'close_session'
] as const;
