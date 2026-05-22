# ADR: Action Observation Layer

- Status: Accepted; explicit lifecycle and action-coupled observation are implemented
- Date: 2026-05-20

## Context

Browser Control already gives agents low-level browser primitives: `snapshot`, `click`, `fill`, `evaluate`, `network_*`, screenshots, downloads, and artifacts. Real workflow testing showed that agents still spend too much time asking "what changed after my action?" They currently approximate this by taking repeated snapshots, screenshots, and network lists, then manually diffing them.

The Action Observation Layer adds a first-class, bounded way to answer that question without turning Browser Control into a site-specific script library, a Playwright replacement, or a heavy framework-automation layer.

## Decision

Add an explicit observation lifecycle as the foundation:

1. `observe_start`: capture a scoped text/network baseline.
2. User or agent performs ordinary browser actions (`click`, `fill`, `press`, `evaluate`, etc.).
3. `observe_diff`: capture the current observation, compare it with the baseline, and return a compact delta.

The observation layer must be viewport-first, text-first, capped, and compatible with the existing result envelope. Action commands may also request action-coupled observation through `expectChange` and `observe`, implemented by creating a baseline before the action and returning a compact diff after the action.

## API shape

### Public commands

#### `observe_start`

Purpose: capture a baseline for the active session tab.

Arguments:

```json
{
  "tabId": 123,
  "mode": "viewport_text",
  "includeNetworkMarker": true,
  "maxTextChars": 12000,
  "maxTextRuns": 300,
  "baselineId": "optional-human-label"
}
```

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
  "networkMarker": {
    "markerId": "net_20260520_abc123",
    "timestampMs": 1779256800000
  },
  "summary": {
    "textRunCount": 42,
    "visibleTextChars": 1800,
    "truncated": false
  }
}
```

`observe_start` stores the full capped baseline server-side and returns metadata, not the full observation by default.

#### `observe_diff`

Purpose: compare the current active session tab with a stored baseline.

Arguments:

```json
{
  "baselineId": "obs_20260520_abc123",
  "tabId": 123,
  "includeCurrent": false,
  "includeNetwork": true,
  "maxAdded": 80,
  "maxRemoved": 80,
  "maxSummaryChars": 1200
}
```

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
    "requestCount": 1,
    "requests": [
      { "requestId": "...", "method": "POST", "url": "/api/save", "status": 200 }
    ],
    "truncated": false
  },
  "artifacts": []
}
```

### Action-coupled observation

`click`, `fill`, and `press` support `expectChange` and `observe`:

```json
{"command":"click","args":{"selector":"@e4","expectChange":true,"observe":{"includeNetwork":true,"waitMs":150}}}
```

Semantics:

- The daemon creates a pre-action baseline using the same bounded observation path as `observe_start`.
- The action runs normally.
- The daemon waits briefly, then computes an `observe_diff`-style delta.
- The command result includes `actionObservation` with visible text, optional network changes, stale/navigation metadata, and warnings when `expectChange` was requested but no meaningful delta was observed.
- The explicit `observe_start` / `observe_diff` lifecycle remains the preferred debugging and multi-step workflow primitive.

## Baseline storage

Baselines will be stored in daemon memory, not page context or extension service-worker-only state.

Rationale:

- The daemon already owns sessions, request envelopes, artifacts, and response shaping.
- Page context storage is lost on navigation and may pollute customer pages.
- Extension service workers can suspend; daemon memory is more predictable during an agent task.
- Artifact fallback is already daemon-side.

Storage key:

```text
session + tabId + baselineId
```

Baseline record:

```json
{
  "baselineId": "obs_...",
  "session": "demo",
  "tabId": 123,
  "createdAt": "2026-05-20T06:00:00.000Z",
  "lastAccessedAt": "2026-05-20T06:00:10.000Z",
  "expiresAt": "2026-05-20T07:00:00.000Z",
  "navigationKey": "123:https://example.com/path",
  "url": "https://example.com/path",
  "title": "Example",
  "networkMarker": { "markerId": "net_...", "timestampMs": 1779256800000 },
  "observation": { "visibleText": "...", "textRuns": [] },
  "artifact": null
}
```

Caps and cleanup:

- Default TTL: one hour.
- Per-session baseline cap: 20.
- Global in-memory baseline cap: 200.
- Oldest/expired baselines are evicted first.
- `close_session` removes baselines for that session.
- `close_tab` removes baselines for that session/tab.
- `observe_diff` updates `lastAccessedAt`.

## Session and tab scoping

A baseline is valid only for the same `session` and `tabId` unless a future command explicitly supports cross-tab comparison.

Rules:

- `observe_start` resolves `tabId` exactly like other commands: explicit `tabId` first, otherwise active tab for the session.
- `observe_diff` without `tabId` resolves active tab but must reject if it differs from the stored baseline tab.
- Cross-tab diff returns `VALIDATION_ERROR` or `NOT_FOUND` with a next step to create a fresh baseline for the active tab.

## Navigation invalidation

Navigation invalidates semantic equality even if `tabId` stays the same.

`observe_start` stores a `navigationKey` made from tab id plus URL. `observe_diff` compares the current URL to the stored URL:

- Same URL: diff normally.
- Same origin but different URL: return `stale: true`, include `urlChanged: true`, and provide a high-level navigation summary if possible.
- Different origin: return `stale: true` and do not compute added/removed text by default unless `allowStaleNavigationDiff: true` is explicitly passed.

