import {
  DEFAULT_DAEMON_WS_URL,
  KEEPALIVE_INTERVAL_MS,
  MAX_RECONNECT_DELAY_MS,
  RECONNECT_DELAY_MS,
  getDaemonWsUrl,
  getExtensionRuntimeMetadata,
  setDaemonWsUrl
} from './runtime-metadata';
import { handleDaemonMessage } from './command-router';
import { broadcastStatus } from './status';
import type { CommandAction, CommandArgs, PendingRequest, SessionName } from '../shared/types';

let ws: WebSocket | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let keepAliveTimer: ReturnType<typeof setInterval> | null = null;
let reconnectDelay = RECONNECT_DELAY_MS;
export const pendingRequests = new Map<number, PendingRequest>(); // requestId -> { resolve, reject, timer }
let requestCounter = 0;

// ─── WebSocket lifecycle ────────────────────────────────────────────


export function stopKeepAlive(): void {
  if (keepAliveTimer) {
    clearInterval(keepAliveTimer);
    keepAliveTimer = null;
  }
}

export function startKeepAlive(): void {
  stopKeepAlive();
  keepAliveTimer = setInterval(() => {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      stopKeepAlive();
      return;
    }
    try {
      ws.send(JSON.stringify({ type: 'ping', timestamp: Date.now() }));
    } catch {
      stopKeepAlive();
    }
  }, KEEPALIVE_INTERVAL_MS);
}

export function connectWebSocket(options: { silent?: boolean } = {}): void {
  const { silent = false } = options;
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
    return;
  }

  if (!silent) {
    console.log('[AgentBridge] Connecting to daemon...');
  }
  ws = new WebSocket(getDaemonWsUrl());

  ws.onopen = () => {
    console.log('[AgentBridge] Connected to daemon');
    reconnectDelay = RECONNECT_DELAY_MS;
    startKeepAlive();
    sendExtensionHello();
    broadcastStatus({ connected: true });
  };

  ws.onmessage = (event) => {
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch {
      console.error('[AgentBridge] Invalid message from daemon:', event.data);
      return;
    }
    handleDaemonMessage(msg);
  };

  ws.onclose = (event) => {
    // 1006 = abnormal closure (connection refused) — expected during silent retries
    if (!silent || event.code !== 1006) {
      console.log(`[AgentBridge] Disconnected (code=${event.code})`);
    }
    ws = null;
    stopKeepAlive();
    broadcastStatus({ connected: false });
    scheduleReconnect({ silent: true });
  };

  ws.onerror = () => {
    // Connection refused during polling is expected — suppress noisy error
    if (silent) {
      console.warn('[AgentBridge] Daemon not reachable, will retry later');
    } else {
      console.warn('[AgentBridge] WebSocket error');
    }
  };
}

export function scheduleReconnect(options: { silent?: boolean } = {}): void {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectWebSocket({ silent: true }); // Auto-retries are always silent
    reconnectDelay = Math.min(reconnectDelay * 1.5, MAX_RECONNECT_DELAY_MS);
  }, reconnectDelay);
}

export function ensureConnected(): Promise<void> {
  return new Promise<void>((resolve) => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      resolve();
      return;
    }
    connectWebSocket();
    const check = setInterval(() => {
      if (ws && ws.readyState === WebSocket.OPEN) {
        clearInterval(check);
        resolve();
      }
    }, 100);
    // Timeout after 10s
    setTimeout(() => {
      clearInterval(check);
      resolve(); // resolve anyway, caller should handle errors
    }, 10000);
  });
}

// ─── Settings ────────────────────────────────────────────────────────

export async function loadDaemonUrl(): Promise<void> {
  try {
    const stored = await chrome.storage.sync.get({ daemonUrl: DEFAULT_DAEMON_WS_URL });
    setDaemonWsUrl((stored.daemonUrl || DEFAULT_DAEMON_WS_URL) as string);
  } catch {
    setDaemonWsUrl(DEFAULT_DAEMON_WS_URL);
  }
}

export function sendToDaemon(msg: unknown): void {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    console.error('[AgentBridge] Cannot send, not connected');
    return;
  }
  ws.send(JSON.stringify(msg));
}

export function sendCommandAndWait(
  session: SessionName,
  action: CommandAction,
  args: CommandArgs | undefined,
  timeoutMs = 30000
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const requestId = ++requestCounter;
    const timer = setTimeout(() => {
      pendingRequests.delete(requestId);
      reject(new Error(`Request ${requestId} timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    pendingRequests.set(requestId, { resolve, reject, timer });

    sendToDaemon({
      type: 'command',
      requestId,
      session,
      action,
      args
    });
  });
}



async function sendExtensionHello(): Promise<void> {
  try {
    sendToDaemon({
      type: 'hello',
      data: await getExtensionRuntimeMetadata()
    });
  } catch {
    // Hello metadata is diagnostic-only; command transport remains best-effort.
  }
}

export function isWebSocketConnected(): boolean {
  return !!(ws && ws.readyState === WebSocket.OPEN);
}

export function closeWebSocket(): void {
  if (ws) ws.close();
}

export function resetReconnectDelay(): void {
  reconnectDelay = RECONNECT_DELAY_MS;
}

export function clearReconnectTimer(): void {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
}
