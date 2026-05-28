---
name: browser-control
description: Control the user's real Chrome through a local Browser Control daemon and Chrome extension. Use when a task requires browser or webpage automation, screenshots, DOM snapshots, authenticated sessions, form interaction, network inspection, downloads, PDFs, or direct website interaction from an agent.
---

# Browser Control

Browser Control lets an agent operate the user's real Chrome profile through a localhost daemon and a Chrome Manifest V3 extension.

```text
agent -> scripts/browser-control.js -> localhost HTTP daemon -> WebSocket -> Chrome extension -> Chrome DOM
```

Use this skill for browser work that benefits from the user's installed Chrome, logged-in sessions, extension environment, or visible tabs.

## Quick start

Run commands from this skill directory unless `browser-control` is already on `PATH`:

```bash
node scripts/browser-control.js start --json
node scripts/browser-control.js doctor --json
node scripts/health-check.js --json
```

The daemon listens on `http://127.0.0.1:10087` by default and the extension connects to `ws://127.0.0.1:10087/ws`.

## Agent execution loop

1. Choose a unique `session` name for the task, such as `research-<topic>` or `checkout-review`.
2. Start or reuse the singleton daemon: `node scripts/browser-control.js start --json`.
3. Run `node scripts/browser-control.js doctor --json` and proceed only when the daemon is reachable and `extension_connected` is true.
4. Navigate with `navigate`, or find/attach an existing tab with `tabs` (action: `switch`; default attaches the matched tab).
5. Take a fresh `snapshot` before every element interaction. Snapshot is a compact structure/interaction view, not a full text dump; use `get_text` for reading page prose. On noisy pages, use filters such as `hasVisibleText`, `viewportOnly`, `textIncludes`, `roles`, and `tags`.
6. Use `@e` references from the latest snapshot as `target` for `click`, `fill`, `press`, `scroll`, and `upload`; refresh the snapshot after navigation or significant DOM changes. Stale revisions fail closed with `STALE_ELEMENT_REFERENCE`. Use `scroll` for non-keyboard page or region scrolling; use `target:"css=..."` only when a snapshot ref is unavailable.
7. Let `click` choose its internal strategy. Inspect `warnings` and the returned diagnostics before retrying. For `fill` and `press`, use default strategies first.
8. Covered click targets fail with `COVERED_TARGET`; prefer fixing the target locator, closing the overlay, or choosing a visible child target.
9. Verify important state-changing actions with `snapshot` (with `diff_to` to detect DOM changes), `wait_for`, or `capture` when visual evidence matters. For DOM structure diffs, take a snapshot (note its `baselineId`), perform the action, then call `snapshot diff_to=<baselineId>` to get structured added/removed/changed subtrees.
10. Stop and ask before sensitive, destructive, account-changing, purchase/payment, upload, submit/send/post/publish, credential, MFA, or permission-grant actions.
11. Close task-specific tabs or sessions with `tabs` (action: `close`) / `close_session` when finished.

## Command API

Send typed command envelopes to `POST http://127.0.0.1:10087/command` or use the CLI helper:

```bash
node scripts/browser-control.js command snapshot --session demo --args '{}'
node scripts/browser-control.js command click --session demo --args '{"target":"@e1jm0sbb_1"}'
node scripts/browser-control.js command click --session demo --args '{"target":"@e1jm0sbb_1","probe":{"filter":"/api/","includeBody":true}}'
node scripts/browser-control.js command click --session demo --args '{"text":"Submit","x":200,"y":300}'
node scripts/browser-control.js command fill --session demo --args '{"target":"@e0abc12_1","value":"draft text"}'
node scripts/browser-control.js command get_text --session demo --args '{"scope":"viewport","maxChars":4000}'
node scripts/browser-control.js command scroll --session demo --args '{"deltaY":800,"strategy":"dom"}'
node scripts/browser-control.js command scroll --session demo --args '{"strategy":"wheel","x":400,"y":500,"deltaY":800}'
node scripts/browser-control.js command snapshot --session demo --args '{"hasVisibleText":true,"viewportOnly":true}'
node scripts/browser-control.js command snapshot --session demo --args '{"roles":["button","link","textbox","combobox"],"viewportOnly":true}'
node scripts/browser-control.js command evaluate --session demo --code-file ./snippet.js
```

