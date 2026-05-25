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
    'Typical loop: navigate -> snapshot -> use @e ids for click/fill/press -> get_text/screenshot for reading -> browser_control_close_session when done.',
    'Do not build Google or YouTube search URLs with query parameters when a task asks for real UI usage; navigate to the homepage and operate the search box.',
    'Prefer snapshot before element actions and prefer @e references from the latest snapshot.'
  ].join('\n')));

  server.registerPrompt('browser_control_command_reference', {
    title: 'Browser Control command reference',
    description: 'Low-level Browser Control protocol commands accepted by browser_control_command.'
  }, () => {
    const lines = Object.entries(COMMANDS).map(([command, meta]) => {
      const required = meta.required?.length ? meta.required.join(', ') : 'none';
      const optional = meta.optional?.length ? meta.optional.join(', ') : 'none';
      return `- ${command}: required: ${required}; optional: ${optional}`;
    });
    return textPrompt('Browser Control command reference', [
      'Call browser_control_command with this shape:',
      '{"command":"snapshot","args":{"viewportOnly":true,"maxElements":120}}',
      '',
      'All commands:',
      ...lines,
      '',
      'Common examples:',
      '{"command":"navigate","args":{"url":"https://example.com"}}',
      '{"command":"snapshot","args":{"viewportOnly":true,"maxElements":120}}',
      '{"command":"click","args":{"selector":"@eabc_1","expectChange":true}}',
      '{"command":"fill","args":{"selector":"@eabc_1","value":"draft","clear":true}}',
      '{"command":"press","args":{"key":"Enter","expectChange":true}}',
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
