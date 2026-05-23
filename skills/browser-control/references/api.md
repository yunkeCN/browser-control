# Browser Control API reference

## Runtime endpoints

- HTTP API: `http://127.0.0.1:10087`
- Extension WebSocket: `ws://127.0.0.1:10087/ws`
- Health: `GET /health`
- Status: `GET /status`
- Commands: `POST /command`

Override host and port with `BROWSER_CONTROL_HOST` and `BROWSER_CONTROL_PORT`. Override artifact output with `BROWSER_CONTROL_ARTIFACT_DIR`.

`GET /health`, `GET /status`, and `doctor --json` expose layered runtime metadata when available:

- CLI expected protocol/runtime schema and CLI-known capabilities.
- Daemon version, runtime schema, and daemon-owned capabilities such as `actionObservation`.
- Extension manifest/build metadata and browser-side capabilities such as `navigateFinalMetadata`, observation primitives, CDP-backed actions, and DOM pointer fallback.

Missing legacy extension metadata is a warning rather than a global command blocker. A command fails with `UNSUPPORTED` only when it explicitly requests a feature that the connected runtime metadata shows is unavailable, for example `expectChange`/`observe` without extension observation primitives.

## CLI

Use the bundled CLI from the skill package:

```bash
node skills/browser-control/scripts/browser-control.js <command> [options]
```

When installed as a package or symlinked into a local `PATH`, the `browser-control` command may also be available directly.

Commands:

- `start [--json]`: start the singleton daemon or report that an existing Browser Control daemon is already running.
- `stop [--json]`: stop the daemon tracked by Browser Control state.
- `restart`: stop then start the daemon.
- `status [--json]`: report daemon reachability, PID state, port, extension connection, sessions, and artifact/log paths.
- `doctor [--json]`: run daemon, Chrome, and extension diagnostics with next steps.
- `diagnose daemon|chrome|extension [--json]`: show a focused diagnostic subset.
- `logs [-n N] [-f]`: print or follow daemon logs.
- `command <name> [--session <name>] [--args <json>] [--args-file <path>] [--code-file <path>] [--timeout-ms <ms>] [--id <id>] [--version <version>]`: send a browser command envelope to `POST /command`.
- `e2e --help`: print live end-to-end test handoff instructions.

Browser command helper examples:

```bash
node skills/browser-control/scripts/browser-control.js command snapshot --session demo --args '{}'
node skills/browser-control/scripts/browser-control.js command click --session demo --args '{"selector":"@e1jm0sbb_1"}'
node skills/browser-control/scripts/browser-control.js command scroll --session demo --args '{"deltaY":800,"strategy":"dom"}'
node skills/browser-control/scripts/browser-control.js command evaluate --session demo --code-file ./snippet.js
```

Use `--args-file` for large JSON argument objects. Use `--code-file` only with `evaluate`; it reads UTF-8 JavaScript into `args.code` and avoids shell/JSON escaping. Browser Control intentionally does not support `codeBase64`.

## Command envelope

Every browser operation uses a typed command envelope:

```json
{
  "id": "req-1",
  "version": "2026-05-19",
  "session": "demo",
  "command": "navigate",
  "args": { "url": "https://example.com" },
  "timeoutMs": 30000
}
```

Fields:

- `id`: caller-generated request id.
- `version`: protocol version string.
- `session`: logical browser session. Session tabs persist between calls.
- `command`: one of the supported command names below.
- `args`: command-specific arguments.
- `timeoutMs`: command timeout in milliseconds.

Command arguments are strict. Unknown fields fail validation instead of being ignored, with a hint when a close canonical name exists; for example `find_tab` uses the canonical `*Includes` substring fields for URL and title matching.

## Result envelope

Responses include:

- `id`, `ok`, `command`, `backend`, `session`, `tab`
- `startedAt`, `endedAt`, `durationMs`
- `data` for normal command output
- `artifacts` for generated files such as screenshots, PDFs, downloads, and large network bodies
- `error` with stable `code`, `message`, optional `retryable`, and optional `details`
- `diagnostics` for extra context when available

Common error codes: `VALIDATION_ERROR`, `UNKNOWN_COMMAND`, `TIMEOUT`, `BACKEND_UNAVAILABLE`, `BACKEND_ERROR`, `UNSUPPORTED`, and `NOT_FOUND`.

Validation and recoverable backend failures include `error.details` when the agent can act on them. Examples:

- `fill` with `text` instead of `value` returns a `VALIDATION_ERROR` whose details point to `args.value`.
- stale `@e<structureId>_<revision>` references return `STALE_ELEMENT_REFERENCE` when Browser Control can prove the element at that structural location changed. Missing references may return `NOT_FOUND`; in both cases take a fresh `snapshot` and retry after `wait_for` if needed.
- missing active tabs or disconnected extension failures return `BACKEND_UNAVAILABLE` with readiness or attach/navigation guidance.

## Browser commands

### `navigate`

Open a URL in a new or existing tab.

```json
{"id":"n1","version":"2026-05-19","session":"demo","command":"navigate","args":{"url":"https://example.com","newTab":true},"timeoutMs":30000}
```

Arguments: `url` required, optional `newTab`, optional `timeoutMs`.

`newTab` defaults to `true`. When `newTab:false`, Browser Control navigates the current session tab if one exists, otherwise it creates a new tab. `args.timeoutMs` controls the tab load wait used by navigation metadata; the envelope-level `timeoutMs` still controls the overall command request timeout.

Stable response fields:

- `url`: latest post-load tab URL available to the extension. Normal completed navigations should not return the pre-navigation `about:blank` URL.
- `title`: latest post-load tab title available to the extension.
- `navigationComplete`: `true` when Chrome reported tab load completion before timeout; `false` for degraded/timeout responses.
- `warnings`: actionable warnings, including navigation timeout/degraded metadata notes.
- `network`: API-focused network capture diagnostics. Browser Control intentionally creates an `about:blank` tab first for new navigations so network capture can attach before target page requests begin.

### `find_tab`

Find an existing tab by URL, title, or active state.

Arguments: optional `urlIncludes`, `titleIncludes`, `active`, `tabId`, and `attach`. By default the first match is attached to the session and session-scoped network capture is extended to that tab; pass `attach:false` for lookup-only behavior. Older `attach_tab` calls are accepted as a compatibility alias for `find_tab` with `attach:true`, but new agent code should use `find_tab`.

### `snapshot`

Return a compact accessibility/DOM snapshot for interaction and page structure. Snapshot is optimized for choosing actionable targets, not for dumping all page prose; use `get_text` when you mainly need readable page text.

Arguments: optional `tabId`, `maxDepth`, `roles`, `tags`, `hasVisibleText`, `textIncludes`, `viewportOnly`, and `maxElements`.

Response semantics:

- `schemaVersion: 2` and `semantics: "compact-dom-v2"` identify the compact snapshot behavior.
- `stats.scanned` counts candidate elements after cheap visibility/depth/tag/viewport pruning.
- `stats.matched` counts elements matching role/text filters before `maxElements`.
- `stats.returned` and `stats.truncated` describe the returned element list.
- Legacy aliases `totalBeforeFilter`, `returned`, and `truncated` are preserved for compatibility.
- `maxDepth` is enforced only when explicitly provided; omitting it preserves broad default element discovery for deeply nested SPA controls.
- Generic containers prefer direct text instead of aggregating all descendant text, which reduces duplicated Ant Design/layout text. Interactive elements still preserve discoverable names/text for targeting.
- Likely sensitive input values, such as password/token/secret/session/cookie/API-key fields, are redacted by default with `attributes.redacted:true` and optional `valueLength`.
- `@e` references use the format `@e<structureId>_<revision>`. They are page-state references scoped to the latest snapshot of the current document, not permanent selectors. Refresh the snapshot after navigation, dialog reconstruction, filtering, list reordering, or significant DOM changes. Browser Control rejects stale revisions with `STALE_ELEMENT_REFERENCE` rather than clicking a changed element.

