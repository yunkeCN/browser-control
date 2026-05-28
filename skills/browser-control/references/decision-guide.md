# Browser Control decision guide

Use this guide to decide whether to proceed automatically, retry, or ask the user.

## Readiness decisions

| Observation | Agent action | Can browser task proceed? |
|---|---|---|
| Daemon unreachable | Run `node scripts/browser-control.js start --json`, then `doctor --json` again. | Not until daemon is reachable. |
| Daemon reachable and `extension_connected=true` | Proceed with browser automation. | Yes. |
| Daemon reachable and `extension_connected=false` | Ask the user to load/reload the Chrome extension and guide them with `references/chrome-extension-setup.md`. | No, except daemon diagnostics. |
| Chrome not installed/found | Report prerequisite and ask user to install/open Chrome. | No. |
| Port conflict | Use a free `BROWSER_CONTROL_PORT` consistently for daemon and extension, or ask user to stop the conflicting service. | Not until resolved. |
| Extension install/reload UI is required | If you cannot safely operate `chrome://extensions`, ask user to perform it. | No. |

## Command failure decisions

| Error or symptom | Likely cause | Agent action |
|---|---|---|
| `BACKEND_UNAVAILABLE` | Extension disconnected or daemon-extension bridge unavailable. | Run `doctor --json`; ask user to reload extension if disconnected. |
| `TIMEOUT` | Slow page/action, pending load, or selector wait too short. | Check page state, use `wait_for`, retry with fresh snapshot or larger `timeoutMs`. |
| `VALIDATION_ERROR` | Malformed envelope or missing/invalid args. | Fix command JSON before retrying. |
| `UNKNOWN_COMMAND` | Unsupported command name or typo. | Check `references/api.md` and correct command. |
| `STALE_ELEMENT_REFERENCE` or `Element not found` | Stale `@e<structureId>_<revision>` reference or selector mismatch. | Take fresh `snapshot`, rebuild locator, retry once with new target. |
| Click/fill appears ignored | Site blocks synthetic events or target is custom UI. | Verify with a fresh snapshot; repair the locator, use `scroll` for obscured/below-fold targets, or retry with a deliberate click/fill strategy only if safe. |
| Empty/partial network list | Monitoring started after the request fired, filter/tab/method/status too narrow, or traffic is not same-origin XHR/fetch API traffic. | Repeat the action so monitoring (automatic on navigate) captures it, adjust `filter`, `tabId`, `method`, `statusCode`, or inspect non-API resource loads separately. |

## User escalation decisions

Ask the user before continuing when any of these appear:

- MFA, CAPTCHA, login wall, password prompt, passkey, or security challenge.
- Browser permission prompts, native file picker, OS dialog, or extension install/reload requirement.
- Payment, purchase, booking, subscription, order placement, cancellation, deletion, or irreversible change.
- Account, security, privacy, organization, OAuth, permission, or billing changes.
- Uploading files or entering/sending personal, private, sensitive, credential-like, financial, medical, legal, or regulated data.
- Ambiguous UI target where the wrong click could have side effects.

## Retry limits

- Retry daemon startup through the singleton CLI once before reporting a blocker.
- Retry selector-based actions only after a fresh snapshot.
- Retry timeouts only after checking page state and whether a longer timeout is justified.
- Do not repeatedly click final-action controls; verify or ask.

## Reporting decisions

When reporting success, include the evidence type that proves it:

- visible text or snapshot result for read tasks
- before/after state for UI changes
- artifact path for screenshots, PDFs, downloads, or large network bodies
- request URL/status/body summary for network tasks
- confirmation or resulting page state for submissions

When blocked, report the exact layer and next user action: daemon, Chrome, extension, page login/MFA, permission prompt, selector ambiguity, or site limitation.
