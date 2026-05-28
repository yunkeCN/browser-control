import { NETWORK_API_RESOURCE_TYPES, NETWORK_LIST_LIMIT, createArtifactHint } from '../runtime-metadata';
import { getActiveTabId, getTrackedTabIds } from '../sessions';
import { resolveClickTargetForCdp } from '../page-runtime/cdp-target';
import type { ActionDebuggerLease, CommandArgs, NetworkCapture, NetworkRequest, SessionName } from '../../shared/types';

type DebuggerSource = chrome.debugger.Debuggee;
type DebuggerParams = Record<string, any>;
type CdpKeyboardKeyDefinition = {
  key: string;
  code: string;
  keyCode: number;
  text?: string;
  location?: number;
};

const SPECIAL_CDP_KEYS: Record<string, CdpKeyboardKeyDefinition> = {
  enter: { key: 'Enter', code: 'Enter', keyCode: 13 },
  return: { key: 'Enter', code: 'Enter', keyCode: 13 },
  escape: { key: 'Escape', code: 'Escape', keyCode: 27 },
  esc: { key: 'Escape', code: 'Escape', keyCode: 27 },
  tab: { key: 'Tab', code: 'Tab', keyCode: 9 },
  backspace: { key: 'Backspace', code: 'Backspace', keyCode: 8 },
  delete: { key: 'Delete', code: 'Delete', keyCode: 46 },
  del: { key: 'Delete', code: 'Delete', keyCode: 46 },
  arrowleft: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
  left: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
  arrowup: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
  up: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
  arrowright: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
  right: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
  arrowdown: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
  down: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
  home: { key: 'Home', code: 'Home', keyCode: 36 },
  end: { key: 'End', code: 'End', keyCode: 35 },
  pageup: { key: 'PageUp', code: 'PageUp', keyCode: 33 },
  pagedown: { key: 'PageDown', code: 'PageDown', keyCode: 34 },
  space: { key: ' ', code: 'Space', keyCode: 32, text: ' ' },
  ' ': { key: ' ', code: 'Space', keyCode: 32, text: ' ' }
};

const PRINTABLE_CDP_KEYS: Record<string, { code: string; keyCode: number }> = {
  '-': { code: 'Minus', keyCode: 189 },
  '=': { code: 'Equal', keyCode: 187 },
  '[': { code: 'BracketLeft', keyCode: 219 },
  ']': { code: 'BracketRight', keyCode: 221 },
  '\\': { code: 'Backslash', keyCode: 220 },
  ';': { code: 'Semicolon', keyCode: 186 },
  "'": { code: 'Quote', keyCode: 222 },
  ',': { code: 'Comma', keyCode: 188 },
  '.': { code: 'Period', keyCode: 190 },
  '/': { code: 'Slash', keyCode: 191 },
  '`': { code: 'Backquote', keyCode: 192 }
};

export async function handleNetwork(args: CommandArgs = {}, session: SessionName): Promise<any> {
  const { cmd, filter, requestId, sinceTimestampMs, limit, tabId, method, statusCode } = args || {};

  switch (cmd) {
    case 'list':
      return listNetworkRequests(session, filter, { sinceTimestampMs, limit, tabId, method, statusCode });
    case 'detail':
      return getNetworkRequestDetail(session, requestId);
    default:
      throw new Error(`Unknown network cmd: ${cmd}. Use: list, detail`);
  }
}

// Network capture state
export const networkCaptures = new Map<SessionName, NetworkCapture>(); // session -> { requests: [], filter, tabId, auto }
let debuggerListenerInstalled = false;
const actionDebuggerOwners = new Map<number, { owner: string; warnings?: string[] }>();

const CLICK_PROBE_DEFAULT_WAIT_MS = 1000;
const CLICK_PROBE_DEFAULT_MAX_REQUESTS = 100;
const CLICK_PROBE_API_RESOURCE_TYPES = new Set(['fetch', 'xhr', 'xmlhttprequest']);
const SENSITIVE_FIELD_PATTERN = /(^|[-_.])(cookie|authorization|proxy-authorization|x-api-key|api-key|token|access_token|refresh_token|secret|password|session|csrf|jwt)([-_.]|$)/i;

export interface ClickProbeCapture {
  blocked: true;
  mode: 'cdp-fetch-request';
  waitMs: number;
  filter: string | null;
  interceptedCount: number;
  requests: any[];
  warnings: string[];
}

function installWebRequestListeners(): boolean {
  if (!chrome.webRequest?.onBeforeRequest || !chrome.webRequest?.onCompleted) return false;
  if (!chrome.webRequest.onBeforeRequest.hasListener(networkListener as any)) {
    chrome.webRequest.onBeforeRequest.addListener(
      networkListener as any,
      { urls: ['<all_urls>'] },
      ['requestBody']
    );
    chrome.webRequest.onCompleted.addListener(
      networkCompletedListener as any,
      { urls: ['<all_urls>'] },
      ['responseHeaders']
    );
  }
  return true;
}

function isApiResourceType(type: unknown): boolean {
  return NETWORK_API_RESOURCE_TYPES.has(String(type || '').toLowerCase());
}

function captureTracksTab(capture: NetworkCapture, tabId: unknown): boolean {
  const id = Number(tabId);
  const ids = Array.isArray(capture.tabIds) ? capture.tabIds : (capture.tabId ? [capture.tabId] : []);
  if (!ids.length) return capture.scope !== 'session';
  if (!Number.isFinite(id) || id < 0) return true;
  return ids.includes(id);
}

function debuggerTabIds(capture: NetworkCapture | null | undefined): number[] {
  if (!capture) return [];
  return Array.isArray(capture.debuggerAttachedTabIds) ? capture.debuggerAttachedTabIds : (capture.debuggerAttachedTabId ? [capture.debuggerAttachedTabId] : []);
}

export function removeNetworkTab(tabId: number): void {
  for (const capture of networkCaptures.values()) {
    capture.tabIds = (capture.tabIds || []).filter(id => id !== tabId);
    capture.debuggerAttachedTabIds = debuggerTabIds(capture).filter(id => id !== tabId);
    if (capture.tabId === tabId) capture.tabId = capture.tabIds?.[0] || null;
    if (capture.debuggerAttachedTabId === tabId) capture.debuggerAttachedTabId = capture.debuggerAttachedTabIds?.[0] || null;
  }
}

function originFromUrl(value: unknown): string | null {
  if (!value) return null;
  try {
    const origin = new URL(String(value)).origin;
    return origin && origin !== 'null' ? origin : null;
  } catch {
    return null;
  }
}

async function currentTabOrigin(tabId: number): Promise<string | null> {
  if (!Number.isFinite(tabId) || tabId < 0) return null;
  try {
    const tab = await chrome.tabs.get(tabId);
    return originFromUrl(tab.url);
  } catch {
    return null;
  }
}