Examples:

```bash
node skills/browser-control/scripts/browser-control.js command snapshot --session demo --args '{"viewportOnly":true,"hasVisibleText":true,"maxElements":120}'
node skills/browser-control/scripts/browser-control.js command snapshot --session demo --args '{"roles":["button","link","textbox","combobox"],"viewportOnly":true}'
```

### `click`

Click an element by `@e` reference or CSS selector.

Arguments: `selector` required, optional `tabId`, `strategy`, `force`, `button`, `clickCount`, `modifiers`, `expectChange`, `observe`, `observeNewTab`, and `expectNewTab`.

Strategies:

- `auto` default: prefer real CDP mouse input when safe, otherwise use DOM pointer fallback with a warning.
- `cdp_mouse`: use Chrome debugger mouse events. If debugger ownership is unavailable, return a recoverable error instead of silently falling back.
- `dom_pointer`: dispatch one pointer/mouse sequence against the hit-tested target. It does not call `el.click()` after a successful sequence.
- `element_click`: explicitly call `el.click()`. This is an escape hatch, not the default, and may bypass pointer/mouse semantics.

Diagnostics may include `strategyUsed`, `target`, `hitTest`, `focusBefore`, `focusAfter`, `newTab` / `newTabs` when the action opens another tab, and `warnings`. When a click opens a new tab, Browser Control attaches that tab to the session and extends session network capture so the next `snapshot` or `wait_for` continues on the new page. Covered targets fail by default with covering element details; use `force:true` only after confirming the overlay should be bypassed.

```json
{"command":"click","args":{"selector":"@e1jm0sbb_1","strategy":"auto","expectChange":true}}
```

### `fill`

Clear and fill an input, textarea, contenteditable element, or select.

Arguments: `selector` and `value` required, optional `tabId`, `strategy`, `clear`, `commit`, `expectChange`, `observe`.

Strategies:

- `native_setter` default: use the native value setter plus input/change style events for framework compatibility.
- `text_input`: reserved for a typed-text style implementation.
- `paste_like`: reserved for paste-like input semantics.

`clear` controls whether existing text is cleared first. `commit` may be `change`, `blur`, `enter`, or `none`. Sensitive fields such as password/token inputs should report redacted diagnostics and lengths rather than values.

Use `value` exactly:

```json
{"command":"fill","args":{"selector":"@e0abc12_1","value":"draft text"}}
```

### `press`

Press a keyboard key, optionally targeting an element first.

Arguments: `key` required, optional `selector`, optional `tabId`, `strategy`, `modifiers`, `expectChange`, `observe`, `observeNewTab`, and `expectNewTab`.

Strategies:

- `auto` default: prefer CDP keyboard input when safe, otherwise use DOM keyboard fallback with a warning.
- `cdp_keyboard`: use Chrome debugger keyboard events where available.
- `dom_keyboard`: dispatch synthetic keyboard events and report that they are untrusted.

Press diagnostics may include key/code/modifier data, focused target before and after the action, `strategyUsed`, `newTab` / `newTabs` when the key opens another tab, and `warnings`.

### Action observation options

`click`, `fill`, and `press` can request action-coupled observation with `expectChange` and `observe`. When enabled, Browser Control may capture a pre-action baseline and a post-action diff. The returned `actionObservation` summarizes visible text and optional network changes. A no-delta result is a warning for the agent to inspect with `snapshot` or `observe_diff` before repeating the action.

