import { sendToDaemon, pendingRequests } from './transport';
import { handleNavigate, handleSnapshot, handleClick, handleClickProbe, handleFill, handlePress, handleScroll, handleWaitFor, handleFindTab, handleAttachTab, handleEvaluate, handleScreenshot, handleObserveCapture, handleGetText, handleCdpClickAt } from './handlers/navigation-actions';
import { handleNetwork } from './handlers/network-cdp';
import { handleUpload, handleDownload, handleSaveAsPdf, handleListTabs, handleCloseTab, handleCloseSession } from './handlers/artifacts-tabs';
import type { CommandAction, CommandArgs, CommandResult, RequestId, SessionName } from '../shared/types';

// ─── Message routing ─────────────────────────────────────────────────

export function handleDaemonMessage(msg: any): void {
  const { type, requestId, session, action, args } = msg;

  if (type === 'response' && requestId) {
    const pending = pendingRequests.get(requestId);
    if (pending) {
      clearTimeout(pending.timer);
      pendingRequests.delete(requestId);
      if (msg.error) {
        pending.reject(new Error(msg.error));
      } else {
        pending.resolve(msg.data);
      }
    }
    return;
  }

  // Incoming command from daemon
  if (type === 'command') {
    executeCommand(requestId, session, action, args).catch((err: any) => {
      sendToDaemon({
        type: 'response',
        requestId,
        error: err.message || String(err)
      });
    });
  }
}

// ─── Command execution ──────────────────────────────────────────────

export async function executeCommand(
  requestId: RequestId,
  session: SessionName,
  action: CommandAction,
  args: CommandArgs = {}
): Promise<void> {
  try {
    let result: CommandResult;
    switch (action) {
      case 'navigate':
        result = await handleNavigate(args, session);
        break;
      case 'snapshot':
        result = await handleSnapshot(args, session);
        break;
      case 'click':
        result = await handleClick(args, session);
        break;
      case 'click_probe':
        result = await handleClickProbe(args, session);
        break;
      case 'cdp_click_at':
        result = await handleCdpClickAt(args, session);
        break;
      case 'fill':
        result = await handleFill(args, session);
        break;
      case 'press':
        result = await handlePress(args, session);
        break;
      case 'scroll':
        result = await handleScroll(args, session);
        break;
      case 'wait_for':
        result = await handleWaitFor(args, session);
        break;
      case 'find_tab':
        result = await handleFindTab(args, session);
        break;
      case 'attach_tab':
        result = await handleAttachTab(args, session);
        break;
      case 'evaluate':
        result = await handleEvaluate(args, session);
        break;
      case 'screenshot':
        result = await handleScreenshot(args, session);
        break;
      case 'get_text':
        result = await handleGetText(args, session);
        break;
      case 'observe_capture':
        result = await handleObserveCapture(args, session);
        break;
      case 'network':
        result = await handleNetwork(args, session);
        break;
      case 'upload':
        result = await handleUpload(args, session);
        break;
      case 'download':
        result = await handleDownload(args, session);
        break;
      case 'save_as_pdf':
        result = await handleSaveAsPdf(args, session);
        break;
      case 'list_tabs':
        result = await handleListTabs(session);
        break;
      case 'close_tab':
        result = await handleCloseTab(args, session);
        break;
      case 'close_session':
        result = await handleCloseSession(session);
        break;
      default:
        throw new Error(`Unknown action: ${action}`);
    }

    sendToDaemon({
      type: 'response',
      requestId,
      data: result
    });
  } catch (err: any) {
    sendToDaemon({
      type: 'response',
      requestId,
      error: err.message || String(err)
    });
  }
}