`navigate` should also proactively invalidate baselines for the session/tab when the daemon can identify the tab.

## Payload caps and artifact fallback

Observation payloads must not flood agent context.

Default caps for P1b:

- `visibleText`: 12,000 characters.
- `textRuns`: 300 runs.
- Individual text run: 500 characters.
- `addedText`: 80 entries.
- `removedText`: 80 entries.
- Summary: 1,200 characters.
- Network summaries: 100 requests.

When a capture exceeds caps:

- Normal response returns a compact summary plus `truncated: true`.
- Full capped observation may be persisted to the local artifact store when useful.
- Raw artifact paths may be returned, but raw large text/base64 must not be printed into ordinary responses.

Artifact metadata should include kind `observation`, session, tabId, URL, createdAt, and whether sensitive-looking fields were redacted.

## Privacy and sensitive output

Observation reads visible page text, which may include private business data, personal data, credentials, or internal URLs.

Rules:

- Preserve existing confirmation boundaries; observation is for reading state, not bypassing confirmation.
- Do not log full visible text to daemon logs.
- Do not include hidden input values, password fields, token-looking values, or file paths in text runs.
- Redact values from `input[type=password]`, fields with `autocomplete=current-password|one-time-code`, and common token/secret patterns.
- Keep artifacts local; agents should summarize, not paste full sensitive artifacts, unless the user explicitly asks and the content is appropriate to share.
- Observation commands should expose caps so agents can choose smaller outputs for sensitive pages.

## Network/action marker semantics

P1b should correlate network activity by marker timestamp, not by trying to infer framework-specific actions.

Marker rules:

- `observe_start` records `networkMarker.timestampMs` using daemon time immediately before or after the baseline capture; the exact order must be documented in implementation.
- `observe_diff({ includeNetwork: true })` lists captured requests whose start time is greater than or equal to that marker.
- The response includes `sinceMarkerId`, `sinceTimestampMs`, `requestCount`, and a capped list of request summaries.
- Background requests are not automatically excluded in P1b. The response should label this as "since marker" rather than "caused by action".

Future action correlation may add `actionId` to every state-changing command response, but that is not required for P1b.

## TextRuns extraction prototype notes

Preferred extraction path:

1. Walk visible text nodes in document order.
2. Skip nodes under invisible, inert, disabled-hidden, script/style/template, password, and aria-hidden containers.
3. Use `Range#getClientRects()` for text-node rectangles.
4. Intersect rectangles with the viewport by default.
5. Normalize whitespace for comparison while retaining original text for display.
6. Attach nearest stable element metadata when possible: `@e` id from fresh snapshot tags, role, accessible name, and selector.
7. For controls without text nodes, synthesize runs from accessible name, placeholder, selected option text, button text, image alt text, and ARIA labels.
8. De-duplicate ancestor text so a button's text appears once, not once for every container.

Run shape:

```json
{
  "id": "t1",
  "text": "Add branch",
  "normalizedText": "Add branch",
  "rect": { "x": 744, "y": 16, "width": 80, "height": 22 },
  "element": "@e760",
  "role": "button",
  "selector": "button.ant-btn-primary"
}
```

## Diff semantics prototype notes

P1b guarantees only `addedText`, `removedText`, and a concise `summary`.

Algorithm:

1. Normalize each run text: trim, collapse whitespace, drop empty strings.
2. Count occurrences with a multiset rather than a plain set.
3. Added text = current multiset count greater than baseline count.
4. Removed text = baseline multiset count greater than current count.
5. Preserve first-seen order from current for additions and baseline for removals.
6. Cap arrays and set `truncated: true` when caps are exceeded.

Deferred or experimental categories:

- `hiddenText`: text still in DOM but CSS-hidden.
- `occludedText`: text visible by CSS but covered by overlay.
- `changedText`: matching approximate element/location with changed content.
- form-state intelligence.

These categories may appear later behind an `experimental` object, but P1b must not claim high confidence for them.

## Compatibility

The existing result envelope remains unchanged:

```json
{
  "ok": true,
  "command": "observe_diff",
  "data": { "summary": "..." },
  "artifacts": []
}
```

New commands will be additive. Existing commands remain source-compatible.

## Acceptance criteria for P1b implementation

P1b is accepted only when fixtures prove:

1. Modal/drawer open/close produces added/removed visible text.
2. Large DOM output is capped and can artifact fallback without context flooding.
3. Navigation marks baselines stale or invalid.
4. Stale `@e` / stale baseline errors include recovery guidance.
5. Network list can filter requests since the baseline marker.
6. Background network noise is labeled as "since marker", not asserted as causation.
7. `SKILL.md` and `references/api.md` describe how agents should use observation safely.
8. No screenshot/base64 or large raw observation payload leaks into normal output.

## Consequences

Positive:

- Agents get a direct answer to what visibly changed after an action.
- The explicit lifecycle is easy to test and debug.
- The daemon remains the stable state owner and artifact gatekeeper.

Negative/tradeoffs:

- The explicit two-step lifecycle is more verbose than action-coupled observation.
- Daemon memory now owns short-lived observation state and cleanup policy.
- Since-marker network correlation is weaker than true causation, but more honest and implementable.

## Revisit triggers

Reconsider broader semantic locator/form APIs only after observation proves it materially reduces automation friction across representative real-world workflows.
