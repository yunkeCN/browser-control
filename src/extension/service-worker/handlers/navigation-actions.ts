import { createArtifactHint, getTabMetadata } from '../runtime-metadata';
import { getActiveTabId, setActiveTab } from '../sessions';
import { ensureNetworkCapture, performCdpClickAt, performCdpEvaluate, performCdpKeyboardPress, performCdpMouseClick, performCdpWheelScroll, runClickProbeCapture } from './network-cdp';
import { getAccessibilitySnapshot } from '../page-runtime/snapshot';
import { captureViewportTextObservation } from '../page-runtime/observation';
import { getDocumentTextSnapshot, getTextSnapshot } from '../page-runtime/get-text';
import { performClick } from '../page-runtime/click';
import { performFill } from '../page-runtime/fill';
import { focusPressTarget, performPress } from '../page-runtime/press';
import { performDomScroll } from '../page-runtime/scroll';
import { performWaitFor } from '../page-runtime/wait-for';
import { performEvaluate } from '../page-runtime/evaluate';
import { updateTabAndWaitForLoad } from '../navigation-helpers';
import type { CommandArgs, SessionName } from '../../shared/types';

// ─── Action handlers ─────────────────────────────────────────────────

type NewTabCandidate = {
  id?: number;
  title?: string;
  url?: string;
  active?: boolean;
  openerTabId?: number;
  windowId?: number;
};

function tabSummary(tab: chrome.tabs.Tab): NewTabCandidate {
  return {
    id: tab.id,
    title: tab.title,
    url: tab.url,
    active: tab.active,
    openerTabId: tab.openerTabId,
    windowId: tab.windowId
  };
}

async function beginNewTabWatch(): Promise<Set<number>> {
  const tabs = await chrome.tabs.query({});
  return new Set(tabs.map(tab => tab.id).filter((id): id is number => typeof id === 'number'));
}

async function attachNewTabsIfAny(session: SessionName, sourceTabId: number, beforeIds: Set<number>, args: CommandArgs = {}): Promise<any> {
  await new Promise(resolve => setTimeout(resolve, 250));
  const afterTabs = await chrome.tabs.query({});
  const candidates = afterTabs
    .filter(tab => typeof tab.id === 'number' && !beforeIds.has(tab.id))
    .map(tabSummary);
  const openerMatch = candidates.find(tab => tab.openerTabId === sourceTabId) || (candidates.length === 1 ? candidates[0] : null);
  const warnings: string[] = [];
  if (args?.expectNewTab === true && !openerMatch) warnings.push('expectNewTab was requested but no new tab was observed after the action.');
  if (openerMatch?.id) {
    await setActiveTab(session, openerMatch.id);
    await ensureNetworkCapture(session, { tabId: openerMatch.id, auto: true, scope: 'session' });
  }
  return { openerMatch, candidates, warnings };
}

function mergeNewTabObservation(result: any, observed: any): any {
  const warnings = [...(result?.warnings || []), ...(observed.warnings || [])];
  if (!observed.openerMatch && !observed.candidates.length && !warnings.length) return result;
  return {
    ...result,
    newTab: observed.openerMatch,
    newTabs: observed.candidates,
    observedNewTabs: observed.candidates,
    suggestedNextStep: observed.openerMatch?.id
      ? `A new tab opened and Browser Control attached it to this session. Continue with snapshot or wait_for on tab ${observed.openerMatch.id}.`
      : result?.suggestedNextStep,
    warnings
  };
}

function mergePressFocusDiagnostics(result: any, focusResult: any): any {
  if (!focusResult) return result;
  const warnings = [...(result?.warnings || []), ...(focusResult.warnings || [])];
  return {
    ...result,
    selector: result?.selector ?? focusResult.selector ?? null,
    target: result?.target || focusResult.target,
    focusBefore: result?.focusBefore || focusResult.focusBefore,
    focusAfter: result?.focusAfter || focusResult.focusAfter,
    focused: focusResult.focused,
    focus: {
      before: focusResult.focusBefore || null,
      after: focusResult.focusAfter || null,
      target: focusResult.target || null,
      focused: Boolean(focusResult.focused)
    },
    warnings
  };
}

