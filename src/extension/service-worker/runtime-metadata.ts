// Browser Control — Service Worker
// Maintains WebSocket connection to local daemon, routes commands to content scripts,
// handles tab/session management, and captures screenshots.

import type { ArtifactHint, ExtensionRuntimeMetadata, TabMetadata } from '../shared/types';

export const DEFAULT_DAEMON_WS_URL = 'ws://127.0.0.1:10087/ws';
let DAEMON_WS_URL = DEFAULT_DAEMON_WS_URL;
export const RECONNECT_DELAY_MS = 2000;
export const MAX_RECONNECT_DELAY_MS = 30000;
export const KEEPALIVE_INTERVAL_MS = 20000; // Keep MV3 service worker + WebSocket alive.
export const NETWORK_LIST_LIMIT = 100;
export const NETWORK_API_RESOURCE_TYPES = new Set(['fetch', 'xhr', 'xmlhttprequest']);

export function getDaemonWsUrl(): string {
  return DAEMON_WS_URL;
}

export function setDaemonWsUrl(value: string | null | undefined): void {
  DAEMON_WS_URL = value || DEFAULT_DAEMON_WS_URL;
}


export const EXTENSION_BACKEND_NAME = 'extension';
export const ARTIFACT_SCHEMA_VERSION = '2026-05-19';
export const EXTENSION_CAPABILITIES = [
  'navigateFinalMetadata',
  'observe_capture',
  'observe_start',
  'observe_diff',
  'network',
  'clickProbe',
  'cdpEvaluate',
  'cdpMouse',
  'cdpKeyboard',
  'cdpWheelScroll',
  'domPointer',
  'scroll',
  'get_text',
  'sessionNetworkCapture',
  'snapshotFilters',
  'snapshotAriaTree'
];

let extensionRuntimeMetadata: ExtensionRuntimeMetadata | null = null;

export function nowIso(): string {
  return new Date().toISOString();
}

export function sanitizeArtifactName(name: unknown, fallback?: string): string {
  return String(name || fallback || 'artifact')
    .replace(/[/\\?%*:|"<>]/g, '-')
    .replace(/\s+/g, '-')
    .slice(0, 120) || fallback || 'artifact';
}

export function createArtifactHint(kind: string, options: any = {}): ArtifactHint {
  const ext = String(options.ext || options.format || 'bin').replace(/^\./, '').toLowerCase();
  const baseName = sanitizeArtifactName(options.fileName || options.name, kind);
  const fileName = baseName.endsWith(`.${ext}`) ? baseName : `${baseName}.${ext}`;
  return {
    schemaVersion: ARTIFACT_SCHEMA_VERSION,
    backend: EXTENSION_BACKEND_NAME,
    kind,
    fileName,
    mimeType: options.mimeType || 'application/octet-stream',
    sizeBytes: options.sizeBytes || null,
    encoding: options.encoding || null,
    source: {
      session: options.session || null,
      tabId: options.tabId || null,
      url: options.url || null,
      title: options.title || null
    },
    createdAt: nowIso()
  };
}

export async function getExtensionRuntimeMetadata(): Promise<ExtensionRuntimeMetadata> {
  if (extensionRuntimeMetadata !== null) return extensionRuntimeMetadata;
  const manifest = chrome.runtime.getManifest();
  extensionRuntimeMetadata = {
    layer: 'extension',
    name: manifest.name,
    version: manifest.version,
    manifestVersion: manifest.manifest_version,
    protocolVersion: ARTIFACT_SCHEMA_VERSION,
    artifactSchemaVersion: ARTIFACT_SCHEMA_VERSION,
    build: { channel: 'source', source: 'extension' },
    capabilities: EXTENSION_CAPABILITIES
  };
  return extensionRuntimeMetadata;
}

export async function getTabMetadata(tabId: number | null | undefined): Promise<TabMetadata> {
  if (!tabId) return {};
  try {
    const tab = await chrome.tabs.get(tabId);
    return { tabId: tab.id, windowId: tab.windowId, url: tab.url || null, title: tab.title || null };
  } catch {
    return { tabId };
  }
}
