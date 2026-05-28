# Browser Control MCP server

Browser Control includes a stdio MCP server for controlling the same local Chrome daemon used by the Skill CLI. Each browser command is registered as an independent MCP tool with a typed schema and annotations.

## Start

MCP servers are started by the MCP client. Add this to the client config for an installed Skill package:

```json
{
  "mcpServers": {
    "browser-control": {
      "command": "node",
      "args": ["/absolute/path/to/browser-control/scripts/browser-control-mcp.mjs"]
    }
  }
}
```

From this repository checkout, either use the Skill-packaged artifact:

```json
{
  "mcpServers": {
    "browser-control": {
      "command": "node",
      "args": ["/absolute/path/to/browser-control/skills/browser-control/scripts/browser-control-mcp.mjs"]
    }
  }
}
```

Or use the root development copy:

```json
{
  "mcpServers": {
    "browser-control": {
      "command": "node",
      "args": ["/absolute/path/to/browser-control/bin/browser-control-mcp.mjs"]
    }
  }
}
```

Build or refresh both generated copies with:

```bash
npm run build:mcp
```

The generated `.mjs` file is self-contained. You may copy it elsewhere and point the MCP client at the copy.

## Runtime

After saving the config, restart or reload the MCP client. The first tool call starts or reuses the Browser Control daemon automatically. Chrome still needs the Browser Control extension loaded from `skills/browser-control/extension/`.

Use environment variables for non-default daemon settings:

```json
{
  "mcpServers": {
    "browser-control": {
      "command": "node",
      "args": ["/absolute/path/to/browser-control/scripts/browser-control-mcp.mjs"],
      "env": {
        "BROWSER_CONTROL_HOST": "127.0.0.1",
        "BROWSER_CONTROL_PORT": "10087"
      }
    }
  }
}
```

## Tools

Each command is an independent tool with typed parameters and MCP annotations:

| Tool | Description | Annotation |
|------|-------------|------------|
| `browser_navigate` | Navigate to URL | `openWorldHint` |
| `browser_tabs` | List, switch, or close tabs | `destructiveHint` |
| `browser_snapshot` | Capture page accessibility tree | `readOnlyHint` |
| `browser_get_text` | Extract page text | `readOnlyHint` |
| `browser_click` | Click element (ref, text, or probe mode) | `destructiveHint` |
| `browser_fill` | Fill form field | `destructiveHint` |
| `browser_press` | Press keyboard key | `destructiveHint` |
| `browser_scroll` | Scroll page or element | — |
| `browser_wait_for` | Wait for condition | `readOnlyHint` |
| `browser_capture` | Screenshot or PDF | — |
| `browser_evaluate` | Execute JavaScript | `destructiveHint` |
| `browser_network` | Query captured network requests | `readOnlyHint` |
| `browser_upload` | Upload files | `destructiveHint` |
| `browser_download` | Download file | — |
| `browser_close_session` | Close session | — |
| `browser_status` | Daemon status and diagnostics | `readOnlyHint` |
| `browser_doctor` | Setup troubleshooting | `readOnlyHint` |

Tool parameters are called directly (no `command`/`args` wrapping):

```json
{ "name": "browser_snapshot", "arguments": { "viewportOnly": true, "hasVisibleText": true } }
{ "name": "browser_click", "arguments": { "target": "@eabc_1" } }
{ "name": "browser_navigate", "arguments": { "url": "https://example.com" } }
```

Snapshot MCP responses include `tree` (compact ARIA text with embedded `@e` refs), `elementCount`, `title`, `url`, and optional `diff` when `diff_to` is used. The raw daemon returns additional `refs` JSON and structured tree; MCP returns the controller's flat CommandResult via `structuredContent`. If the snapshot text exceeds 100k characters, the daemon stores the full JSON payload as a local artifact and recommends narrowing with `textIncludes`, `roles`, `tags`, `hasVisibleText`, or `viewportOnly`.

The server also provides prompts:

- `browser_control_usage`
- `browser_control_command_reference`
- `browser_control_safety`

## Example calls

Check readiness:

```json
{ "name": "browser_status", "arguments": {} }
```

Navigate and snapshot:

```json
{ "name": "browser_navigate", "arguments": { "url": "https://example.com" } }
{ "name": "browser_snapshot", "arguments": { "viewportOnly": true, "hasVisibleText": true } }
```

Click with network interception:

```json
{ "name": "browser_click", "arguments": { "target": "@eabc_1", "probe": { "filter": "/api/", "includeBody": true } } }
```

Query network requests:

```json
{ "name": "browser_network", "arguments": { "action": "list", "filter": "/api/" } }
```

Close session:

```json
{ "name": "browser_close_session", "arguments": {} }
```

## Notes

- The MCP server validates schemas but does not ask the user for confirmation or block sensitive commands. Tools marked `destructiveHint` may cause side effects.
- Artifact-producing commands return local paths and metadata; raw image, PDF, and large network body data is not inlined.
- If another service owns the daemon port, stop that service or set `BROWSER_CONTROL_PORT`.
- If `extension_connected` is false, load or reload the bundled Chrome extension.
