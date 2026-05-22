# Maintainer Architecture

Browser Control is split into source code for maintainers and a self-contained Skill package for users.

## Runtime Path

```text
agent command envelope
  -> skills/browser-control/scripts/browser-control.js
  -> skills/browser-control/scripts/daemon.js
  -> localhost WebSocket
  -> skills/browser-control/extension/service-worker.js
  -> skills/browser-control/extension/content.js
  -> Chrome DOM
```

The daemon listens on localhost and owns command validation, sessions, artifacts, logs, and response shaping. The Chrome extension owns tab operations, DOM interactions, screenshots, downloads, and network capture.

## Maintainer Source

| Path | Purpose |
| --- | --- |
| `src/extension/` | Editable Chrome Manifest V3 extension TypeScript source. |
| `contracts.ts` | Protocol contract used by maintainers and tests. |
| `scripts/build-extension.mjs` | Builds the loadable extension into the Skill package. |
| `scripts/check-extension-build-drift.mjs` | Verifies generated extension output is in sync. |
| `.github/workflows/release.yml` | Builds release assets on tag pushes. |
| `tests/` | Protocol, daemon, package entrypoint, artifact, extension, and e2e regression tests. |
| `docs/` | Maintainer notes, ADRs, and release/testing guidance. |

## Published Skill Package

| Path | Purpose |
| --- | --- |
| `skills/browser-control/SKILL.md` | Agent-facing instructions and safety boundaries. |
| `skills/browser-control/references/` | Progressive-disclosure API docs, recipes, setup, and troubleshooting. |
| `skills/browser-control/scripts/` | CLI, daemon, protocol helpers, diagnostics, artifact helpers, and session cleanup. |
| `skills/browser-control/scripts/vendor/ws/` | Vendored WebSocket runtime used when installed without repository dependencies. |
| `skills/browser-control/extension/` | Generated Chrome extension directory for Load unpacked. |

The Skill package is intentionally self-contained so a user can install only `skills/browser-control/`, start the daemon, and load the bundled extension without running `npm install` or building TypeScript.

Tag-triggered GitHub releases publish two zip files: a complete `browser-control/` Skill archive and a separate `extension/` archive for Chrome-only installation.

## Build Boundary

Maintain extension behavior in `src/extension/**`. Run `npm run build` after source changes to regenerate `skills/browser-control/extension/**`.

Do not hand-edit generated extension output unless the change is part of debugging and is immediately carried back to `src/extension/**`.

Daemon and CLI code currently live directly inside the published Skill package under `skills/browser-control/scripts/**` because agents need those scripts at runtime.

## Documentation Boundary

User-facing runtime docs live in the Skill package:

- `skills/browser-control/SKILL.md`
- `skills/browser-control/references/api.md`
- `skills/browser-control/references/recipes.md`
- `skills/browser-control/references/troubleshooting.md`
- `skills/browser-control/references/chrome-extension-setup.md`

Maintainer-only material belongs under `docs/`. Keep public docs free of private URLs, credentials, local absolute paths, and organization-specific CI details before publishing.