async function isSameOriginRequest(url: string, tabId: number): Promise<boolean> {
  const tabOrigin = await currentTabOrigin(tabId);
  const requestOrigin = originFromUrl(url);
  return Boolean(tabOrigin && requestOrigin && tabOrigin === requestOrigin);
}

async function shouldCaptureRequest(capture: NetworkCapture, url: unknown, tabId: unknown, type: unknown): Promise<boolean> {
  if (!isApiResourceType(type)) return false;
  const urlStr = String(url || '');
  if (capture.filter && !urlStr.includes(capture.filter)) return false;
  return await isSameOriginRequest(urlStr, Number(tabId));
}

function removeCapturedRequest(capture: NetworkCapture, requestId: string): void {
  const index = capture.requests.findIndex(r => r.id === requestId || r.cdpRequestId === requestId || r.webRequestId === requestId);
  if (index >= 0) capture.requests.splice(index, 1);
}

function ensureDebuggerListener(): void {
  if (debuggerListenerInstalled || !chrome.debugger?.onEvent) return;
  chrome.debugger.onEvent.addListener((source, method, params) => {
    for (const [session, capture] of networkCaptures) {
      if (!captureTracksTab(capture, source.tabId)) continue;
      handleDebuggerNetworkEvent(session, capture, method, params || {}, source).catch(() => {});
    }
  });
  debuggerListenerInstalled = true;
}

const PER_TAB_LIMIT = 100;

function upsertCapturedRequest(capture: NetworkCapture, patch: Partial<NetworkRequest> & { requestId?: string }): NetworkRequest | null {
  const id = patch.id || patch.requestId;
  if (!id) return null;
  let req = capture.requests.find(r => r.id === id || r.cdpRequestId === id || r.webRequestId === id);
  if (!req) {
    req = { id, status: 'pending' };
    capture.requests.push(req);
  }
  Object.assign(req, patch);
  // Enforce per-tab limit
  if (patch.tabId !== undefined) {
    const tabRequests = capture.requests.filter(r => r.tabId === patch.tabId);
    if (tabRequests.length > PER_TAB_LIMIT) {
      const toRemove = tabRequests.length - PER_TAB_LIMIT;
      let removed = 0;
      capture.requests = capture.requests.filter(r => {
        if (removed >= toRemove) return true;
        if (r.tabId === patch.tabId && tabRequests.indexOf(r) < toRemove) {
          removed++;
          return false;
        }
        return true;
      });
    }
  }
  return req;
}

async function handleDebuggerNetworkEvent(
  session: SessionName,
  capture: NetworkCapture,
  method: string,
  params: DebuggerParams,
  source: DebuggerSource
): Promise<void> {
  if (!params?.requestId) return;
  if (method === 'Network.requestWillBeSent') {
    const url = params.request?.url || params.documentURL || '';
    // Some Chrome versions omit params.type here. Keep the early event so we do
    // not lose request body, then drop non-API resources when responseReceived
    // reports the final resource type.
    if (!(await isSameOriginRequest(url, Number(source.tabId)))) return;
    upsertCapturedRequest(capture, {
      id: params.requestId,
      cdpRequestId: params.requestId,
      url,
      method: params.request?.method || null,
      requestHeaders: params.request?.headers || {},
      requestBody: params.request?.postData || null,
      timestamp: params.timestamp || Date.now(),
      wallTime: params.wallTime || null,
      type: params.type || null,
      source: 'debugger',
      tabId: source.tabId,
      status: 'pending'
    });
  } else if (method === 'Network.responseReceived') {
    const url = params.response?.url || '';
    if (!(await shouldCaptureRequest(capture, url, source.tabId, params.type))) {
      removeCapturedRequest(capture, params.requestId);
      return;
    }
    upsertCapturedRequest(capture, {
      id: params.requestId,
      cdpRequestId: params.requestId,
      url,
      method: capture.requests.find(r => r.cdpRequestId === params.requestId)?.method || null,
      type: params.type || null,
      status: 'response',
      statusCode: params.response?.status,
      statusText: params.response?.statusText || '',
      mimeType: params.response?.mimeType || null,
      responseHeaders: params.response?.headers || {},
      source: 'debugger',
      tabId: source.tabId
    });
  } else if (method === 'Network.loadingFinished') {
    const req = capture.requests.find(r => r.cdpRequestId === params.requestId || r.id === params.requestId);
    if (!req) return;
    req.status = 'complete';
    req.encodedDataLength = params.encodedDataLength;
    try {
      const body = await chrome.debugger.sendCommand({ tabId: source.tabId }, 'Network.getResponseBody', { requestId: params.requestId }) as any;
      req.body = body.body;
      req.base64Encoded = body.base64Encoded;
      req.bodyLength = typeof body.body === 'string' ? body.body.length : 0;
      if (!body.base64Encoded && typeof body.body === 'string') {
        try { req.json = JSON.parse(body.body); } catch { /* not json */ }
      }
    } catch (err: any) {
      req.bodyError = err?.message || String(err);
    }
  } else if (method === 'Network.loadingFailed') {
    const req = capture.requests.find(r => r.cdpRequestId === params.requestId || r.id === params.requestId);
    if (req) {
      req.status = 'failed';
      req.errorText = params.errorText || null;
      req.canceled = Boolean(params.canceled);
    }
  }
}

async function attachDebuggerForCapture(capture: NetworkCapture, tabId: number | null | undefined): Promise<string> {
  if (!tabId || !chrome.debugger) return 'not_attached';
  if (debuggerTabIds(capture).includes(tabId)) return 'attached';

  try {
    ensureDebuggerListener();
    await chrome.debugger.attach({ tabId }, '1.3');
    await chrome.debugger.sendCommand({ tabId }, 'Network.enable', { maxResourceBufferSize: 10_000_000, maxTotalBufferSize: 50_000_000 });
    capture.debuggerAttachedTabIds = [...new Set([...debuggerTabIds(capture), tabId])];
    capture.debuggerAttachedTabId = capture.debuggerAttachedTabIds[0] || tabId;
    return 'attached';
  } catch (err: any) {
    return `unavailable:${err?.message || String(err)}`;
  }
}

