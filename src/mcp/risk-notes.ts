const RISK_NOTES: Record<string, string> = {
  click: 'Risk: may trigger page actions, submissions, navigation, or account-affecting UI. With probe mode, still performs a real frontend click and may change page state while intercepting API requests. The MCP server does not perform user confirmation; callers must follow Browser Control safety boundaries.',
  fill: 'Risk: may place sensitive or private data into page fields. The MCP server does not perform user confirmation.',
  press: 'Risk: may submit forms, activate focused controls, or navigate. The MCP server does not perform user confirmation.',
  evaluate: 'Risk: executes JavaScript in the page context and can read page data (DOM, cookies, storage) or trigger side effects. The MCP server does not perform user confirmation.',
  upload: 'Risk: uploads local files to the page. The MCP server does not perform user confirmation.',
  download: 'Risk: downloads remote content through Chrome. The MCP server does not perform user confirmation.',
  capture: 'Risk: creates a page artifact (screenshot or PDF) that may contain sensitive visible content. The MCP server does not perform user confirmation.',
  network: 'Risk: network detail action may expose request/response headers or bodies that contain sensitive data. The MCP server does not perform user confirmation.'
};

export function riskNoteFor(command: string): string | null {
  return RISK_NOTES[command] || null;
}

export function isSensitiveCommand(command: string): boolean {
  return Object.prototype.hasOwnProperty.call(RISK_NOTES, command);
}
