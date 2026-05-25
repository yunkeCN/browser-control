#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { registerBrowserControlTools } from './tools.js';
import { registerBrowserControlPrompts } from './prompts.js';
import { loadScriptPackageVersion } from './runtime-paths.js';
import { MCP_DAEMON_ARG } from '../daemon/process-manager.js';
import { runDaemonServer } from '../daemon/server.js';

export function createServer(): McpServer {
  const server = new McpServer({
    name: 'browser-control',
    version: loadScriptPackageVersion() || '0.0.0'
  });
  registerBrowserControlTools(server);
  registerBrowserControlPrompts(server);
  return server;
}

export async function main(): Promise<void> {
  if (process.argv[2] === MCP_DAEMON_ARG) {
    runDaemonServer();
    return;
  }
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch(error => {
  console.error(`[browser-control-mcp] ${error instanceof Error ? error.stack || error.message : String(error)}`);
  process.exit(1);
});