export async function ensureNetworkCapture(session: SessionName, options: any = {}): Promise<any> {
  const explicitTabId = options.tabId || null;
  const activeTabId = getActiveTabId(session);
  const scope = options.scope || (explicitTabId ? 'tab' : 'session');
  const tabId = explicitTabId || activeTabId;
  let capture = networkCaptures.get(session);
  if (!capture) capture = { requests: [], filter: null, tabId: null, tabIds: [], scope, auto: false };

  capture.filter = options.filter !== undefined ? (options.filter || null) : (capture.filter || null);
  capture.scope = scope;
  const tracked = scope === 'tab' ? (tabId ? [tabId] : []) : [...new Set([...getTrackedTabIds(session), ...(tabId ? [tabId] : []), ...(capture.tabIds || [])])];
  capture.tabIds = tracked;
  capture.tabId = scope === 'tab' ? (tabId || capture.tabId || null) : (capture.tabId || tracked[0] || null);
  capture.auto = Boolean(capture.auto || options.auto);
  networkCaptures.set(session, capture);

  const webRequest = installWebRequestListeners();
  const debuggerTargets = capture.scope === 'session' ? (capture.tabIds || []) : (capture.tabId ? [capture.tabId] : []);
  const debuggerStatuses = [];
  for (const id of debuggerTargets) debuggerStatuses.push(`${id}:${await attachDebuggerForCapture(capture, id)}`);
  const debuggerStatus = debuggerStatuses.join(',') || 'not_attached';

  return {
    status: 'capturing',
    session,
    tabId: capture.tabId || null,
    captureScope: capture.scope || 'session',
    trackedTabIds: capture.tabIds || [],
    auto: Boolean(capture.auto),
    mode: 'api-only',
    stored: capture.requests.length,
    webRequest,
    debugger: debuggerStatus
  };
}

function findNetworkDebuggerCapture(tabId: number): { session: SessionName; capture: NetworkCapture } | null {
  for (const [session, capture] of networkCaptures) {
    if (debuggerTabIds(capture).includes(tabId)) return { session, capture };
  }
  return null;
}

export async function acquireActionDebugger(tabId: number): Promise<ActionDebuggerLease> {
  if (!chrome.debugger?.sendCommand) {
    return { error: 'chrome.debugger API is unavailable', recoverable: true };
  }

  const actionOwner = actionDebuggerOwners.get(tabId);
  if (actionOwner) {
    return {
      debuggee: { tabId },
      temporary: false,
      owner: actionOwner.owner,
      warnings: actionOwner.warnings || []
    };
  }

  const networkOwner = findNetworkDebuggerCapture(tabId);
  if (networkOwner) {
    return {
      debuggee: { tabId },
      temporary: false,
      owner: 'network_capture',
      warnings: []
    };
  }

  try {
    await chrome.debugger.attach({ tabId }, '1.3');
    return { debuggee: { tabId }, temporary: true, owner: 'action', warnings: [] };
  } catch (err: any) {
    return {
      error: `chrome.debugger attach failed: ${err?.message || String(err)}`,
      recoverable: true,
      warnings: ['Another debugger client may already be attached, or debugger permission may be unavailable.']
    };
  }
}

export async function acquireNamedActionDebugger(tabId: number, owner: string, warnings: string[] = []): Promise<ActionDebuggerLease> {
  const lease = await acquireActionDebugger(tabId);
  if (!lease.error) {
    actionDebuggerOwners.set(tabId, { owner, warnings });
  }
  return lease;
}

export async function releaseNamedActionDebugger(tabId: number, lease: ActionDebuggerLease): Promise<string | null> {
  actionDebuggerOwners.delete(tabId);
  return releaseActionDebugger(lease);
}

export async function releaseActionDebugger(lease: ActionDebuggerLease): Promise<string | null> {
  if (!lease?.temporary || !lease.debuggee) return null;
  try {
    await chrome.debugger.detach(lease.debuggee);
    return null;
  } catch (err: any) {
    return `Failed to detach temporary debugger session: ${err?.message || String(err)}`;
  }
}

function normalizeClickProbeWaitMs(value: unknown): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return CLICK_PROBE_DEFAULT_WAIT_MS;
  return Math.max(0, Math.min(10_000, Math.round(numeric)));
}

function normalizeClickProbeMaxRequests(value: unknown): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return CLICK_PROBE_DEFAULT_MAX_REQUESTS;
  return Math.max(1, Math.min(500, Math.round(numeric)));
}

function clickProbeIncludesHeaders(options: any): boolean {
  return options?.includeHeaders !== false;
}

function clickProbeIncludesBody(options: any): boolean {
  return options?.includeBody !== false;
}

function clickProbeRedactsSensitive(options: any): boolean {
  return options?.redactSensitive !== false;
}

function isSensitiveFieldName(name: unknown): boolean {
  return SENSITIVE_FIELD_PATTERN.test(String(name || ''));
}

function redactObject(value: any): any {
  if (Array.isArray(value)) return value.map(item => redactObject(item));
  if (!value || typeof value !== 'object') return value;
  const redacted: Record<string, any> = {};
  for (const [key, child] of Object.entries(value)) {
    redacted[key] = isSensitiveFieldName(key) ? '[REDACTED]' : redactObject(child);
  }
  return redacted;
}

function maybeRedactHeaders(headers: any, redactSensitive: boolean): any {
  if (!headers || !redactSensitive) return headers || {};
  const redacted: Record<string, any> = {};
  for (const [key, value] of Object.entries(headers)) {
    redacted[key] = isSensitiveFieldName(key) ? '[REDACTED]' : value;
  }
  return redacted;
}

function parseRequestBody(body: unknown, redactSensitive: boolean): unknown {
  if (typeof body !== 'string') return body ?? null;
  const trimmed = body.trim();
  if (!trimmed) return '';
  try {
    const parsed = JSON.parse(trimmed);
    return redactSensitive ? redactObject(parsed) : parsed;
  } catch {
    return redactSensitive ? redactStringBody(trimmed) : trimmed;
  }
}

function redactStringBody(value: string): string {
  const params = new URLSearchParams(value);
  let matched = false;
  for (const key of [...params.keys()]) {
    if (isSensitiveFieldName(key)) {
      params.set(key, '[REDACTED]');
      matched = true;
    }
  }
  return matched ? params.toString() : value;
}

function shouldBlockProbeRequest(params: any, filter: string | null): boolean {
  const url = String(params?.request?.url || '');
  if (filter && !url.includes(filter)) return false;
  const resourceType = String(params?.resourceType || params?.type || '').toLowerCase();
  return CLICK_PROBE_API_RESOURCE_TYPES.has(resourceType);
}

function buildProbeRequest(params: any, options: any): any {
  const request = params?.request || {};
  const redactSensitive = clickProbeRedactsSensitive(options);
  const includeBody = clickProbeIncludesBody(options);
  const includeHeaders = clickProbeIncludesHeaders(options);
  const body = typeof request.postData === 'string' ? request.postData : null;
  const result: any = {
    id: String(params?.requestId || ''),
    url: String(request.url || ''),
    method: request.method || null,
    type: params?.resourceType || params?.type || null,
    blockedReason: 'probe',
    redacted: redactSensitive
  };
  if (includeHeaders) result.requestHeaders = maybeRedactHeaders(request.headers || {}, redactSensitive);
  if (includeBody) {
    result.requestBody = parseRequestBody(body, redactSensitive);
    result.requestBodyLength = typeof body === 'string' ? body.length : 0;
  }
  return result;
}