function targetSelector(args: CommandArgs = {}): string | undefined {
  if (typeof args?.target === 'string' && args.target) {
    if (args.target.startsWith('css=')) return args.target.slice(4).trim();
    return args.target;
  }
  return args?.selector;
}

type TextClickCandidate = {
  role: string;
  text: string;
  ref?: string;
  box: { x: number; y: number; width: number; height: number };
  boxCenterX: number;
  boxCenterY: number;
  distance: number;
  candidateCount?: number;
};

function normalizeSearchText(value: unknown): string {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function nodeSearchText(node: any): string {
  const parts: string[] = [];
  if (node?.name) parts.push(String(node.name));
  if (node?.text) parts.push(String(node.text));
  if (Array.isArray(node?.children)) {
    for (const child of node.children) {
      if (child?.text) parts.push(String(child.text));
      else parts.push(nodeSearchText(child));
    }
  }
  return normalizeSearchText(parts.join(' '));
}

function boxCenter(box: { x: number; y: number; width: number; height: number }): { x: number; y: number } {
  return {
    x: Math.round(box.x + box.width / 2),
    y: Math.round(box.y + box.height / 2)
  };
}

function distanceBetween(x1: number, y1: number, x2: number, y2: number): number {
  return Math.sqrt((x2 - x1) ** 2 + (y2 - y1) ** 2);
}

function collectTextClickCandidates(snapshot: any, query: string, roles: unknown, x: number, y: number): TextClickCandidate[] {
  const normalizedQuery = normalizeSearchText(query).toLowerCase();
  const roleFilter = Array.isArray(roles) ? new Set(roles.map(role => String(role).toLowerCase())) : null;
  const candidates: TextClickCandidate[] = [];
  const seen = new Set<string>();

  const visit = (node: any) => {
    if (!node || typeof node !== 'object') return;
    const role = String(node.role || '');
    const text = nodeSearchText(node);
    const box = node.box;
    if (
      role &&
      text &&
      box &&
      typeof box.x === 'number' &&
      typeof box.y === 'number' &&
      typeof box.width === 'number' &&
      typeof box.height === 'number' &&
      text.toLowerCase().includes(normalizedQuery) &&
      (!roleFilter || roleFilter.has(role.toLowerCase()))
    ) {
      const center = boxCenter(box);
      const ref = typeof node.ref === 'string' ? node.ref : undefined;
      const key = `${ref || ''}:${role}:${text}:${box.x},${box.y},${box.width},${box.height}`;
      if (!seen.has(key)) {
        seen.add(key);
        candidates.push({
          role,
          text,
          ref,
          box,
          boxCenterX: center.x,
          boxCenterY: center.y,
          distance: distanceBetween(x, y, center.x, center.y)
        });
      }
    }
    if (Array.isArray(node.children)) node.children.forEach(visit);
  };

  if (Array.isArray(snapshot?.tree)) snapshot.tree.forEach(visit);
  if (!candidates.length && Array.isArray(snapshot?.refs)) {
    for (const refRecord of snapshot.refs) visit(refRecord);
  }

  return candidates.sort((a, b) => {
    if (Math.abs(a.distance - b.distance) < 1) {
      if (a.ref && !b.ref) return -1;
      if (!a.ref && b.ref) return 1;
    }
    return a.distance - b.distance;
  });
}

function withTextClickMetadata(result: any, candidate: TextClickCandidate, method: 'ref' | 'cdp'): any {
  return {
    ...result,
    textClick: {
      method,
      text: candidate.text,
      role: candidate.role,
      ref: candidate.ref,
      boxCenterX: candidate.boxCenterX,
      boxCenterY: candidate.boxCenterY,
      distance: Math.round(candidate.distance),
      candidateCount: candidate.candidateCount
    }
  };
}

async function focusTargetForCdpKeyboard(tabId: number, selector: unknown): Promise<any> {
  const targetSelector = typeof selector === 'string' && selector ? selector : null;
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: focusPressTarget,
    args: [targetSelector],
    world: 'MAIN'
  });
  return results[0]?.result || {
    focused: false,
    selector: targetSelector,
    strategyUsed: 'cdp_keyboard',
    error: 'Focus script returned no result',
    recoverable: true
  };
}

