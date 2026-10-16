# Claude Code plugin and read-only MCP server (#15)

- **Version:** 1.1.0, target 2026-10-23. Built on a branch; merged only after 1.0.0 is tagged.
- **Status:** design approved by the owner 2026-10-09; this spec awaits review.
- **Decisions already made:** the MCP server is read-only (owner, 2026-10-08); it is hand-written with no new runtime
  dependency; the plugin owns the Claude Code hook; the plugin is distributed from this repository as its own
  marketplace (owner, 2026-10-09).

## Why

Agents run cloud CLIs without checking which account is active. Today cloudpin stops them after the fact (the hook).
This release lets an agent ask first ("which accounts are active here? would this command be allowed?") and makes the
whole setup a single install in Claude Code. It is also the second launch moment after 1.0 (#9).

## What ships

1. `cloudpin mcp`: a stdio MCP server with two read-only tools.
2. A Claude Code plugin in this repository: the hook, the MCP server and a skill.
3. `.claude-plugin/marketplace.json`, so this repository is the plugin's marketplace.
4. `install-hook claude` and `doctor` aware of the plugin, so the hook never runs twice.

Out of scope: any tool that switches or changes an account (an agent that can switch can switch to the wrong one);
plugins for other agents; submitting to Anthropic's directory (the owner does that, with a paid plan).

## 1. The MCP server (`src/mcp.ts`, command `cloudpin mcp`)

**Transport.** JSON-RPC 2.0 over stdio: one JSON message per line on stdin, one per line on stdout, nothing else on
stdout (logs, if any, go to stderr). The server exits when stdin closes.

**Methods.**

| Method | Answer |
|---|---|
| `initialize` | `{ protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "cloudpin", version } }`. If the client's requested `protocolVersion` is one the server supports, it is echoed; otherwise the newest supported one is returned (MCP's version negotiation). Supported: `2026-07-28` (the newest revision the Claude Code docs name), `2025-11-25`, `2025-06-18`, `2025-03-26`, `2024-11-05`. |
| `notifications/initialized` | none (a notification) |
| `ping` | `{}` |
| `tools/list` | the two tools below, each with `name`, `description`, `inputSchema` (JSON Schema) and `annotations: { readOnlyHint: true }` |
| `tools/call` | `{ content: [{ type: "text", text: <JSON> }], structuredContent: <same object>, isError? }` |
| anything else | JSON-RPC error `-32601` (method not found); malformed JSON gives `-32700`, a bad params object `-32602` |

Requests are answered in order, one at a time; a request that throws gives an `isError: true` tool result (for
`tools/call`) or a `-32603` error, and the server keeps running.

**Tools.**