export async function runClickProbeCapture<T>(
  tabId: number,
  args: any,
  action: () => Promise<T>
): Promise<{ result: T; probe: ClickProbeCapture }> {
  const waitMs = normalizeClickProbeWaitMs(args?.waitMs);
  const maxRequests = normalizeClickProbeMaxRequests(args?.maxRequests);
  const filter = typeof args?.filter === 'string' && args.filter ? args.filter : null;
  const warnings: string[] = [];
  const requests: any[] = [];
  let totalIntercepted = 0;
  let fetchEnabled = false;
  let listenerInstalled = false;

  const lease = await acquireNamedActionDebugger(tabId, 'click_probe', ['Reusing debugger session owned by click_probe.']);
  if (lease.error || !lease.debuggee) {
    throw new Error(`click_probe could not enable CDP request interception: ${lease.error || 'debugger unavailable'}`);
  }

  const debuggee = lease.debuggee as any;
  const listener = (source: chrome.debugger.Debuggee, method: string, params: any) => {
    if (source.tabId !== tabId || method !== 'Fetch.requestPaused') return;
    const requestId = params?.requestId;
    if (!requestId) return;
    const shouldBlock = shouldBlockProbeRequest(params, filter);
    if (shouldBlock) {
      totalIntercepted += 1;
      if (requests.length < maxRequests) requests.push(buildProbeRequest(params, args));
      chrome.debugger.sendCommand(debuggee, 'Fetch.failRequest', { requestId, errorReason: 'BlockedByClient' }).catch((err: any) => {
        warnings.push(`Failed to block probed request ${requestId}: ${err?.message || String(err)}`);
      });
      return;
    }
    chrome.debugger.sendCommand(debuggee, 'Fetch.continueRequest', { requestId }).catch((err: any) => {
      warnings.push(`Failed to continue nonmatching request ${requestId}: ${err?.message || String(err)}`);
    });
  };

  try {
    chrome.debugger.onEvent.addListener(listener);
    listenerInstalled = true;
    await chrome.debugger.sendCommand(debuggee, 'Fetch.enable', {
      patterns: [{ urlPattern: '*', requestStage: 'Request' }]
    });
    fetchEnabled = true;

    const result = await action();
    await new Promise(resolve => setTimeout(resolve, waitMs));
    if (totalIntercepted > requests.length) {
      warnings.push(`click_probe captured ${requests.length} of ${totalIntercepted} intercepted requests; increase maxRequests for more detail.`);
    }

    return {
      result,
      probe: {
        blocked: true,
        mode: 'cdp-fetch-request',
        waitMs,
        filter,
        interceptedCount: totalIntercepted,
        requests,
        warnings
      }
    };
  } finally {
    if (fetchEnabled) {
      try { await chrome.debugger.sendCommand(debuggee, 'Fetch.disable'); } catch (err: any) { warnings.push(`Failed to disable Fetch interception: ${err?.message || String(err)}`); }
    }
    if (listenerInstalled) {
      try { chrome.debugger.onEvent.removeListener(listener); } catch { /* Ignore listener cleanup failures. */ }
    }
    const detachWarning = await releaseNamedActionDebugger(tabId, lease);
    if (detachWarning) warnings.push(detachWarning);
  }
}

function buildRuntimeEvaluationExpression(source: string, mode: 'expression' | 'body'): string {
  const invocation = mode === 'expression'
    ? `const __bcValue = await (async () => (${source}))();`
    : `const __bcValue = await (async () => { ${source}\n })();`;

  return `(async () => {
    ${invocation}
    const __bcState = { warnings: [], truncated: false, seen: typeof WeakSet !== 'undefined' ? new WeakSet() : null };
    function __bcSerialize(value, depth) {
      if (value === null) return null;
      const type = typeof value;
      if (type === 'string' || type === 'number' || type === 'boolean') return value;
      if (type === 'undefined') return null;
      if (type === 'bigint') {
        __bcState.warnings.push('Converted bigint to string.');
        return value.toString();
      }
      if (type === 'symbol' || type === 'function') {
        __bcState.warnings.push('Converted ' + type + ' to string.');
        return String(value);
      }
      if (depth >= 6) {
        __bcState.truncated = true;
        return '[MaxDepth]';
      }
      if (__bcState.seen && typeof value === 'object') {
        if (__bcState.seen.has(value)) {
          __bcState.warnings.push('Replaced circular reference.');
          return '[Circular]';
        }
        __bcState.seen.add(value);
      }
      if (typeof Element !== 'undefined' && value instanceof Element) {
        const rect = value.getBoundingClientRect();
        return {
          nodeType: 'element',
          tagName: value.tagName.toLowerCase(),
          id: value.id || null,
          className: typeof value.className === 'string' ? value.className : null,
          textContent: (value.innerText || value.textContent || '').slice(0, 500),
          boundingBox: {
            x: Math.round(rect.x + window.scrollX),
            y: Math.round(rect.y + window.scrollY),
            width: Math.round(rect.width),
            height: Math.round(rect.height)
          }
        };
      }
      if (typeof Node !== 'undefined' && value instanceof Node) {
        return { nodeType: value.nodeType, nodeName: value.nodeName, textContent: (value.textContent || '').slice(0, 500) };
      }
      if (value instanceof Error) {
        return { name: value.name, message: value.message, stack: typeof value.stack === 'string' ? value.stack.split('\\n').slice(0, 8).join('\\n') : undefined };
      }
      if (value instanceof Date) return value.toISOString();
      if (Array.isArray(value)) {
        if (value.length > 100) __bcState.truncated = true;
        return value.slice(0, 100).map(item => __bcSerialize(item, depth + 1));
      }
      const output = {};
      const keys = Object.keys(value);
      if (keys.length > 100) __bcState.truncated = true;
      for (const key of keys.slice(0, 100)) {
        try {
          output[key] = __bcSerialize(value[key], depth + 1);
        } catch (err) {
          output[key] = '[Unserializable: ' + ((err && err.message) || err) + ']';
          __bcState.warnings.push('Could not serialize property ' + key + '.');
        }
      }
      return output;
    }
    const __bcPayload = { result: __bcSerialize(__bcValue, 0) };
    if (__bcValue === undefined) {
      __bcPayload.result = null;
      __bcPayload.serialization = { undefinedResult: true, warnings: ['Evaluation returned undefined; use return ... or a single expression to return data.'] };
    } else if (__bcState.warnings.length || __bcState.truncated) {
      __bcPayload.serialization = { truncated: __bcState.truncated, warnings: __bcState.warnings };
    }
    return __bcPayload;
  })()`;
}

function formatRuntimeEvaluationException(details: any): any {
  const exception = details?.exception || {};
  const description = exception.description || details?.text || 'Runtime.evaluate failed';
  const firstLine = String(description).split('\n')[0];
  return {
    error: firstLine,
    errorDetails: {
      name: exception.className || 'Error',
      message: firstLine,
      stack: typeof description === 'string' ? description.split('\n').slice(0, 8).join('\n') : undefined
    }
  };
}

function isSyntaxException(details: any): boolean {
  const exception = details?.exception || {};
  const text = `${exception.className || ''} ${exception.description || ''} ${details?.text || ''}`;
  return text.includes('SyntaxError');
}

