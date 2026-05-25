#!/usr/bin/env node
// Browser Control Daemon — HTTP + WebSocket server
// Bridges AI agents (via HTTP) with Chrome Extension (via WebSocket)
// Listen only on localhost for security.

// @ts-nocheck
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { WebSocketServer } from 'ws';
import {
  normalizeRequest,
  validateRequest,
  protocolErrorFrom,
  createResultEnvelope,
  mapNetworkCommand,
  ProtocolError,
  PROTOCOL_VERSION,
  RUNTIME_SCHEMA_VERSION,
  DAEMON_CAPABILITIES
} from '../protocol.js';
import { ArtifactStore, extractArtifacts } from './artifact-store.js';
import packageJson from '../../package.json';

export function runDaemonServer() {

// ─── Configuration ───────────────────────────────────────────────────

const BROWSER_CONTROL_HOME = process.env.BROWSER_CONTROL_HOME || path.join(os.homedir(), '.browser-control');

const CONFIG = {
  host: process.env.BROWSER_CONTROL_HOST || '127.0.0.1',
  port: Number(process.env.BROWSER_CONTROL_PORT || 10087),
  logDir: BROWSER_CONTROL_HOME,
  pidFile: path.join(BROWSER_CONTROL_HOME, 'daemon.pid'),
  logFile: path.join(BROWSER_CONTROL_HOME, 'daemon.log'),
  artifactDir: process.env.BROWSER_CONTROL_ARTIFACT_DIR || path.join(BROWSER_CONTROL_HOME, 'artifacts'),
  maxLogSize: 10 * 1024 * 1024, // 10MB
};

// ─── Logging ─────────────────────────────────────────────────────────

function ensureLogDir() {
  if (!fs.existsSync(CONFIG.logDir)) {
    fs.mkdirSync(CONFIG.logDir, { recursive: true });
  }
}

function log(level, message, data = null) {
  const timestamp = new Date().toISOString();
  const entry = { timestamp, level, message, ...(data ? { data } : {}) };
  const line = JSON.stringify(entry);

  // Console output
  const prefix = level === 'error' ? '[ERROR]' : level === 'warn' ? '[WARN]' : '[INFO]';
  console.error(`${prefix} ${message}`);

  // File output
  try {
    ensureLogDir();
    fs.appendFileSync(CONFIG.logFile, line + '\n');
  } catch {
    // Log file write failure is non-fatal
  }
}

// ─── Session Management ──────────────────────────────────────────────

const sessions = new Map(); // sessionName -> { createdAt, tabCount, lastActivity }
const artifactStore = new ArtifactStore(CONFIG.artifactDir);
const observationBaselines = new Map(); // baselineId -> baseline record

const OBSERVATION_DEFAULTS = {
  ttlMs: 60 * 60 * 1000,
  maxPerSession: 20,
  maxGlobal: 200,
  maxTextChars: 12_000,
  maxTextRuns: 300,
  maxAdded: 80,
  maxRemoved: 80,
  maxSummaryChars: 1200,
  maxNetworkRequests: 100
};

const CLICK_AFTER_DEFAULTS = {
  initialDelayMs: 80,
  stableWindowMs: 120,
  timeoutMs: 700,
  snapshotOptions: {
    viewportOnly: true,
    hasVisibleText: true,
    boxes: true
  }
};

function getOrCreateSession(name) {
  if (!name) name = 'default';
  if (!sessions.has(name)) {
    sessions.set(name, {
      name,
      createdAt: new Date().toISOString(),
      tabCount: 0,
      lastActivity: new Date().toISOString()
    });
  }
  return sessions.get(name);
}

function updateSessionActivity(name) {
  const session = sessions.get(name);
  if (session) {
    session.lastActivity = new Date().toISOString();
  }
}

// ─── Extension WebSocket Connection ──────────────────────────────────

let extensionWs = null;
let extensionConnected = false;
let extensionRuntime = null;
const pendingRequests = new Map(); // requestId -> { resolve, reject, timer, session }

function daemonRuntimeMetadata() {
  return {
    layer: 'daemon',
    version: packageJson.version,
    protocolVersion: PROTOCOL_VERSION,
    runtimeSchemaVersion: RUNTIME_SCHEMA_VERSION,
    capabilities: DAEMON_CAPABILITIES
  };
}

function runtimeMetadata() {
  return {
    schemaVersion: RUNTIME_SCHEMA_VERSION,
    daemon: daemonRuntimeMetadata(),
    extension: extensionRuntime
  };
}

function capabilityWarnings() {
  const warnings = [];
  if (extensionConnected && !extensionRuntime) {
    warnings.push('Connected extension has not sent runtime metadata; it may be an older extension. Ordinary commands remain enabled, but reload the source extension for full diagnostics.');
  }
  return warnings;
}

function extensionHasCapabilities(capabilities) {
  if (!extensionRuntime) return null;
  const available = new Set(Array.isArray(extensionRuntime.capabilities) ? extensionRuntime.capabilities : []);
  return capabilities.every(capability => available.has(capability));
}

function ensureActionObservationSupported(request) {
  if (!actionObservationRequested(request)) return;
  if (!DAEMON_CAPABILITIES.includes('actionObservation')) {
    throw new ProtocolError('UNSUPPORTED', 'This daemon does not support actionObservation; run browser-control restart after upgrading.', {
      requested: 'actionObservation',
      nextSteps: ['Restart Browser Control daemon with: browser-control restart']
    });
  }
  const supported = extensionHasCapabilities(['observe_start', 'observe_diff']);
  if (supported === false) {
    throw new ProtocolError('UNSUPPORTED', 'Connected extension metadata does not advertise observation primitives required for expectChange/observe.', {
      requested: ['expectChange', 'observe'],
      extensionCapabilities: extensionRuntime.capabilities || [],
      nextSteps: ['Reload the Browser Control extension from the source path, then rerun doctor --json.']
    });
  }
}

function clickAfterMode(request) {
  return request.command === 'click' ? (request.args.after || 'auto') : 'none';
}

function clickAfterRequested(request) {
  return request.command === 'click' && clickAfterMode(request) !== 'none';
}

function ensureClickAfterSupported(request) {
  if (!clickAfterRequested(request)) return;
  const supported = extensionHasCapabilities(['observe_capture']);
  if (supported === false) {
    throw new ProtocolError('UNSUPPORTED', 'Connected extension metadata does not advertise primitives required for click after observation.', {
      requested: ['click.after', 'observe_capture'],
      extensionCapabilities: extensionRuntime.capabilities || [],
      nextSteps: ['Reload the Browser Control extension from the source path, or call click with after:"none" for a raw click.']
    });
  }
}

function setExtensionConnection(ws) {
  extensionWs = ws;
  extensionConnected = true;

  ws.on('message', (data) => {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      log('warn', 'Invalid message from extension');
      return;
    }
    handleExtensionMessage(msg);
  });

  ws.on('close', () => {
    extensionWs = null;
    extensionConnected = false;
    extensionRuntime = null;
    log('info', 'Extension disconnected');

    // Reject all pending requests
    for (const [id, pending] of pendingRequests) {
      clearTimeout(pending.timer);
      pending.reject(new Error('Extension disconnected'));
      pendingRequests.delete(id);
    }
  });

  ws.on('error', (err) => {
    log('error', 'Extension WebSocket error', { error: err.message });
  });

  log('info', 'Extension connected');
}