export async function handleNavigate(args: CommandArgs = {}, session: SessionName): Promise<any> {
  const { url, newTab = true } = args || {};
  if (!url) throw new Error('url is required for navigate');

  let tab: any;
  if (newTab) {
    // Create an about:blank tab first so network capture can attach before the
    // target page starts loading. Otherwise early document/API requests are
    // missed.
    tab = await chrome.tabs.create({ url: 'about:blank', active: true });
    await setActiveTab(session, tab.id);
    await ensureNetworkCapture(session, { tabId: tab.id, auto: true, scope: 'session' });
    tab = await updateTabAndWaitForLoad(tab.id, { url, active: true }, {
      expectedUrl: url,
      timeoutMs: args?.timeoutMs
    });
  } else {
    const tabId = getActiveTabId(session);
    if (tabId) {
      await setActiveTab(session, tabId);
      await ensureNetworkCapture(session, { tabId, auto: true, scope: 'session' });
      tab = await updateTabAndWaitForLoad(tabId, { url, active: true }, {
        expectedUrl: url,
        timeoutMs: args?.timeoutMs
      });
    } else {
      tab = await chrome.tabs.create({ url: 'about:blank', active: true });
      await setActiveTab(session, tab.id);
      await ensureNetworkCapture(session, { tabId: tab.id, auto: true, scope: 'session' });
      tab = await updateTabAndWaitForLoad(tab.id, { url, active: true }, {
        expectedUrl: url,
        timeoutMs: args?.timeoutMs
      });
    }
  }

  await setActiveTab(session, tab.id);

  const latestTab = tab.tab || tab;
  const warnings: string[] = [];
  if (!tab.complete) {
    warnings.push(`Navigation did not reach tab status "complete" within ${tab.timeoutMs}ms; returning latest available tab metadata.`);
  }

  return {
    tabId: latestTab.id,
    url: latestTab.url || url,
    title: latestTab.title || '',
    navigationComplete: tab.complete,
    warnings,
    session,
    network: {
      autoStarted: true,
      capture: 'enabled',
      query: ['network_list', 'network_detail', 'network_stop']
    }
  };
}

export async function handleSnapshot(args: CommandArgs = {}, session: SessionName): Promise<any> {
  const tabId = args?.tabId || getActiveTabId(session);
  if (!tabId) throw new Error('No active tab in session');

  // Execute content script to get accessibility tree
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: getAccessibilitySnapshot,
    args: [args || {}],
    world: 'MAIN'
  });

  return results[0]?.result || { elements: [], url: '' };
}

export async function handleClick(args: CommandArgs = {}, session: SessionName): Promise<any> {
  const { tabId: argTabId } = args || {};
  const selector = targetSelector(args);
  const hasTextTarget = typeof args?.text === 'string' && args.text.trim();
  if (!selector && !hasTextTarget) throw new Error('target or text is required for click');

  const tabId = argTabId || getActiveTabId(session);
  if (!tabId) throw new Error('No active tab in session');

  if (hasTextTarget) {
    if (typeof args.x !== 'number' || typeof args.y !== 'number') {
      throw new Error('x and y coordinates are required for click text mode');
    }

    const snapshotResults = await chrome.scripting.executeScript({
      target: { tabId },
      func: getAccessibilitySnapshot,
      args: [{ viewportOnly: false, boxes: true, tabId }],
      world: 'MAIN'
    });
    const snapshot = snapshotResults[0]?.result || {};
    const candidates = collectTextClickCandidates(snapshot, args.text, args.roles, args.x, args.y);
    const best = candidates[0];
    if (!best) {
      return {
        clicked: false,
        error: `No visible text match found for click text "${args.text}"`,
        recoverable: true,
        textClick: {
          text: args.text,
          candidateCount: 0
        }
      };
    }
    best.candidateCount = candidates.length;

    if (best.ref) {
      const result = await performObservedClick({
        ...args,
        target: best.ref,
        selector: best.ref,
        text: undefined,
        x: undefined,
        y: undefined,
        roles: undefined
      }, session, tabId);
      return withTextClickMetadata(result, best, 'ref');
    }

    const beforeIds = await beginNewTabWatch();
    const cdpResult = await performCdpClickAt(tabId, best.boxCenterX, best.boxCenterY, {});
    const observed = await attachNewTabsIfAny(session, tabId, beforeIds, args || {});
    return withTextClickMetadata(mergeNewTabObservation(cdpResult, observed), best, 'cdp');
  }

  if (args?.interceptRequests && typeof args.interceptRequests === 'object') {
    const { result, probe } = await runClickProbeCapture(tabId, args.interceptRequests, () => performObservedClick(args, session, tabId));
    const warnings = [
      ...((result as any)?.warnings || []),
      ...(probe.warnings || [])
    ];
    if ((result as any)?.newTab || ((result as any)?.newTabs && (result as any).newTabs.length)) {
      warnings.push('click request interception does not guarantee blocking first requests from newly opened tabs.');
    }
    return {
      ...(result as any),
      warnings,
      probe: {
        ...probe,
        warnings: probe.warnings || []
      }
    };
  }

  return performObservedClick(args, session, tabId);
}

