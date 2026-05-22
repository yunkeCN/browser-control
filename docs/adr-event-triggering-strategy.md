# ADR: Event Triggering Strategy for Browser Actions

Date: 2026-05-20
Status: accepted

## Context

Browser Control exposes `click`, `fill`, and `press` commands through the localhost daemon and Chrome extension. Existing commands are intentionally small and backward compatible, but the default click implementation mixed synthetic pointer or mouse events with `HTMLElement.click()`. That can double-trigger toggles, hide overlay problems, and make it hard for agents to explain why a UI action produced no visible change.

Synthetic DOM events remain useful, especially when the Chrome debugger is unavailable, but they are not equivalent to real user input because `isTrusted` is `false`. Agents also need structured diagnostics for target geometry, hit testing, focus movement, warnings, and optional observation deltas.

## Decision

Introduce a strategy-aware action layer for state-changing commands:

- `click.strategy`: `auto`, `cdp_mouse`, `dom_pointer`, or `element_click`.
- `fill.strategy`: `native_setter`, `text_input`, or `paste_like`.
- `press.strategy`: `auto`, `cdp_keyboard`, or `dom_keyboard`.

The existing command shapes remain valid. `click({ selector })`, `fill({ selector, value })`, and `press({ key })` continue to validate. Strategy and diagnostics fields are additive.

Default `click` uses `auto`: prefer CDP mouse input when debugger ownership is safe, otherwise use `dom_pointer`. The DOM pointer path dispatches one coherent pointer/mouse sequence and must not call `el.click()` after a successful sequence. Direct `el.click()` is available only through the explicit `element_click` strategy and must report synthetic/untrusted limitations.

Covered elements fail by default with recoverable diagnostics. `force: true` may bypass the hit-test guard, but only when the agent has confirmed the overlay is intentional.

## Consequences

- Action results should include `strategyUsed`, `target`, `hitTest`, `focusBefore`, `focusAfter`, `warnings`, and optional `actionObservation`.
- CDP strategies must respect debugger ownership used by network and PDF features. Explicit CDP failures should be recoverable and visible; silent fallback is reserved for `auto`.
- Documentation must teach agents to inspect warnings and no-delta outcomes before retrying.
- Tests must prove the default DOM click no longer double-triggers, covered targets are diagnosable, and existing requests remain valid.

## Alternatives considered

- DOM-only patch: smaller, but still weaker against frameworks that ignore synthetic events.
- Default direct `el.click()`: easy, but bypasses pointer/mouse semantics and overlay safety.
- Framework-specific commands first: useful later, but brittle before the core action layer is reliable.
- Full Playwright-style reimplementation: out of scope for Browser Control's daemon and extension architecture.
