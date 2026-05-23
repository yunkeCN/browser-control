# Browser Control troubleshooting

## First checks

```bash
node skills/browser-control/scripts/browser-control.js status --json
node skills/browser-control/scripts/browser-control.js doctor --json
bash skills/browser-control/scripts/health-check.sh
```

Confirm all three layers:

1. The daemon is reachable on `127.0.0.1`.
2. Chrome is installed and running.
3. The Browser Control extension is loaded and connected.

`doctor --json` also includes layered runtime diagnostics:

- CLI expected protocol/runtime schema and capabilities.
- Daemon version, runtime schema, and daemon-owned capabilities such as `actionObservation`.
- Extension version/build/channel and browser-side capabilities when the connected extension sends hello metadata.

If health/status lacks runtime fields, the CLI reports that the daemon may be old; run `browser-control restart`. If the extension is connected but has no runtime metadata, reload the unpacked extension. Ordinary legacy commands remain allowed unless a command requests a definitely unsupported feature such as action observation without extension observation primitives.

## Daemon is not reachable

Run:

```bash
node skills/browser-control/scripts/browser-control.js start --json
node skills/browser-control/scripts/browser-control.js logs -n 100
```

If startup reports that another service owns the port, either stop that service or set a free `BROWSER_CONTROL_PORT` for both daemon and extension configuration.

If a stale PID is reported, rerun `start`; the CLI cleans stale Browser Control PID state before spawning a new daemon.

## Extension is not connected

1. Open `chrome://extensions`.
2. Enable Developer mode.
3. Load the unpacked extension path printed by `doctor --json`.
4. Reload the extension if it was already loaded.
5. Re-run `doctor --json` and confirm `extension_connected` is true.

For the release package option, see `references/chrome-extension-setup.md`.

The editable extension source path is `<repo>/src/extension`; the Chrome Load unpacked path is the self-contained `<skill>/extension` directory, generated at `<repo>/skills/browser-control/extension` during repository development. Run `npm run build` before reloading after source edits.

## Source reload matrix

| Symptom or edit | Action |
| --- | --- |
| `doctor --json` says daemon shape may be old | Run `node skills/browser-control/scripts/browser-control.js restart`. |
| Chrome loads `<skill>/extension` and `src/extension` service-worker or manifest source changed | Run `npm run build`, then reload the extension in `chrome://extensions`. |
| `src/extension` content script source changed | Run `npm run build`, reload the extension, and refresh target pages so the content script reinjects. |
| `expectChange`/`observe` says observation primitives are unsupported | Reload the extension from the source path, then rerun `doctor --json`. |

## Command times out

- Check whether the page is still loading.
- Increase `timeoutMs` for legitimately slow operations.
- Use `snapshot` to verify the target tab and visible page state.
- Check `logs -n 100` for backend errors.

## Element not found

- Take a fresh `snapshot`; `@e` references are only valid for the snapshot's current page state.
- Prefer `@e` references returned by the latest snapshot.
- Fall back to stable CSS selectors such as `[data-testid="..."]` when available.
- Avoid retrying the exact same stale selector without verifying the DOM changed.

## Screenshot or PDF output is too large

Use helper scripts instead of embedding base64 in the conversation:

```bash
bash skills/browser-control/scripts/health-check.sh
bash skills/browser-control/scripts/screenshot.sh -s demo -p
```

Artifacts are written under `~/.browser-control/artifacts` unless `BROWSER_CONTROL_ARTIFACT_DIR` is set.

## Network capture is missing requests

- Capture is scoped to the active session tab.
- `navigate` starts API-focused capture before load.
- Resource requests are intentionally excluded. Network capture is API-focused on XHR/fetch traffic; inspect page resource loads separately with browser tooling or `performance.getEntriesByType('resource')` when needed.
- Service-worker restarts can affect timing; restart capture and repeat the action when in doubt.

## Known limitations

- Synthetic DOM events have `isTrusted: false`; sites that require trusted user gestures may reject clicks or fills.
- Cross-origin iframes are not controlled from the main frame; navigate directly to the iframe URL when practical.
- File uploads are constrained by Chrome extension and browser security rules.
- Custom dropdowns are not native selects; interact with them through click sequences, fresh snapshots, and `scroll` when the option list is below the fold.
- Screenshots are viewport-only in the current extension backend. The `fullPage` argument is accepted for protocol compatibility and reports that full-page capture is not currently supported.