async function performObservedClick(args: CommandArgs = {}, session: SessionName, tabId: number): Promise<any> {
  const selector = targetSelector(args);
  const beforeIds = await beginNewTabWatch();

  let clickResult: any;

  const cdpResult = await performCdpMouseClick(tabId, selector!, args || {});
  if (!cdpResult.error || cdpResult.code === 'STALE_ELEMENT_REFERENCE') {
    clickResult = cdpResult;
  } else {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: performClick,
      args: [selector!, {
        strategy: 'dom_pointer',
        force: args?.force,
        warnings: args?.warnings
      }],
      world: 'MAIN'
    });
    clickResult = results[0]?.result as any;
  }

  if (clickResult?.error && !clickResult?.recoverable) throw new Error(clickResult.error);

  const observed = await attachNewTabsIfAny(session, tabId, beforeIds, args || {});
  return mergeNewTabObservation(clickResult, observed);
}

export async function handleFill(args: CommandArgs = {}, session: SessionName): Promise<any> {
  const { value } = args || {};
  const selector = targetSelector(args);
  if (!selector) throw new Error('target is required for fill');
  if (value === undefined) throw new Error('value is required for fill');

  const tabId = args?.tabId || getActiveTabId(session);
  if (!tabId) throw new Error('No active tab in session');

  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: performFill,
    args: [selector, value, args || {}],
    world: 'MAIN'
  });

  const result = results[0]?.result as any;
  if (result == null) throw new Error('Fill script returned no result');
  if (result?.error && result?.recoverable) return result;
  if (result?.error) throw new Error(result.error);
  return result;
}

export async function handlePress(args: CommandArgs = {}, session: SessionName): Promise<any> {
  const { key } = args || {};
  const selector = targetSelector(args);
  if (!key) throw new Error('key is required for press');

  const tabId = args?.tabId || getActiveTabId(session);
  if (!tabId) throw new Error('No active tab in session');
  const strategy = args?.strategy || 'auto';
  const beforeIds = await beginNewTabWatch();

  if (strategy === 'auto' || strategy === 'cdp_keyboard') {
    const focusResult = await focusTargetForCdpKeyboard(tabId, selector);
    if (focusResult?.error) return observeNewTabResult(focusResult);

    const cdpResult = await performCdpKeyboardPress(tabId, key, args || {});
    const cdpResultWithFocus = mergePressFocusDiagnostics(cdpResult, focusResult);
    if (!cdpResult.error || strategy === 'cdp_keyboard') return observeNewTabResult(cdpResultWithFocus);
    args = {
      ...args,
      strategy: 'dom_keyboard',
      warnings: [
        ...(args?.warnings || []),
        ...(focusResult?.warnings || []),
        `cdp_keyboard unavailable in auto mode; fell back to dom_keyboard: ${cdpResult.error}`
      ]
    };
  }

  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: performPress,
    args: [key, selector || null, args || {}],
    world: 'MAIN'
  });

  const result = results[0]?.result as any;
  if (result?.error && result?.recoverable) return result;
  if (result?.error) throw new Error(result.error);
  return observeNewTabResult(result);

  async function observeNewTabResult(result: any): Promise<any> {
    const observed = await attachNewTabsIfAny(session, tabId, beforeIds, args || {});
    return mergeNewTabObservation(result, observed);
  }
}


