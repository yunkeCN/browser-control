// Browser Control — Options Script

const defaults = {
  daemonUrl: 'ws://127.0.0.1:10087/ws',
  snapshotMaxDepth: 20,
  requestTimeout: 30000,
  confirmActions: true
};

async function loadSettings() {
  const stored = await chrome.storage.sync.get(defaults) as typeof defaults;
  (document.getElementById('daemonUrl') as HTMLInputElement).value = stored.daemonUrl;
  (document.getElementById('snapshotMaxDepth') as HTMLInputElement).value = stored.snapshotMaxDepth as any;
  (document.getElementById('requestTimeout') as HTMLInputElement).value = stored.requestTimeout as any;
  (document.getElementById('confirmActions') as HTMLInputElement).checked = stored.confirmActions;
}

async function saveSettings() {
  const settings = {
    daemonUrl: (document.getElementById('daemonUrl') as HTMLInputElement).value || defaults.daemonUrl,
    snapshotMaxDepth: parseInt((document.getElementById('snapshotMaxDepth') as HTMLInputElement).value) || defaults.snapshotMaxDepth,
    requestTimeout: parseInt((document.getElementById('requestTimeout') as HTMLInputElement).value) || defaults.requestTimeout,
    confirmActions: (document.getElementById('confirmActions') as HTMLInputElement).checked
  };

  await chrome.storage.sync.set(settings);

  const msg = document.getElementById('savedMsg');
  msg!.classList.add('show');
  setTimeout(() => msg!.classList.remove('show'), 2000);
}

document.getElementById('btnSave')!.addEventListener('click', saveSettings);
loadSettings();
