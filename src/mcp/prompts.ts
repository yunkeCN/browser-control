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
    'Typical loop: browser_navigate -> browser_snapshot -> browser_click/browser_fill/browser_press (use @e refs) -> browser_snapshot again for fresh refs -> browser_close_session when done.',
    '',
    'Detecting page changes after an action:',
    '- DOM structure changes (new elements, dialogs, removed items): browser_snapshot with diff_to=<baselineId>',
    '- API calls triggered by a click: browser_click with probe parameter (e.g. probe: { filter: "/api/" })',
    '- Ongoing network monitoring: browser_network { action: "start" } -> browser_network { action: "list" }',
    'Typical diff workflow: browser_snapshot (get baselineId) -> perform action -> browser_snapshot { diff_to: baselineId } to see what changed.',
    '',
    'Network monitoring: browser_network { action: "start" } to begin capture (optional URL filter), browser_network { action: "list" } to list captured requests, browser_network { action: "detail", requestId: "..." } to inspect headers/body, browser_network { action: "stop" } to end capture.',
    '',
    'Advanced click with network interception: browser_click with probe parameter performs a click and simultaneously captures matching network requests via CDP Fetch.enable.',
    '',
    'Click by text: browser_click with text, x, y parameters finds the nearest visible element matching the text and clicks it.',
    '',
    'Keyboard-driven interactions: browser_press works on the focused element and can trigger shortcuts or form submission.',
    '',
    'When you need to act on an element by visible text, use browser_snapshot with textIncludes, roles, tags, hasVisibleText, and viewportOnly to narrow the returned @e references, then pass the chosen ref as target.',
    '',
    '@e reference lifecycle:',
    '- Each snapshot produces @e<structureId>_<revision> references.',
    '- The _<revision> suffix tracks element identity. When the same element changes (e.g. DOM updates, checkbox toggle), its revision increments.',
    '- A higher revision for the SAME structureId means a fresher reference. Do NOT compare revisions across different elements.',
    '- References become stale when the page navigates or the DOM updates (including aria state changes like checkbox, selection).',
    '- Always call browser_snapshot again after page-changing actions (browser_click, browser_fill, browser_press, browser_scroll, browser_navigate) to get fresh references.',
    '- If a ref fails with STALE_ELEMENT_REFERENCE, call browser_snapshot to obtain a new ref for that element.',
    '',
    'Error recovery:',
    '- STALE_ELEMENT_REFERENCE: call browser_snapshot again and use the new @e ref.',
    '- Command timeout: check page status with browser_snapshot, retry if page is still loading.',
    '- Extension not connected: call browser_doctor, then browser_status.',
    '- fill value not applied: try strategy "text_input" or "paste_like" as fallback.',
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
      'Key parameters:',
      '- browser_click: target (@e ref or css=) OR text+x+y for text-based clicking. probe: { filter, includeBody, includeHeaders } for CDP network interception.',
      '- browser_tabs: action "list" (default), "switch", "close".',
      '- browser_capture: format "png" (default), "jpeg", "pdf". PDF-specific: paperFormat, landscape, scale, printBackground.',
      '- browser_network: action "start", "list", "detail" (requires requestId), "stop". scope: "tab" (default) or "session".',
      '',
      '- browser_get_text scope:',
      '  - "viewport" (default): text visible in the current scroll position.',
      '  - "full": all rendered text on the page, excluding hidden/zero-size elements.',
      '  - "document": raw body.innerText (includes hidden text, may contain noise).',
      '',
      '- browser_fill: strategy "native_setter", "text_input", "paste_like". commit: "change" (default), "blur", "enter", "none".',
      '- browser_press: strategy "auto", "cdp_keyboard", "dom_keyboard".',
      '- browser_scroll: strategy "auto", "dom", "wheel".',
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
      'browser_network({ action: "start", filter: "/api/" })',
      'browser_network({ action: "list" })',
      'browser_network({ action: "detail", requestId: "<id from list>" })',
      'browser_get_text({ scope: "full", maxChars: 6000 })'
    ].join('\n'));
  });

  server.registerPrompt('browser_control_safety', {
    title: 'Browser Control safety',
    description: 'Confirmation boundaries for Browser Control MCP tools.'
  }, () => {
    return textPrompt('Browser Control safety', [
      'The MCP server does not ask the user for confirmation or block sensitive actions.',
      'Tools marked destructiveHint (browser_click, browser_fill, browser_press, browser_evaluate, browser_upload) may cause irreversible changes.',
      'Ask the user before: submit/send/post/publish, purchases/payments, destructive actions, account/security/privacy changes, uploads, credentials, MFA, CAPTCHA, permission prompts, or irreversible operations.',
    ].join('\n'));
  });
}
