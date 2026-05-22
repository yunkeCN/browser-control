import { getAccessibilitySnapshot, getDomSnapshot } from './snapshot';
import { performClick, performFill, performPress, performSelectOption, performSetChecked, performWaitFor, performUpload, performEvaluate, scrollToElement } from './actions';

// Browser Control — Content Script
// Injected into every page to provide DOM manipulation APIs.
// Communicates with the service worker via chrome.runtime messaging.

// Listen for commands from the service worker (relayed from daemon)
chrome.runtime.onMessage.addListener((msg: any, sender, sendResponse) => {
  if (msg.type === 'ping') {
    sendResponse({ ok: true, url: window.location.href });
    return true;
  }

  if (msg.type === 'exec') {
    handleExec(msg.action, msg.args)
      .then(result => sendResponse({ data: result }))
      .catch((err: any) => sendResponse({ error: err.message }));
    return true; // keep channel open for async
  }
});

export async function handleExec(action: string, args: any): Promise<any> {
  switch (action) {
    case 'getSnapshot':
      return getAccessibilitySnapshot(args?.maxDepth);
    case 'click':
      return performClick(args?.selector, args || {});
    case 'fill':
      return performFill(args?.selector, args?.value, args || {});
    case 'press':
      return performPress(args?.key, args?.selector, args || {});
    case 'selectOption':
    case 'select_option':
      return performSelectOption(args?.selector, args?.value);
    case 'setChecked':
    case 'set_checked':
      return performSetChecked(args?.selector, args?.checked);
    case 'waitFor':
    case 'wait_for':
      return performWaitFor(args);
    case 'upload':
      return performUpload(args?.selector, args?.files || []);
    case 'evaluate':
      return performEvaluate(args?.code);
    case 'getDomSnapshot':
      return getDomSnapshot();
    case 'scrollTo':
      return scrollToElement(args?.selector);
    default:
      throw new Error(`Unknown content action: ${action}`);
  }
}