function handleExtensionMessage(msg) {
  const { type, requestId, data, error } = msg;

  if (type === 'hello' || type === 'status') {
    extensionRuntime = {
      ...(data && typeof data === 'object' ? data : {}),
      receivedAt: new Date().toISOString()
    };
    log('info', 'Extension runtime metadata received', {
      version: extensionRuntime.version,
      capabilities: extensionRuntime.capabilities
    });
    return;
  }

  if (type === 'response' && requestId !== undefined) {
    const pending = pendingRequests.get(requestId);
    if (pending) {
      clearTimeout(pending.timer);
      pendingRequests.delete(requestId);

      if (error) {
        pending.reject(new Error(error));
      } else {
        pending.resolve(data);
      }

      if (pending.session) {
        updateSessionActivity(pending.session);
      }
    }
  }
}

function sendToExtension(msg) {
  return new Promise((resolve, reject) => {
    if (!extensionWs || extensionWs.readyState !== 1) { // 1 = OPEN
      reject(new Error('Extension not connected. Ensure Chrome is running and the Browser Control extension is installed and enabled.'));
      return;
    }
    extensionWs.send(JSON.stringify(msg), (err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

function sendCommandToExtension(session, action, args, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const requestId = `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;

    const timer = setTimeout(() => {
      pendingRequests.delete(requestId);
      reject(new Error(`Command timeout: ${action} (${timeoutMs}ms)`));
    }, timeoutMs);

    pendingRequests.set(requestId, { resolve, reject, timer, session });

    sendToExtension({
      type: 'command',
      requestId,
      session,
      action,
      args
    }).catch(err => {
      clearTimeout(timer);
      pendingRequests.delete(requestId);
      reject(err);
    });
  });
}

// ─── HTTP API Handlers ───────────────────────────────────────────────

function parseJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (e) {
        reject(new Error('Invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, statusCode, data) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': 'http://127.0.0.1:*',
    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  });
  res.end(JSON.stringify(data));
}

function sendError(res, statusCode, message, details = null) {
  sendJson(res, statusCode, {
    ok: false,
    error: message,
    ...(details ? { details } : {})
  });
}

function makeObservationBaselineId(label = '') {
  const safe = String(label || '').replace(/[^a-zA-Z0-9_-]/g, '-').replace(/-+/g, '-').slice(0, 40);
  return `${safe ? `${safe}-` : ''}obs-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function observationStorageKey(session, tabId, baselineId) {
  return `${session || 'default'}:${tabId || 'unknown'}:${baselineId}`;
}

function cleanupObservationBaselines(now = Date.now()) {
  for (const [key, baseline] of observationBaselines) {
    if (baseline.expiresAtMs <= now) observationBaselines.delete(key);
  }
  if (observationBaselines.size <= OBSERVATION_DEFAULTS.maxGlobal) return;
  const sorted = [...observationBaselines.entries()].sort((a, b) => (a[1].lastAccessedAtMs || a[1].createdAtMs) - (b[1].lastAccessedAtMs || b[1].createdAtMs));
  for (const [key] of sorted.slice(0, observationBaselines.size - OBSERVATION_DEFAULTS.maxGlobal)) {
    observationBaselines.delete(key);
  }
}

function cleanupSessionObservationBaselines(session, tabId = null) {
  for (const [key, baseline] of observationBaselines) {
    if (baseline.session !== session) continue;
    if (tabId !== null && baseline.tabId !== tabId) continue;
    observationBaselines.delete(key);
  }
}

function enforceSessionObservationCap(session) {
  const entries = [...observationBaselines.entries()]
    .filter(([, baseline]) => baseline.session === session)
    .sort((a, b) => (a[1].lastAccessedAtMs || a[1].createdAtMs) - (b[1].lastAccessedAtMs || b[1].createdAtMs));
  const extra = entries.length - OBSERVATION_DEFAULTS.maxPerSession;
  if (extra > 0) {
    for (const [key] of entries.slice(0, extra)) observationBaselines.delete(key);
  }
}

function summarizeObservation(observation) {
  return {
    textRunCount: Array.isArray(observation?.textRuns) ? observation.textRuns.length : 0,
    visibleTextChars: typeof observation?.visibleText === 'string' ? observation.visibleText.length : 0,
    truncated: Boolean(observation?.truncated || observation?.caps?.truncated)
  };
}

function observationNavigationKey(observation) {
  return `${observation?.tabId || 'unknown'}:${observation?.url || ''}`;
}

async function captureObservation(request, overrides = {}) {
  const args = {
    mode: 'viewport_text',
    maxTextChars: OBSERVATION_DEFAULTS.maxTextChars,
    maxTextRuns: OBSERVATION_DEFAULTS.maxTextRuns,
    ...(request.args || {}),
    ...overrides
  };
  return sendCommandToExtension(request.session, 'observe_capture', args, request.timeoutMs);
}

async function handleObserveStart(request) {
  cleanupObservationBaselines();
  const markerTimestampMs = Date.now();
  const observation = await captureObservation(request);
  const baselineId = makeObservationBaselineId(request.args.baselineId);
  const now = Date.now();
  const record = {
    baselineId,
    session: request.session,
    tabId: observation.tabId || request.args.tabId || null,
    createdAt: new Date(now).toISOString(),
    createdAtMs: now,
    lastAccessedAtMs: now,
    expiresAt: new Date(now + OBSERVATION_DEFAULTS.ttlMs).toISOString(),
    expiresAtMs: now + OBSERVATION_DEFAULTS.ttlMs,
    url: observation.url || null,
    title: observation.title || '',
    navigationKey: observationNavigationKey(observation),
    networkMarker: request.args.includeNetworkMarker === false ? null : {
      markerId: `${baselineId}-network`,
      timestampMs: markerTimestampMs
    },
    observation
  };
  observationBaselines.set(observationStorageKey(request.session, record.tabId, baselineId), record);
  enforceSessionObservationCap(request.session);

  return {
    data: {
      baselineId,
      session: request.session,
      tabId: record.tabId,
      url: record.url,
      title: record.title,
      observedAt: record.createdAt,
      expiresAt: record.expiresAt,
      navigationKey: record.navigationKey,
      networkMarker: record.networkMarker,
      summary: summarizeObservation(observation)
    },
    artifacts: []
  };
}

function findObservationBaseline(session, baselineId, tabId = undefined) {
  cleanupObservationBaselines();
  if (tabId !== undefined && tabId !== null) {
    return observationBaselines.get(observationStorageKey(session, tabId, baselineId)) || null;
  }
  for (const baseline of observationBaselines.values()) {
    if (baseline.session === session && baseline.baselineId === baselineId) return baseline;
  }
  return null;
}

function textCounts(textRuns = []) {
  const counts = new Map();
  const ordered = [];
  for (const run of textRuns) {
    const text = String(run.normalizedText || run.text || '').replace(/\s+/g, ' ').trim();
    if (!text) continue;
    if (!counts.has(text)) ordered.push(text);
    counts.set(text, (counts.get(text) || 0) + 1);
  }
  return { counts, ordered };
}

function diffObservationText(beforeRuns, afterRuns, args = {}) {
  const maxAdded = Number.isFinite(args.maxAdded) ? args.maxAdded : OBSERVATION_DEFAULTS.maxAdded;
  const maxRemoved = Number.isFinite(args.maxRemoved) ? args.maxRemoved : OBSERVATION_DEFAULTS.maxRemoved;
  const before = textCounts(beforeRuns);
  const after = textCounts(afterRuns);
  const addedText = [];
  const removedText = [];
  let truncated = false;

  for (const text of after.ordered) {
    const delta = (after.counts.get(text) || 0) - (before.counts.get(text) || 0);
    for (let i = 0; i < delta; i++) {
      if (addedText.length >= maxAdded) { truncated = true; break; }
      addedText.push(text);
    }
  }
  for (const text of before.ordered) {
    const delta = (before.counts.get(text) || 0) - (after.counts.get(text) || 0);
    for (let i = 0; i < delta; i++) {
      if (removedText.length >= maxRemoved) { truncated = true; break; }
      removedText.push(text);
    }
  }
  return { addedText, removedText, truncated };
}

function buildObservationSummary(textDiff, stale, urlChanged, maxChars = OBSERVATION_DEFAULTS.maxSummaryChars) {
  const parts = [];
  if (stale) parts.push(urlChanged ? 'Baseline is stale because the tab URL changed.' : 'Baseline is stale.');
  if (textDiff.titleChanged) parts.push('Page title changed.');
  if (textDiff.activeElementChanged) parts.push('Focused element changed.');
  if (textDiff.visibleTextRunCountDelta) parts.push(`Visible text run count changed by ${textDiff.visibleTextRunCountDelta}.`);
  if (textDiff.visibleTextCharsDelta) parts.push(`Visible text character count changed by ${textDiff.visibleTextCharsDelta}.`);
  if (textDiff.addedText.length) parts.push(`Visible text added: ${textDiff.addedText.slice(0, 8).join('; ')}.`);
  if (textDiff.removedText.length) parts.push(`Visible text removed: ${textDiff.removedText.slice(0, 8).join('; ')}.`);
  if (!parts.length) parts.push('No added or removed visible text detected.');
  let summary = parts.join(' ');
  if (summary.length > maxChars) summary = `${summary.slice(0, Math.max(0, maxChars - 1))}…`;
  return summary;
}

function requestTimestampMs(request) {
  if (Number.isFinite(request.timestampMs)) return request.timestampMs;
  if (Number.isFinite(request.wallTime)) return Math.round(request.wallTime * 1000);
  if (Number.isFinite(request.timestamp)) {
    return request.timestamp > 1e12 ? request.timestamp : Math.round(request.timestamp * 1000);
  }
  return null;
}

function summarizeNetworkSince(networkList, marker, limit = OBSERVATION_DEFAULTS.maxNetworkRequests) {
  const sinceTimestampMs = marker?.timestampMs || null;
  let requests = Array.isArray(networkList?.requests) ? networkList.requests : [];
  if (sinceTimestampMs !== null) {
    requests = requests.filter(r => {
      const ts = requestTimestampMs(r);
      return ts === null || ts >= sinceTimestampMs;
    });
  }
  const truncated = requests.length > limit;
  requests = requests.slice(0, limit).map(r => ({
    requestId: r.id || r.requestId || r.webRequestId || r.cdpRequestId || null,
    method: r.method || null,
    url: r.url || null,
    status: r.status || null,
    statusCode: r.statusCode || null,
    type: r.type || null,
    timestampMs: requestTimestampMs(r)
  }));
  return {
    sinceMarkerId: marker?.markerId || null,
    sinceTimestampMs,
    requestCount: requests.length,
    requests,
    truncated,
    label: 'requests since marker; not proof of causation'
  };
}

async function handleObserveDiff(request, currentOverride = null) {
  const baseline = findObservationBaseline(request.session, request.args.baselineId, request.args.tabId);
  if (!baseline) {
    throw new Error(`Observation baseline not found or expired: ${request.args.baselineId}. Run observe_start again for the active tab.`);
  }
  baseline.lastAccessedAtMs = Date.now();

  const current = currentOverride || await captureObservation(request, { tabId: request.args.tabId || baseline.tabId });
  const currentNavigationKey = observationNavigationKey(current);
  const urlChanged = currentNavigationKey !== baseline.navigationKey;
  const titleChanged = String(current.title || '') !== String(baseline.title || '');
  const stale = Boolean(urlChanged);
  let textDiff = { addedText: [], removedText: [], truncated: false };
  if (!stale || request.args.allowStaleNavigationDiff === true) {
    textDiff = diffObservationText(baseline.observation.textRuns, current.textRuns, request.args);
  }
  const baselineCaps = baseline.observation?.caps || {};
  const currentCaps = current?.caps || {};
  textDiff = {
    ...textDiff,
    visibleTextRunCountDelta: (currentCaps.textRunCount || 0) - (baselineCaps.textRunCount || 0),
    visibleTextCharsDelta: (currentCaps.visibleTextChars || 0) - (baselineCaps.visibleTextChars || 0),
    titleChanged,
    activeElementChanged: JSON.stringify(baseline.observation?.activeElement || null) !== JSON.stringify(current?.activeElement || null),
    activeElementBefore: baseline.observation?.activeElement || null,
    activeElementAfter: current?.activeElement || null
  };

  let network = null;
  if (request.args.includeNetwork !== false && baseline.networkMarker) {
    const networkList = await sendCommandToExtension(request.session, 'network', {
      cmd: 'list',
      sinceTimestampMs: baseline.networkMarker.timestampMs,
      limit: OBSERVATION_DEFAULTS.maxNetworkRequests
    }, request.timeoutMs);
    network = summarizeNetworkSince(networkList, baseline.networkMarker, OBSERVATION_DEFAULTS.maxNetworkRequests);
  }

  const maxSummaryChars = Number.isFinite(request.args.maxSummaryChars) ? request.args.maxSummaryChars : OBSERVATION_DEFAULTS.maxSummaryChars;
  const summary = buildObservationSummary(textDiff, stale, urlChanged, maxSummaryChars);
  const artifacts = [];
  let artifact = null;
  if (textDiff.truncated || current.truncated || request.args.includeCurrent === true) {
    artifact = artifactStore.writeText('observation', JSON.stringify({ baseline: baseline.observation, current, textDiff, network }, null, 2), {
      ext: 'json',
      name: `observation-${request.args.baselineId}`,
      mimeType: 'application/json'
    });
    if (artifact) artifacts.push(artifact);
  }

  return {
    data: {
      baselineId: baseline.baselineId,
      session: request.session,
      tabId: baseline.tabId,
      url: current.url || null,
      title: current.title || '',
      urlChanged,
      titleChanged,
      stale,
      summary,
      textDiff,
      network,
      current: request.args.includeCurrent === true ? current : undefined,
      artifact
    },
    artifacts
  };
}

function isObservableAction(command) {
  return command === 'click' || command === 'fill' || command === 'press';
}

function actionObservationRequested(request) {
  return isObservableAction(request.command) && (
    request.args.expectChange === true ||
    (request.args.observe && typeof request.args.observe === 'object')
  );
}

function actionObserveArgs(request) {
  return request.args.observe && typeof request.args.observe === 'object' ? request.args.observe : {};
}

async function delay(ms) {
  if (!ms) return;
  await new Promise(resolve => setTimeout(resolve, ms));
}

function summarizeActionObservation(diffData, expectChange) {
  const addedCount = diffData?.textDiff?.addedText?.length || 0;
  const removedCount = diffData?.textDiff?.removedText?.length || 0;
  const networkCount = diffData?.network?.requestCount || 0;
  const lightweightDelta = Boolean(
    diffData?.urlChanged ||
    diffData?.titleChanged ||
    diffData?.textDiff?.activeElementChanged ||
    diffData?.textDiff?.visibleTextRunCountDelta ||
    diffData?.textDiff?.visibleTextCharsDelta
  );
  const warnings = [];
  if (expectChange && addedCount === 0 && removedCount === 0 && networkCount === 0 && !lightweightDelta) {
    warnings.push('expectChange was requested but no visible text, network, URL, title, focus, or text-metric delta was observed; inspect the latest snapshot before retrying.');
  }
  return {
    baselineId: diffData?.baselineId || null,
    summary: diffData?.summary || '',
    textDiff: diffData?.textDiff || { addedText: [], removedText: [], truncated: false },
    network: diffData?.network || null,
    stale: Boolean(diffData?.stale),
    urlChanged: Boolean(diffData?.urlChanged),
    titleChanged: Boolean(diffData?.titleChanged),
    warnings
  };
}

function observationSignature(observation) {
  const runs = Array.isArray(observation?.textRuns) ? observation.textRuns : [];
  return JSON.stringify({
    url: observation?.url || null,
    title: observation?.title || '',
    activeElement: observation?.activeElement || null,
    textRunCount: observation?.caps?.textRunCount || runs.length,
    visibleTextChars: observation?.caps?.visibleTextChars || (typeof observation?.visibleText === 'string' ? observation.visibleText.length : 0),
    texts: runs.slice(0, 500).map(run => run?.normalizedText || run?.text || '')
  });
}

async function waitForClickSettle(request, tabId) {
  const startedAtMs = Date.now();
  let captures = 0;
  await delay(CLICK_AFTER_DEFAULTS.initialDelayMs);

  let current = await captureObservation(request, { tabId });
  captures += 1;
  let currentSignature = observationSignature(current);

  while (Date.now() - startedAtMs < CLICK_AFTER_DEFAULTS.timeoutMs) {
    const remainingMs = CLICK_AFTER_DEFAULTS.timeoutMs - (Date.now() - startedAtMs);
    await delay(Math.min(CLICK_AFTER_DEFAULTS.stableWindowMs, Math.max(0, remainingMs)));
    const next = await captureObservation(request, { tabId });
    captures += 1;
    const nextSignature = observationSignature(next);
    if (nextSignature === currentSignature) {
      return {
        observation: next,
        settle: {
          settled: true,
          elapsedMs: Date.now() - startedAtMs,
          captures,
          initialDelayMs: CLICK_AFTER_DEFAULTS.initialDelayMs,
          stableWindowMs: CLICK_AFTER_DEFAULTS.stableWindowMs,
          timeoutMs: CLICK_AFTER_DEFAULTS.timeoutMs
        }
      };
    }
    current = next;
    currentSignature = nextSignature;
  }

  return {
    observation: current,
    settle: {
      settled: false,
      timedOut: true,
      elapsedMs: Date.now() - startedAtMs,
      captures,
      initialDelayMs: CLICK_AFTER_DEFAULTS.initialDelayMs,
      stableWindowMs: CLICK_AFTER_DEFAULTS.stableWindowMs,
      timeoutMs: CLICK_AFTER_DEFAULTS.timeoutMs
    }
  };
}

function shouldReturnClickPostSnapshot(mode, diffData, result) {
  if (mode === 'snapshot') return true;
  if (mode !== 'auto') return false;
  const textDiff = diffData?.textDiff || {};
  return Boolean(
    result?.newTab ||
    (Array.isArray(result?.newTabs) && result.newTabs.length) ||
    diffData?.urlChanged ||
    diffData?.titleChanged ||
    textDiff.activeElementChanged ||
    textDiff.visibleTextRunCountDelta ||
    textDiff.visibleTextCharsDelta ||
    (Array.isArray(textDiff.addedText) && textDiff.addedText.length) ||
    (Array.isArray(textDiff.removedText) && textDiff.removedText.length)
  );
}

function postSnapshotTabId(result, fallbackTabId) {
  if (result?.newTab?.id) return result.newTab.id;
  if (Array.isArray(result?.newTabs) && result.newTabs.length === 1 && result.newTabs[0]?.id) return result.newTabs[0].id;
  return fallbackTabId;
}

async function runActionWithObservation(request, mapped) {
  const observeArgs = actionObserveArgs(request);
  const baselineId = observeArgs.baselineId || `action_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const start = await handleObserveStart({
    ...request,
    args: {
      tabId: request.args.tabId,
      baselineId,
      includeNetworkMarker: observeArgs.includeNetwork !== false
    }
  });

  const result = await sendCommandToExtension(request.session, mapped.command, mapped.args, request.timeoutMs);
  const waitMs = Number.isFinite(observeArgs.waitMs) ? Math.min(Math.max(0, observeArgs.waitMs), 5000) : 150;
  await delay(waitMs);

  const diff = await handleObserveDiff({
    ...request,
    args: {
      ...observeArgs,
      baselineId: start.data.baselineId,
      tabId: start.data.tabId,
      includeNetwork: observeArgs.includeNetwork !== false
    }
  });

  const actionObservation = summarizeActionObservation(diff.data, request.args.expectChange === true);
  const data = result && typeof result === 'object' && !Array.isArray(result)
    ? { ...result, actionObservation }
    : { result, actionObservation };
  return { data, artifacts: diff.artifacts || [] };
}

async function runClickWithAfter(request, mapped) {
  const mode = clickAfterMode(request);
  if (mode === 'none') {
    const data = await sendCommandToExtension(request.session, mapped.command, mapped.args, request.timeoutMs);
    return { data, artifacts: [] };
  }

  const baselineId = `click_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const start = await handleObserveStart({
    ...request,
    args: {
      tabId: request.args.tabId,
      baselineId,
      includeNetworkMarker: true
    }
  });

  const result = await sendCommandToExtension(request.session, mapped.command, mapped.args, request.timeoutMs);
  const settleTargetTabId = postSnapshotTabId(result, start.data.tabId);
  const settled = await waitForClickSettle(request, settleTargetTabId);

  const diff = await handleObserveDiff({
    ...request,
    args: {
      baselineId: start.data.baselineId,
      tabId: start.data.tabId,
      includeNetwork: true,
      allowStaleNavigationDiff: true
    }
  }, settled.observation);

  const changes = summarizeActionObservation(diff.data, false);
  const artifacts = [...(diff.artifacts || [])];
  let postSnapshot = null;
  let postSnapshotError = null;
  if (shouldReturnClickPostSnapshot(mode, diff.data, result)) {
    try {
      const rawSnapshot = await sendCommandToExtension(request.session, 'snapshot', {
        ...CLICK_AFTER_DEFAULTS.snapshotOptions,
        tabId: settleTargetTabId
      }, request.timeoutMs);
      const extracted = extractArtifacts('snapshot', rawSnapshot, artifactStore);
      postSnapshot = extracted.data;
      artifacts.push(...extracted.artifacts);
    } catch (err) {
      postSnapshotError = err?.message || String(err);
    }
  }

  const data = result && typeof result === 'object' && !Array.isArray(result)
    ? { ...result }
    : { clicked: Boolean(result), result };
  data.after = mode;
  data.settle = settled.settle;
  data.changes = changes;
  if (postSnapshot) data.postSnapshot = postSnapshot;
  if (postSnapshotError) {
    data.postSnapshot = null;
    data.warnings = [
      ...(Array.isArray(data.warnings) ? data.warnings : []),
      `Post-click snapshot failed: ${postSnapshotError}`
    ];
  }
  if (!postSnapshot && mode === 'auto') {
    data.postSnapshot = null;
    data.postSnapshotReason = 'No major visible, focus, title, URL, or new-tab change was detected.';
  }
  return { data, artifacts };
}

async function handleCommand(req, res) {
  const startedAt = new Date().toISOString();
  let request;
  try {
    const body = await parseJsonBody(req);
    request = validateRequest(normalizeRequest(body));
  } catch (err) {
    const error = protocolErrorFrom(err, 'VALIDATION_ERROR');
    const fallbackRequest = request || { id: 'invalid', command: 'unknown', session: 'default' };
    return sendJson(res, 400, createResultEnvelope(fallbackRequest, {
      ok: false,
      startedAt,
      error: { code: error.code, message: error.message, retryable: error.retryable, details: error.details }
    }));
  }

  getOrCreateSession(request.session);
  const mapped = mapNetworkCommand(request.command, request.args);

  try {
    log('info', `Command: ${request.command}`, { session: request.session, args: Object.keys(request.args) });
    ensureActionObservationSupported(request);
    ensureClickAfterSupported(request);
    if (request.command === 'observe_start' || request.command === 'observe_diff') {
      const observed = request.command === 'observe_start'
        ? await handleObserveStart(request)
        : await handleObserveDiff(request);
      const tab = observed.data && typeof observed.data === 'object' ? (observed.data.tab || observed.data.tabId || null) : null;
      return sendJson(res, 200, createResultEnvelope(request, {
        ok: true,
        startedAt,
        tab,
        data: observed.data,
        artifacts: observed.artifacts,
        diagnostics: { extensionConnected, pendingRequests: pendingRequests.size, runtime: runtimeMetadata(), warnings: capabilityWarnings() }
      }));
    }
    const clickAfter = clickAfterRequested(request)
      ? await runClickWithAfter(request, mapped)
      : null;
    const observedAction = !clickAfter && actionObservationRequested(request)
      ? await runActionWithObservation(request, mapped)
      : null;
    const result = clickAfter ? clickAfter.data : observedAction ? observedAction.data : await sendCommandToExtension(request.session, mapped.command, mapped.args, request.timeoutMs);
    const { data, artifacts } = extractArtifacts(request.command, result, artifactStore);
    if (clickAfter?.artifacts?.length) artifacts.push(...clickAfter.artifacts);
    if (observedAction?.artifacts?.length) artifacts.push(...observedAction.artifacts);
    const tab = data && typeof data === 'object' ? (data.tab || data.tabId || null) : null;
    if (request.command === 'navigate' && tab !== null) cleanupSessionObservationBaselines(request.session, tab);
    if (request.command === 'close_session') cleanupSessionObservationBaselines(request.session);
    if (request.command === 'close_tab') {
      const closedTab = data?.closed || tab;
      if (closedTab !== null && closedTab !== undefined) cleanupSessionObservationBaselines(request.session, closedTab);
    }
    sendJson(res, 200, createResultEnvelope(request, {
      ok: true,
      startedAt,
      tab,
      data,
      artifacts,
      diagnostics: { extensionConnected, pendingRequests: pendingRequests.size, runtime: runtimeMetadata(), warnings: capabilityWarnings() }
    }));
  } catch (err) {
    const error = protocolErrorFrom(err);
    log('error', `Command failed: ${request.command}`, { code: error.code, error: error.message });
    const statusCode = error.code === 'TIMEOUT' ? 504 : error.code === 'NOT_FOUND' ? 404 : 502;
    sendJson(res, statusCode, createResultEnvelope(request, {
      ok: false,
      startedAt,
      error: { code: error.code, message: error.message, retryable: error.retryable, details: error.details },
      diagnostics: { extensionConnected, pendingRequests: pendingRequests.size, runtime: runtimeMetadata(), warnings: capabilityWarnings() }
    }));
  }
}

async function handleHealth(req, res) {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    status: 'ok',
    running: true,
    port: CONFIG.port,
    version: packageJson.version,
    protocolVersion: PROTOCOL_VERSION,
    runtimeSchemaVersion: RUNTIME_SCHEMA_VERSION,
    capabilities: DAEMON_CAPABILITIES,
    runtime: runtimeMetadata(),
    warnings: capabilityWarnings(),
    extensionConnected,
    extension_connected: extensionConnected,
    artifactDir: CONFIG.artifactDir,
    uptimeSeconds: Math.floor(process.uptime()),
    sessions: sessions.size,
    pendingRequests: pendingRequests.size,
    timestamp: new Date().toISOString()
  }));
}

async function handleStatus(req, res) {
  const result = {
    running: true,
    port: CONFIG.port,
    version: packageJson.version,
    protocolVersion: PROTOCOL_VERSION,
    runtimeSchemaVersion: RUNTIME_SCHEMA_VERSION,
    capabilities: DAEMON_CAPABILITIES,
    runtime: runtimeMetadata(),
    warnings: capabilityWarnings(),
    extension_connected: extensionConnected,
    uptime_seconds: Math.floor(process.uptime()),
    sessions: [...sessions.entries()].map(([name, s]) => ({
      name,
      createdAt: s.createdAt,
      tabCount: s.tabCount,
      lastActivity: s.lastActivity
    })),
    logFile: CONFIG.logFile,
    artifactDir: CONFIG.artifactDir,
    pid: process.pid
  };
  sendJson(res, 200, result);
}

function handleCors(req, res) {
  res.writeHead(204, {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  });
  res.end();
}

// ─── HTTP Server ─────────────────────────────────────────────────────

const server = http.createServer((req, res) => {
  const { method, url } = req;
  const parsedUrl = new URL(url, `http://${req.headers.host || 'localhost'}`);

  // CORS preflight
  if (method === 'OPTIONS') {
    return handleCors(req, res);
  }

  // Route: POST /command
  if (method === 'POST' && parsedUrl.pathname === '/command') {
    return handleCommand(req, res);
  }

  // Route: GET /health
  if (method === 'GET' && parsedUrl.pathname === '/health') {
    return handleHealth(req, res);
  }

  // Route: GET /status (detailed status)
  if (method === 'GET' && parsedUrl.pathname === '/status') {
    return handleStatus(req, res);
  }

  // Route: GET / (simple info page)
  if (method === 'GET' && parsedUrl.pathname === '/') {
    return sendJson(res, 200, {
      name: 'Browser Control Daemon',
      version: packageJson.version,
      endpoints: {
        'POST /command': 'Execute a browser command',
        'GET /health': 'Health check',
        'GET /status': 'Detailed status',
        'GET /': 'This page'
      },
      docs: 'https://github.com/example/browser-control'
    });
  }

  // 404
  sendError(res, 404, 'Not found');
});

// ─── WebSocket Server (for Chrome Extension) ─────────────────────────

const wss = new WebSocketServer({ server });

wss.on('connection', (ws, req) => {
  const clientIp = req.socket.remoteAddress;

  // Only accept local connections
  if (clientIp !== '127.0.0.1' && clientIp !== '::1' && clientIp !== '::ffff:127.0.0.1') {
    log('warn', 'Rejected non-local WebSocket connection', { ip: clientIp });
    ws.close(4001, 'Only localhost connections allowed');
    return;
  }

  // Only one extension connection at a time
  if (extensionWs) {
    log('warn', 'Replacing existing extension connection');
    extensionWs.close(4002, 'New connection established');
  }

  log('info', 'WebSocket client connected', { ip: clientIp });
  setExtensionConnection(ws);
});

wss.on('error', (err) => {
  log('error', 'WebSocket server error', { error: err.message });
});

// ─── Startup ─────────────────────────────────────────────────────────

function writePidFile() {
  ensureLogDir();
  fs.writeFileSync(CONFIG.pidFile, String(process.pid));
}

function removePidFile() {
  try {
    if (fs.existsSync(CONFIG.pidFile)) {
      fs.unlinkSync(CONFIG.pidFile);
    }
  } catch {
    // Best effort
  }
}

// Handle graceful shutdown
function shutdown() {
  log('info', 'Shutting down...');

  if (extensionWs) {
    extensionWs.close(1000, 'Daemon shutting down');
  }

  wss.close(() => {
    server.close(() => {
      removePidFile();
      log('info', 'Daemon stopped');
      process.exit(0);
    });
  });

  // Force exit after 5s
  setTimeout(() => {
    log('error', 'Forced shutdown after timeout');
    removePidFile();
    process.exit(1);
  }, 5000);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('uncaughtException', (err) => {
  log('error', 'Uncaught exception', { error: err.message, stack: err.stack });
  shutdown();
});
process.on('unhandledRejection', (reason) => {
  log('error', 'Unhandled rejection', { error: reason?.message || String(reason) });
});


server.on('error', (err) => {
  const code = err && err.code;
  const message = code === 'EADDRINUSE'
    ? `Port ${CONFIG.port} is already in use`
    : code === 'EACCES'
      ? `No permission to listen on ${CONFIG.host}:${CONFIG.port}`
      : err.message;
  log('error', 'Daemon listen failed', { code, error: message, host: CONFIG.host, port: CONFIG.port });
  removePidFile();
  process.exit(1);
});

// Start server
server.listen(CONFIG.port, CONFIG.host, () => {
  writePidFile();
  log('info', `Daemon listening on http://${CONFIG.host}:${CONFIG.port}`);
  log('info', `WebSocket available at ws://${CONFIG.host}:${CONFIG.port}/ws`);
  log('info', `Log file: ${CONFIG.logFile}`);
  log('info', `PID: ${process.pid}`);
});

}
