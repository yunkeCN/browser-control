# Browser Control MCP server

Browser Control includes a stdio MCP server for controlling the same local Chrome daemon used by the Skill CLI. It exposes the full Browser Control protocol through a small tool surface.

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

The generated `.mjs` file is self-contained. You may copy `skills/browser-control/scripts/browser-control-mcp.mjs` elsewhere and point the MCP client at the copy.

## Runtime

After saving the config, restart or reload the MCP client. The first tool call starts or reuses the Browser Control daemon automatically. Chrome still needs the Browser Control extension loaded from `skills/browser-control/extension/`.

Running `node scripts/browser-control-mcp.mjs` directly is only a smoke check; it waits for MCP stdio messages and normally prints nothing.

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

- `browser_control_command`: run any Browser Control protocol command.
- `browser_control_close_session`: close the active MCP-managed session.
- `browser_control_status`: daemon status, compatibility diagnostics, and active session.
- `browser_control_doctor`: deeper setup diagnostics.

`browser_control_command` takes:

- `command`: protocol command name, such as `navigate`, `snapshot`, `click`, `fill`, `get_text`, or `network_list`.
- `args`: command arguments, default `{}`.
- `session`: optional; omit it for normal use. The MCP server manages an active session per process.
- `timeoutMs`: optional command timeout.
- `id`: optional request id.

For element actions, prefer `snapshot` to get `@e` references, then pass the chosen `@e` as `click`/`fill`/`press` `selector`. To avoid large snapshots when looking for visible text, filter first:

```json
{
  "name": "browser_control_command",
  "arguments": {
    "command": "snapshot",
    "args": {
      "textIncludes": "新增工单",
      "hasVisibleText": true,
      "viewportOnly": true,
      "maxElements": 10
    }
  }
}
```

Snapshot responses keep their existing `data` shape and clipping behavior, and also include a top-level `artifacts` entry before `data`, so clients can find the same snapshot payload as a JSON artifact even when they truncate large tool output.

The server also provides prompts:

- `browser_control_usage`
- `browser_control_command_reference`
- `browser_control_safety`

## Example calls

Check readiness:

```json
{
  "name": "browser_control_status",
  "arguments": {}
}
```

Navigate:

```json
{
  "name": "browser_control_command",
  "arguments": {
    "command": "navigate",
    "args": {
      "url": "https://example.com",
      "newTab": true
    }
  }
}
```

Close the current task session:

```json
{
  "name": "browser_control_close_session",
  "arguments": {}
}
```

## Notes

- The MCP server validates schemas and returns hints, but does not ask the user for confirmation or block sensitive commands.
- Sensitive or side-effecting protocol commands are documented in `browser_control_safety` and include `riskNotes` in command results.
- Artifact-producing commands return local paths and metadata; raw screenshot, PDF, download, and large network body data is not inlined.
- If another service owns the daemon port, stop that service or set `BROWSER_CONTROL_PORT`.
- If `extension_connected` is false, load or reload the bundled Chrome extension.
