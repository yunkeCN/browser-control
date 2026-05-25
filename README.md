# Browser Control

[![skills.sh](https://skills.sh/b/yunkeCN/browser-control)](https://skills.sh/yunkeCN/browser-control)

[中文说明](README.zh-CN.md)

Browser Control lets AI agents operate the user's real Chrome browser locally.

It runs a localhost daemon that talks to a Chrome Manifest V3 extension over WebSocket. Through that bridge, agents can navigate pages, inspect the DOM, click, fill forms, capture screenshots and downloads, and inspect network requests while keeping browser automation traffic on the local machine.

```text
AI Agent -> Browser Control skill scripts -> localhost HTTP daemon -> WebSocket -> Chrome extension -> Chrome DOM
```

The published Skill lives in `skills/browser-control/`. That directory is self-contained: it includes the agent-facing `SKILL.md`, command-line scripts, reference docs, a loadable Chrome extension build, and a generated daemon bundle that carries its WebSocket runtime.

## What It Can Do

- Navigate, inspect, and operate real Chrome tabs.
- Read DOM snapshots and visible page text.
- Click, fill, press keys, select options, and toggle controls.
- Capture screenshots, PDFs, downloads, and other local artifacts.
- Inspect network requests from the active browser session.
- Reuse logged-in Chrome sessions while keeping all traffic on localhost.

## Requirements

- Chrome or a Chromium-based browser.
- Node.js 18 or newer.
- Permission to load an unpacked Chrome extension.

## Install As A Skill

Install it with the skills CLI:

```bash
npx skills add yunkeCN/browser-control --skill browser-control
```

This is also how skills.sh discovers and ranks community skills: installs through the `skills` CLI are counted anonymously unless users opt out of telemetry.

For local development, install from this checkout:

```bash
npx skills add . --skill browser-control
```

## Chrome Extension Setup

Browser Control needs the bundled extension loaded in Chrome.

1. Start the daemon from the installed skill directory:

   ```bash
   node scripts/browser-control.js start --json
   node scripts/browser-control.js doctor --json
   ```

2. Open `chrome://extensions`.
3. Enable **Developer mode**.
4. Click **Load unpacked**.
5. Select the `extension/` directory inside the installed `browser-control` skill.
6. Run `node scripts/browser-control.js doctor --json` again and confirm `extension_connected` is true.

If the installed Skill `extension/` directory is not convenient to select, download `browser-control-extension-<tag>.zip` from <https://github.com/yunkeCN/browser-control/releases>, unzip it, and load the extracted `extension/` directory instead.

When working from this source repository, the loadable extension is generated at `skills/browser-control/extension/`.

## Quick CLI Use

Run commands from `skills/browser-control/` unless `browser-control` is already on `PATH`:

```bash
node scripts/browser-control.js status --json
node scripts/browser-control.js doctor --json
node scripts/health-check.js --json
node scripts/browser-control.js command snapshot --session demo --args '{}'
node scripts/browser-control.js command get_text --session demo --args '{"scope":"viewport","maxChars":4000}'
```

Default local endpoints:

- Daemon HTTP: `http://127.0.0.1:10087`
- Extension WebSocket: `ws://127.0.0.1:10087/ws`
- Artifact directory: `~/.browser-control/artifacts`

Environment overrides:

- `BROWSER_CONTROL_HOST`
- `BROWSER_CONTROL_PORT`
- `BROWSER_CONTROL_ARTIFACT_DIR`
- `BROWSER_CONTROL_EXTENSION_DIR`

## Command API

Commands are sent to `POST /command` as typed envelopes:

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

Supported browser commands include `navigate`, `find_tab`, `snapshot`, `get_text`, `scroll`, `click`, `click_probe`, `fill`, `press`, `wait_for`, `evaluate`, `screenshot`, `save_as_pdf`, `observe_start`, `observe_diff`, `network_start`, `network_list`, `network_detail`, `network_stop`, `upload`, `download`, `list_tabs`, `close_tab`, and `close_session`.

See `skills/browser-control/references/api.md` for the full CLI and API reference.

## Safety Model

Browser Control is intentionally localhost-only by default. The daemon listens on `127.0.0.1`, the extension connects to the local daemon WebSocket, and artifacts are written to the user's local machine.

Because Browser Control automates a real browser, the Chrome extension requests permissions to access pages, manage downloads, capture screenshots, and use debugger-backed browser operations. Agents should still ask before risky actions such as submitting forms, changing account settings, uploading local files, handling credentials, making purchases, or performing destructive operations. The Skill instructions define those confirmation boundaries in `skills/browser-control/SKILL.md`.

Snapshot and observation commands redact likely sensitive field values such as password, token, cookie, session, and API-key-like fields.

## Release Downloads

Tagged GitHub releases publish two archives:

- `browser-control-skill-<tag>.zip`: the complete `browser-control/` Skill directory, including `SKILL.md`, `scripts/`, `references/`, `extension/`, the bundled daemon runtime, and `scripts/browser-control-mcp.mjs`.
- `browser-control-extension-<tag>.zip`: only the Chrome `extension/` directory, for users who just want to load the browser extension.

Download release packages from <https://github.com/yunkeCN/browser-control/releases>.

## Repository Layout

```text
browser-control/
├── src/protocol.ts            # Editable protocol contract and validation source
├── src/daemon/                # Editable daemon server and process-management source
├── src/extension/             # Editable Chrome MV3 extension TypeScript source
├── src/mcp/                   # Editable MCP server source
├── bin/                       # Generated MCP single-file runtime
├── skills/browser-control/    # Self-contained published Skill package
├── .github/workflows/         # Tag-triggered release packaging
├── tests/                     # Unit, integration, and fixture e2e tests
├── docs/                      # Maintainer docs and architectural notes
├── contracts.ts               # Protocol contract for maintainers and tests
└── package.json               # Development scripts and dependencies
```

Generated Skill output is committed under `skills/browser-control/`: the loadable extension lives in `extension/`, and generated protocol/daemon/MCP runtime files live in `scripts/`. A root copy of the MCP runtime is also generated at `bin/browser-control-mcp.mjs`.

## Development

```bash
npm install
npm run build
npm run typecheck
npm run lint
npm test
npm run e2e:fixture
```

Live browser smoke testing needs Chrome with the generated extension loaded:

```bash
npm run e2e:live
```

See `docs/testing.md` for the full validation workflow and reload matrix.

## Documentation

- Skill instructions: `skills/browser-control/SKILL.md`
- API reference: `skills/browser-control/references/api.md`
- Recipes: `skills/browser-control/references/recipes.md`
- Troubleshooting: `skills/browser-control/references/troubleshooting.md`
- Chrome extension setup: `skills/browser-control/references/chrome-extension-setup.md`
- Maintainer architecture: `docs/maintainer-architecture.md`
- MCP server: `docs/mcp.md`
- Testing and release checks: `docs/testing.md`