export async function handleScroll(args: CommandArgs = {}, session: SessionName): Promise<any> {
  const tabId = args?.tabId || getActiveTabId(session);
  if (!tabId) throw new Error('No active tab in session');
  args = { ...args, selector: targetSelector(args) };
  const strategy = args?.strategy || 'auto';

  if (strategy === 'wheel' || (strategy === 'auto' && (args?.x !== undefined || args?.y !== undefined || args?.region))) {
    const cdpResult = await performCdpWheelScroll(tabId, args || {});
    if (!cdpResult.error || strategy === 'wheel') return cdpResult;
    const { x, y, region, ...domArgs } = args || {};
    args = {
      ...domArgs,
      strategy: 'dom',
      warnings: [
        ...(args?.warnings || []),
        `wheel unavailable in auto mode; fell back to dom: ${cdpResult.error}`
      ]
    };
  }

  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: performDomScroll,
    args: [args || {}],
    world: 'MAIN'
  });

  const result = results[0]?.result as any;
  if (!result) throw new Error('Scroll script returned no result');
  if (result?.error && result?.recoverable) return result;
  if (result?.error) throw new Error(result.error);
  return result;
}

export async function handleWaitFor(args: CommandArgs = {}, session: SessionName): Promise<any> {
  const tabId = args?.tabId || getActiveTabId(session);
  if (!tabId) throw new Error('No active tab in session');
  const { selector, text, state = 'visible', timeoutMs = 5000, expression } = args || {};

  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: performWaitFor,
    args: [{ selector, text, state, timeoutMs, expression }],
    world: 'MAIN'
  });

  const result = results[0]?.result as any;
  if (!result) throw new Error('Wait script returned no result');
  if (result?.error && result?.recoverable) return result;
  if (result?.error) throw new Error(result.error);
  return result;
}

export async function handleFindTab(args: CommandArgs = {}, session: SessionName): Promise<any> {
  const query = args || {};
  const tabs = await chrome.tabs.query({});
  const urlNeedle = query.urlIncludes;
  const titleNeedle = query.titleIncludes;
  const candidates = tabs.filter(tab => {
    if (query.tabId !== undefined && tab.id !== query.tabId) return false;
    if (urlNeedle && !(tab.url || '').includes(urlNeedle)) return false;
    if (titleNeedle && !(tab.title || '').includes(titleNeedle)) return false;
    if (query.active !== undefined && tab.active !== query.active) return false;
    return true;
  }).map(tab => ({ id: tab.id, title: tab.title, url: tab.url, active: tab.active, windowId: tab.windowId }));

  if (query.attach !== false && candidates[0]) {
    const tabId = candidates[0].id as number;
    await setActiveTab(session, tabId);
    await ensureNetworkCapture(session, { tabId, auto: true, extend: true, scope: 'session' });
  }

  return { session, tabs: candidates, tab: candidates[0] || null };
}

export async function handleAttachTab(args: CommandArgs = {}, session: SessionName): Promise<any> {
  const result = await handleFindTab({ ...args, attach: true }, session);
  if (!result.tab) throw new Error('No matching tab found to attach');
  return { session, attached: result.tab.id, tab: result.tab, tabs: result.tabs };
}

export async function handleEvaluate(args: CommandArgs = {}, session: SessionName): Promise<any> {
  const { code } = args || {};
  if (!code) throw new Error('code is required for evaluate');

  const tabId = args?.tabId || getActiveTabId(session);
  if (!tabId) throw new Error('No active tab in session');

  const cdpResult = await performCdpEvaluate(tabId, code);
  if (!cdpResult?.recoverable) return cdpResult;

  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: performEvaluate,
    args: [code],
    world: 'ISOLATED'
  });

  return results[0]?.result;
}

