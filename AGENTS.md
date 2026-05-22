<!-- Updated: 2026-05-22 -->

# browser-control

## Purpose

Browser Control is a local Chrome automation bridge for AI agents. Agents talk to a localhost daemon packaged inside the Browser Control skill; the daemon talks to a Chrome Manifest V3 extension over WebSocket; the extension operates the user's real Chrome DOM, tabs, downloads, screenshots, and network capture.

```text
AI Agent → skills/browser-control/scripts/browser-control.js → localhost HTTP daemon → WebSocket → skills/browser-control/extension/ → Chrome DOM
```

## Core source modules

| Path | Purpose |
|------|---------|
| `src/extension/` | Editable Chrome MV3 extension TypeScript source. |
| `skills/browser-control/` | Self-contained Agent-facing skill package: `SKILL.md`, references, daemon/runtime scripts, vendored runtime dependency, generated Chrome extension, diagnostics, artifact helpers, session utilities. |

Repository support paths:

| Path | Purpose |
|------|---------|
| `.github/workflows/release.yml` | Builds the extension on tag pushes and publishes Skill and extension zip release assets. |
| `tests/` | Unit, integration, fixture e2e, singleton daemon, and package entrypoint tests. |
| `docs/` | Maintainer/testing documentation only. Runtime/operator docs live in the skill references. |
| `contracts.ts` | TypeScript protocol contract used by maintainers/tests. |

## For AI agents

- Before browser operations, verify readiness with `node skills/browser-control/scripts/browser-control.js doctor --json` or `bash skills/browser-control/scripts/health-check.sh`.
- Use `skills/browser-control/scripts/screenshot.sh` for screenshots; do not paste raw screenshot/PDF base64 into context.
- Take a `snapshot` before `@e` interactions; prefer `@e` references over ad-hoc CSS selectors.
- Use separate sessions for independent tasks and call `close_session` when done.
- All communication is localhost-only by design; confirm before submitting sensitive, destructive, purchase, or account-affecting actions.

## Development commands

```bash
npm run typecheck
npm run lint
npm test
node skills/browser-control/scripts/browser-control.js start --json
node skills/browser-control/scripts/browser-control.js doctor --json
```

Load the Chrome extension from `skills/browser-control/extension/`.

## Documentation map

- Project overview: `README.md`
- Canonical skill: `skills/browser-control/SKILL.md`
- API/CLI reference: `skills/browser-control/references/api.md`
- Troubleshooting: `skills/browser-control/references/troubleshooting.md`
- Chrome extension setup: `skills/browser-control/references/chrome-extension-setup.md`
- Architecture notes: `docs/maintainer-architecture.md`
- Test/release checks: `docs/testing.md`
