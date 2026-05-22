// ─── Helpers ─────────────────────────────────────────────────────────

export function getNavigationTimeoutMs(timeoutMs: unknown): number {
  return typeof timeoutMs === 'number' && Number.isFinite(timeoutMs) && timeoutMs > 0 ? Math.min(timeoutMs, 60000) : 15000;
}

export function isNavigationCompletionCandidate(tab: any, options: any = {}): boolean {
  const { expectedUrl = null, previousUrl = null, sawLoading = false } = options;
  const currentUrl = tab?.url || '';
  if (!tab || tab.status !== 'complete') return false;
  if (!currentUrl || currentUrl === 'about:blank') return false;
  if (sawLoading) return true;
  if (!expectedUrl) return true;
  if (currentUrl !== previousUrl) return true;
  return false;
}

export async function updateTabAndWaitForLoad(
  tabId: number,
  updateProperties: chrome.tabs.UpdateProperties,
  options: any = {}
): Promise<any> {
  const timeoutMs = getNavigationTimeoutMs(options.timeoutMs);
  const expectedUrl = options.expectedUrl || updateProperties?.url || null;
  const previousTab = await chrome.tabs.get(tabId).catch(() => null);
  const previousUrl = previousTab?.url || null;
  let latestTab: chrome.tabs.Tab | { id: number } = previousTab || { id: tabId };
  let sawLoading = false;
  let settled = false;
  let timeout: ReturnType<typeof setTimeout> | null = null;
  let listener: ((tabId: number, changeInfo: any, tab: chrome.tabs.Tab) => void) | null = null;
  let settleLoad: ((value: any) => void) | null = null;

  const finish = (result: any) => {
    if (settled) return;
    settled = true;
    if (timeout) clearTimeout(timeout);
    if (listener) chrome.tabs.onUpdated.removeListener(listener);
    settleLoad?.(result);
  };

  const loadPromise = new Promise<any>((resolve) => {
    settleLoad = resolve;
    listener = (updatedTabId: number, changeInfo: any, updatedTab: chrome.tabs.Tab) => {
      if (updatedTabId !== tabId) return;
      if (updatedTab) latestTab = updatedTab;
      if (changeInfo.status === 'loading') sawLoading = true;
      if (changeInfo.status === 'complete' && isNavigationCompletionCandidate(latestTab, {
        expectedUrl,
        previousUrl,
        sawLoading
      })) {
        finish({ complete: true, timedOut: false, timeoutMs });
      }
    };
    chrome.tabs.onUpdated.addListener(listener);
    timeout = setTimeout(() => {
      finish({ complete: false, timedOut: true, timeoutMs });
    }, timeoutMs);
  });

  try {
    latestTab = await chrome.tabs.update(tabId, updateProperties) as chrome.tabs.Tab;
    if (isNavigationCompletionCandidate(latestTab, { expectedUrl, previousUrl, sawLoading })) {
      finish({ complete: true, timedOut: false, timeoutMs });
    }
  } catch (error) {
    finish({ complete: false, timedOut: false, timeoutMs });
    throw error;
  }

  const load = await loadPromise;
  latestTab = await chrome.tabs.get(tabId).catch(() => latestTab) as chrome.tabs.Tab | { id: number };
  return {
    ...load,
    id: latestTab?.id || tabId,
    tab: latestTab || { id: tabId },
    previousUrl
  };
}
