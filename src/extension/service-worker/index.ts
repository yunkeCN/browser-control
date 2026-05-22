import { DEFAULT_DAEMON_WS_URL, RECONNECT_DELAY_MS, setDaemonWsUrl } from './runtime-metadata';
import { activeSessions, removeTrackedTab, sessionTabs } from './sessions';
import { removeNetworkTab } from './handlers/network-cdp';
import { clearReconnectTimer, closeWebSocket, connectWebSocket, isWebSocketConnected, loadDaemonUrl, resetReconnectDelay, stopKeepAlive } from './transport';

// ─── Message listeners ───────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'getStatus') {
    sendResponse({
      connected: isWebSocketConnected(),
      sessionCount: sessionTabs.size,
      activeSessions: [...activeSessions.keys()],
      tabCount: [...sessionTabs.values()].reduce((sum, s) => sum + s.size, 0)
    });
  } else if (msg.type === 'connect') {
    connectWebSocket();
    sendResponse({ ok: true });
  } else if (msg.type === 'disconnect') {
    stopKeepAlive();
    closeWebSocket();
    sendResponse({ ok: true });
  }
  return true;
});

chrome.tabs.onRemoved.addListener((tabId) => {
  removeTrackedTab(tabId);
  removeNetworkTab(tabId);
});

// ─── Startup ─────────────────────────────────────────────────────────

// Listen for daemon URL changes in settings
chrome.storage.onChanged.addListener((changes) => {
  if (changes.daemonUrl) {
    setDaemonWsUrl((changes.daemonUrl.newValue || DEFAULT_DAEMON_WS_URL) as string);
    // Reconnect with new URL
    stopKeepAlive();
    closeWebSocket();
    resetReconnectDelay();
    clearReconnectTimer();
    connectWebSocket({ silent: true });
  }
});

// Delay initial connection — daemon may not be running yet
loadDaemonUrl().then(() => {
  setTimeout(() => {
    connectWebSocket({ silent: true });
  }, 5000);
});
console.log('[AgentBridge] Service worker started, will attempt connection in 5s');