async function evaluateRuntimeExpression(debuggee: any, expression: string): Promise<any> {
  const response = await chrome.debugger.sendCommand(debuggee, 'Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
    userGesture: true
  }) as any;
  if (response?.exceptionDetails) {
    return { exceptionDetails: response.exceptionDetails, payload: formatRuntimeEvaluationException(response.exceptionDetails) };
  }
  return { payload: response?.result?.value ?? { result: null, serialization: { undefinedResult: true } } };
}

export async function performCdpEvaluate(tabId: number, code: unknown): Promise<any> {
  const lease = await acquireActionDebugger(tabId);
  if (lease.error) {
    return {
      error: lease.error,
      recoverable: lease.recoverable,
      warnings: lease.warnings || []
    };
  }

  const source = String(code ?? '');
  const hasExplicitReturn = /\breturn\b/.test(source);
  const debuggee = lease.debuggee as any;

  try {
    if (!hasExplicitReturn) {
      const expressionResult = await evaluateRuntimeExpression(debuggee, buildRuntimeEvaluationExpression(source, 'expression'));
      if (!expressionResult.exceptionDetails) return expressionResult.payload;
      if (!isSyntaxException(expressionResult.exceptionDetails)) return expressionResult.payload;
    }

    const bodyResult = await evaluateRuntimeExpression(debuggee, buildRuntimeEvaluationExpression(source, 'body'));
    return bodyResult.payload;
  } catch (err: any) {
    return {
      error: `Runtime.evaluate failed: ${err?.message || String(err)}`,
      recoverable: true,
      warnings: lease.warnings || []
    };
  } finally {
    const detachWarning = await releaseActionDebugger(lease);
    if (detachWarning) {
      // There is no safe place to append this to an arbitrary evaluation result,
      // so leave a console diagnostic instead of changing the public payload.
      console.warn('[AgentBridge] ' + detachWarning);
    }
  }
}

export async function performCdpMouseClick(tabId: number, selector: string, options: any = {}): Promise<any> {
  const geometryResults = await chrome.scripting.executeScript({
    target: { tabId },
    func: resolveClickTargetForCdp,
    args: [selector, options || {}],
    world: 'MAIN'
  });
  const geometry = geometryResults[0]?.result;
  if (geometry?.error) return geometry;

  const lease = await acquireActionDebugger(tabId);
  if (lease.error) {
    return {
      clicked: false,
      selector,
      strategyUsed: 'cdp_mouse',
      error: lease.error,
      recoverable: true,
      warnings: lease.warnings || []
    };
  }

  const warnings = [...(lease.warnings || [])];
  const debuggee = lease.debuggee as any;
  const button = options?.button === 'right' ? 'right' : options?.button === 'middle' ? 'middle' : 'left';
  const clickCount = Math.max(1, Number(options?.clickCount || 1));
  const modifiers = cdpModifierMask(options?.modifiers);
  const clickX = geometry.hitTest.topClientX ?? geometry.hitTest.clientX;
  const clickY = geometry.hitTest.topClientY ?? geometry.hitTest.clientY;

  const dispatchWarnings: string[] = [];
  try {
    await chrome.debugger.sendCommand(debuggee, 'Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: clickX,
      y: clickY,
      button: 'none',
      modifiers
    });
  } catch (err: any) {
    return {
      clicked: false,
      selector,
      strategyUsed: 'cdp_mouse',
      error: `CDP mouseMoved dispatch failed: ${err?.message || String(err)}`,
      recoverable: true,
      target: geometry.target,
      hitTest: geometry.hitTest,
      warnings
    };
  }
  try {
    await chrome.debugger.sendCommand(debuggee, 'Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x: clickX,
      y: clickY,
      button,
      clickCount,
      modifiers
    });
  } catch (err: any) {
    return {
      clicked: false,
      selector,
      strategyUsed: 'cdp_mouse',
      error: `CDP mousePressed dispatch failed: ${err?.message || String(err)}`,
      recoverable: true,
      target: geometry.target,
      hitTest: geometry.hitTest,
      warnings
    };
  }
  try {
    await chrome.debugger.sendCommand(debuggee, 'Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x: clickX,
      y: clickY,
      button,
      clickCount,
      modifiers
    });
  } catch (err: any) {
    dispatchWarnings.push(`CDP mouseReleased failed (mousePressed succeeded): ${err?.message || String(err)}`);
  }
  if (dispatchWarnings.length) warnings.push(...dispatchWarnings);

  try {
    const detachWarning = await releaseActionDebugger(lease);
    if (detachWarning) warnings.push(detachWarning);
  } catch {
    // debugger may already be detached; ignore cleanup errors
  }

  return {
    clicked: true,
    selector,
    strategyUsed: 'cdp_mouse',
    synthetic: false,
    target: geometry.target,
    hitTest: geometry.hitTest,
    warnings
  };
}

function captureWheelScrollMetrics(point: { x: number; y: number }): any {
  function metricsFor(target: Element | Window): any {
    if (target === window) {
      const root = document.scrollingElement || document.documentElement;
      return {
        scrollX: Math.round(window.scrollX || window.pageXOffset || 0),
        scrollY: Math.round(window.scrollY || window.pageYOffset || 0),
        scrollWidth: Math.round(root?.scrollWidth || document.documentElement.scrollWidth || 0),
        scrollHeight: Math.round(root?.scrollHeight || document.documentElement.scrollHeight || 0),
        clientWidth: Math.round(window.innerWidth || document.documentElement.clientWidth || 0),
        clientHeight: Math.round(window.innerHeight || document.documentElement.clientHeight || 0)
      };
    }
    const el = target as HTMLElement;
    return {
      scrollX: Math.round(el.scrollLeft || 0),
      scrollY: Math.round(el.scrollTop || 0),
      scrollWidth: Math.round(el.scrollWidth || 0),
      scrollHeight: Math.round(el.scrollHeight || 0),
      clientWidth: Math.round(el.clientWidth || 0),
      clientHeight: Math.round(el.clientHeight || 0)
    };
  }

  function isScrollable(el: Element): boolean {
    const style = window.getComputedStyle(el);
    const overflowY = `${style.overflowY} ${style.overflow}`;
    const overflowX = `${style.overflowX} ${style.overflow}`;
    const node = el as HTMLElement;
    const canY = /(auto|scroll|overlay)/.test(overflowY) && node.scrollHeight > node.clientHeight + 1;
    const canX = /(auto|scroll|overlay)/.test(overflowX) && node.scrollWidth > node.clientWidth + 1;
    return canY || canX;
  }

  function findScrollContainer(el: Element | null): Element | Window {
    let current: Element | null = el;
    while (current && current !== document.documentElement && current !== document.body) {
      if (isScrollable(current)) return current;
      current = current.parentElement;
    }
    return window;
  }

  const element = document.elementFromPoint(point.x, point.y);
  const target = findScrollContainer(element);
  return {
    target: target === window ? 'document' : 'element',
    metrics: metricsFor(target)
  };
}