`observe` options are intentionally small and stable: optional `baselineId`, `includeNetwork`, `waitMs`, and the `observe_diff` caps such as `maxAdded`, `maxRemoved`, and `maxSummaryChars`. Command result shapes for browser actions remain intentionally loose because pages and fallback strategies produce dynamic diagnostics; stable fields are the result envelope, documented action diagnostics, and optional `actionObservation`.


### `scroll`

Scroll the document, a selected scroll container, or a viewport point/region without relying on keyboard keys. Use this for pages where `Space`, `PageDown`, or `End` may be intercepted by a focused media/player area.

Arguments: optional `tabId`, `selector`, `strategy` (`auto`, `dom`, or `wheel`), `deltaX`, `deltaY`, `x`, `y`, `region`, `steps`, `block`, `behavior`, and `waitMs`.

Strategies:

- `auto` default: use wheel input when `x`, `y`, or `region` is provided; otherwise use DOM document/container scrolling. If wheel/CDP input is unavailable in auto mode, Browser Control falls back to DOM scrolling with a warning.
- `dom`: scroll `document.scrollingElement` or the nearest scrollable container inferred from `selector`. Mode is inferred from arguments: selector-only means `scrollIntoView`; `x`/`y` means absolute offsets; `deltaX`/`deltaY` means relative scrolling. A legacy `mode` override is still accepted for compatibility but is no longer part of the recommended command surface.
- `wheel`: dispatch Chrome debugger mouse-wheel input at viewport coordinates. For wheel, `x` and `y` are CSS-pixel viewport coordinates; explicit wheel failures are recoverable instead of silently falling back.

Responses include `ok`, `target`, `strategyUsed`, `before`, `after`, `movedX`, `movedY`, optional `attemptedDeltaX`/`attemptedDeltaY` for wheel input, optional `atBoundary`, and optional `warnings`. `movedX`/`movedY` are measured movement, not requested delta.

```json
{"command":"scroll","args":{"deltaY":800,"strategy":"dom"}}
{"command":"scroll","args":{"strategy":"wheel","x":400,"y":500,"deltaY":800}}
```

### `select_option`

Set a native `<select>` value.

Arguments: `selector` and `value` required, optional `tabId`.

### `set_checked`

Set a checkbox or radio checked state.

Arguments: `selector` and `checked` required, optional `tabId`.

### `wait_for`

Wait for a selector or visible text to appear.

Arguments: optional `selector`, optional `text`, optional `state`, optional `timeoutMs`, optional `tabId`, optional `expression`.

When `text` is provided, Browser Control waits for user-visible text using the
same narrow visible-text semantics as the Action Observation Layer: whitespace is
collapsed, matching is case-sensitive substring matching, hidden/ARIA-hidden and
password/hidden input content is ignored, and visible control text such as input
values, placeholders, selected options, image alt text, and ARIA labels may
match. Prefer `wait_for.text` over custom `evaluate` polling for ordinary UI
readiness checks.

For selector waits, `state` defaults to `visible`; supported values are `visible`, `attached`, `hidden`, and `detached`. `expression` evaluates a JavaScript expression in the page context and succeeds when it returns a truthy value; prefer `selector` or `text` unless expression polling is specifically needed.

### `evaluate`

Evaluate JavaScript in the page context. `evaluate` is designed to work on pages
with strict script policies such as Trusted Types. If browser debugger support
is unavailable, Browser Control may fall back to an isolated extension world;
DOM access still works there, but page-defined JavaScript globals may not be shared.

Arguments: `code` required, optional `tabId`.

`code` may be either a function body with an explicit `return` or a single expression/IIFE:

```json
{"command":"evaluate","args":{"code":"return { title: document.title }"}}
{"command":"evaluate","args":{"code":"(() => ({ title: document.title }))()"}}
```

Successful evaluations return JSON-compatible data at `data.result`. Undefined results are normalized to `null` with `data.serialization.undefinedResult=true`, so agents can distinguish "no value returned" from a transport failure. DOM nodes, errors, circular references, functions, symbols, and very large structures are sanitized with caps; when this happens, `data.serialization.warnings` and/or `data.serialization.truncated` explain the conversion.