Envelope shape:

```json
{
  "id": "req-1",
  "version": "2026-05-19",
  "session": "demo",
  "command": "snapshot",
  "args": {},
  "timeoutMs": 30000
}
```

Controller CLI and MCP tools return a flat result: `ok`, `summary`, `nextSteps`, `baselineId`, plus command-specific fields at the top level. Raw daemon HTTP (`POST /command`) wraps output in a protocol envelope with a nested `data` field; see `references/api.md` for format differences by layer.

Common commands: `navigate`, `tabs`, `snapshot`, `click`, `fill`, `press`, `scroll`, `wait_for`, `evaluate`, `get_text`, `capture`, `network`, `upload`, `download`, and `close_session`.

MCP tools are registered as individual tools: `browser_navigate`, `browser_tabs`, `browser_snapshot`, `browser_get_text`, `browser_click`, `browser_fill`, `browser_press`, `browser_scroll`, `browser_wait_for`, `browser_capture`, `browser_evaluate`, `browser_network`, `browser_upload`, `browser_download`, `browser_close_session`, plus `browser_status` and `browser_doctor` for diagnostics.

Load `references/api.md` for the full command and CLI reference.

Snapshot redacts likely sensitive field values by default (`password`, token/secret/session/cookie/API-key-like fields). If you need page text rather than targets, prefer `get_text` so the agent does not spend context on layout containers. For below-fold or scrollable-region text, use `scroll` plus `get_text` instead of using `evaluate` as a scrolling workaround.

## Common recipes

Load `references/recipes.md` for task playbooks:

- read a page
- operate UI safely
- fill a form without submitting
- submit after confirmation
- capture screenshots or PDFs
- inspect network calls
- download files
- clean up sessions

For quick single-action verification, use `snapshot diff_to` to compare DOM structure before and after. For network interception during a click, use `click` with the `probe` parameter to block matching API requests before they reach the server. Note: probe is not a dry run — the click still happens and may change frontend state, storage, dialogs, or route state. Only the matching network requests are blocked.

Network monitoring starts automatically on `navigate`. Use `network { action: 'list' }` to list captured same-origin xhr/fetch requests (per-tab 100 request limit) and `network { action: 'detail', requestId: '...' }` to inspect a specific request.

## Screenshots and artifacts

Do not paste raw screenshot or PDF base64 into context. Use bundled artifact helpers:

```bash
node scripts/screenshot.js -s demo -f png
```

Artifact-producing commands return file references and metadata. Default artifact storage is `~/.browser-control/artifacts`; override it with `BROWSER_CONTROL_ARTIFACT_DIR` when needed.

`capture` responses intentionally omit raw base64 after the daemon persists the file. Read the returned artifact path from the result's `filePath` field; the `scripts/screenshot.js` helper does this and prints only the saved file path.

## Confirmation boundaries

Must ask the user before:

- clicking Submit, Send, Post, Publish, Confirm, Buy, Pay, Delete, Cancel, or similar final-action controls
- placing orders, payments, subscriptions, bookings, or irreversible changes
- changing account, security, privacy, OAuth, permission, or organization settings
- uploading local files or entering/sending personal, sensitive, private, or credential-like data
- handling login, MFA, CAPTCHA, browser permission prompts, or native file pickers

Usually no confirmation is needed for navigation, reading visible content, opening non-submitting menus, taking screenshots for task evidence, or filling reversible draft fields with non-sensitive content.

If risk is ambiguous, stop and ask.

## Readiness and troubleshooting

Start with:

```bash
node scripts/browser-control.js status --json
node scripts/browser-control.js doctor --json
node scripts/browser-control.js logs -n 100
```

If `extension_connected` is false, browser automation is blocked except for diagnostics; ask the user to load or reload the bundled Chrome extension from this skill's `extension/` directory when you cannot safely do it. If commands fail with `Element not found`, take a fresh `snapshot` and rebuild the locator. Validation errors include stable `error.details`; for example `fill` requires `args.value` (not `args.text`).

If `extension_connected` is false after `doctor --json`, guide the user to load the Chrome extension with `references/chrome-extension-setup.md`; it covers both the installed skill's `extension/` directory and the release extension zip.

Load `references/decision-guide.md` for readiness/failure decisions and `references/troubleshooting.md` for detailed recovery steps and known limitations.