export async function handleGetText(args: CommandArgs = {}, session: SessionName): Promise<any> {
  const tabId = args?.tabId || getActiveTabId(session);
  if (!tabId) throw new Error('No active tab in session');
  const scope = args?.scope === 'document' ? 'document' : args?.scope === 'full' ? 'full' : 'viewport';
  const maxChars = Number.isFinite(args?.maxChars) ? Math.max(0, Math.min(Number(args.maxChars), 200000)) : 12000;
  const selector = args?.selector || null;

  if (scope === 'viewport') {
    const observed = await handleObserveCapture({
      tabId,
      maxTextChars: maxChars,
      maxTextRuns: args?.includeRuns === true ? 1000 : 300,
      selector
    }, session);
    const textRuns = args?.includeRuns ? observed.textRuns || [] : undefined;
    return {
      text: observed.visibleText || '',
      truncated: Boolean(observed.truncated),
      caps: observed.caps || { maxTextChars: maxChars },
      url: observed.url || null,
      title: observed.title || '',
      textRuns,
      runs: textRuns,
      error: observed.error || undefined,
      selector
    };
  }

  if (scope === 'document') {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: getDocumentTextSnapshot,
      args: [{ maxChars, includeRuns: args?.includeRuns === true, selector }],
      world: 'MAIN'
    });
    return results[0]?.result || { text: '', truncated: false, caps: { maxChars, scope: 'document' }, url: null, title: '' };
  }

  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: getTextSnapshot,
    args: [{ scope, maxChars, includeRuns: args?.includeRuns === true, maxTextRuns: args?.includeRuns === true ? 1000 : 300, selector }],
    world: 'MAIN'
  });
  return results[0]?.result || { text: '', truncated: false, caps: { maxChars, scope }, url: null, title: '' };
}

export async function handleScreenshot(args: CommandArgs = {}, session: SessionName): Promise<any> {
  const { format = 'png', quality, file_name, fileName } = args || {};
  const tabId = args?.tabId || getActiveTabId(session);
  const tabMeta = await getTabMetadata(tabId);
  const captureOptions: any = { format };
  if (quality !== undefined) captureOptions.quality = quality;

  let restoredActiveTabId: number | null = null;
  let activatedTabForCapture = false;
  let previousActiveTabId: number | null = null;

  // chrome.tabs.captureVisibleTab captures the active tab in a window, not an
  // arbitrary tab. If a session/tab target is known, briefly activate it before
  // capture so the returned pixels match the returned tab metadata.
  if (tabId && !tabMeta.windowId) {
    throw new Error(`Tab ${tabId} is not available for screenshot`);
  }
  if (tabId && tabMeta.windowId) {
    const activeTabs = await chrome.tabs.query({ windowId: tabMeta.windowId, active: true });
    previousActiveTabId = activeTabs[0]?.id || null;
    if (previousActiveTabId !== tabId) {
      await chrome.tabs.update(tabId, { active: true });
      activatedTabForCapture = true;
    }
  }

  const dataUrl = tabMeta.windowId
    ? await chrome.tabs.captureVisibleTab(tabMeta.windowId, captureOptions)
    : await chrome.tabs.captureVisibleTab(captureOptions);

  if (activatedTabForCapture && previousActiveTabId && previousActiveTabId !== tabId) {
    try {
      await chrome.tabs.update(previousActiveTabId, { active: true });
      restoredActiveTabId = previousActiveTabId;
    } catch {
      // Best-effort only: the previous active tab may have closed during capture.
    }
  }

  const base64 = dataUrl.replace(/^data:image\/\w+;base64,/, '');
  const mimeType = format === 'jpeg' ? 'image/jpeg' : 'image/png';
  const artifact = createArtifactHint('screenshot', {
    ext: format === 'jpeg' ? 'jpg' : 'png',
    fileName: file_name || fileName || `screenshot-${Date.now()}`,
    mimeType,
    sizeBytes: Math.floor(base64.length * 0.75),
    encoding: 'base64',
    session,
    ...tabMeta
  });

  return {
    format,
    mimeType,
    dataLength: base64.length,
    data: base64,
    artifact,
    artifacts: [artifact],
    tabId: tabMeta.tabId || tabId || null,
    url: tabMeta.url || null,
    title: tabMeta.title || null,
    activatedTabForCapture,
    restoredActiveTabId
  };
}

export async function handleObserveCapture(args: CommandArgs = {}, session: SessionName): Promise<any> {
  const tabId = args?.tabId || getActiveTabId(session);
  if (!tabId) throw new Error('No active tab in session');
  const options = {
    mode: args?.mode || 'viewport_text',
    maxTextChars: Number.isFinite(args?.maxTextChars) ? args.maxTextChars : 12000,
    maxTextRuns: Number.isFinite(args?.maxTextRuns) ? args.maxTextRuns : 300,
    selector: args?.selector || null
  };
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: captureViewportTextObservation,
    args: [options],
    world: 'MAIN'
  });
  const result = results[0]?.result || { visibleText: '', textRuns: [] };
  return {
    session,
    tabId,
    ...result
  };
}
