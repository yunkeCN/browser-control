import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { COMMANDS } from './protocol.js';

function textPrompt(description: string, text: string) {
  return {
    description,
    messages: [{
      role: 'user' as const,
      content: { type: 'text' as const, text }
    }]
  };
}

export function registerBrowserControlPrompts(server: McpServer): void {
  server.registerPrompt('browser_control_usage', {
    title: 'Browser Control MCP usage',
    description: 'Recommended execution loop for Browser Control MCP tools.'
  }, () => textPrompt('Browser Control MCP usage', [
    'Each browser action is a separate tool: browser_navigate, browser_snapshot, browser_click, browser_fill, etc.',
    'The MCP server manages an active session automatically; omit session unless you intentionally need a separate session.',
    '',
    '## Tool selection',
    '',
    '- Need element refs for interaction → browser_snapshot',
    '- Need readable page text → browser_get_text (scope: "viewport" for visible, "full" for all rendered, "document" for raw innerText)',
    '- Need to run custom JS in page → browser_evaluate',
    '- Need to detect DOM structure changes → browser_snapshot with diff_to',
    '- Need to inspect API traffic → browser_network or browser_click with probe',
    '',
    '## Typical loop',
    '',
    'browser_navigate → browser_snapshot → browser_click/browser_fill/browser_press (use @e refs) → browser_snapshot again for fresh refs → browser_close_session when done.',
    '',
    '## Detecting page changes',
    '',
    '- DOM structure changes (new elements, dialogs, removed items): browser_snapshot with diff_to=<baselineId>.',
    '- API calls triggered by a click: browser_click with probe parameter (e.g. probe: { filter: "/api/" }).',
    '- Network requests triggered by any action: browser_network { action: "list" } to view captured same-origin API requests.',
    '',
    'diff_to is a two-step mechanism: the first call with a given ID stores the baseline and returns a normal snapshot; the second call with the same ID returns the structured diff. Do not expect diff output on the first call.',
    '',
    'Network monitoring starts automatically on browser_navigate. Same-origin xhr/fetch requests are captured per tab (last 100). Use browser_network { action: "list" } to query, browser_network { action: "detail", requestId: "..." } to inspect headers/body.',
    '',
    '## @e reference lifecycle',
    '',
    '- Each snapshot produces @e<structureId>_<revision> references.',
    '- The _<revision> suffix tracks element identity. When the same element changes (e.g. DOM updates, checkbox toggle), its revision increments.',
    '- A higher revision for the SAME structureId means a fresher reference. Do NOT compare revisions across different elements.',
    '- References become stale when the page navigates or the DOM updates (including aria state changes like checkbox, selection).',
    '- Always call browser_snapshot again after page-changing actions (browser_click, browser_fill, browser_press, browser_scroll, browser_navigate) to get fresh references.',
    '- If a ref fails with STALE_ELEMENT_REFERENCE, call browser_snapshot to obtain a new ref for that element.',
    '',
    '## Error recovery',
    '',
    '- STALE_ELEMENT_REFERENCE: call browser_snapshot again and use the new @e ref.',
    '- Command timeout: check page status with browser_snapshot, retry if page is still loading.',
    '- Extension not connected: call browser_doctor, then browser_status.',
    '- fill value not applied: try a different commit mode ("blur", "enter") or use browser_evaluate as fallback.',
    '',
    'Read browser_control_safety for confirmation boundaries before sensitive actions.'
  ].join('\n')));

  server.registerPrompt('browser_control_command_reference', {
    title: 'Browser Control command reference',
    description: 'Tool reference for Browser Control MCP tools.'
  }, () => {
    const categories: Record<string, string[]> = {
      'Navigation': ['navigate'],
      'Tab management': ['tabs'],
      'Observation': ['snapshot', 'wait_for'],
      'Element actions': ['click', 'fill', 'press', 'scroll', 'upload'],
      'Reading page': ['get_text', 'capture', 'evaluate'],
      'Network': ['network'],
      'Other': ['download', 'close_session']
    };

    const lines: string[] = [];
    for (const [category, cmds] of Object.entries(categories)) {
      lines.push(`${category}:`);
      for (const command of cmds) {
        const meta = COMMANDS[command];
        if (!meta) continue;
        const required = meta.required?.length ? meta.required.join(', ') : 'none';
        const optional = meta.optional?.length ? meta.optional.join(', ') : 'none';
        let line = `  - browser_${command}: required: ${required}; optional: ${optional}`;
        if (meta.strategies?.length) {
          line += `; strategies: ${meta.strategies.join(', ')}`;
        }
        lines.push(line);
      }
      lines.push('');
    }

    return textPrompt('Browser Control tool reference', [
      'Each tool is called directly with typed parameters (no command/args wrapping):',
      'browser_snapshot({ viewportOnly: true, hasVisibleText: true })',
      '',
      'Cross-tool usage patterns:',
      '- Narrow snapshot results before interaction: use textIncludes, roles, tags, hasVisibleText, viewportOnly to filter.',
      '- Verify state changes: snapshot with diff_to, or wait_for with text/selector, or capture for visual evidence.',
      '- Intercept API during click: browser_click with probe captures matching requests; use browser_network for post-hoc inspection.',
      '- Read specific page region: browser_get_text with selector (e.g. selector: ".search-results") avoids sidebar/nav noise.',
      '- Scroll then read: browser_scroll + browser_get_text for below-fold content (prefer over keyboard or evaluate workarounds).',
      '',
      'Tools by category:',
      ...lines,
      'Common examples:',
      'browser_navigate({ url: "https://example.com" })',
      'browser_snapshot({ viewportOnly: true, hasVisibleText: true })',
      'browser_snapshot({ textIncludes: "Login", hasVisibleText: true, viewportOnly: true, roles: ["button", "link", "textbox"] })',
      'browser_snapshot({ diff_to: "s1_abc123" })',
      'browser_click({ target: "@eabc_1" })',
      'browser_click({ target: "@eabc_1", probe: { filter: "/api/", includeBody: true } })',
      'browser_click({ text: "Submit", x: 200, y: 300 })',
      'browser_fill({ target: "@eabc_1", value: "draft", clear: true })',
      'browser_press({ key: "Enter" })',
      'browser_scroll({ deltaY: 800 })',
      'browser_tabs({ action: "switch", urlIncludes: "example.com" })',
      'browser_capture({ format: "pdf", paperFormat: "A4" })',
      'browser_network({ action: "list", filter: "/api/" })',
      'browser_network({ action: "detail", requestId: "<id from list>" })',
      'browser_get_text({ scope: "full", maxChars: 6000 })',
      'browser_get_text({ scope: "viewport", selector: "article" })'
    ].join('\n'));
  });

  server.registerPrompt('browser_control_safety', {
    title: 'Browser Control safety',
    description: 'Confirmation boundaries for Browser Control MCP tools.'
  }, () => {
    return textPrompt('Browser Control safety', [
      'The MCP server does not ask the user for confirmation or block sensitive actions.',
      'Tools marked destructiveHint (browser_click, browser_fill, browser_press, browser_evaluate, browser_upload, browser_tabs with action "close") may cause irreversible changes.',
      'Ask the user before: submit/send/post/publish, purchases/payments, destructive actions, account/security/privacy changes, uploads, credentials, MFA, CAPTCHA, permission prompts, or irreversible operations.',
    ].join('\n'));
  });
}
