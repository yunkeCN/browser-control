// Shared Browser Control extension type boundaries.
// These types intentionally model the loose daemon/extension protocol without
// changing runtime behavior during the mechanical JS -> TS migration.

export type SessionName = string;
export type RequestId = number | string;
export type CommandArgs = Record<string, any>;
export type CommandResult = any;

export type CommandAction =
  | 'navigate'
  | 'snapshot'
  | 'click'
  | 'fill'
  | 'press'
  | 'scroll'
  | 'select_option'
  | 'set_checked'
  | 'wait_for'
  | 'find_tab'
  | 'evaluate'
  | 'screenshot'
  | 'observe_capture'
  | 'network'
  | 'upload'
  | 'download'
  | 'save_as_pdf'
  | 'get_text'
  | 'attach_tab'
  | 'list_tabs'
  | 'close_tab'
  | 'close_session';

export interface DaemonCommandMessage {
  type: 'command';
  requestId: RequestId;
  session: SessionName;
  action: CommandAction;
  args?: CommandArgs;
}

export interface DaemonResponseMessage {
  type: 'response';
  requestId: RequestId;
  data?: unknown;
  error?: string;
}

export type DaemonMessage = DaemonCommandMessage | DaemonResponseMessage | CommandArgs;

export interface ArtifactHint {
  schemaVersion: string;
  backend: 'extension';
  kind: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number | null;
  encoding: string | null;
  source: {
    session: SessionName | null;
    tabId: number | null;
    url: string | null;
    title: string | null;
  };
  createdAt: string;
}

export interface PendingRequest {
  resolve(value: unknown): void;
  reject(reason?: unknown): void;
  timer: ReturnType<typeof setTimeout>;
}

export interface TabMetadata {
  tabId?: number | null;
  windowId?: number | null;
  url?: string | null;
  title?: string | null;
}

export interface ExtensionRuntimeMetadata {
  layer: 'extension';
  name: string;
  version: string;
  manifestVersion: number;
  protocolVersion: string;
  artifactSchemaVersion: string;
  build: {
    channel: 'source';
    source: 'extension';
  };
  capabilities: readonly string[];
}

export interface NetworkCapture {
  requests: NetworkRequest[];
  filter?: string | null;
  tabId?: number | null;
  tabIds?: number[];
  scope?: 'session' | 'tab';
  auto?: boolean;
  persistedAt?: string | null;
  debuggerAttachedTabId?: number | null;
  debuggerAttachedTabIds?: number[];
}

export interface NetworkRequest {
  id: string;
  status?: string;
  webRequestId?: string;
  cdpRequestId?: string;
  url?: string;
  method?: string | null;
  requestHeaders?: Record<string, unknown> | null;
  requestBody?: unknown;
  responseHeaders?: unknown;
  body?: string | null;
  json?: unknown;
  bodyError?: string | null;
  bodyLength?: number;
  base64Encoded?: boolean;
  timestamp?: number;
  timestampMs?: number;
  wallTime?: number | null;
  type?: string | null;
  source?: string;
  tabId?: number;
  statusCode?: number;
  statusText?: string;
  mimeType?: string | null;
  encodedDataLength?: number;
  errorText?: string | null;
  canceled?: boolean;
}

export interface ActionDebuggerLease {
  debuggee?: any;
  temporary?: boolean;
  owner?: string;
  error?: string;
  recoverable?: boolean;
  warnings?: string[];
}