Prefer explicit `return ...` for multi-statement snippets to avoid accidental `undefined` results.

### `get_text`

Return capped page text without writing custom JavaScript.

Arguments: optional `tabId`, `scope` (`viewport` default, backward-compatible `document`, or rendered/reachable `full`), `maxChars`, `includeRuns`, and `selector`.

When `selector` is provided, text extraction is scoped to the first element matching the CSS selector. If no element matches, the response includes an `error` field instead of returning empty text. This is the recommended way to extract text from a specific region (e.g., `".search-results"`, `"article"`, `"main"`) without noise from navigation, sidebars, or footers.

The default viewport scope reuses the same visible-text extraction semantics as observation. Document scope preserves the legacy coarse `body.innerText` behavior. Full scope traverses rendered layout text and filters hidden/zero-size/off-layout decoys. Responses include `text`, `truncated`, `caps`, `url`, and `title`; canonical `textRuns` are returned only when requested, with `runs` retained as a compatibility alias. Truncated large observations may be stored as `observation` artifacts.

```json
{"command":"get_text","args":{"scope":"viewport","maxChars":4000}}
{"command":"get_text","args":{"scope":"document","maxChars":12000}}
{"command":"get_text","args":{"scope":"full","maxChars":12000,"includeRuns":true}}
{"command":"get_text","args":{"scope":"full","maxChars":5000,"selector":".search-results"}}
```

### `screenshot`

Capture a viewport screenshot.

Arguments: optional `tabId`, `format` (`png` or `jpeg`), `quality`, `fullPage`.

`fullPage:true` is accepted for forward compatibility, but the current Chrome extension backend still captures the visible viewport. Responses expose `fullPageSupported:false`, `fullPageRequested`, and a note when full-page capture was requested.

When Browser Control knows the target session tab, it may briefly bring that tab
to the front so the screenshot matches the returned tab metadata, then
best-effort restores the previously active tab. Responses may include
`activatedTabForCapture` and `restoredActiveTabId` diagnostics.

Use `bash skills/browser-control/scripts/screenshot.sh` for routine screenshots so the agent receives a file path instead of large image data.

The daemon persists returned screenshot base64 into an artifact and strips the raw payload from the normal envelope. Consumers should use `data.artifact.path` or `artifacts[0].path`; `scripts/screenshot.sh` accepts both artifact-backed and raw-base64 response shapes.

### `save_as_pdf`

Export a page as PDF when Chrome permissions allow it.

Arguments: optional `tabId`, `paper_format`, `landscape`, `scale`, `print_background`, `file_name`.

### Network commands

- `network_start`: start or reset API-focused capture; optional args `filter`, `tabId`, and `scope` (`session` or `tab`). `filter`, when provided, must be a URL substring string. Session-scoped capture tracks tabs associated with the session and extends when `navigate` or attached `find_tab` adds a tab. Resource loads such as images, CSS, fonts, scripts, and documents are intentionally excluded to keep the buffer focused on XHR/fetch API traffic.
- `network_list`: list captured requests; optional args `filter`, `sinceTimestampMs`, `limit`, `tabId`, `method`, `statusCode`, and `type`. `filter`, when provided, must be a URL substring string; omit it for no filtering. `method`, `statusCode`, and `type` narrow by request metadata; `tabId` narrows session-scoped capture to one tab. `limit` is clamped to 1..100 (`NETWORK_LIST_LIMIT`). When `sinceTimestampMs` is used, requests without a comparable timestamp are excluded and counted in `omittedUntimestamped`.
- `network_detail`: fetch request/response detail by `requestId`. Detail responses may merge matching webRequest and CDP records and expose `ids` plus `mergeConfidence`; ambiguous records are not silently merged.
- `network_stop`: stop capture and clear persisted capture state.

