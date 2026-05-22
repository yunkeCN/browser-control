'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const serviceWorker = fs.readFileSync(path.join(root, 'skills', 'browser-control', 'extension', 'service-worker.js'), 'utf8');
const networkCdpSource = fs.readFileSync(path.join(root, 'src', 'extension', 'service-worker', 'handlers', 'network-cdp.ts'), 'utf8');
const navigationSource = fs.readFileSync(path.join(root, 'src', 'extension', 'service-worker', 'handlers', 'navigation-actions.ts'), 'utf8');
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
  assert.match(networkCdpSource, /owner:\s*'network_capture'/);
  assert.match(networkCdpSource, /temporary:\s*false/);
  assert.match(networkCdpSource, /will not detach it after the action/);
  assert.match(networkCdpSource, /if \(!lease\?\.temporary \|\| !lease\.debuggee\) return null/);
  assert.match(networkCdpSource, /temporary:\s*true/);
});

test('auto action strategies fall back visibly while explicit CDP strategies return recoverable errors', () => {
  assert.match(navigationSource, /cdp_mouse unavailable in auto mode; fell back to dom_pointer/);
  assert.match(navigationSource, /strategy === ['"]cdp_mouse['"]\) return cdpResult/);
  assert.match(navigationSource, /cdp_keyboard unavailable in auto mode; fell back to dom_keyboard/);
  assert.match(navigationSource, /strategy === ['"]cdp_keyboard['"]\) return cdpResult/);
  assert.match(networkCdpSource, /recoverable:\s*true/);
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

test('extension announces runtime metadata and browser-side capabilities', () => {
  assert.match(runtimeMetadataSource, /const EXTENSION_CAPABILITIES = \[/);
  assert.match(runtimeMetadataSource, /['"]navigateFinalMetadata['"]/);
  assert.match(runtimeMetadataSource, /['"]observe_start['"]/);
  assert.match(runtimeMetadataSource, /['"]observe_diff['"]/);
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
  assert.match(navigationSource, /case|handleAttachTab|export async function handleAttachTab/);
});

test('snapshot filters and get_text are wired through navigation handlers', () => {
  assert.match(navigationSource, /func: getAccessibilitySnapshot,[\s\S]*args: \[args \|\| \{\}\]/);
  assert.match(navigationSource, /export async function handleGetText/);
  assert.match(serviceWorker, /get_text/);
});
