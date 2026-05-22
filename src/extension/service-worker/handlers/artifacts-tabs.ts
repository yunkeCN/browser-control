import { ARTIFACT_SCHEMA_VERSION, EXTENSION_BACKEND_NAME, createArtifactHint, getTabMetadata, nowIso } from '../runtime-metadata';
import { activeSessions, getActiveTabId, getSessionTabs, sessionTabs, setActiveTab } from '../sessions';
import { networkCaptures, removeNetworkTab } from './network-cdp';
import { performUpload } from '../page-runtime/upload-find';
import type { CommandArgs, SessionName } from '../../shared/types';

export async function handleUpload(args: CommandArgs = {}, session: SessionName): Promise<any> {
  const { selector, files } = args || {};
  if (!selector) throw new Error('selector is required for upload');
  if (!files || !files.length) throw new Error('files array is required for upload');

  const tabId = args?.tabId || getActiveTabId(session);
  if (!tabId) throw new Error('No active tab in session');

  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: performUpload,
    args: [selector, files],
    world: 'MAIN'
  });

  // For file uploads, we also need to handle via debugger
  // The content script sets up the input but actual file chooser is native
  const result = results[0]?.result;
  return result || { status: 'attempted', selector, fileCount: files.length };
}

export async function handleDownload(args: CommandArgs = {}, session: SessionName): Promise<any> {
  const { url, filename, saveAs = false } = args || {};
  if (!url) throw new Error('url is required for download');
  const downloadId = await chrome.downloads.download({ url, filename, saveAs });
  const item = await new Promise<any>((resolve) => {
    const timeout = setTimeout(() => {
      chrome.downloads.onChanged.removeListener(listener);
      chrome.downloads.search({ id: downloadId }, items => resolve(items[0] || { id: downloadId, state: 'unknown' }));
    }, 30000);
    const listener = (delta: chrome.downloads.DownloadDelta) => {
      const currentState = delta.state?.current;
      if (delta.id === downloadId && currentState) {
        chrome.downloads.search({ id: downloadId }, items => {
          if (currentState === 'complete' || currentState === 'interrupted') {
            clearTimeout(timeout);
            chrome.downloads.onChanged.removeListener(listener);
            resolve(items[0] || { id: downloadId, state: currentState });
          }
        });
      }
    };
    chrome.downloads.onChanged.addListener(listener);
  });
  const fileName = item.filename ? item.filename.split(/[\\/]/).pop() : filename || null;
  const artifact = item.filename ? {
    schemaVersion: ARTIFACT_SCHEMA_VERSION,
    backend: EXTENSION_BACKEND_NAME,
    kind: 'download',
    path: item.filename,
    fileName,
    mimeType: item.mime || 'application/octet-stream',
    sizeBytes: item.fileSize || item.totalBytes || null,
    source: { session, tabId: getActiveTabId(session), url: item.url || url, title: null },
    createdAt: nowIso()
  } : null;
  return {
    id: downloadId,
    state: item.state,
    path: item.filename || null,
    fileName,
    url: item.url || url,
    mimeType: item.mime || null,
    sizeBytes: item.fileSize || item.totalBytes || null,
    artifact,
    artifacts: artifact ? [artifact] : [],
    session
  };
}

export async function handleSaveAsPdf(args: CommandArgs = {}, session: SessionName): Promise<any> {
  const tabId = args?.tabId || getActiveTabId(session);
  if (!tabId) throw new Error('No active tab in session');

  const { paper_format = 'A4', landscape = false, scale = 1, print_background = false, file_name } = args || {};

  // Use chrome.debugger Page.printToPDF if available
  let pdfData!: string;
  try {
    await chrome.debugger.attach({ tabId }, '1.3');
    const result = await chrome.debugger.sendCommand({ tabId }, 'Page.printToPDF', {
      paperWidth: paper_format === 'A4' ? 8.27 : 8.5,
      paperHeight: paper_format === 'A4' ? 11.69 : 11,
      landscape,
      scale,
      printBackground: print_background,
      preferCSSPageSize: false
    });
    pdfData = (result as any).data;
    await chrome.debugger.detach({ tabId });
  } catch (err) {
    throw new Error(`PDF generation failed: ${(err as any).message}`);
  }

  const tabMeta = await getTabMetadata(tabId);
  const artifact = createArtifactHint('pdf', {
    ext: 'pdf',
    fileName: file_name || `page-${Date.now()}.pdf`,
    mimeType: 'application/pdf',
    sizeBytes: Math.floor(pdfData.length * 0.75),
    encoding: 'base64',
    session,
    ...tabMeta
  });

  return {
    format: 'pdf',
    mimeType: 'application/pdf',
    dataLength: pdfData.length,
    data: pdfData,
    fileName: artifact.fileName,
    artifact,
    artifacts: [artifact],
    tabId,
    url: tabMeta.url || null,
    title: tabMeta.title || null
  };
}

export async function handleListTabs(session: SessionName): Promise<any> {
  const tabs = getSessionTabs(session);
  const tabInfos = [];

  for (const tabId of tabs) {
    try {
      const tab = await chrome.tabs.get(tabId);
      tabInfos.push({
        id: tab.id,
        title: tab.title,
        url: tab.url,
        active: tab.active,
        windowId: tab.windowId
      });
    } catch {
      // Tab may have been closed
      tabs.delete(tabId);
    }
  }

  return { session, tabs: tabInfos };
}

export async function handleCloseTab(args: CommandArgs = {}, session: SessionName): Promise<any> {
  const tabId = args?.tabId || getActiveTabId(session);
  if (!tabId) throw new Error('No tab to close');

  await chrome.tabs.remove(tabId);
  const tabs = getSessionTabs(session);
  tabs.delete(tabId);
  removeNetworkTab(tabId);

  return { closed: tabId, session };
}

export async function handleCloseSession(session: SessionName): Promise<any> {
  const tabs = getSessionTabs(session);

  // Close all session tabs
  for (const tabId of tabs) {
    try {
      await chrome.tabs.remove(tabId);
    } catch {
      // Tab may already be closed
    }
  }

  sessionTabs.delete(session);
  activeSessions.delete(session);
  networkCaptures.delete(session);

  return { closed: session, tabCount: tabs.size };
}