function canScrollFurther(metrics: any, dx: number, dy: number): boolean {
  const maxX = Math.max(0, Number(metrics?.scrollWidth || 0) - Number(metrics?.clientWidth || 0));
  const maxY = Math.max(0, Number(metrics?.scrollHeight || 0) - Number(metrics?.clientHeight || 0));
  if (dx < 0 && Number(metrics?.scrollX || 0) > 0) return true;
  if (dx > 0 && Number(metrics?.scrollX || 0) < maxX) return true;
  if (dy < 0 && Number(metrics?.scrollY || 0) > 0) return true;
  if (dy > 0 && Number(metrics?.scrollY || 0) < maxY) return true;
  return false;
}

function finiteNumber(value: unknown, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

export async function performCdpWheelScroll(tabId: number, options: any = {}): Promise<any> {
  const region = options?.region || null;
  const regionX = finiteNumber(region?.x, 0);
  const regionY = finiteNumber(region?.y, 0);
  const regionWidth = finiteNumber(region?.width, 0);
  const regionHeight = finiteNumber(region?.height, 0);
  const x = Number.isFinite(options?.x) ? Number(options.x) : region ? regionX + regionWidth / 2 : 1;
  const y = Number.isFinite(options?.y) ? Number(options.y) : region ? regionY + regionHeight / 2 : 1;
  const deltaX = Number.isFinite(options?.deltaX) ? Number(options.deltaX) : 0;
  const deltaY = Number.isFinite(options?.deltaY) ? Number(options.deltaY) : 0;
  const steps = Math.max(1, Math.min(Math.floor(Number(options?.steps || 1)), 20));
  const waitMs = Math.max(0, Math.min(finiteNumber(options?.waitMs, 50), 5000));

  const beforeResults = await chrome.scripting.executeScript({
    target: { tabId },
    func: captureWheelScrollMetrics,
    args: [{ x, y }],
    world: 'MAIN'
  });
  const beforeSnapshot = beforeResults[0]?.result as any;
  const before = beforeSnapshot?.metrics || null;
  const target = beforeSnapshot?.target || 'document';

  const lease = await acquireActionDebugger(tabId);
  if (lease.error) {
    return {
      ok: false,
      target,
      strategyUsed: 'wheel',
      before,
      after: before,
      movedX: 0,
      movedY: 0,
      attemptedDeltaX: deltaX,
      attemptedDeltaY: deltaY,
      atBoundary: before ? !canScrollFurther(before, deltaX, deltaY) : undefined,
      error: lease.error,
      recoverable: true,
      warnings: lease.warnings || []
    };
  }

  const warnings = [...(lease.warnings || [])];
  const debuggee = lease.debuggee as any;

  try {
    await chrome.debugger.sendCommand(debuggee, 'Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x,
      y,
      button: 'none'
    });
    for (let i = 0; i < steps; i += 1) {
      await chrome.debugger.sendCommand(debuggee, 'Input.dispatchMouseEvent', {
        type: 'mouseWheel',
        x,
        y,
        deltaX: deltaX / steps,
        deltaY: deltaY / steps,
        button: 'none'
      });
    }
  } catch (err: any) {
    return {
      ok: false,
      target,
      strategyUsed: 'wheel',
      before,
      after: before,
      movedX: 0,
      movedY: 0,
      attemptedDeltaX: deltaX,
      attemptedDeltaY: deltaY,
      atBoundary: before ? !canScrollFurther(before, deltaX, deltaY) : undefined,
      error: `CDP wheel dispatch failed: ${err?.message || String(err)}`,
      recoverable: true,
      warnings
    };
  } finally {
    const detachWarning = await releaseActionDebugger(lease);
    if (detachWarning) warnings.push(detachWarning);
  }

  if (waitMs) await new Promise(resolve => setTimeout(resolve, waitMs));
  const afterResults = await chrome.scripting.executeScript({
    target: { tabId },
    func: captureWheelScrollMetrics,
    args: [{ x, y }],
    world: 'MAIN'
  });
  const afterSnapshot = afterResults[0]?.result as any;
  const after = afterSnapshot?.metrics || before;
  const movedX = Number(after?.scrollX || 0) - Number(before?.scrollX || 0);
  const movedY = Number(after?.scrollY || 0) - Number(before?.scrollY || 0);
  const ok = movedX !== 0 || movedY !== 0;
  const atBoundary = after ? !canScrollFurther(after, deltaX, deltaY) : undefined;
  if (!ok) warnings.push('Wheel event dispatched but measured scroll position did not change.');

  return {
    ok,
    target: afterSnapshot?.target || target,
    strategyUsed: 'wheel',
    before,
    after,
    movedX,
    movedY,
    attemptedDeltaX: deltaX,
    attemptedDeltaY: deltaY,
    atBoundary,
    point: { x, y },
    warnings: warnings.length ? warnings : undefined
  };
}

function normalizeCdpKeyboardKey(input: string): CdpKeyboardKeyDefinition {
  const key = String(input || '');
  const special = SPECIAL_CDP_KEYS[key.toLowerCase()];
  if (special) return special;
  if (/^[a-z]$/i.test(key)) {
    return {
      key,
      code: `Key${key.toUpperCase()}`,
      keyCode: key.toUpperCase().charCodeAt(0),
      text: key
    };
  }
  if (/^[0-9]$/.test(key)) {
    return {
      key,
      code: `Digit${key}`,
      keyCode: key.charCodeAt(0),
      text: key
    };
  }
  const printable = key.length === 1 ? PRINTABLE_CDP_KEYS[key] : null;
  if (printable) {
    return {
      key,
      code: printable.code,
      keyCode: printable.keyCode,
      text: key
    };
  }
  if (key.length === 1) {
    return {
      key,
      code: 'Unidentified',
      keyCode: key.toUpperCase().charCodeAt(0),
      text: key
    };
  }
  return { key, code: key || 'Unidentified', keyCode: 0 };
}

function buildCdpKeyboardEvent(type: 'rawKeyDown' | 'keyDown' | 'keyUp', definition: CdpKeyboardKeyDefinition, modifiers: number): any {
  const event: any = {
    type,
    key: definition.key,
    code: definition.code,
    windowsVirtualKeyCode: definition.keyCode,
    nativeVirtualKeyCode: definition.keyCode,
    modifiers
  };
  if (definition.location !== undefined) event.location = definition.location;
  if (definition.text && type !== 'keyUp') {
    event.text = definition.text;
    event.unmodifiedText = definition.text;
  }
  return event;
}

