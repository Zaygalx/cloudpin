# cloudpin's MCP server

`cloudpin mcp` is an MCP server (stdio) for any agent that supports MCP. The
[Claude Code plugin](../README.md#claude-code-plugin) starts it for you. It has two tools:

| Tool | Answers |
|---|---|
| `cloudpin_status` | which account each CLI is using here, what the project pins, which environment applies, which hooks are installed (the same as `cloudpin status --json`) |
| `cloudpin_check` | would cloudpin allow this command line, as an agent's: each call, the account it would use and why, and the verdict with its reason and fix (the same as `cloudpin explain --agent --json`). The line is read as bash; pass `shell: "powershell"` for a PowerShell command (`--powershell` for `explain`) |

Neither tool runs, switches or changes anything, by design: an agent that could switch accounts could switch to the
wrong one, and only you know which account the work is for.

When an agent connects, the server also hands it a few lines of instructions: check first, and
on a block stop and tell you the reason and the fix, never work around it.

## Add it to your agent

Install cloudpin first (`npm install --global cloudpin`). Any MCP client that starts stdio servers takes the same
entry, with the command and its arguments:

```json
{"command": "cloudpin", "args": ["mcp"]}
```

Or, where the client starts servers outside your terminal and `cloudpin` may not be on its PATH:

```json
{"command": "npx", "args": ["-y", "cloudpin", "mcp"]}
```

<!-- Checked 2026-10-21 against each agent's MCP docs: Codex learn.chatgpt.com/docs/extend/mcp (codex mcp add,
     [mcp_servers.<name>] in ~/.codex/config.toml or a trusted project's .codex/config.toml; reads the server's
     instructions); Gemini CLI geminicli.com/docs/tools/mcp-server (gemini mcp add, project scope by default; appends
     the instructions to its system instructions); VS Code code.visualstudio.com/docs/copilot/reference/mcp-configuration
     ("servers", type stdio); Cursor cursor.com/docs/mcp.md (mcpServers, type stdio, .cursor/mcp.json and
     ~/.cursor/mcp.json); Windsurf, now Devin Desktop, docs.devin.ai/desktop/cascade/mcp and
     docs.devin.ai/cli/extensibility/mcp/configuration (user mcp_config.json, read by Cascade and the Devin Local
     agent); Claude Desktop modelcontextprotocol.io/docs/develop/connect-local-servers (Settings > Developer > Edit
     Config, npx). None of them documents a one-click install link for a server outside its own marketplace (Cursor's
     deeplink reference, cursor.com/docs/reference/deeplinks.md, covers prompts, commands and rules only), so there are
     none here. -->

**Codex**: run `codex mcp add cloudpin -- cloudpin mcp`, or add this to `~/.codex/config.toml` (or to a trusted
project's `.codex/config.toml`):

```toml
[mcp_servers.cloudpin]
command = "cloudpin"
args = ["mcp"]
```

**Cursor**: `.cursor/mcp.json` in the project, or `~/.cursor/mcp.json` for every project:

```json
{"mcpServers": {"cloudpin": {"type": "stdio", "command": "cloudpin", "args": ["mcp"]}}}
```

**VS Code (GitHub Copilot agent mode)**: `.vscode/mcp.json` in the project:

```json
{"servers": {"cloudpin": {"type": "stdio", "command": "cloudpin", "args": ["mcp"]}}}
```

**Gemini CLI**: `gemini mcp add cloudpin cloudpin mcp` writes this project's `.gemini/settings.json` (`-s user` for
yours).

**Windsurf (now Devin Desktop)**: `~/.config/devin/mcp_config.json` (`%APPDATA%\devin\mcp_config.json` on Windows):

```json
{"mcpServers": {"cloudpin": {"command": "cloudpin", "args": ["mcp"]}}}
```

**Claude Desktop**: Settings > Developer > Edit Config. It starts servers outside any terminal or project, so it gets
the npx form, as in its own MCP guide, which also works without a global install:

```json
{"mcpServers": {"cloudpin": {"command": "npx", "args": ["-y", "cloudpin", "mcp"]}}}
```

An app that starts the server outside your project should pass the project folder as the tools' `cwd`; the
instructions tell the agent so.

## Advice, not enforcement

MCP gives an agent advice: nothing stops it from running a command without checking. Codex, Cursor and Gemini CLI can
also take the blocking hook (`cloudpin install-hook <agent>`, see
[Protect your AI agent](../README.md#protect-your-ai-agent)). cloudpin has no hook for VS Code, Windsurf or Claude
Desktop, so there the MCP server is advice only.
