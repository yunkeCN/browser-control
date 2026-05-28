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
import { computeSnapshotDiff } from '../shared/snapshot-diff.js';
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
const snapshotStore = new Map(); // baselineId -> { tree?, textRuns, observation, ... }

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

const CLICK_SETTLE = {
  initialDelayMs: 80,
  stableWindowMs: 120,
  timeoutMs: 700
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

function allowedCorsOrigin(req) {
  const origin = req?.headers?.origin;
  if (!origin) return null;
  try {
    const url = new URL(origin);
    const isHttp = url.protocol === 'http:' || url.protocol === 'https:';
    const isLocal = ['127.0.0.1', 'localhost', '::1'].includes(url.hostname);
    return isHttp && isLocal ? origin : null;
  } catch {
    return null;
  }
}

function jsonHeaders(req) {
  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  };
  const origin = allowedCorsOrigin(req);
  if (origin) {
    headers['Access-Control-Allow-Origin'] = origin;
    headers.Vary = 'Origin';
  }
  return headers;
}

function sendJson(req, res, statusCode, data) {
  res.writeHead(statusCode, jsonHeaders(req));
  res.end(JSON.stringify(data));
}

function sendError(req, res, statusCode, message, details = null) {
  sendJson(req, res, statusCode, {
    ok: false,
    error: message,
    ...(details ? { details } : {})
  });
}

let _snapCounter = 0;
function makeObservationBaselineId(label = '') {
  const safe = String(label || '').replace(/[^a-zA-Z0-9_-]/g, '-').replace(/-+/g, '-').slice(0, 40);
  if (safe) return safe;
  return `s${++_snapCounter}_${Math.random().toString(36).slice(2, 6)}`;
}

function observationStorageKey(session, tabId, baselineId) {
  return `${session || 'default'}:${tabId || 'unknown'}:${baselineId}`;
}

function cleanupObservationBaselines(now = Date.now()) {
  for (const [key, baseline] of snapshotStore) {
    if (baseline.expiresAtMs <= now) snapshotStore.delete(key);
  }
  if (snapshotStore.size <= OBSERVATION_DEFAULTS.maxGlobal) return;
  const sorted = [...snapshotStore.entries()].sort((a, b) => (a[1].lastAccessedAtMs || a[1].createdAtMs) - (b[1].lastAccessedAtMs || b[1].createdAtMs));
  for (const [key] of sorted.slice(0, snapshotStore.size - OBSERVATION_DEFAULTS.maxGlobal)) {
    snapshotStore.delete(key);
  }
}

function cleanupSessionObservationBaselines(session, tabId = null) {
  for (const [key, baseline] of snapshotStore) {
    if (baseline.session !== session) continue;
    if (tabId !== null && baseline.tabId !== tabId) continue;
    snapshotStore.delete(key);
  }
}

function enforceSessionObservationCap(session) {
  const entries = [...snapshotStore.entries()]
    .filter(([, baseline]) => baseline.session === session)
    .sort((a, b) => (a[1].lastAccessedAtMs || a[1].createdAtMs) - (b[1].lastAccessedAtMs || b[1].createdAtMs));
  const extra = entries.length - OBSERVATION_DEFAULTS.maxPerSession;
  if (extra > 0) {
    for (const [key] of entries.slice(0, extra)) snapshotStore.delete(key);
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
    observation,
    tree: null
  };
  snapshotStore.set(observationStorageKey(request.session, record.tabId, baselineId), record);
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
    return snapshotStore.get(observationStorageKey(session, tabId, baselineId)) || null;
  }
  for (const baseline of snapshotStore.values()) {
    if (baseline.session === session && baseline.baselineId === baselineId) return baseline;
  }
  return null;
}

/**
 * 在 snapshotStore 中找出同一 session+tab 的最新一条带 tree 的快照记录
 * 用于存储前去重：如果新快照与最新快照无差，则复用其 baselineId
 */
function findLatestTreeForTab(session, tabId) {
  let latest = null;
  let latestMs = -1;
  for (const record of snapshotStore.values()) {
    if (record.session !== session) continue;
    if (record.tabId !== tabId) continue;
    if (!record.tree) continue; // observe_start 等无 tree 的记录跳过
    if (record.createdAtMs > latestMs) {
      latestMs = record.createdAtMs;
      latest = { baselineId: record.baselineId, tree: record.tree };
    }
  }
  return latest;
}

