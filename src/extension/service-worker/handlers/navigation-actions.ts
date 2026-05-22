import { createArtifactHint, getTabMetadata } from '../runtime-metadata';
import { getActiveTabId, setActiveTab } from '../sessions';
import { ensureNetworkCapture, performCdpKeyboardPress, performCdpMouseClick } from './network-cdp';
import { getAccessibilitySnapshot } from '../page-runtime/snapshot';
import { captureViewportTextObservation } from '../page-runtime/observation';
import { performClick } from '../page-runtime/click';
import { performFill } from '../page-runtime/fill';
import { performPress } from '../page-runtime/press';
import { performSelectOption, performSetChecked } from '../page-runtime/select-check';
import { performWaitFor } from '../page-runtime/wait-for';
import { performEvaluate } from '../page-runtime/evaluate';
import { updateTabAndWaitForLoad } from '../navigation-helpers';
import type { CommandArgs, SessionName } from '../../shared/types';

// ─── Action handlers ─────────────────────────────────────────────────

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
  const { selector, tabId: argTabId } = args || {};
  if (!selector) throw new Error('selector is required for click');

  const tabId = argTabId || getActiveTabId(session);
  if (!tabId) throw new Error('No active tab in session');
  const strategy = args?.strategy || 'auto';
  const shouldObserveNewTab = args?.observeNewTab === true || args?.expectNewTab === true;
  const beforeTabs = shouldObserveNewTab ? await chrome.tabs.query({}) : [];
  const beforeIds = new Set(beforeTabs.map(tab => tab.id).filter((id): id is number => typeof id === 'number'));

  if (strategy === 'auto' || strategy === 'cdp_mouse') {
    const cdpResult = await performCdpMouseClick(tabId, selector, args || {});
    if (!cdpResult.error) return observeNewTabResult(cdpResult);
    if (strategy === 'cdp_mouse') return cdpResult;
    args = {
      ...args,
      strategy: 'dom_pointer',
      warnings: [
        ...(args?.warnings || []),
        `cdp_mouse unavailable in auto mode; fell back to dom_pointer: ${cdpResult.error}`
      ]
    };
  }

  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: performClick,
    args: [selector, {
      strategy: args?.strategy,
      force: args?.force,
      button: args?.button,
      clickCount: args?.clickCount,
      modifiers: args?.modifiers,
      warnings: args?.warnings
    }],
    world: 'MAIN'
  });

  const result = results[0]?.result as any;
  if (result?.error && result?.recoverable) return result;
  if (result?.error) throw new Error(result.error);
  return observeNewTabResult(result);

  async function observeNewTabResult(result: any): Promise<any> {
    if (!shouldObserveNewTab) return result;
    await new Promise(resolve => setTimeout(resolve, 250));
    const afterTabs = await chrome.tabs.query({});
    const candidates = afterTabs
      .filter(tab => typeof tab.id === 'number' && !beforeIds.has(tab.id))
      .map(tab => ({ id: tab.id, title: tab.title, url: tab.url, active: tab.active, openerTabId: tab.openerTabId, windowId: tab.windowId }));
    const openerMatch = candidates.find(tab => tab.openerTabId === tabId) || candidates[0] || null;
    const warnings = [...(result?.warnings || [])];
    if (args?.expectNewTab === true && !openerMatch) warnings.push('expectNewTab was requested but no new tab was observed after the click.');
    if (openerMatch?.id) {
      await setActiveTab(session, openerMatch.id as number);
      await ensureNetworkCapture(session, { tabId: openerMatch.id, auto: true, scope: 'session' });
    }
    return { ...result, newTab: openerMatch, observedNewTabs: candidates, warnings };
  }
}

export async function handleFill(args: CommandArgs = {}, session: SessionName): Promise<any> {
  const { selector, value } = args || {};
  if (!selector) throw new Error('selector is required for fill');
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
  if (result?.error) throw new Error(result.error);
  return result;
}

