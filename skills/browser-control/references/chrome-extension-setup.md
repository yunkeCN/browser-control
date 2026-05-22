# Chrome extension setup

Browser Control uses a Chrome Manifest V3 extension as the browser-side module.

## Installed skill load

The skill is self-contained: the Chrome Load unpacked directory is bundled at `<skill>/extension` alongside `SKILL.md` and the daemon scripts.

1. Start the daemon with `node scripts/browser-control.js start` from this skill directory, or use `browser-control start` when it is on `PATH`.
2. Run `node scripts/browser-control.js doctor --json`.
3. Open `chrome://extensions`.
4. Enable Developer mode.
5. Click **Load unpacked**.
6. Select the `extension` directory reported by `doctor --json`, or the `extension` directory inside this installed skill.
7. Confirm connection with `node scripts/browser-control.js doctor --json`.

`doctor --json` reports the self-contained extension path and, when Chrome profile data is readable, the currently loaded unpacked extension path. It also reports extension runtime metadata after the extension connects to the daemon. Missing runtime metadata is a warning for stale/legacy extensions, not a global command blocker.

## Release package load

Use the installed skill's `extension/` directory, or use the GitHub release package:

1. Open <https://github.com/yunkeCN/browser-control/releases>.
2. Download `browser-control-extension-<tag>.zip`.
3. Unzip the archive.
4. In `chrome://extensions`, choose **Load unpacked** and select the extracted `extension/` directory.
5. Run `node scripts/browser-control.js doctor --json` and confirm `extension_connected` is true.

## Repository development load

When working from the source repository, run `npm run build` to regenerate `skills/browser-control/extension` from `src/extension`.

## Reload matrix

| Change made | Required action |
| --- | --- |
| Daemon or CLI code under `skills/browser-control/scripts/` | Run `browser-control restart`; extension reload usually not required. |
| Extension source under `src/extension` affecting service worker or `manifest.json` | Run `npm run build`, then click **Reload** for the unpacked extension in `chrome://extensions`. |
| Extension source under `src/extension` affecting `content.js` | Run `npm run build`, reload the extension, then refresh already-open target pages. |
| Docs/tests only | No browser reload required. |

The extension reports source-channel runtime metadata and does not include local private source paths.

## Connection defaults

- Daemon HTTP: `http://127.0.0.1:10087`
- Extension WebSocket: `ws://127.0.0.1:10087/ws`

If you change `BROWSER_CONTROL_PORT`, make sure the extension is configured to connect to the same port.

## Live smoke test

After loading the extension:

```bash
npm run build
node skills/browser-control/scripts/browser-control.js start
node skills/browser-control/scripts/browser-control.js doctor --json
npm run e2e:live
```

If the live test reports that the extension is missing, reload the unpacked extension path reported by `doctor --json` (when available) and retry the doctor check before rerunning tests.