`navigate` also starts API-focused network capture for the session before page load.

### Observation commands

The Action Observation Layer is specified in `docs/adr-action-observation-layer.md`. Use it when an agent needs to know what visible text and API/network activity changed after ordinary browser actions. Observation reads visible page text, so keep the existing sensitive-data and confirmation boundaries.

#### `observe_start`

Capture a viewport-text baseline for the current session tab and store it in daemon-managed short-lived baseline storage. The full baseline is not returned by default.

Arguments: optional `tabId`, optional `mode` (`viewport_text`), optional `baselineId`, optional `includeNetworkMarker`, optional `maxTextChars`, optional `maxTextRuns`.

Response data:

```json
{
  "baselineId": "obs_20260520_abc123",
  "session": "demo",
  "tabId": 123,
  "url": "https://example.com/page",
  "title": "Example",
  "observedAt": "2026-05-20T06:00:00.000Z",
  "navigationKey": "123:https://example.com/page",
  "networkMarker": { "markerId": "net_20260520_abc123", "timestampMs": 1779256800000 },
  "summary": { "textRunCount": 42, "visibleTextChars": 1800, "truncated": false }
}
```

#### `observe_diff`

Capture the current viewport text, compare it with a stored baseline, and return a capped added/removed visible-text delta plus optional network requests since the baseline marker.

Arguments: `baselineId` required, optional `tabId`, optional `includeCurrent`, optional `includeNetwork`, optional `maxAdded`, optional `maxRemoved`, optional `maxSummaryChars`, optional `allowStaleNavigationDiff`.

Response data:

```json
{
  "baselineId": "obs_20260520_abc123",
  "session": "demo",
  "tabId": 123,
  "urlChanged": false,
  "stale": false,
  "summary": "Visible text added: Saved successfully. Removed: Submitting.",
  "textDiff": {
    "addedText": ["Saved successfully"],
    "removedText": ["Submitting"],
    "truncated": false
  },
  "network": {
    "sinceMarkerId": "net_20260520_abc123",
    "sinceTimestampMs": 1779256800000,
    "requestCount": 1,
    "requests": [{ "requestId": "...", "method": "POST", "url": "/api/save", "status": 200 }],
    "truncated": false
  }
}
```

Constraints:

- Baselines are scoped to `session + tabId + baselineId`; cross-tab diff is invalid unless a future command explicitly supports it.
- Navigation invalidates baselines for the navigated tab; if stale baseline data is available, different-origin navigation should not compute text diff by default.
- Output is capped by default. Large observations should become local artifacts rather than raw response payloads.
- Network correlation is \"requests since marker\", not proof that a request was caused by an action.
- Visible text may contain sensitive data; do not log full observations or paste full artifacts unless appropriate and user-authorized.

### File and tab commands

- `upload`: args `selector`, `files`, optional `tabId`. Browser security may require user cooperation.
- `download`: args `url` required, optional `filename` and `saveAs`. The extension currently waits up to 30 seconds for Chrome download completion/interruption metadata.
- `list_tabs`: list tabs known to the session.
- `close_tab`: close the current tab, or pass optional `tabId` to close a specific session tab.
- `close_session`: close all tabs in the session and remove session state; no arguments.

## Installed skill layout

```text
skills/browser-control/
├── SKILL.md
├── extension/
│   ├── manifest.json
│   ├── service-worker.js
│   └── content.js
├── scripts/
│   ├── browser-control.js
│   ├── daemon.js
│   ├── protocol.js
│   ├── artifact-store.js
│   ├── vendor/ws/
│   ├── health-check.sh
│   ├── screenshot.sh
│   └── session-cleanup.sh
└── references/
    ├── api.md
    ├── decision-guide.md
    ├── recipes.md
    ├── chrome-extension-setup.md
    └── troubleshooting.md
```
