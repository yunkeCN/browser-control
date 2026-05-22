import { NETWORK_API_RESOURCE_TYPES, NETWORK_CAPTURE_LIMIT, NETWORK_LIST_LIMIT, NETWORK_STORAGE_PREFIX, createArtifactHint, nowIso } from '../runtime-metadata';
import { getActiveTabId, getTrackedTabIds } from '../sessions';
import { resolveClickTargetForCdp } from '../page-runtime/cdp-target';
import type { ActionDebuggerLease, CommandArgs, NetworkCapture, NetworkRequest, SessionName } from '../../shared/types';

type DebuggerSource = chrome.debugger.Debuggee;
type DebuggerParams = Record<string, any>;

export async function handleNetwork(args: CommandArgs = {}, session: SessionName): Promise<any> {
  const { cmd, filter, requestId, includeResources = false, sinceTimestampMs, limit, tabId, scope } = args || {};

  switch (cmd) {
    case 'start':
      return startNetworkCapture(session, filter, includeResources, { tabId, scope });
    case 'stop':
      return stopNetworkCapture(session);
    case 'list':
      return listNetworkRequests(session, filter, { sinceTimestampMs, limit });
    case 'detail':
      return getNetworkRequestDetail(session, requestId);
    default:
      throw new Error(`Unknown network cmd: ${cmd}. Use: start, stop, list, detail`);
  }
}

// Network capture state
export const networkCaptures = new Map<SessionName, NetworkCapture>(); // session -> { requests: [], filter, tabId, auto }
let debuggerListenerInstalled = false;
let networkPersistTimers = new Map<SessionName, ReturnType<typeof setTimeout>>();

