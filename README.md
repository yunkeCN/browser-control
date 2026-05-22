# Browser Control

Browser Control is a local Chrome automation bridge for AI agents. It gives an agent a controlled way to operate the user's real Chrome browser through a localhost daemon and a Chrome Manifest V3 extension.

```text
AI Agent -> Browser Control skill scripts -> localhost HTTP daemon -> WebSocket -> Chrome extension -> Chrome DOM
```

The published Skill lives in `skills/browser-control/`. That directory is self-contained: it includes the agent-facing `SKILL.md`, command-line scripts, reference docs, a loadable Chrome extension build, and the vendored WebSocket runtime needed by the daemon.

## What It Can Do

- Navigate, inspect, and operate real Chrome tabs.
- Read DOM snapshots and visible page text.
- Click, fill, press keys, select options, and toggle controls.
- Capture screenshots, PDFs, downloads, and other local artifacts.
- Inspect network requests from the active browser session.
- Reuse logged-in Chrome sessions while keeping all traffic on localhost.

## Install As A Skill

After this repository is published on GitHub, install it with the skills CLI:

```bash
npx skills add <owner>/<repo> --skill browser-control
```

For local development, install from this checkout:

```bash
npx skills add . --skill browser-control
```

## Release Downloads

Tagged GitHub releases publish two archives:

- `browser-control-skill-<tag>.zip`: the complete `browser-control/` Skill directory, including `SKILL.md`, `scripts/`, `references/`, `extension/`, and vendored `ws`.
- `browser-control-extension-<tag>.zip`: only the Chrome `extension/` directory, for users who just want to load the browser extension.

Download release packages from <https://github.com/yunkeCN/browser-control/releases>.

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

Supported browser commands include `navigate`, `find_tab`, `attach_tab`, `snapshot`, `get_text`, `click`, `fill`, `press`, `select_option`, `set_checked`, `wait_for`, `evaluate`, `screenshot`, `save_as_pdf`, `observe_start`, `observe_diff`, `network_start`, `network_list`, `network_detail`, `network_stop`, `upload`, `download`, `list_tabs`, `close_tab`, and `close_session`.

See `skills/browser-control/references/api.md` for the full CLI and API reference.

## Safety Model

Browser Control is intentionally localhost-only by default. The daemon listens on `127.0.0.1`, the extension connects to the local daemon WebSocket, and artifacts are written to the user's local machine.

The Chrome extension requests broad permissions, including access to pages, downloads, screenshots, and debugger-backed browser operations. That is necessary for browser automation, but agents should still ask before risky actions such as submitting forms, changing account settings, uploading local files, handling credentials, or performing destructive operations. The Skill instructions define those confirmation boundaries in `skills/browser-control/SKILL.md`.

Snapshot and observation commands redact likely sensitive field values such as password, token, cookie, session, and API-key-like fields.

## Repository Layout

```text
browser-control/
├── src/extension/             # Editable Chrome MV3 extension TypeScript source
├── skills/browser-control/    # Self-contained published Skill package
├── .github/workflows/         # Tag-triggered release packaging
├── tests/                     # Unit, integration, and fixture e2e tests
├── docs/                      # Maintainer docs and architectural notes
├── contracts.ts               # Protocol contract for maintainers and tests
└── package.json               # Development scripts and dependencies
```

Generated extension output is committed under `skills/browser-control/extension/` so users can load the extension after installing the Skill without running a build first.

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
- Testing and release checks: `docs/testing.md`
