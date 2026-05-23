// Browser Control — Popup Script

interface PopupStatus {
  connected: boolean;
  sessionCount: number;
  activeSessions: string[];
  tabCount: number;
}

const el = (id: string): HTMLElement => document.getElementById(id)!;

function renderExtensionVersion(): void {
  const manifest = chrome.runtime.getManifest();
  el('extensionVersion').textContent = `v${manifest.version} — AI Browser Automation`;
}

async function refreshStatus(): Promise<void> {
  try {
    const status = await chrome.runtime.sendMessage({ type: 'getStatus' });
    updateUI(status);
  } catch {
    updateUI({ connected: false, sessionCount: 0, activeSessions: [], tabCount: 0 });
  }
}

function updateUI(status: PopupStatus): void {
  const connected = status.connected;

  el('daemonDot').className = 'dot ' + (connected ? 'green' : 'red');
  el('daemonStatus').textContent = connected ? 'connected' : 'disconnected';
  el('wsDot').className = 'dot ' + (connected ? 'green' : 'yellow');
  el('wsStatus').textContent = connected ? 'open' : 'closed';
  el('sessionCount').textContent = String(status.sessionCount || 0);
  el('tabCount').textContent = String(status.tabCount || 0);

  // Render session list
  const container = el('sessionList');
  if (status.activeSessions && status.activeSessions.length > 0) {
    container.innerHTML = status.activeSessions
      .map((s: string) => `<span class="session-tag">🤖 ${escapeHtml(s)}</span>`)
      .join('');
  } else {
    container.innerHTML = '';
  }

  (el('btnConnect') as HTMLButtonElement).disabled = connected;
  (el('btnDisconnect') as HTMLButtonElement).disabled = !connected;
}

function escapeHtml(str: string): string {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

el('btnConnect').addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: 'connect' });
  setTimeout(refreshStatus, 500);
});

el('btnDisconnect').addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: 'disconnect' });
  setTimeout(refreshStatus, 500);
});

// Refresh on open
renderExtensionVersion();
refreshStatus();

// Poll status every 5 seconds
setInterval(refreshStatus, 5000);
