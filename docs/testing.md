# Testing And Release Checks

Run these checks before publishing a new version or changing the bundled Skill:

```bash
npm run build
npm run typecheck
npm run lint
npm test
npm run e2e:fixture
```

These checks cover protocol validation, artifact extraction, daemon HTTP behavior, singleton daemon startup, package entrypoints, extension transport, recoverable error mapping, and generated extension drift.

## Build Output

`npm run build` compiles the editable extension source from `src/extension/` into the committed loadable extension at `skills/browser-control/extension/`.

The generated extension output is part of the published Skill package. Keep it in sync with the TypeScript source before releasing.

## Fixture E2E

`npm run e2e:fixture` starts a simulated extension WebSocket client. It validates daemon command envelopes, artifact stripping, extension transport, and command/response behavior without requiring Chrome.

Use this when changing:

- daemon or CLI code under `skills/browser-control/scripts/`
- command protocol shape
- artifact persistence or response stripping
- extension transport contracts

## Live E2E

Live E2E requires Chrome with the generated extension loaded.

1. Run `npm run build`.
2. Open `chrome://extensions`.
3. Enable Developer mode.
4. Load unpacked from `<repo>/skills/browser-control/extension`.
5. Confirm readiness:

   ```bash
   node skills/browser-control/scripts/browser-control.js doctor --json
   ```

6. Run:

   ```bash
   npm run e2e:live
   ```

The live script starts a local fixture server and covers navigation, snapshot, fill, select, checkbox, keypress, wait, click, evaluate, screenshot artifacts, PDF artifacts when debugger permission is available, network list/detail, direct downloads, multi-tab session metadata, and session cleanup.

If the extension is not loaded, `tests/e2e-test.js` exits with code `2` and prints recovery steps. Treat that state as an environment blocker, not a product assertion failure.

## Reload Matrix

| Change | Required action |
| --- | --- |
| `skills/browser-control/scripts/` daemon or CLI code | Run `browser-control restart` or `node skills/browser-control/scripts/browser-control.js restart`. |
| `src/extension` service worker or `manifest.json` source | Run `npm run build`, then reload the unpacked extension in `chrome://extensions`. |
| `src/extension` content script source | Run `npm run build`, reload the unpacked extension, then refresh already-open target pages. |
| Docs or tests only | No daemon restart or extension reload required. |

`doctor --json` reports the expected extension path and, when Chrome profile data is readable, the currently loaded unpacked extension path.

## Publish Checklist

- `npm run build` leaves no extension build drift.
- `npm run typecheck`, `npm run lint`, and `npm test` pass.
- `npm run e2e:fixture` passes.
- Live E2E passes when changing extension behavior.
- `npx skills add . --list` finds exactly one Skill: `browser-control`.
- `skills/browser-control/SKILL.md` remains the only `SKILL.md` in the repository.
- Tag-triggered releases use `.github/workflows/release.yml` and publish both `browser-control-skill-<tag>.zip` and `browser-control-extension-<tag>.zip`.
- Public docs do not include private URLs, credentials, local absolute paths, or organization-specific CI instructions.