export async function performCdpClickAt(
  tabId: number,
  x: number,
  y: number,
  options: { button?: string; clickCount?: number; modifiers?: string[] } = {}
): Promise<any> {
  const lease = await acquireActionDebugger(tabId);
  if (lease.error) {
    return { clicked: false, error: lease.error, warnings: lease.warnings || [] };
  }

  const warnings = [...(lease.warnings || [])];
  const debuggee = lease.debuggee as any;
  const button = options?.button === 'right' ? 'right' : options?.button === 'middle' ? 'middle' : 'left';
  const clickCount = Math.max(1, Number(options?.clickCount || 1));
  const modifiers = cdpModifierMask(options?.modifiers);

  try {
    await chrome.debugger.sendCommand(debuggee, 'Input.dispatchMouseEvent', {
      type: 'mouseMoved', x, y, button: 'none', modifiers
    });
  } catch (err: any) {
    return { clicked: false, x, y, error: `CDP mouseMoved dispatch failed: ${err?.message || String(err)}`, warnings };
  }
  try {
    await chrome.debugger.sendCommand(debuggee, 'Input.dispatchMouseEvent', {
      type: 'mousePressed', x, y, button, clickCount, modifiers
    });
  } catch (err: any) {
    return { clicked: false, x, y, error: `CDP mousePressed dispatch failed: ${err?.message || String(err)}`, warnings };
  }
  try {
    await chrome.debugger.sendCommand(debuggee, 'Input.dispatchMouseEvent', {
      type: 'mouseReleased', x, y, button, clickCount, modifiers
    });
  } catch (err: any) {
    warnings.push(`CDP mouseReleased failed (mousePressed succeeded): ${err?.message || String(err)}`);
  }
  try {
    const detachWarning = await releaseActionDebugger(lease);
    if (detachWarning) warnings.push(detachWarning);
  } catch {
    // debugger may already be detached; ignore cleanup errors
  }
  return { clicked: true, x, y, strategyUsed: 'cdp_mouse', warnings };
}

export async function performCdpKeyboardPress(tabId: number, key: string, options: any = {}): Promise<any> {
  const lease = await acquireActionDebugger(tabId);
  if (lease.error) {
    return {
      pressed: false,
      key,
      strategyUsed: 'cdp_keyboard',
      error: lease.error,
      recoverable: true,
      warnings: lease.warnings || []
    };
  }

  const warnings = [...(lease.warnings || [])];
  const debuggee = lease.debuggee as any;
  const keyDefinition = normalizeCdpKeyboardKey(key);
  const downType = keyDefinition.text ? 'keyDown' : 'rawKeyDown';
  const modifiers = cdpModifierMask(options?.modifiers);
  try {
    await chrome.debugger.sendCommand(debuggee, 'Input.dispatchKeyEvent', buildCdpKeyboardEvent(downType, keyDefinition, modifiers));
    await chrome.debugger.sendCommand(debuggee, 'Input.dispatchKeyEvent', buildCdpKeyboardEvent('keyUp', keyDefinition, modifiers));
  } catch (err: any) {
    return {
      pressed: false,
      key,
      strategyUsed: 'cdp_keyboard',
      error: `CDP keyboard dispatch failed: ${err?.message || String(err)}`,
      recoverable: true,
      warnings
    };
  } finally {
    const detachWarning = await releaseActionDebugger(lease);
    if (detachWarning) warnings.push(detachWarning);
  }

  return {
    pressed: true,
    key: keyDefinition.key,
    inputKey: key,
    code: keyDefinition.code,
    windowsVirtualKeyCode: keyDefinition.keyCode,
    nativeVirtualKeyCode: keyDefinition.keyCode,
    strategyUsed: 'cdp_keyboard',
    synthetic: false,
    warnings
  };
}

function cdpModifierMask(modifiers: unknown): number {
  const list = Array.isArray(modifiers) ? modifiers.map(String) : [];
  let mask = 0;
  if (list.some(m => /^alt$/i.test(m))) mask += 1;
  if (list.some(m => /^(ctrl|control)$/i.test(m))) mask += 2;
  if (list.some(m => /^(meta|cmd|command)$/i.test(m))) mask += 4;
  if (list.some(m => /^shift$/i.test(m))) mask += 8;
  return mask;
}

function extractRequestBody(details: any): unknown {
  if (!details.requestBody) return null;
  if (details.requestBody.formData) return details.requestBody.formData;
  if (details.requestBody.raw?.length) {
    try {
      return details.requestBody.raw.map((part: any) => {
        if (!part.bytes) return '';
        return new TextDecoder('utf-8').decode(part.bytes);
      }).join('');
    } catch {
      return '[unavailable raw request body]';
    }
  }
  return null;
}

function networkListener(details: any): void {
  handleWebRequestBeforeRequest(details).catch(() => {});
}

async function handleWebRequestBeforeRequest(details: any): Promise<void> {
  // Store request for all active sessions.
  for (const [, capture] of networkCaptures) {
    if (!captureTracksTab(capture, details.tabId)) continue;
    if (await shouldCaptureRequest(capture, details.url, details.tabId, details.type)) {
      upsertCapturedRequest(capture, {
        id: details.requestId,
        webRequestId: details.requestId,
        url: details.url,
        method: details.method,
        requestBody: extractRequestBody(details),
        timestamp: details.timeStamp,
        type: details.type,
        source: 'webRequest',
        tabId: details.tabId,
        status: 'pending'
      });
    }
  }
}

function networkCompletedListener(details: any): void {
  for (const [, capture] of networkCaptures) {
    if (!captureTracksTab(capture, details.tabId)) continue;
    const req = capture.requests.find(r => r.webRequestId === details.requestId || r.id === details.requestId || r.url === details.url);
    if (req) {
      req.status = 'complete';
      req.statusCode = details.statusCode;
      req.responseHeaders = details.responseHeaders;
    }
  }
}

function capturedRequestTimestampMs(r: NetworkRequest): number | null {
  const timestampMs = r.timestampMs;
  if (Number.isFinite(timestampMs)) return timestampMs as number;
  const wallTime = r.wallTime;
  if (Number.isFinite(wallTime)) return Math.round((wallTime as number) * 1000);
  const timestamp = r.timestamp;
  if (Number.isFinite(timestamp)) return (timestamp as number) > 1e12 ? timestamp as number : Math.round((timestamp as number) * 1000);
  return null;
}

function clampNetworkListLimit(value: unknown): number {
  if (!Number.isFinite(value)) return NETWORK_LIST_LIMIT;
  return Math.max(1, Math.min(Math.floor(Number(value)), NETWORK_LIST_LIMIT));
}

function matchesNetworkListFilters(r: NetworkRequest, options: any): boolean {
  if (options.method && String(r.method || '').toUpperCase() !== String(options.method).toUpperCase()) return false;
  if (options.type && String(r.type || '').toLowerCase() !== String(options.type).toLowerCase()) return false;
  if (Number.isFinite(options.statusCode) && Number(r.statusCode) !== Number(options.statusCode)) return false;
  return true;
}