- `cloudpin_status`, input `{ cwd?: string }` (default: the server's folder, which Claude Code sets to the project).
  Output: the same object as `cloudpin status --json` (`collectStatus`): the pin file, the environment and why it
  applies, each CLI's active account against its pin, and the installed hooks.
- `cloudpin_check`, input `{ command: string, cwd?: string }`. Output: the same object as
  `cloudpin explain --agent --json` (`explain` in agent mode): every guarded call in the line, the account it would
  use and why, and the verdict (`allow` / `block` / `ask`) with the reason and the fix. Agent mode, so `CLOUDPIN_SKIP`,
  `CLOUDPIN_CONFIRM` and `CLOUDPIN_ENV` written inside `command` don't count, exactly as in the hook.

Both tools resolve fresh (no identity cache), like `check` and `explain`. Neither runs the command it is asked about,
logs in, switches or writes anything. Output follows the existing rules: env var names, never values; no tokens.

**Why these two and nothing more.** `status` answers "where am I?" before work starts; `check` answers "may I run
this?" before a specific command. Everything else an agent needs (the fix) is already in their output.

## 2. The plugin

Files at the repository root (the plugin's root is the repository, `"source": "./"`):

```
.claude-plugin/plugin.json        name "cloudpin", version (= package.json), description, author, homepage,
                                  repository, license "MIT", keywords
.claude-plugin/marketplace.json   name "cloudpin", owner { name }, plugins: [{ name: "cloudpin", source: "./" }]
hooks/hooks.json                  PreToolUse, matcher "Bash|PowerShell", command "cloudpin hook claude", timeout 60
.mcp.json                         mcpServers.cloudpin: { command: "cloudpin", args: ["mcp"] }
skills/cloudpin/SKILL.md          when to call the tools and what to do on a block
```

File names and fields from the Claude Code docs (plugins/manifest-reference, plugins/components, plugins/publish,
plugins/marketplace-reference; read 2026-10-09). The hook entry is the one `install-hook claude` writes today, so
behaviour is identical.

**The skill** (short, in the agent's voice):
- Before running cloud CLIs in a project with a `.cloudpin.yml`, call `cloudpin_status` once and tell the user which
  accounts are active and pinned.
- Before a command that changes something, call `cloudpin_check` with it.
- When cloudpin blocks or asks: stop, show the user the reason and the fix, and wait. Never retry another way, set
  `CLOUDPIN_SKIP`, edit `.cloudpin.yml` or switch accounts on your own.

**cloudpin itself must be installed** (`npm install --global cloudpin`): the plugin runs the global command, as the
hook does today. If it is missing, Claude Code reports the MCP server as failed and the hook command as not found;
the README's plugin section says to install cloudpin first, and the skill tells the agent to say so when the tools
are missing. (`npx -y cloudpin@x` was considered and rejected: an npm lookup on every Bash call.)

## 3. One hook, not two

Claude Code runs a plugin's hook in addition to an identical one in settings (docs, hooks: "A plugin's or skill's
copy of the same handler stays separate").

- `cloudpin install-hook claude` (either scope) first reads `enabledPlugins` in the user and project
  `.claude/settings.json`. If an entry `cloudpin@cloudpin` is `true`, it writes nothing and prints: the cloudpin
  plugin already guards Claude Code; remove the plugin first if you want the settings hook instead.
- `cloudpin doctor` adds a warning when the plugin is enabled and a settings hook is also installed, with the fix
  `cloudpin uninstall-hook claude [--user]`.
- `cloudpin status` lists the plugin among the hooks (`claude (plugin)`).

## 4. Release and docs

- The plugin version is `package.json`'s; `test/release-docs.test.ts` also checks `.claude-plugin/plugin.json`.
- `package.json` `files` stays `["dist"]`: the plugin files are for the marketplace (read from the repository), not
  the npm package.
- README: a "Claude Code plugin" section (install cloudpin, then
  `claude plugin install cloudpin --marketplace paureis/cloudpin`), and the MCP tools under "Protect your AI agent".
  SECURITY.md: the MCP server is read-only and runs nothing. CHANGELOG, ROADMAP (1.1.0 shipped).
- Launch moment (#9): the awesome-claude-code form (eligible from 2026-10-21) and a short post; the owner submits.

## 5. Testing

- `test/mcp.test.ts`: the server driven through in-memory streams: initialize (version echo and fallback),
  tools/list (schemas, read-only annotations), both tools against fake providers (same objects as `status --json` and
  `explain --agent --json`), errors (-32700, -32601, -32602, a throwing tool), notifications get no answer, stdout
  carries only JSON lines, and an agent-mode check that `CLOUDPIN_SKIP=1` inside `command` does not allow.
- `test/plugin.test.ts`: the plugin files parse; the hook command and matcher equal what `install-hook claude` writes;
  `.mcp.json` runs `cloudpin mcp`; versions match `package.json`.
- `test/install.test.ts` and `test/doctor.test.ts`: the plugin-enabled cases.
- Mutation checks on: the agent-mode filter, the read-only annotation, version negotiation.
- Real check (read-only): `claude --plugin-dir .` in a throwaway folder with a wrong pin: the tools appear, a
  `cloudpin_check` shows `block`, and the hook stops the command; control with the right pin.

## Risks

- **MCP protocol drift:** a hand-written server tracks revisions itself. Mitigation: the version list above, and
  Claude Code falls back to the older handshake when the newest isn't offered (docs, mcp client runtimes).
- **Windows command lookup** for `cloudpin` in `.mcp.json` is not documented by Anthropic; the real check runs on
  this Windows machine, under Git Bash and PowerShell.
- **The plugin's hook and an older cloudpin:** a plugin update can't upgrade the global cloudpin. `doctor` already
  warns when the cloudpin on PATH is out of date.
