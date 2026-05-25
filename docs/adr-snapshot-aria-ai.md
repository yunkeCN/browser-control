# ADR: Playwright-Style ARIA Snapshot For AI Agents

Status: Accepted.

## Context

The previous `snapshot` command returned a flat compact-DOM element list. It was useful for simple target lookup, but it duplicated layout text, lost parent/child structure, and encouraged agents to scan many records instead of reading a page-shaped representation.

Playwright MCP's current approach is different:

- Build an accessibility/ARIA tree, not a DOM dump.
- Use AI mode semantics: include ARIA-visible or visually visible nodes, include useful generic containers, and assign refs only to visible pointer-receiving elements.
- Normalize adjacent text into concise text runs.
- Collapse generic wrappers that add no structure.
- Render a YAML-like tree where roles, accessible names, states, refs, pointer cursor hints, and optional boxes are visible at a glance.
- Keep structured refs for tool actions, and refresh refs when the page changes.

## Decision

`snapshot` now returns `schemaVersion: 3` with `semantics: "playwright-aria-ai-v1"`.

The response has three primary views of the same page state:

- `snapshot`: compact YAML-like ARIA text for model reasoning.
- `tree`: structured JSON ARIA tree for programmatic clients.
- `refs`: actionable reference index for `click`, `fill`, `press`, upload, selection, and wait workflows.

The implementation keeps Browser Control's strict structural `@e<structureId>_<revision>` refs instead of Playwright's short `eN` refs. This preserves stale-reference protection while adopting Playwright's ARIA tree, text normalization, generic-wrapper collapse, pointer-event gating, state rendering, and optional bounding-box rendering.

## Consequences

- Old consumers that read `data.elements` must switch to `data.refs` and/or `data.tree`.
- Filters now preserve ancestors around matching nodes so the agent can understand context.
- The public command intentionally avoids caller-managed size knobs such as `depth`, `maxDepth`, and `maxElements`. Large pages should be narrowed with semantic filters (`textIncludes`, `roles`, `tags`, `hasVisibleText`, and `viewportOnly`) or delivered through the snapshot artifact fallback.
- Long prose remains the job of `get_text`; snapshot is for page structure and interaction targets.
- Same-origin iframes are traversed where possible. Cross-origin or inaccessible iframes remain represented as iframe nodes without child content.