async function listNetworkRequests(session: SessionName, filter: string | null | undefined, options: any = {}): Promise<any> {
  const capture: NetworkCapture | null | undefined = networkCaptures.get(session);
  if (!capture) return { requests: [] };

  let requests = capture.requests;
  if (filter) requests = requests.filter(r => String(r.url || '').includes(filter));
  requests = requests.filter(r => matchesNetworkListFilters(r, options));
  const requestedTabId = Number(options.tabId);
  const hasTabIdFilter = Number.isFinite(requestedTabId);
  if (hasTabIdFilter) requests = requests.filter(r => Number(r.tabId) === requestedTabId);

  const sinceTimestampMs = Number.isFinite(options.sinceTimestampMs) ? Number(options.sinceTimestampMs) : null;
  let omittedUntimestamped = 0;
  if (sinceTimestampMs !== null) {
    requests = requests.filter(r => {
      const timestampMs = capturedRequestTimestampMs(r);
      if (timestampMs === null) {
        omittedUntimestamped += 1;
        return false;
      }
      return timestampMs >= sinceTimestampMs;
    });
  }
  const requestLimit = clampNetworkListLimit(options.limit);
  const responseRequests = requests.slice(-requestLimit).map(r => {
    const timestampMs = capturedRequestTimestampMs(r);
    return {
      id: r.id,
      webRequestId: r.webRequestId || null,
      cdpRequestId: r.cdpRequestId || null,
      url: r.url,
      method: r.method,
      timestamp: r.timestamp,
      timestampMs,
      timestampMissing: timestampMs === null,
      type: r.type,
      source: r.source,
      tabId: r.tabId,
      status: r.status,
      statusCode: r.statusCode,
      statusText: r.statusText,
      mimeType: r.mimeType,
      requestBody: r.requestBody,
      responseHeaders: r.responseHeaders,
      bodyLength: r.bodyLength || (typeof r.body === 'string' ? r.body.length : 0),
      hasBody: typeof r.body === 'string',
      bodyError: r.bodyError || null,
      json: r.json
    };
  });
  return {
    session,
    tabId: capture.tabId || null,
    tabIdFilter: hasTabIdFilter ? requestedTabId : null,
    captureScope: capture.scope || 'session',
    trackedTabIds: capture.tabIds || [],
    auto: Boolean(capture.auto),
    mode: 'api-only',
    methodFilter: options.method ? String(options.method).toUpperCase() : null,
    statusCodeFilter: Number.isFinite(options.statusCode) ? Number(options.statusCode) : null,
    totalStored: capture.requests.length,
    matched: requests.length,
    returned: responseRequests.length,
    requestLimit,
    sinceTimestampMs,
    omittedUntimestamped,
    requests: responseRequests
  };
}

async function getNetworkRequestDetail(session: SessionName, requestId: string): Promise<any> {
  const capture: NetworkCapture | null | undefined = networkCaptures.get(session);
  if (!capture) throw new Error('No network capture for session');
  const known = capture.requests.find(r => r.id === requestId || r.webRequestId === requestId || r.cdpRequestId === requestId) || null;
  if (!known) return { requestId, body: null, error: 'Request not found in capture buffer' };
  const merged = mergeNetworkRequest(capture.requests, known);

  const textLength = typeof merged.body === 'string' ? merged.body.length : 0;
  return {
    requestId,
    id: merged.id,
    ids: {
      id: merged.id,
      webRequestId: merged.webRequestId || null,
      cdpRequestId: merged.cdpRequestId || null
    },
    webRequestId: merged.webRequestId || null,
    cdpRequestId: merged.cdpRequestId || null,
    mergeConfidence: merged.mergeConfidence,
    mergedFrom: merged.mergedFrom,
    url: merged.url || null,
    method: merged.method || null,
    tabId: merged.tabId || null,
    status: merged.status || null,
    statusCode: merged.statusCode || null,
    statusText: merged.statusText || null,
    requestHeaders: merged.requestHeaders || null,
    requestBody: merged.requestBody || null,
    responseHeaders: merged.responseHeaders || [],
    mimeType: merged.mimeType || null,
    body: merged.body || null,
    json: merged.json || null,
    base64Encoded: Boolean(merged.base64Encoded),
    bodyLength: textLength,
    bodyError: merged.bodyError || null,
    artifactRecommended: textLength > 16 * 1024,
    artifact: textLength > 16 * 1024 ? createArtifactHint('network', {
      ext: merged.base64Encoded ? 'bin' : (merged.mimeType === 'application/json' ? 'json' : 'txt'),
      fileName: `network-${requestId}`,
      mimeType: merged.base64Encoded ? 'application/octet-stream' : (merged.mimeType || 'text/plain'),
      sizeBytes: merged.base64Encoded ? Math.floor(textLength * 0.75) : textLength,
      encoding: merged.base64Encoded ? 'base64' : 'utf8',
      session,
      tabId: merged.tabId || capture.tabId || null,
      url: merged.url || null
    }) : null
  };
}

function mergeNetworkRequest(requests: NetworkRequest[], known: NetworkRequest): NetworkRequest & { mergeConfidence: string; mergedFrom: string[] } {
  const exactIds = new Set([known.id, known.webRequestId, known.cdpRequestId].filter(Boolean));
  let parts = requests.filter(r => exactIds.has(r.id) || exactIds.has(r.webRequestId) || exactIds.has(r.cdpRequestId));
  let mergeConfidence = parts.length > 1 ? 'exact' : 'single';
  if (parts.length <= 1) {
    const knownTs = capturedRequestTimestampMs(known);
    const siblings = requests.filter(r => {
      if (r === known) return false;
      if (!known.url || r.url !== known.url) return false;
      if ((known.method || null) !== (r.method || null)) return false;
      if (known.tabId !== undefined && r.tabId !== undefined && known.tabId !== r.tabId) return false;
      const ts = capturedRequestTimestampMs(r);
      return knownTs === null || ts === null || Math.abs(ts - knownTs) <= 2000;
    });
    if (siblings.length === 1) {
      parts = [known, siblings[0]];
      mergeConfidence = 'heuristic';
    } else if (siblings.length > 1) {
      mergeConfidence = 'ambiguous';
    }
  }
  const merged: any = { ...known };
  for (const part of parts) {
    for (const [key, value] of Object.entries(part)) {
      if (value !== undefined && value !== null && (merged[key] === undefined || merged[key] === null || merged[key] === '')) merged[key] = value;
    }
    if (part.webRequestId) merged.webRequestId = part.webRequestId;
    if (part.cdpRequestId) merged.cdpRequestId = part.cdpRequestId;
    if (part.requestBody !== undefined && part.requestBody !== null) merged.requestBody = part.requestBody;
    if (typeof part.body === 'string') {
      merged.body = part.body;
      merged.bodyLength = part.bodyLength;
      merged.base64Encoded = part.base64Encoded;
      merged.json = part.json;
    }
  }
  merged.mergeConfidence = mergeConfidence;
  merged.mergedFrom = parts.map(p => p.id);
  return merged;
}
