<!-- Parent: ../AGENTS.md -->
<!-- Updated: 2026-05-22 -->

# tests

## Purpose

Regression tests for the Browser Control two-module architecture. The suite covers protocol validation, action behavior, observation, artifact stripping, daemon HTTP behavior, singleton/idempotent startup, package entrypoints, generated extension output, skill docs, and mocked extension WebSocket fixture e2e.

## Key files

| File | Purpose |
|------|---------|
| `protocol.test.js` | Runtime command validation and envelope behavior. |
| `artifact-store.test.js` | Artifact extraction and base64 stripping. |
| `action-click.test.js` | Click strategy, target diagnostics, and click fallback behavior. |
| `action-fill-press.test.js` | Fill and keypress strategy diagnostics and sensitive value redaction. |
| `action-wait-for.test.js` | `wait_for` selector/text readiness behavior. |
| `action-cdp.test.js` | Chrome debugger/CDP action strategy and ownership behavior. |
| `action-observation-e2e.test.js` | `expectChange` / `observe` action-coupled observation behavior. |
| `daemon-http.test.js` | Daemon health and backend-unavailable behavior without a real extension. |
| `daemon-singleton.test.js`, `singleton-start.test.js` | Idempotent singleton daemon startup. |
| `fixture-e2e.test.js` | Mock extension WebSocket end-to-end command dispatch. |
| `observation-e2e.test.js` | Explicit `observe_start` / `observe_diff` lifecycle behavior. |
| `observation-adr.test.js` | Observation ADR and API reference alignment. |
| `cli.test.js` | CLI parsing, doctor diagnostics, and command envelope behavior. |
| `extension-build.test.js` | Generated extension output, manifest, and runtime bundle behavior. |
| `package-scripts.test.js` | Root package scripts and bin entrypoints. |
| `skill-docs.test.js` | Skill instructions and reference docs coverage. |
| `e2e-test.sh` | Live Chrome extension smoke test. |

## Test commands

```bash
npm run typecheck
npm run lint
npm test
npm run e2e:fixture
```

Live browser testing requires Chrome with the extension loaded from `skills/browser-control/extension/`, then:

```bash
npm run e2e:live
```

If live e2e exits because the extension is not connected, treat it as an environment blocker and run `node skills/browser-control/scripts/browser-control.js doctor --json`.
