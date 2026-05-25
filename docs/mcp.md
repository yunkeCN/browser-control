# Browser Control MCP server

Browser Control includes a root-level MCP server that is independent from the `skills/browser-control` package. It exposes the same low-level browser command surface as `skills/browser-control/scripts/protocol.js`, but its code, build output, and documentation live outside the skill directory.

## Client configuration

Use the package bin when Browser Control is installed on `PATH`:

```json
{
  "mcpServers": {
    "browser-control": {
      "command": "browser-control-mcp",
      "args": []
    }
  }
}
```

Use the generated root artifact directly from this repository:

```json
{
  "mcpServers": {
    "browser-control": {
      "command": "node",
      "args": ["bin/browser-control-mcp.mjs"]
    }
  }
}
```

The generated `bin/browser-control-mcp.mjs` is also a single-file runtime artifact. You can copy that one file to another local directory and point an MCP client at it. The file carries the daemon module and protocol metadata in the MCP bundle; when it needs to start the daemon without neighboring repository files, it launches the same copied file with an internal daemon argument.

To use a non-default daemon port, pass environment variables through your MCP client:

```json
{
  "mcpServers": {
    "browser-control": {
      "command": "browser-control-mcp",
      "args": [],
      "env": {
        "BROWSER_CONTROL_PORT": "10087",
        "BROWSER_CONTROL_HOST": "127.0.0.1"
      }
    }
  }
}
```

## Tools

The server registers four tools:

- `browser_control_command`: run any Browser Control protocol command.
- `browser_control_close_session`: close the current MCP-managed session and rotate to a fresh one.
- `browser_control_status`: daemon status, MCP compatibility diagnostics, and active session.
- `browser_control_doctor`: daemon health/status diagnostics for setup troubleshooting.

`browser_control_command` accepts:

- `command`: a command declared in the Browser Control protocol, such as `navigate`, `snapshot`, `click`, `get_text`, or `network_list`.
- `args`: command-specific arguments; defaults to `{}`.
- `session`: optional advanced override. Omit it for normal use; the MCP server manages an active session per server process.
- `timeoutMs`: command timeout in milliseconds; default `30000`.
- `id`: caller-provided request id.

Covered protocol commands are `navigate`, `find_tab`, `snapshot`, `get_text`, `scroll`, `click`, `click_probe`, `fill`, `press`, `select_option`, `set_checked`, `wait_for`, `evaluate`, `screenshot`, `save_as_pdf`, `observe_start`, `observe_diff`, `network_start`, `network_list`, `network_detail`, `network_stop`, `upload`, `download`, `list_tabs`, `close_tab`, and `close_session`.

The server also registers prompts:

- `browser_control_usage`
- `browser_control_command_reference`
- `browser_control_safety`

## Daemon lifecycle

On tool calls, the MCP server ensures the Browser Control daemon is available:

1. Query `GET /status`.
2. Start the daemon if it is absent.
3. Reuse an existing daemon when version, protocol version, runtime schema version, and daemon capabilities match.
4. Restart an old or incompatible Browser Control daemon.
5. Refuse to kill a non-Browser-Control service on the configured port.

An old or disconnected Chrome extension is reported as diagnostics and next steps. It is not treated as proof that the daemon must restart.

## Examples

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

Snapshot:

```json
{
  "name": "browser_control_command",
  "arguments": {
    "command": "snapshot",
    "args": {
      "viewportOnly": true,
      "hasVisibleText": true,
      "maxElements": 120
    }
  }
}
```

Click:

```json
{
  "name": "browser_control_command",
  "arguments": {
    "command": "click",
    "args": {
      "selector": "@e1jm0sbb_1",
      "expectChange": true
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

Explicit sessions remain available for advanced isolation:

```json
{
  "name": "browser_control_command",
  "arguments": {
    "session": "mcp-demo",
    "command": "snapshot",
    "args": {
      "viewportOnly": true
    }
  }
}
```

## Safety

The MCP server does not perform user confirmation or block sensitive commands. Sensitive or side-effecting protocol commands are documented in the safety prompt and include `riskNotes` in command results. Callers must follow Browser Control confirmation boundaries: ask before submit/send/post/publish, purchases/payments, destructive actions, account/security/privacy changes, uploads, credential-like data, MFA, CAPTCHA, permission prompts, or other irreversible operations.

Artifact-producing commands return paths and metadata from the daemon. The MCP server does not inline raw screenshot, PDF, download, or large network body data.

## Troubleshooting

- If `browser_control_status` reports that the daemon is missing, the MCP server will try to start it.
- If another service owns the port, stop that service or configure `BROWSER_CONTROL_PORT`.
- If the daemon is compatible but `extension_connected` is false, load or reload the bundled Chrome extension from `skills/browser-control/extension`.
- If browser commands return `BACKEND_UNAVAILABLE`, run `browser_control_doctor` and follow its next steps.
