<!-- Parent: ../../AGENTS.md -->
<!-- Updated: 2026-05-20 -->

# src/extension

## Purpose

Editable TypeScript source for the Browser Control Chrome MV3 extension. Build output is generated into `skills/browser-control/extension/` for Chrome Load unpacked.

## Rules for agents

- Edit `src/extension/**`, not generated runtime files under `skills/browser-control/extension/**`.
- Run `npm run build:extension` after source edits to regenerate `skills/browser-control/extension/`.
- Preserve behavior during the JS-to-TS migration; do not combine semantic cleanup or deduplication with mechanical module moves.
- Keep functions passed to `chrome.scripting.executeScript({ func })` self-contained because Chrome serializes them into the page context.
- Keep generated runtime entrypoints classic-script compatible: no top-level runtime imports/exports and no dynamic `import()`.

## Verification

```bash
npm run build
npm run typecheck
npm run lint
npm test
npm run e2e:fixture
```
