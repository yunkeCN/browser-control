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
- Daemon version, runtime schema, and daemon-owned capabilities.
- Extension manifest/build metadata and browser-side capabilities such as `navigateFinalMetadata`, CDP-backed actions, and DOM pointer fallback.

Missing legacy extension metadata is a warning rather than a global command blocker. A command fails with `UNSUPPORTED` only when it explicitly requests a feature that the connected runtime metadata shows is unavailable.

## CLI

Use the bundled CLI from the skill package:

```bash
node skills/browser-control/scripts/browser-control.js <command> [options]
```

When installed as a package or symlinked into a local `PATH`, the `browser-control` command may also be available directly.

Commands:

- `start [--json]`: start the singleton daemon or report that an existing Browser Control daemon is already running.
- `stop [--json]`: stop the daemon tracked by Browser Control state.
- `restart [--json]`: stop then start the daemon.
- `status [--json]`: report daemon reachability, PID state, port, extension connection, sessions, and artifact/log paths.
- `doctor [--json]`: run daemon, Chrome, and extension diagnostics with next steps. If the daemon is running but the extension is disconnected, use `node skills/browser-control/scripts/open-chrome.js --json` to inspect the installed extension profile, then `node skills/browser-control/scripts/open-chrome.js` to open it. Diagnostics do not open Chrome automatically.
- `diagnose daemon|chrome|extension [--json]`: show a focused diagnostic subset.
- `logs [-n N] [-f]`: print or follow daemon logs.
- `command <name> [--session <name>] [--args <json>] [--args-file <path>] [--code-file <path>] [--timeout-ms <ms>] [--id <id>] [--version <version>]`: send a browser command envelope to `POST /command`.
- `e2e --help`: print live end-to-end test handoff instructions.

Browser command helper examples:

