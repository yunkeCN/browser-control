export const PROTOCOL_VERSION = '2026-05-19' as const;

export type BackendName = 'extension';
export type ArtifactKind = 'screenshot' | 'pdf' | 'download' | 'network' | 'observation';
export type ScrollLogicalPosition = 'start' | 'center' | 'end' | 'nearest';
export type ScrollBehavior = 'auto' | 'instant' | 'smooth';
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
  snapshot: { tabId?: number; maxDepth?: number; roles?: string[]; tags?: string[]; hasVisibleText?: boolean; textIncludes?: string; viewportOnly?: boolean; maxElements?: number };
  click: { selector: string; tabId?: number; strategy?: 'auto' | 'cdp_mouse' | 'dom_pointer' | 'element_click'; force?: boolean; button?: 'left' | 'middle' | 'right'; clickCount?: number; modifiers?: string[]; expectChange?: boolean; observe?: ObserveOptions; observeNewTab?: boolean; expectNewTab?: boolean };
  fill: { selector: string; value: string; tabId?: number; strategy?: 'native_setter' | 'text_input' | 'paste_like'; clear?: boolean; commit?: 'change' | 'blur' | 'enter' | 'none'; expectChange?: boolean; observe?: ObserveOptions };
  press: { key: string; selector?: string; tabId?: number; strategy?: 'auto' | 'cdp_keyboard' | 'dom_keyboard'; modifiers?: string[]; expectChange?: boolean; observe?: ObserveOptions; observeNewTab?: boolean; expectNewTab?: boolean };
  scroll: { tabId?: number; selector?: string; strategy?: 'auto' | 'dom' | 'wheel'; deltaX?: number; deltaY?: number; x?: number; y?: number; region?: { x: number; y: number; width: number; height: number }; steps?: number; block?: ScrollLogicalPosition; behavior?: ScrollBehavior; waitMs?: number };
  select_option: { selector: string; value: string; tabId?: number };
  set_checked: { selector: string; checked: boolean; tabId?: number };
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
  upload: { selector: string; files: string[]; tabId?: number };
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

export interface SnapshotElement {
  id: string;
  tag: string;
  role: string;
  name: string;
  description: string;
  cssSelector: string;
  testId: string | null;
  href: string | null;
  visibleText: string | null;
  boundingBox: { x: number; y: number; width: number; height: number };
  enabled: boolean;
  visible: boolean;
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
  schemaVersion: 2;
  semantics: 'compact-dom-v2';
  elements: SnapshotElement[];
  url: string;
  title: string;
  stats: {
    scanned: number;
    matched: number;
    returned: number;
    truncated: boolean;
  };
  totalBeforeFilter: number;
  returned: number;
  truncated: boolean;
  filters: {
    maxDepth: number | null;
    roles: string[] | null;
    tags: string[] | null;
    hasVisibleText: boolean;
    textIncludes: string | null;
    viewportOnly: boolean;
    maxElements: number | null;
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
  'navigate', 'find_tab', 'snapshot', 'click', 'fill', 'press', 'scroll', 'select_option', 'set_checked', 'wait_for',
  'evaluate', 'screenshot', 'save_as_pdf', 'observe_start', 'observe_diff', 'network_start', 'network_list', 'network_detail',
  'network_stop', 'upload', 'download', 'get_text', 'list_tabs', 'close_tab', 'close_session'
] as const;
