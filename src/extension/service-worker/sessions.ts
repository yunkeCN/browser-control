import type { SessionName } from '../shared/types';

export const sessionTabs = new Map<SessionName, Set<number>>();    // sessionName -> Set<tabId>
export const activeSessions = new Map<SessionName, { name: string; createdAt: string }>(); // sessionName -> { name, createdAt }

// ─── Tab & Session management ────────────────────────────────────────

export function getSessionTabs(session: SessionName): Set<number> {
  if (!sessionTabs.has(session)) {
    sessionTabs.set(session, new Set());
  }
  return sessionTabs.get(session)!;
}

export function getActiveTabId(session: SessionName): number | null {
  const tabs = getSessionTabs(session);
  // Return the last tab in the set (most recently used)
  const arr = [...tabs];
  return arr.length > 0 ? arr[arr.length - 1] : null;
}

export function getTrackedTabIds(session: SessionName): number[] {
  return [...getSessionTabs(session)];
}

export function removeTrackedTab(tabId: number): void {
  for (const tabs of sessionTabs.values()) {
    tabs.delete(tabId);
  }
}

export async function setActiveTab(session: SessionName, tabId: number): Promise<void> {
  const tabs = getSessionTabs(session);
  tabs.add(tabId);

  // Group tabs for this session
  try {
    if (tabs.size > 1) {
      const existingGroup = await chrome.tabGroups.query({ title: `🤖 ${session}` });
      if (existingGroup.length === 0) {
        const groupId = await chrome.tabs.group({ tabIds: [...tabs] as any });
        await chrome.tabGroups.update(groupId as number, { title: `🤖 ${session}`, collapsed: false });
      }
    }
  } catch {
    // Tab grouping may not be available
  }
}