```bash
node skills/browser-control/scripts/browser-control.js command snapshot --session demo --args '{}'
node skills/browser-control/scripts/browser-control.js command click --session demo --args '{"target":"@e1jm0sbb_1"}'
node skills/browser-control/scripts/browser-control.js command click --session demo --args '{"target":"@e1jm0sbb_1","probe":{"filter":"/api/"}}'
node skills/browser-control/scripts/browser-control.js command scroll --session demo --args '{"deltaY":800,"strategy":"dom"}'
node skills/browser-control/scripts/browser-control.js command evaluate --session demo --code-file ./snippet.js
node skills/browser-control/scripts/browser-control.js command tabs --session demo --args '{"action":"list"}'
node skills/browser-control/scripts/browser-control.js command capture --session demo --args '{"format":"png"}'
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

Command arguments are strict. Unknown fields fail validation instead of being ignored, with a hint when a close canonical name exists.

## Result formats

Results differ by access layer:

**Raw daemon HTTP** (`POST /command`) returns a protocol envelope with `id`, `ok`, `command`, `backend`, `session`, `tab`, `startedAt`, `endedAt`, `durationMs`, `data` (nested command output), `artifacts`, `error`, and `diagnostics`.

**Controller CLI** (`browser-control <command>`) returns a flat `CommandResult`: `ok`, `summary`, `nextSteps`, `baselineId`, plus command-specific business fields at the top level (no `data` wrapper).

**MCP tools** (`browser_*`) return the same flat `CommandResult` via `structuredContent`, with `summary` as the primary text content.

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

### `tabs`

Manage tabs in the current session: list, switch, or close.

Arguments: optional `action` (`list`, `switch`, or `close`; defaults to `list`), plus action-specific options.

- `action:"list"`: list all tabs known to the session. No additional arguments required.
- `action:"switch"`: find and attach a tab by URL, title, or tab ID. Optional `urlIncludes`, `titleIncludes`, `active`, and `tabId`. The matched tab is attached to the session and session-scoped network capture is extended to it.
- `action:"close"`: close the current tab, or pass optional `tabId` to close a specific session tab.

```json
{"command":"tabs","args":{"action":"list"}}
{"command":"tabs","args":{"action":"switch","urlIncludes":"example.com"}}
{"command":"tabs","args":{"action":"switch","tabId":123}}
{"command":"tabs","args":{"action":"close"}}
{"command":"tabs","args":{"action":"close","tabId":456}}
```

### `snapshot`

Return a Playwright-inspired ARIA snapshot for interaction and page structure. Snapshot is optimized for choosing actionable targets, not for dumping all page prose; use `get_text` when you mainly need readable page text.

Arguments: optional `tabId`, `roles`, `tags`, `hasVisibleText`, `textIncludes`, `viewportOnly`, `boxes`, and `diff_to`.

When `diff_to` is provided, the first call with a given ID stores the current DOM structure tree. A subsequent call with the same ID returns a structured diff showing added, removed, and changed subtrees instead of the full snapshot. Use this to see what DOM structure changed between two points in time without re-reading the entire tree.

Response semantics:

- `schemaVersion: 3` and `semantics: "playwright-aria-ai-v1"` identify the ARIA-tree snapshot behavior.
- `snapshot` is a compact YAML-like text tree, e.g. `- button "Submit" [ref=@e...]`.
- `tree` is the same page state as structured JSON for clients that prefer data over text.
- `refs` is the actionable reference index. It contains refs, roles, names, direct text, selectors, boxes, and safe input attributes.
- The tree is built from visible or ARIA-visible nodes, includes generic roles only when they carry useful structure, normalizes text runs, collapses noisy single-child generic wrappers, and assigns refs only to visible pointer-receiving elements.
- `boxes:true` adds viewport-relative boxes to the rendered snapshot text and tree.
- If `snapshot` text exceeds 100k characters, Browser Control stores the full JSON snapshot as a local `snapshot` artifact, returns a short preview with `artifact`, and includes filtering guidance. Narrow large pages with `textIncludes`, `roles`, `tags`, `hasVisibleText:true`, or `viewportOnly:true`.
- Likely sensitive input values, such as password/token/secret/session/cookie/API-key fields, are redacted by default with `attributes.redacted:true` and optional `valueLength`.
- `@e` references use the format `@e<structureId>_<revision>`. They are page-state references scoped to the latest snapshot of the current document, not permanent selectors. For element actions, pass the ref as `target`; CSS fallback must be explicit with `target:"css=..."`. Refresh the snapshot after navigation, dialog reconstruction, filtering, list reordering, or significant DOM changes. Browser Control rejects stale revisions with `STALE_ELEMENT_REFERENCE` rather than acting on a changed element.
- Design notes live in `docs/adr-snapshot-aria-ai.md`.

Examples:

```bash
node skills/browser-control/scripts/browser-control.js command snapshot --session demo --args '{"viewportOnly":true,"hasVisibleText":true}'
node skills/browser-control/scripts/browser-control.js command snapshot --session demo --args '{"roles":["button","link","textbox","combobox"],"viewportOnly":true}'
node skills/browser-control/scripts/browser-control.js command snapshot --session demo --args '{"diff_to":"page-1"}'   # first call stores baseline
node skills/browser-control/scripts/browser-control.js command snapshot --session demo --args '{"diff_to":"page-1"}'   # second call returns diff
```

### `click`

Click an element by snapshot ref, CSS fallback, or visible text coordinates.

Arguments: `target` or `text` required (mutually exclusive), optional `tabId`, `x`, `y`, `roles`, `force`, and `probe`.

Target mode (ref or CSS):

- `target:"@e<structureId>_<revision>"` uses a fresh snapshot ref.
- `target:"css=<selector>"` is the explicit CSS fallback when no snapshot ref is available.

Text mode:

- `text` specifies visible text to click. `x` and `y` are required in text mode as viewport-relative coordinates of the text target. Optional `roles` to narrow by ARIA role.

Common options:

- `force`: skip visibility checks and click even if the element is covered or hidden.
- `probe`: intercept matching API requests at the CDP level so the server never receives them. The `probe` object accepts: `filter` (URL substring to match), `includeHeaders` (default `true`), `includeBody` (default `true`), `redactSensitive` (default `true`), and `maxRequests` (default `100`). When `filter` is set, only API requests whose URL includes the filter are blocked and returned; nonmatching requests continue normally. Probe is not a full dry run: the click still executes on the page and may change frontend state, storage, dialogs, or route state — only the matching network requests are prevented from reaching the server.

Browser Control chooses the click strategy internally: it prefers real CDP mouse input when safe, then falls back to DOM pointer events. After the actual click returns, Browser Control waits 500ms before settle/diff capture so delayed UI changes have time to appear. Diagnostics may include `strategyUsed`, `target`, `hitTest`, `focusBefore`, `focusAfter`, `newTab` / `newTabs`, `settle`, `changes`, `postSnapshot`, and `warnings`. `clicked:true` means the click event was triggered; verify business-state completion with `changes`, a fresh `snapshot`, or `wait_for`. Covered targets fail with `COVERED_TARGET`; take a fresh snapshot, close the overlay, or choose a visible child target.

```json
{"command":"click","args":{"target":"@e1jm0sbb_1"}}
{"command":"click","args":{"target":"css=.submit-btn","force":true}}
{"command":"click","args":{"text":"Submit","x":400,"y":300}}
{"command":"click","args":{"target":"@e1jm0sbb_1","probe":{"filter":"/api/","includeBody":true}}}
```

### `fill`

Clear and fill an input, textarea, contenteditable element, or select.

Arguments: `target` and `value` required; optional `tabId`, `strategy`, `clear`, and `commit`.

Strategies:

- `native_setter` default: use the native value setter plus input/change style events for framework compatibility.
- `text_input`: accepted for forward compatibility; currently behaves as native_setter.
- `paste_like`: accepted for forward compatibility; currently behaves as native_setter.

`clear` controls whether existing text is cleared first. `commit` may be `change`, `blur`, `enter`, or `none`. Sensitive fields such as password/token inputs should report redacted diagnostics and lengths rather than values.

Use `value` exactly:

```json
{"command":"fill","args":{"target":"@e0abc12_1","value":"draft text"}}
```

### `press`

Press a keyboard key, optionally targeting an element first.

Arguments: `key` required, optional `target`, `tabId`, `strategy`, and `modifiers`.

Strategies:

- `auto` default: prefer CDP keyboard input when safe, otherwise use DOM keyboard fallback with a warning.
- `cdp_keyboard`: use Chrome debugger keyboard events where available.
- `dom_keyboard`: dispatch synthetic keyboard events and report that they are untrusted.

Press diagnostics may include key/code/modifier data, focused target before and after the action, `strategyUsed`, `newTab` / `newTabs` when the key opens another tab, and `warnings`.

### `scroll`

Scroll the page or a specific element. Use this instead of keyboard keys for scrolling, especially on pages where `Space`/`PageDown` may be intercepted.

Arguments: optional `target`, `tabId`, `strategy` (`auto`, `dom`, or `wheel`), `deltaX`, `deltaY`, `x`, `y`, `region`, `steps`, `block`, `behavior`, and `waitMs`.

Strategies:

- `auto` (default): picks the best method based on arguments — wheel when viewport coordinates are provided, DOM scrolling otherwise.
- `dom`: scrolls via DOM APIs (`element.scrollBy`, `scrollIntoView`). Use `deltaX`/`deltaY` for relative scrolling, `target` for scrolling an element into view.
- `wheel`: dispatches Chrome mouse-wheel events at viewport coordinates (`x`, `y` in CSS pixels).

If `auto` tries wheel scrolling and CDP wheel input is unavailable, Browser Control falls back to DOM relative scrolling without treating the wheel pointer `x`/`y` as absolute DOM scroll targets.

Responses include `ok`, `strategyUsed`, `before`, `after`, `movedX`, `movedY`, optional `atBoundary`, and optional `warnings`. `movedX`/`movedY` are measured movement, not requested delta.

```json
{"command":"scroll","args":{"deltaY":800,"strategy":"dom"}}
{"command":"scroll","args":{"strategy":"wheel","x":400,"y":500,"deltaY":800}}
```

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

Successful evaluations return JSON-compatible data at `result`. Undefined results are normalized to `null` with `serialization.undefinedResult=true`, so agents can distinguish "no value returned" from a transport failure. DOM nodes, errors, circular references, functions, symbols, and very large structures are sanitized with caps; when this happens, `serialization.warnings` and/or `serialization.truncated` explain the conversion.

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

### `capture`

Capture the current page as a screenshot or PDF.

Arguments: optional `tabId`, `format` (`png`, `jpeg`, or `pdf`).

For image formats (`png`, `jpeg`): optional `quality`. When Browser Control knows the target session tab, it may briefly bring that tab to the front so the capture matches the returned tab metadata, then best-effort restores the previously active tab. Responses may include `activatedTabForCapture` and `restoredActiveTabId` diagnostics.

For PDF format: optional `paperFormat`, `landscape`, `scale`, `printBackground`, `fileName`. Chrome permissions may restrict PDF export on some pages.

Use `node skills/browser-control/scripts/screenshot.js` for routine screenshots so the agent receives a file path instead of large image data.

The daemon persists returned screenshot/PDF data into an artifact and strips the raw payload from the normal envelope. Consumers should use `artifact.path` or `artifacts[0].path`.

```json
{"command":"capture","args":{"format":"png"}}
{"command":"capture","args":{"format":"jpeg","quality":80}}
{"command":"capture","args":{"format":"pdf","paperFormat":"A4","landscape":true}}
```

### Network commands

Network monitoring is automatic. `navigate` starts API-focused network capture for the session before page load. There are no explicit start or stop commands. Monitoring captures only same-origin XHR/fetch requests, with a per-tab limit of 100 entries. Resource loads such as images, CSS, fonts, scripts, and documents are intentionally excluded to keep the buffer focused on API traffic.

- `network` with `action:"list"`: list captured requests. Optional args `filter` (URL substring string), `limit`, `tabId`, `method`, and `statusCode`. `method` and `statusCode` narrow by request metadata; `tabId` narrows to a specific tab. `limit` is clamped to 1..100.
- `network` with `action:"detail"`: fetch request/response detail by `requestId`. Detail responses may merge matching webRequest and CDP records and expose `ids` plus `mergeConfidence`; ambiguous records are not silently merged.

```json
{"command":"network","args":{"action":"list","filter":"/api/"}}
{"command":"network","args":{"action":"list","method":"POST","limit":20}}
{"command":"network","args":{"action":"detail","requestId":"req-abc123"}}
```

### File and tab commands

- `upload`: args `target`, `files`, optional `tabId`. Browser security may require user cooperation.
- `download`: args `url` required, optional `filename` and `saveAs`. The extension currently waits up to 30 seconds for Chrome download completion/interruption metadata.
- `close_session`: close all tabs in the session and remove session state; no arguments.

## Installed skill layout

```text
skills/browser-control/
├── SKILL.md
├── extension/
│   ├── manifest.json
│   └── service-worker.js
├── scripts/
│   ├── browser-control.js
│   ├── daemon.js
│   ├── protocol.js
│   ├── support.js
│   ├── health-check.js
│   ├── open-chrome.js
│   ├── screenshot.js
│   └── session-cleanup.js
└── references/
    ├── api.md
    ├── decision-guide.md
    ├── recipes.md
    ├── chrome-extension-setup.md
    └── troubleshooting.md
```
