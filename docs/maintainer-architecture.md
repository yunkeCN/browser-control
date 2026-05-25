# Maintainer Architecture

Browser Control is split into source code for maintainers and a self-contained Skill package for users.

## Runtime Path

```text
agent command envelope
  -> skills/browser-control/scripts/browser-control.js
  -> skills/browser-control/scripts/daemon.js
  -> localhost WebSocket
  -> skills/browser-control/extension/service-worker.js
  -> Chrome DOM
```

The daemon listens on localhost and owns command validation, sessions, artifacts, logs, and response shaping. The Chrome extension owns tab operations, DOM interactions, screenshots, downloads, and network capture.

MCP clients use the root MCP runtime instead of the Skill CLI:

```text
MCP client
  -> bin/browser-control-mcp.mjs
  -> localhost HTTP daemon
  -> WebSocket
  -> skills/browser-control/extension/service-worker.js
  -> Chrome DOM
```

The MCP server is independent from the Skill package. It reuses the same protocol source and daemon module, but its code, prompts, docs, and generated runtime live outside `skills/browser-control/`.

## Maintainer Source

| Path | Purpose |
| --- | --- |
| `src/protocol.ts` | Editable Browser Control protocol contract and validation source. |
| `src/daemon/` | Editable daemon server and process-management source. |
| `src/extension/` | Editable Chrome Manifest V3 extension TypeScript source. |
| `src/mcp/` | Editable MCP server source, tool schemas, prompts, daemon lifecycle, and session manager. |
| `contracts.ts` | Protocol contract used by maintainers and tests. |
| `scripts/build-extension.mjs` | Builds the loadable extension into the Skill package. |
| `scripts/build-protocol.mjs` | Bundles the protocol runtime into the Skill package. |
| `scripts/build-daemon.mjs` | Bundles the daemon runtime into the Skill package. |
| `scripts/build-mcp.mjs` | Bundles the MCP runtime into `bin/browser-control-mcp.mjs`. |
| `scripts/check-extension-build-drift.mjs` | Verifies generated extension output is in sync. |
| `.github/workflows/release.yml` | Builds release assets on tag pushes. |
| `tests/` | Protocol, daemon, package entrypoint, artifact, extension, and e2e regression tests. |
| `docs/` | Maintainer notes, ADRs, and release/testing guidance. |

## Published Skill Package

| Path | Purpose |
| --- | --- |
| `skills/browser-control/SKILL.md` | Agent-facing instructions and safety boundaries. |
| `skills/browser-control/references/` | Progressive-disclosure API docs, recipes, setup, and troubleshooting. |
| `skills/browser-control/scripts/` | CLI, generated daemon/protocol runtime, diagnostics, screenshot helper, support helpers, and session cleanup. |
| `skills/browser-control/extension/` | Generated Chrome extension directory for Load unpacked. |

The Skill package is intentionally self-contained so a user can install only `skills/browser-control/`, start the daemon, and load the bundled extension without running `npm install` or building TypeScript.

Tag-triggered GitHub releases publish two zip files: a complete `browser-control/` Skill archive and a separate `extension/` archive for Chrome-only installation.

## Build Boundary

Maintain extension behavior in `src/extension/**`, daemon behavior in `src/daemon/**`, and protocol validation in `src/protocol.ts`. Run `npm run build` after source changes to regenerate `skills/browser-control/extension/**`, `skills/browser-control/scripts/protocol.js`, `skills/browser-control/scripts/daemon.js`, and the MCP runtime.

Do not hand-edit generated extension output unless the change is part of debugging and is immediately carried back to `src/extension/**`.

`skills/browser-control/scripts/protocol.js` and `skills/browser-control/scripts/daemon.js` are generated output. The protocol and daemon sources of truth live in `src/protocol.ts` and `src/daemon/**`; the generated daemon bundle includes its WebSocket runtime and replaces the older vendored `scripts/vendor/ws` directory.

## Documentation Boundary

User-facing runtime docs live in the Skill package:

- `skills/browser-control/SKILL.md`
- `skills/browser-control/references/api.md`
- `skills/browser-control/references/recipes.md`
- `skills/browser-control/references/troubleshooting.md`
- `skills/browser-control/references/chrome-extension-setup.md`

Maintainer-only material belongs under `docs/`. Keep public docs free of private URLs, credentials, local absolute paths, and organization-specific CI details before publishing.