function indexTextRuns(runs) {
  const map = new Map();
  for (const run of runs) {
    const text = String(run.normalizedText || run.text || '').replace(/\s+/g, ' ').trim();
    if (!text) continue;
    if (!map.has(text)) map.set(text, []);
    map.get(text).push({ ref: run.element || null, role: run.role || null });
  }
  return map;
}

function diffObservationText(beforeRuns, afterRuns, args = {}) {
  const maxAdded = Number.isFinite(args.maxAdded) ? args.maxAdded : OBSERVATION_DEFAULTS.maxAdded;
  const maxRemoved = Number.isFinite(args.maxRemoved) ? args.maxRemoved : OBSERVATION_DEFAULTS.maxRemoved;
  const before = indexTextRuns(beforeRuns);
  const after = indexTextRuns(afterRuns);
  const added = [];
  const removed = [];
  let truncated = false;

  for (const [text, afterItems] of after) {
    const beforeCount = (before.get(text) || []).length;
    const delta = afterItems.length - beforeCount;
    for (let i = 0; i < delta; i++) {
      if (added.length >= maxAdded) { truncated = true; break; }
      const item = afterItems[beforeCount + i] || afterItems[0];
      added.push({ text, ref: item.ref, role: item.role });
    }
  }
  for (const [text, beforeItems] of before) {
    const afterCount = (after.get(text) || []).length;
    const delta = beforeItems.length - afterCount;
    for (let i = 0; i < delta; i++) {
      if (removed.length >= maxRemoved) { truncated = true; break; }
      const item = beforeItems[afterCount + i] || beforeItems[0];
      removed.push({ text, ref: item.ref, role: item.role });
    }
  }
  return { added, removed, truncated };
}

function formatDiffItems(items) {
  return items.slice(0, 8).map(item => {
    const label = item.role && item.ref
      ? `${item.role} ${item.ref}`
      : item.role || item.ref || '';
    return label ? `"${item.text}" (${label})` : `"${item.text}"`;
  }).join('; ');
}

function buildObservationSummary(textDiff, stale, urlChanged, maxChars = OBSERVATION_DEFAULTS.maxSummaryChars) {
  const parts = [];
  if (stale) parts.push(urlChanged ? 'Baseline is stale because the tab URL changed.' : 'Baseline is stale.');
  if (textDiff.titleChanged) parts.push('Page title changed.');
  if (textDiff.activeElementChanged) parts.push('Focused element changed.');
  if (textDiff.visibleTextRunCountDelta) parts.push(`Visible text run count changed by ${textDiff.visibleTextRunCountDelta}.`);
  if (textDiff.visibleTextCharsDelta) parts.push(`Visible text character count changed by ${textDiff.visibleTextCharsDelta}.`);
  if (textDiff.added?.length) parts.push(`Visible text added: ${formatDiffItems(textDiff.added)}.`);
  if (textDiff.removed?.length) parts.push(`Visible text removed: ${formatDiffItems(textDiff.removed)}.`);
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
  let textDiff = { added: [], removed: [], truncated: false };
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
  const addedCount = diffData?.textDiff?.added?.length || 0;
  const removedCount = diffData?.textDiff?.removed?.length || 0;
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
    textDiff: diffData?.textDiff || { added: [], removed: [], truncated: false },
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
  await delay(CLICK_SETTLE.initialDelayMs);

  let current = await captureObservation(request, { tabId });
  captures += 1;
  let currentSignature = observationSignature(current);

  while (Date.now() - startedAtMs < CLICK_SETTLE.timeoutMs) {
    const remainingMs = CLICK_SETTLE.timeoutMs - (Date.now() - startedAtMs);
    await delay(Math.min(CLICK_SETTLE.stableWindowMs, Math.max(0, remainingMs)));
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
          initialDelayMs: CLICK_SETTLE.initialDelayMs,
          stableWindowMs: CLICK_SETTLE.stableWindowMs,
          timeoutMs: CLICK_SETTLE.timeoutMs
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
      initialDelayMs: CLICK_SETTLE.initialDelayMs,
      stableWindowMs: CLICK_SETTLE.stableWindowMs,
      timeoutMs: CLICK_SETTLE.timeoutMs
    }
  };
}

/**
 * Check whether the after-pipeline detected evidence that the click had an effect,
 * regardless of what the click mechanism's self-reported `clicked` field says.
 *
 * This covers scenarios where:
 *  - CDP mouseReleased throws because the page navigated after mousePressed
 *  - DOM fallback reports COVERED_TARGET but the original CDP events already triggered navigation
 *  - The click mechanism reports failure but the page observably changed
 */