export async function handlePress(args: CommandArgs = {}, session: SessionName): Promise<any> {
  const { key, selector } = args || {};
  if (!key) throw new Error('key is required for press');

  const tabId = args?.tabId || getActiveTabId(session);
  if (!tabId) throw new Error('No active tab in session');
  const strategy = args?.strategy || 'auto';

  if (strategy === 'auto' || strategy === 'cdp_keyboard') {
    const cdpResult = await performCdpKeyboardPress(tabId, key, args || {});
    if (!cdpResult.error || strategy === 'cdp_keyboard') return cdpResult;
    args = {
      ...args,
      strategy: 'dom_keyboard',
      warnings: [
        ...(args?.warnings || []),
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
  if (result?.error) throw new Error(result.error);
  return result;
}

export async function handleSelectOption(args: CommandArgs = {}, session: SessionName): Promise<any> {
  const { selector, value } = args || {};
  if (!selector) throw new Error('selector is required for select_option');
  if (value === undefined) throw new Error('value is required for select_option');

  const tabId = args?.tabId || getActiveTabId(session);
  if (!tabId) throw new Error('No active tab in session');

  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: performSelectOption,
    args: [selector, value],
    world: 'MAIN'
  });

  const result = results[0]?.result as any;
  if (result?.error) throw new Error(result.error);
  return result;
}

export async function handleSetChecked(args: CommandArgs = {}, session: SessionName): Promise<any> {
  const { selector, checked } = args || {};
  if (!selector) throw new Error('selector is required for set_checked');
  if (typeof checked !== 'boolean') throw new Error('checked is required for set_checked');

  const tabId = args?.tabId || getActiveTabId(session);
  if (!tabId) throw new Error('No active tab in session');

  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: performSetChecked,
    args: [selector, checked],
    world: 'MAIN'
  });

  const result = results[0]?.result as any;
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
    await setActiveTab(session, candidates[0].id as number);
  }

  return { session, tabs: candidates, tab: candidates[0] || null };
}

export async function handleAttachTab(args: CommandArgs = {}, session: SessionName): Promise<any> {
  const result = await handleFindTab({ ...args, attach: true }, session);
  if (!result.tab) throw new Error('No matching tab found to attach');
  await ensureNetworkCapture(session, { tabId: result.tab.id, auto: true, extend: true, scope: 'session' });
  return { session, attached: result.tab.id, tab: result.tab, tabs: result.tabs };
}

export async function handleEvaluate(args: CommandArgs = {}, session: SessionName): Promise<any> {
  const { code } = args || {};
  if (!code) throw new Error('code is required for evaluate');

  const tabId = args?.tabId || getActiveTabId(session);
  if (!tabId) throw new Error('No active tab in session');

  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: performEvaluate,
    args: [code],
    world: 'MAIN'
  });

  return results[0]?.result;
}

export async function handleGetText(args: CommandArgs = {}, session: SessionName): Promise<any> {
  const tabId = args?.tabId || getActiveTabId(session);
  if (!tabId) throw new Error('No active tab in session');
  const scope = args?.scope === 'document' ? 'document' : 'viewport';
  const maxChars = Number.isFinite(args?.maxChars) ? Math.max(0, Math.min(Number(args.maxChars), 200000)) : 12000;

  if (scope === 'viewport') {
    const observed = await handleObserveCapture({
      tabId,
      maxTextChars: maxChars,
      maxTextRuns: args?.includeRuns === true ? 1000 : 300
    }, session);
    return {
      text: observed.visibleText || '',
      truncated: Boolean(observed.truncated),
      caps: observed.caps || { maxTextChars: maxChars },
      url: observed.url || null,
      title: observed.title || '',
      runs: args?.includeRuns ? observed.textRuns || [] : undefined
    };
  }

  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: (limit: number) => {
      const raw = (document.body?.innerText || document.documentElement?.innerText || '').replace(/\s+\n/g, '\n').trim();
      return {
        text: raw.slice(0, limit),
        truncated: raw.length > limit,
        caps: { maxChars: limit, textChars: Math.min(raw.length, limit), totalTextChars: raw.length },
        url: window.location.href,
        title: document.title
      };
    },
    args: [maxChars],
    world: 'MAIN'
  });
  return results[0]?.result || { text: '', truncated: false, caps: { maxChars }, url: null, title: '' };
}

export async function handleScreenshot(args: CommandArgs = {}, session: SessionName): Promise<any> {
  const { format = 'png', quality, fullPage = false, file_name, fileName } = args || {};
  const tabId = args?.tabId || getActiveTabId(session);
  const tabMeta = await getTabMetadata(tabId);
  const captureOptions: any = { format };
  if (quality !== undefined) captureOptions.quality = quality;

  // chrome.tabs.captureVisibleTab captures a window, not a tab. Resolve the tab's
  // window explicitly so protocol-level tab selection remains compatible with the daemon.
  const dataUrl = tabMeta.windowId
    ? await chrome.tabs.captureVisibleTab(tabMeta.windowId, captureOptions)
    : await chrome.tabs.captureVisibleTab(captureOptions);
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
    fullPageSupported: false,
    fullPageRequested: Boolean(fullPage),
    note: fullPage ? 'Chrome extension backend currently captures the visible viewport; daemon persists returned base64 as an artifact.' : undefined
  };
}

export async function handleObserveCapture(args: CommandArgs = {}, session: SessionName): Promise<any> {
  const tabId = args?.tabId || getActiveTabId(session);
  if (!tabId) throw new Error('No active tab in session');
  const options = {
    mode: args?.mode || 'viewport_text',
    maxTextChars: Number.isFinite(args?.maxTextChars) ? args.maxTextChars : 12000,
    maxTextRuns: Number.isFinite(args?.maxTextRuns) ? args.maxTextRuns : 300
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
