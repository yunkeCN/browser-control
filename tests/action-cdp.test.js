'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const serviceWorker = fs.readFileSync(path.join(root, 'skills', 'browser-control', 'extension', 'service-worker.js'), 'utf8');
const networkCdpSource = fs.readFileSync(path.join(root, 'src', 'extension', 'service-worker', 'handlers', 'network-cdp.ts'), 'utf8');
const navigationSource = fs.readFileSync(path.join(root, 'src', 'extension', 'service-worker', 'handlers', 'navigation-actions.ts'), 'utf8');
const artifactTabsSource = fs.readFileSync(path.join(root, 'src', 'extension', 'service-worker', 'handlers', 'artifacts-tabs.ts'), 'utf8');
const navigationHelpersSource = fs.readFileSync(path.join(root, 'src', 'extension', 'service-worker', 'navigation-helpers.ts'), 'utf8');
const runtimeMetadataSource = fs.readFileSync(path.join(root, 'src', 'extension', 'service-worker', 'runtime-metadata.ts'), 'utf8');
const transportSource = fs.readFileSync(path.join(root, 'src', 'extension', 'service-worker', 'transport.ts'), 'utf8');

test('cdp_mouse and cdp_keyboard strategies use Chrome debugger input dispatch', () => {
  assert.match(networkCdpSource, /async function performCdpMouseClick/);
  assert.match(networkCdpSource, /Input\.dispatchMouseEvent/);
  assert.match(networkCdpSource, /type:\s*['"]mousePressed['"]/);
  assert.match(networkCdpSource, /type:\s*['"]mouseReleased['"]/);
  assert.match(networkCdpSource, /async function performCdpKeyboardPress/);
  assert.match(networkCdpSource, /Input\.dispatchKeyEvent/);
  assert.match(networkCdpSource, /type:\s*['"]keyDown['"]/);
  assert.match(networkCdpSource, /type:\s*['"]keyUp['"]/);
});

test('CDP action debugger reuses network capture ownership and only detaches temporary action leases', () => {
  assert.match(networkCdpSource, /function findNetworkDebuggerCapture/);
  assert.match(networkCdpSource, /actionDebuggerOwners/);
  assert.match(networkCdpSource, /owner:\s*'network_capture'/);
  assert.match(networkCdpSource, /owner:\s*actionOwner\.owner/);
  assert.match(networkCdpSource, /temporary:\s*false/);
  assert.match(networkCdpSource, /will not detach it after the action/);
  assert.match(networkCdpSource, /if \(!lease\?\.temporary \|\| !lease\.debuggee\) return null/);
  assert.match(networkCdpSource, /temporary:\s*true/);
});

test('click_probe is represented as a CDP Fetch-blocking click action', () => {
  assert.match(networkCdpSource, /export async function runClickProbeCapture/);
  assert.match(networkCdpSource, /Fetch\.enable/);
  assert.match(networkCdpSource, /Fetch\.failRequest/);
  assert.match(networkCdpSource, /Fetch\.continueRequest/);
  assert.match(networkCdpSource, /Fetch\.disable/);
  assert.match(networkCdpSource, /BlockedByClient/);
  assert.match(networkCdpSource, /SENSITIVE_FIELD_PATTERN/);
  assert.match(navigationSource, /export async function handleClickProbe/);
  assert.match(navigationSource, /performObservedClick\(args,\s*session,\s*tabId\)/);
  assert.match(runtimeMetadataSource, /['"]clickProbe['"]/);
  assert.match(serviceWorker, /click_probe/);
});

test('auto action strategies fall back visibly while explicit CDP strategies return recoverable errors', () => {
  assert.match(navigationSource, /cdp_mouse unavailable in auto mode; fell back to dom_pointer/);
  assert.match(navigationSource, /strategy === ['"]cdp_mouse['"]\) return cdpResult/);
  assert.match(navigationSource, /cdp_keyboard unavailable in auto mode; fell back to dom_keyboard/);
  assert.match(navigationSource, /strategy === ['"]cdp_keyboard['"]\) return observeNewTabResult\(cdpResult\)/);
  assert.match(networkCdpSource, /recoverable:\s*true/);
});

test('press with @e selectors does not bypass stale validation through cdp_keyboard', () => {
  assert.match(navigationSource, /const selectorIsAgentRef = typeof selector === ['"]string['"] && selector\.startsWith\(['"]@e['"]\)/);
  assert.match(navigationSource, /selectorIsAgentRef && strategy === ['"]cdp_keyboard['"]/);
  assert.match(navigationSource, /UNSUPPORTED_SELECTOR_STRATEGY/);
  assert.match(navigationSource, /!\s*selectorIsAgentRef && \(strategy === ['"]auto['"] \|\| strategy === ['"]cdp_keyboard['"]\)/);
});

test('evaluate uses CDP Runtime.evaluate before isolated-world fallback', () => {
  assert.match(networkCdpSource, /export async function performCdpEvaluate/);
  assert.match(networkCdpSource, /Runtime\.evaluate/);
  assert.match(networkCdpSource, /returnByValue:\s*true/);
  assert.match(networkCdpSource, /awaitPromise:\s*true/);
  assert.match(networkCdpSource, /buildRuntimeEvaluationExpression/);
  assert.match(navigationSource, /const cdpResult = await performCdpEvaluate\(tabId,\s*code\)/);
  assert.match(navigationSource, /if \(!cdpResult\?\.recoverable\) return cdpResult/);
  assert.match(navigationSource, /world:\s*['"]ISOLATED['"]/);
});

test('find_tab accepts only current Includes filters for new-project protocol clarity', () => {
  assert.match(navigationSource, /const urlNeedle = query\.urlIncludes/);
  assert.match(navigationSource, /const titleNeedle = query\.titleIncludes/);
  assert.doesNotMatch(navigationSource, /urlContains|titleContains/);
  assert.match(navigationSource, /query\.active !== undefined/);
});

test('navigate preserves early network capture but returns final metadata diagnostics', () => {
  assert.match(navigationSource, /chrome\.tabs\.create\(\{\s*url:\s*['"]about:blank['"]/);
  assert.match(navigationSource, /ensureNetworkCapture\(session,\s*\{\s*tabId:\s*tab\.id,\s*auto:\s*true,\s*scope:\s*['\"]session['\"]\s*\}\)/);
  assert.match(navigationSource, /tab = await updateTabAndWaitForLoad\(tab\.id/);
  assert.match(navigationHelpersSource, /function isNavigationCompletionCandidate/);
  assert.match(navigationHelpersSource, /currentUrl === ['"]about:blank['"]/);
  assert.doesNotMatch(navigationHelpersSource, /current\.origin === expected\.origin/);
  assert.match(navigationSource, /const latestTab = tab\.tab \|\| tab/);
  assert.match(navigationSource, /navigationComplete:\s*tab\.complete/);
  assert.match(serviceWorker, /warnings/);
  assert.match(navigationHelpersSource, /finish\(\{\s*complete:\s*false,\s*timedOut:\s*true/);
  assert.match(navigationSource, /url:\s*latestTab\.url \|\| url/);
});

test('navigate load wait arms tab update listener before issuing navigation', () => {
  const helperStart = navigationHelpersSource.indexOf('async function updateTabAndWaitForLoad');
  assert.notEqual(helperStart, -1);
  const helper = navigationHelpersSource.slice(helperStart);
  assert.ok(helper.indexOf('chrome.tabs.onUpdated.addListener(listener)') < helper.indexOf('await chrome.tabs.update(tabId, updateProperties)'));
  assert.match(helper, /previousUrl/);
  assert.match(helper, /sawLoading/);
  assert.match(navigationHelpersSource, /if \(sawLoading\) return true/);
  assert.match(navigationHelpersSource, /if \(currentUrl !== previousUrl\) return true/);
});

test('screenshot activates the target tab before captureVisibleTab', () => {
  const screenshotStart = navigationSource.indexOf('export async function handleScreenshot');
  assert.notEqual(screenshotStart, -1);
  const screenshotSource = navigationSource.slice(screenshotStart, navigationSource.indexOf('\n}', screenshotStart) + 2);
  assert.match(screenshotSource, /chrome\.tabs\.query\(\{\s*windowId:\s*tabMeta\.windowId,\s*active:\s*true\s*\}\)/);
  assert.match(screenshotSource, /await chrome\.tabs\.update\(tabId,\s*\{\s*active:\s*true\s*\}\)/);
  assert.match(screenshotSource, /await chrome\.tabs\.captureVisibleTab\(tabMeta\.windowId,\s*captureOptions\)/);
  assert.match(screenshotSource, /await chrome\.tabs\.update\(previousActiveTabId,\s*\{\s*active:\s*true\s*\}\)/);
  assert.match(screenshotSource, /activatedTabForCapture/);
  assert.match(screenshotSource, /restoredActiveTabId/);
});

test('extension announces runtime metadata and browser-side capabilities', () => {
  assert.match(runtimeMetadataSource, /const EXTENSION_CAPABILITIES = \[/);
  assert.match(runtimeMetadataSource, /['"]navigateFinalMetadata['"]/);
  assert.match(runtimeMetadataSource, /['"]observe_start['"]/);
  assert.match(runtimeMetadataSource, /['"]observe_diff['"]/);
  assert.match(runtimeMetadataSource, /['"]cdpEvaluate['"]/);
  assert.match(runtimeMetadataSource, /async function getExtensionRuntimeMetadata/);
  assert.match(runtimeMetadataSource, /extensionRuntimeMetadata/);
  assert.match(runtimeMetadataSource, /channel:\s*['"]source['"]/);
  assert.match(transportSource, /type:\s*['"]hello['"]/);
  assert.match(transportSource, /sendExtensionHello\(\)/);
});

test('session network capture and detail merge are represented in service-worker source', () => {
  assert.match(networkCdpSource, /captureScope/);
  assert.match(networkCdpSource, /trackedTabIds/);
  assert.match(networkCdpSource, /function mergeNetworkRequest/);
  assert.match(networkCdpSource, /mergeConfidence/);
  assert.match(networkCdpSource, /same method \+ URL|r\.url !== known\.url/);
  assert.match(networkCdpSource, /NETWORK_API_RESOURCE_TYPES/);
  assert.doesNotMatch(networkCdpSource, /includeResources/);
  const listStart = networkCdpSource.indexOf('async function listNetworkRequests');
  const listEnd = networkCdpSource.indexOf('async function getNetworkRequestDetail', listStart);
  const listNetworkRequestsSource = networkCdpSource.slice(listStart, listEnd);
  assert.match(networkCdpSource, /function clampNetworkListLimit/);
  assert.match(networkCdpSource, /function matchesNetworkListFilters/);
  assert.match(listNetworkRequestsSource, /requests = requests\.filter\(r => matchesNetworkListFilters\(r, options\)\)/);
  assert.match(networkCdpSource, /Math\.max\(1,\s*Math\.min\(Math\.floor\(Number\(value\)\),\s*NETWORK_LIST_LIMIT\)\)/);
  assert.match(listNetworkRequestsSource, /if \(hasTabIdFilter\) requests = requests\.filter\(r => Number\(r\.tabId\) === requestedTabId\)/);
  assert.match(listNetworkRequestsSource, /omittedUntimestamped \+= 1/);
  assert.match(listNetworkRequestsSource, /timestampMissing:\s*timestampMs === null/);
  assert.match(listNetworkRequestsSource, /methodFilter:\s*options\.method/);
  assert.match(listNetworkRequestsSource, /statusCodeFilter:\s*Number\.isFinite\(options\.statusCode\)/);
  assert.match(listNetworkRequestsSource, /typeFilter:\s*options\.type/);
  assert.match(listNetworkRequestsSource, /totalStored:\s*capture\.requests\.length/);
  assert.match(listNetworkRequestsSource, /requestLimit,\s*\n\s*storageLimit:\s*NETWORK_CAPTURE_LIMIT/);
  assert.doesNotMatch(listNetworkRequestsSource, /stored:\s*capture\.requests\.length/);
  assert.doesNotMatch(listNetworkRequestsSource, /limit:\s*NETWORK_CAPTURE_LIMIT/);
  assert.match(navigationSource, /case|handleAttachTab|export async function handleAttachTab/);
});

test('close_session clears persisted session network capture before dropping memory state', () => {
  assert.match(artifactTabsSource, /import\s+\{[^}]*clearPersistedNetworkCapture[^}]*networkCaptures[^}]*removeNetworkTab[^}]*\}\s+from\s+['"]\.\/network-cdp['"]/s);
  const closeSessionStart = artifactTabsSource.indexOf('export async function handleCloseSession');
  assert.notEqual(closeSessionStart, -1);
  const closeSession = artifactTabsSource.slice(closeSessionStart, artifactTabsSource.indexOf('\n}', closeSessionStart) + 2);
  assert.ok(
    closeSession.indexOf('await clearPersistedNetworkCapture(session)') < closeSession.indexOf('networkCaptures.delete(session)'),
    'persistent storage should be cleared before in-memory capture state is deleted'
  );
  assert.match(networkCdpSource, /export async function clearPersistedNetworkCapture/);
  assert.match(networkCdpSource, /const pending = networkPersistTimers\.get\(session\)/);
  assert.match(networkCdpSource, /clearTimeout\(pending\)/);
  assert.match(networkCdpSource, /networkPersistTimers\.delete\(session\)/);
  assert.match(networkCdpSource, /chrome\.storage\.local\.remove\(networkStorageKey\(session\)\)/);
});



test('scroll command is routed through DOM runtime and CDP wheel fallback semantics', () => {
  const scrollSource = fs.readFileSync(path.join(root, 'src', 'extension', 'service-worker', 'page-runtime', 'scroll.ts'), 'utf8');
  assert.match(navigationSource, /export async function handleScroll/);
  assert.match(navigationSource, /performCdpWheelScroll/);
  assert.match(navigationSource, /wheel unavailable in auto mode; fell back to dom/);
  assert.match(navigationSource, /func:\s*performDomScroll/);
  assert.match(networkCdpSource, /async function performCdpWheelScroll/);
  assert.match(networkCdpSource, /type:\s*['"]mouseWheel['"]/);
  assert.match(networkCdpSource, /recoverable:\s*true/);
  assert.match(networkCdpSource, /captureWheelScrollMetrics/);
  assert.match(networkCdpSource, /attemptedDeltaY/);
  assert.match(networkCdpSource, /movedY\s*=\s*Number\(after\?\.scrollY/);
  assert.doesNotMatch(networkCdpSource, /before:\s*null/);
  assert.doesNotMatch(networkCdpSource, /movedY:\s*deltaY/);
  assert.match(scrollSource, /function findScrollContainer/);
  assert.match(scrollSource, /document\.scrollingElement/);
  assert.match(serviceWorker, /case\s+['"]scroll['"]:/);
  assert.match(serviceWorker, /Input\.dispatchMouseEvent/);
  assert.match(serviceWorker, /mouseWheel/);
});

test('snapshot filters and get_text are wired through navigation handlers', () => {
  assert.match(navigationSource, /func: getAccessibilitySnapshot,[\s\S]*args: \[args \|\| \{\}\]/);
  assert.match(navigationSource, /export async function handleGetText/);
  assert.match(serviceWorker, /get_text/);
});