export function networkStorageKey(session: SessionName | null | undefined): string {
  return `${NETWORK_STORAGE_PREFIX}${session || 'default'}`;
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

async function loadPersistedNetworkCapture(session: SessionName): Promise<NetworkCapture | null> {
  try {
    const key = networkStorageKey(session);
    const stored = await chrome.storage.local.get(key);
    const value = stored?.[key] as any;
    if (!value || !Array.isArray(value.requests)) return null;
    return {
      requests: value.requests.slice(-NETWORK_CAPTURE_LIMIT),
      filter: value.filter || null,
      tabId: value.tabId || null,
      tabIds: Array.isArray(value.tabIds) ? value.tabIds : (value.tabId ? [value.tabId] : []),
      scope: value.scope || (value.tabId ? 'tab' : 'session'),
      auto: Boolean(value.auto),
      includeResources: Boolean(value.includeResources),
      persistedAt: value.persistedAt || null
    };
  } catch {
    return null;
  }
}

function persistNetworkCaptureSoon(session: SessionName, capture: NetworkCapture | null | undefined): void {
  if (!chrome.storage?.local || !capture) return;
  const existing = networkPersistTimers.get(session);
  if (existing) clearTimeout(existing);
  networkPersistTimers.set(session, setTimeout(async () => {
    networkPersistTimers.delete(session);
    try {
      const key = networkStorageKey(session);
      await chrome.storage.local.set({
        [key]: {
          session,
          filter: capture.filter || null,
          tabId: capture.tabId || null,
          tabIds: capture.tabIds || [],
          scope: capture.scope || 'session',
          auto: Boolean(capture.auto),
          includeResources: Boolean(capture.includeResources),
          persistedAt: nowIso(),
          requests: capture.requests.slice(-NETWORK_CAPTURE_LIMIT)
        }
      });
    } catch (err: any) {
      console.warn('[AgentBridge] Failed to persist network capture:', err?.message || err);
    }
  }, 250));
}

async function clearPersistedNetworkCapture(session: SessionName): Promise<void> {
  try {
    await chrome.storage.local.remove(networkStorageKey(session));
  } catch {
    // Ignore storage cleanup failures.
  }
}

function shouldCaptureUrl(capture: NetworkCapture, url: unknown): boolean {
  return !capture.filter || String(url || '').includes(capture.filter);
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

function shouldCaptureRequest(capture: NetworkCapture, url: unknown, type: unknown): boolean {
  if (!shouldCaptureUrl(capture, url)) return false;
  if (capture.includeResources) return true;
  return isApiResourceType(type);
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

function upsertCapturedRequest(capture: NetworkCapture, patch: Partial<NetworkRequest> & { requestId?: string }): NetworkRequest | null {
  const id = patch.id || patch.requestId;
  if (!id) return null;
  let req = capture.requests.find(r => r.id === id || r.cdpRequestId === id || r.webRequestId === id);
  if (!req) {
    req = { id, status: 'pending' };
    capture.requests.push(req);
  }
  Object.assign(req, patch);
  if (capture.requests.length > NETWORK_CAPTURE_LIMIT) capture.requests.splice(0, capture.requests.length - NETWORK_CAPTURE_LIMIT);
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
    if (!shouldCaptureUrl(capture, url)) return;
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
    persistNetworkCaptureSoon(session, capture);
  } else if (method === 'Network.responseReceived') {
    const url = params.response?.url || '';
    if (!shouldCaptureRequest(capture, url, params.type)) {
      removeCapturedRequest(capture, params.requestId);
      persistNetworkCaptureSoon(session, capture);
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
    persistNetworkCaptureSoon(session, capture);
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
    persistNetworkCaptureSoon(session, capture);
  } else if (method === 'Network.loadingFailed') {
    const req = capture.requests.find(r => r.cdpRequestId === params.requestId || r.id === params.requestId);
    if (req) {
      req.status = 'failed';
      req.errorText = params.errorText || null;
      req.canceled = Boolean(params.canceled);
    }
    persistNetworkCaptureSoon(session, capture);
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
  const reset = Boolean(options.reset);
  let capture = reset ? null : networkCaptures.get(session);
  if (!capture && !reset) capture = await loadPersistedNetworkCapture(session);
  if (!capture) capture = { requests: [], filter: null, tabId: null, tabIds: [], scope, auto: false };

  capture.filter = options.filter !== undefined ? (options.filter || null) : (capture.filter || null);
  capture.includeResources = Boolean(options.includeResources || capture.includeResources);
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
  persistNetworkCaptureSoon(session, capture);

  return {
    status: 'capturing',
    session,
    tabId: capture.tabId || null,
    captureScope: capture.scope || 'session',
    trackedTabIds: capture.tabIds || [],
    auto: Boolean(capture.auto),
    mode: capture.includeResources ? 'all' : 'api-only',
    stored: capture.requests.length,
    webRequest,
    debugger: debuggerStatus
  };
}

export async function startNetworkCapture(session: SessionName, filter: string | null | undefined, includeResources = false, options: any = {}): Promise<any> {
  const existing = networkCaptures.get(session);
  for (const id of debuggerTabIds(existing as any)) {
    try { await chrome.debugger.detach({ tabId: id }); } catch { /* Ignore detach failures before reset. */ }
  }
  await clearPersistedNetworkCapture(session);
  return ensureNetworkCapture(session, { filter, includeResources, reset: true, tabId: options.tabId, scope: options.scope });
}

export async function stopNetworkCapture(session: SessionName): Promise<any> {
  const capture = networkCaptures.get(session);
  networkCaptures.delete(session);
  await clearPersistedNetworkCapture(session);

  for (const id of debuggerTabIds(capture as any)) {
    try { await chrome.debugger.detach({ tabId: id }); } catch { /* Not attached or already detached. */ }
  }

  return { status: 'stopped', session };
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

  const networkOwner = findNetworkDebuggerCapture(tabId);
  if (networkOwner) {
    return {
      debuggee: { tabId },
      temporary: false,
      owner: 'network_capture',
      warnings: [`Reusing debugger session owned by network capture for session ${networkOwner.session}; Browser Control will not detach it after the action.`]
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

export async function releaseActionDebugger(lease: ActionDebuggerLease): Promise<string | null> {
  if (!lease?.temporary || !lease.debuggee) return null;
  try {
    await chrome.debugger.detach(lease.debuggee);
    return null;
  } catch (err: any) {
    return `Failed to detach temporary debugger session: ${err?.message || String(err)}`;
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

  try {
    await chrome.debugger.sendCommand(debuggee, 'Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: geometry.hitTest.clientX,
      y: geometry.hitTest.clientY,
      button: 'none',
      modifiers
    });
    await chrome.debugger.sendCommand(debuggee, 'Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x: geometry.hitTest.clientX,
      y: geometry.hitTest.clientY,
      button,
      clickCount,
      modifiers
    });
    await chrome.debugger.sendCommand(debuggee, 'Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x: geometry.hitTest.clientX,
      y: geometry.hitTest.clientY,
      button,
      clickCount,
      modifiers
    });
  } catch (err: any) {
    return {
      clicked: false,
      selector,
      strategyUsed: 'cdp_mouse',
      error: `CDP mouse dispatch failed: ${err?.message || String(err)}`,
      recoverable: true,
      target: geometry.target,
      hitTest: geometry.hitTest,
      warnings
    };
  } finally {
    const detachWarning = await releaseActionDebugger(lease);
    if (detachWarning) warnings.push(detachWarning);
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
  const code = key.length === 1 ? `Key${key.toUpperCase()}` : key;
  const modifiers = cdpModifierMask(options?.modifiers);
  try {
    await chrome.debugger.sendCommand(debuggee, 'Input.dispatchKeyEvent', {
      type: 'keyDown',
      key,
      code,
      windowsVirtualKeyCode: key.length === 1 ? key.toUpperCase().charCodeAt(0) : 0,
      nativeVirtualKeyCode: key.length === 1 ? key.toUpperCase().charCodeAt(0) : 0,
      modifiers
    });
    await chrome.debugger.sendCommand(debuggee, 'Input.dispatchKeyEvent', {
      type: 'keyUp',
      key,
      code,
      windowsVirtualKeyCode: key.length === 1 ? key.toUpperCase().charCodeAt(0) : 0,
      nativeVirtualKeyCode: key.length === 1 ? key.toUpperCase().charCodeAt(0) : 0,
      modifiers
    });
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

  return { pressed: true, key, code, strategyUsed: 'cdp_keyboard', synthetic: false, warnings };
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
  // Store request for all active sessions.
  for (const [session, capture] of networkCaptures) {
    if (!captureTracksTab(capture, details.tabId)) continue;
    if (shouldCaptureRequest(capture, details.url, details.type)) {
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
      persistNetworkCaptureSoon(session, capture);
    }
  }
}

function networkCompletedListener(details: any): void {
  for (const [session, capture] of networkCaptures) {
    if (!captureTracksTab(capture, details.tabId)) continue;
    const req = capture.requests.find(r => r.webRequestId === details.requestId || r.id === details.requestId || r.url === details.url);
    if (req) {
      req.status = 'complete';
      req.statusCode = details.statusCode;
      req.responseHeaders = details.responseHeaders;
      persistNetworkCaptureSoon(session, capture);
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

async function listNetworkRequests(session: SessionName, filter: string | null | undefined, options: any = {}): Promise<any> {
  let capture: NetworkCapture | null | undefined = networkCaptures.get(session);
  if (!capture) {
    capture = await loadPersistedNetworkCapture(session);
    if (capture) networkCaptures.set(session, capture);
  }
  if (!capture) return { requests: [] };

  let requests = capture.requests;
  if (filter) requests = requests.filter(r => String(r.url || '').includes(filter));
  if (Number.isFinite(options.sinceTimestampMs)) {
    requests = requests.filter(r => {
      const timestampMs = capturedRequestTimestampMs(r);
      return timestampMs === null || timestampMs >= options.sinceTimestampMs;
    });
  }
  const limit = Number.isFinite(options.limit) ? options.limit : NETWORK_LIST_LIMIT;
  return {
    session,
    tabId: capture.tabId || null,
    captureScope: capture.scope || 'session',
    trackedTabIds: capture.tabIds || [],
    auto: Boolean(capture.auto),
    mode: capture.includeResources ? 'all' : 'api-only',
    stored: capture.requests.length,
    limit: NETWORK_CAPTURE_LIMIT,
    sinceTimestampMs: Number.isFinite(options.sinceTimestampMs) ? options.sinceTimestampMs : null,
    requests: requests.slice(-limit).map(r => ({
      id: r.id,
      webRequestId: r.webRequestId || null,
      cdpRequestId: r.cdpRequestId || null,
      url: r.url,
      method: r.method,
      timestamp: r.timestamp,
      timestampMs: capturedRequestTimestampMs(r),
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
    }))
  };
}

async function getNetworkRequestDetail(session: SessionName, requestId: string): Promise<any> {
  let capture: NetworkCapture | null | undefined = networkCaptures.get(session);
  if (!capture) {
    capture = await loadPersistedNetworkCapture(session);
    if (capture) networkCaptures.set(session, capture);
  }
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