function hasMeaningfulClickEffect(changes, result, diffDataOverride = null) {
  const diffData = diffDataOverride || changes;
  if (!diffData) return false;
  const textDiff = diffData?.textDiff || {};
  return Boolean(
    result?.newTab ||
    (Array.isArray(result?.newTabs) && result.newTabs.length) ||
    diffData?.urlChanged ||
    diffData?.titleChanged ||
    textDiff.activeElementChanged ||
    textDiff.visibleTextRunCountDelta ||
    textDiff.visibleTextCharsDelta ||
    (Array.isArray(textDiff.added) && textDiff.added.length) ||
    (Array.isArray(textDiff.removed) && textDiff.removed.length)
  );
}

async function runActionWithObservation(request, mapped) {
  const observeArgs = actionObserveArgs(request);
  const start = await handleObserveStart({
    ...request,
    args: {
      tabId: request.args.tabId,
      baselineId: observeArgs.baselineId || undefined,
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

async function runClick(request, mapped) {
  const start = await handleObserveStart({
    ...request,
    args: {
      tabId: request.args.tabId,
      includeNetworkMarker: true
    }
  });

  const result = await sendCommandToExtension(request.session, mapped.command, mapped.args, request.timeoutMs);

  // Determine which tab to settle on (new tab if click opened one)
  const settleTargetTabId = result?.newTab?.id
    || (Array.isArray(result?.newTabs) && result.newTabs.length === 1 && result.newTabs[0]?.id)
    || start.data.tabId;

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

  const data = result && typeof result === 'object' && !Array.isArray(result)
    ? { ...result }
    : { clicked: Boolean(result), result };
  data.settle = settled.settle;
  data.changes = changes;

  // If the click mechanism reported failure but the pipeline detected
  // meaningful page changes, trust the evidence.
  if (!data.clicked && hasMeaningfulClickEffect(changes, result, diff?.data)) {
    data.clicked = true;
    data.clickOverride = 'pipeline detected page change despite click mechanism reporting failure';
  }

  return { data, artifacts: [...(diff.artifacts || [])] };
}

async function runSnapshotWithStore(request, mapped) {
  const diffTo = request.args.diff_to;

  // 1. 捕获 textRuns + snapshot tree
  const observation = await captureObservation(request);
  const snapshotResult = await sendCommandToExtension(request.session, mapped.command, mapped.args, request.timeoutMs);

  // 2. 存入 snapshotStore（存储前去重：与最近快照无差则复用 baselineId）
  const tabId = observation.tabId || request.args.tabId || null;
  const newTree = snapshotResult?.tree || snapshotResult?.snapshot?.tree || null;

  let baselineId;
  if (newTree) {
    const prev = findLatestTreeForTab(request.session, tabId);
    if (prev) {
      const diff = computeSnapshotDiff(prev.tree, newTree);
      if (!diff.hasChanges) {
        baselineId = prev.baselineId; // 页面无变化，复用已有 ID，跳过写入
      }
    }
  }

  if (!baselineId) {
    baselineId = makeObservationBaselineId();
    const now = Date.now();
    const record = {
      baselineId,
      session: request.session,
      tabId,
      createdAt: new Date(now).toISOString(),
      createdAtMs: now,
      lastAccessedAtMs: now,
      expiresAt: new Date(now + OBSERVATION_DEFAULTS.ttlMs).toISOString(),
      expiresAtMs: now + OBSERVATION_DEFAULTS.ttlMs,
      url: observation.url || null,
      title: observation.title || '',
      navigationKey: observationNavigationKey(observation),
      networkMarker: null,
      observation,
      tree: newTree
    };
    snapshotStore.set(observationStorageKey(request.session, tabId, baselineId), record);
    enforceSessionObservationCap(request.session);
  }

  // 3. 如果请求了 diff_to，查找历史基线树
  let baselineTree = null;
  if (diffTo) {
    const baseline = findObservationBaseline(request.session, diffTo, request.args.tabId);
    if (baseline) {
      baseline.lastAccessedAtMs = Date.now();
      baselineTree = baseline.tree || baseline.observation?.tree || null;
    }
  }

  const data = snapshotResult && typeof snapshotResult === 'object' && !Array.isArray(snapshotResult)
    ? { ...snapshotResult }
    : { snapshot: snapshotResult };
  data.baselineId = baselineId;
  if (baselineTree) data.baselineTree = baselineTree;
  if (diffTo && !baselineTree) {
    data.warnings = [
      ...(Array.isArray(data.warnings) ? data.warnings : []),
      `diff_to baseline "${diffTo}" not found or expired`
    ];
  }

  return { data, artifacts: [] };
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
    return sendJson(req, res, 400, createResultEnvelope(fallbackRequest, {
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
    if (request.command === 'observe_start' || request.command === 'observe_diff') {
      const observed = request.command === 'observe_start'
        ? await handleObserveStart(request)
        : await handleObserveDiff(request);
      const tab = observed.data && typeof observed.data === 'object' ? (observed.data.tab || observed.data.tabId || null) : null;
      return sendJson(req, res, 200, createResultEnvelope(request, {
        ok: true,
        startedAt,
        tab,
        data: observed.data,
        artifacts: observed.artifacts,
        diagnostics: { extensionConnected, pendingRequests: pendingRequests.size, runtime: runtimeMetadata(), warnings: capabilityWarnings() }
      }));
    }
    if (request.command === 'snapshot') {
      const { data, artifacts } = await runSnapshotWithStore(request, mapped);
      const tab = data && typeof data === 'object' ? (data.tab || data.tabId || null) : null;
      return sendJson(req, res, 200, createResultEnvelope(request, {
        ok: true,
        startedAt,
        tab,
        data,
        artifacts,
        diagnostics: { extensionConnected, pendingRequests: pendingRequests.size, runtime: runtimeMetadata(), warnings: capabilityWarnings() }
      }));
    }
    let execResult;
    let execArtifacts = [];
    if (request.command === 'click') {
      const clicked = await runClick(request, mapped);
      execResult = clicked.data;
      execArtifacts = clicked.artifacts || [];
    } else if (actionObservationRequested(request)) {
      const observed = await runActionWithObservation(request, mapped);
      execResult = observed.data;
      execArtifacts = observed.artifacts || [];
    } else {
      execResult = await sendCommandToExtension(request.session, mapped.command, mapped.args, request.timeoutMs);
    }
    const { data, artifacts } = extractArtifacts(request.command, execResult, artifactStore);
    if (execArtifacts.length) artifacts.push(...execArtifacts);
    const tab = data && typeof data === 'object' ? (data.tab || data.tabId || null) : null;
    if (request.command === 'navigate' && tab !== null) cleanupSessionObservationBaselines(request.session, tab);
    if (request.command === 'close_session') cleanupSessionObservationBaselines(request.session);
    if (request.command === 'close_tab') {
      const closedTab = data?.closed || tab;
      if (closedTab !== null && closedTab !== undefined) cleanupSessionObservationBaselines(request.session, closedTab);
    }
    sendJson(req, res, 200, createResultEnvelope(request, {
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
    sendJson(req, res, statusCode, createResultEnvelope(request, {
      ok: false,
      startedAt,
      error: { code: error.code, message: error.message, retryable: error.retryable, details: error.details },
      diagnostics: { extensionConnected, pendingRequests: pendingRequests.size, runtime: runtimeMetadata(), warnings: capabilityWarnings() }
    }));
  }
}

async function handleHealth(req, res) {
  res.writeHead(200, jsonHeaders(req));
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
  sendJson(req, res, 200, result);
}

function handleCors(req, res) {
  res.writeHead(204, jsonHeaders(req));
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

  // Route: POST /restart
  if (method === 'POST' && parsedUrl.pathname === '/restart') {
    sendJson(req, res, 200, { ok: true, message: 'Daemon restarting...' });
    log('info', 'Restart requested via HTTP');
    setTimeout(() => {
      server.close(() => process.exit(0));
      setTimeout(() => process.exit(0), 1000);
    }, 200);
    return;
  }

  // Route: GET / (simple info page)
  if (method === 'GET' && parsedUrl.pathname === '/') {
    return sendJson(req, res, 200, {
      name: 'Browser Control Daemon',
      version: packageJson.version,
      endpoints: {
        'POST /command': 'Execute a browser command',
        'GET /health': 'Health check',
        'GET /status': 'Detailed status',
        'POST /restart': 'Restart the daemon',
        'GET /': 'This page'
      },
      docs: 'https://github.com/example/browser-control'
    });
  }

  // 404
  sendError(req, res, 404, 'Not found');
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
