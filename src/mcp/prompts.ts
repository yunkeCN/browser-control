import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { COMMANDS } from './protocol.js';
import { riskNoteFor } from './risk-notes.js';

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
    'Use browser_control_command for browser actions and observations.',
    'The MCP server manages an active session automatically; omit session unless you intentionally need a separate session.',
    'Typical loop: navigate -> snapshot -> use @e ids as target for click/fill/press/scroll/upload -> get_text/screenshot for reading -> browser_control_close_session when done.',
    '',
    'Observation loop: call observe_start to capture a baseline, perform an action, then call observe_diff with the returned baselineId to see what changed.',
    '',
    'DOM structure diff: snapshot accepts "baseline" parameter for structural diff. First call snapshot baseline=<id> stores the tree; second call returns added/removed/changed subtrees. click also supports baseline — pair with snapshot to get structured diff of what the click changed.',
    '',
    'Network monitoring: network_start to begin capture (optional URL filter), network_list to list captured requests, network_detail <requestId> to inspect headers/body, network_stop to end capture.',
    '',
    'Advanced click: click_probe performs a click and simultaneously captures matching network requests. Supports filter (URL substring), includeBody, includeHeaders, and maxRequests.',
    '',
    'Keyboard-driven interactions: press works on the focused element and can trigger shortcuts or form submission.',
    '',
    'When you need to act on an element by visible text, do not request a huge snapshot. Use snapshot with textIncludes, roles, tags, hasVisibleText, and viewportOnly to narrow the returned @e references, then pass the chosen ref as target.',
    'Do not build Google or YouTube search URLs with query parameters when a task asks for real UI usage; navigate to the homepage and operate the search box.',
    'Prefer snapshot before element actions and prefer @e references from the latest snapshot.',
    '',
    '@e reference lifecycle: each snapshot produces @e<structureId>_<revision> references. These references become stale (unclickable) when the page navigates or the DOM updates. Always call snapshot again after any page-changing action (click, fill, press, scroll, navigate) to obtain fresh @e references for the next interaction. The _<revision> suffix increments to indicate staleness — prefer the highest revision.',
    '',
    'Read browser_control_safety for confirmation boundaries before sensitive actions.'
  ].join('\n')));

  server.registerPrompt('browser_control_command_reference', {
    title: 'Browser Control command reference',
    description: 'Low-level Browser Control protocol commands accepted by browser_control_command.'
  }, () => {
    const categories: Record<string, string[]> = {
      'Navigation': ['navigate'],
      'Tab management': ['find_tab', 'list_tabs', 'close_tab'],
      'Observation': ['snapshot', 'wait_for'],
      'Change observation': ['observe_start', 'observe_diff'],
      'Element actions': ['click', 'click_probe', 'fill', 'press', 'scroll', 'upload'],
      'Reading page': ['get_text', 'screenshot', 'evaluate', 'save_as_pdf'],
      'Network': ['network_start', 'network_list', 'network_detail', 'network_stop'],
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
        let line = `  - ${command}: required: ${required}; optional: ${optional}`;
        if (meta.strategies?.length) {
          line += `; strategies: ${meta.strategies.join(', ')}`;
        }
        lines.push(line);
      }
      lines.push('');
    }

    return textPrompt('Browser Control command reference', [
      'Call browser_control_command with this shape:',
      '{"command":"snapshot","args":{"viewportOnly":true,"hasVisibleText":true}}',
      '',
      'Key optional parameters:',
      '- click "after": "auto" (default, returns summary + postSnapshot + triggered API requests), "none", "snapshot" (explicit full snapshot). click also captures network requests triggered within 700ms (URLs only, no body). For advanced network capture (headers/body, URL filtering), use click_probe.',
      '- get_text "scope": "viewport" (default, viewport visible text), "document" (legacy body.innerText), "full" (rendered layout text, filters hidden/zero-size/off-layout)',
      '- fill strategy: "native_setter", "text_input", "paste_like"',
      '- fill "commit": "change" (default — triggers change event, use for auto-save), "blur" (blurs field, use for blur validation), "enter" (press Enter, use for search), "none" (set value only, submit via button separately)',
      '- press strategy: "auto", "cdp_keyboard", "dom_keyboard"',
      '- scroll strategy: "auto", "dom", "wheel"',
      '- click_probe "filter": URL substring to capture matching network requests. "includeBody" and "includeHeaders": booleans to capture request bodies or response headers.',
      '',
      'network scope: "tab" (default, capture requests from current tab only), "session" (capture requests from all tabs in the session)',
      '',
      'Commands by category:',
      ...lines,
      'Common examples:',
      '{"command":"navigate","args":{"url":"https://example.com"}}',
      '{"command":"snapshot","args":{"viewportOnly":true,"hasVisibleText":true}}',
      '{"command":"snapshot","args":{"textIncludes":"Login","hasVisibleText":true,"viewportOnly":true,"roles":["button","link","textbox"]}}',
      '{"command":"snapshot","args":{"baseline":"page-1"}} — first call stores baseline, second call returns added/removed/changed diff',
      '{"command":"click","args":{"target":"@eabc_1","baseline":"page-1"}} — click then diff against stored baseline, returns structured added/removed/changed',
      '{"command":"click","args":{"target":"@eabc_1","after":"auto"}}',
      '{"command":"click_probe","args":{"target":"@eabc_1","filter":"/api/","includeBody":true}}',
      '{"command":"fill","args":{"target":"@eabc_1","value":"draft","clear":true}}',
      '{"command":"press","args":{"key":"Enter","expectChange":true}}',
      '{"command":"scroll","args":{"deltaY":800}}',
      '{"command":"observe_start","args":{"includeNetworkMarker":true}}',
      '{"command":"observe_diff","args":{"baselineId":"obs_...","includeNetwork":true}}',
      '{"command":"network_start","args":{}}',
      '{"command":"network_start","args":{"scope":"session"}}',
      '{"command":"network_list","args":{"filter":"/api/"}}',
      '{"command":"network_detail","args":{"requestId":"<id from network_list>"}}',
      '{"command":"get_text","args":{"scope":"document","maxChars":6000}}'
    ].join('\n'));
  });

  server.registerPrompt('browser_control_safety', {
    title: 'Browser Control safety',
    description: 'Confirmation boundaries and risk notes for Browser Control MCP tools.'
  }, () => {
    const risks = Object.keys(COMMANDS)
      .map(command => riskNoteFor(command))
      .filter((note): note is string => Boolean(note));
    return textPrompt('Browser Control safety', [
      'The MCP server validates schemas and returns risk notes, but it does not ask the user for confirmation or block sensitive actions.',
      'Ask the user before submit/send/post/publish, purchases/payments, destructive actions, account/security/privacy changes, uploads, credentials, MFA, CAPTCHA, permission prompts, or irreversible operations.',
      'Risk notes:',
      ...risks.map(note => `- ${note}`)
    ].join('\n'));
  });
}
