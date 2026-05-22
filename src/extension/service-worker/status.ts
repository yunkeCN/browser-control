export function broadcastStatus(status: Record<string, unknown>): void {
  // Notify all connected popups
  chrome.runtime.sendMessage({ type: 'status', ...status }).catch(() => {
    // Popup may not be open
  });
}
