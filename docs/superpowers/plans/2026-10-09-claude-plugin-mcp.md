# Claude Code plugin and read-only MCP server Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship `cloudpin mcp` (two read-only tools) and a Claude Code plugin (hook + MCP server + skill) distributed from this repository, without the hook ever running twice.

**Architecture:** A pure message handler (`src/mcp.ts`) answers one JSON-RPC line at a time; a thin stdio loop feeds it. The tools (`src/mcp-tools.ts`) wrap the existing `collectStatus` and `explain` (agent mode). Plugin files are static JSON/Markdown at the repository root. Plugin detection (`claudePluginEnabled`) lives in `src/install.ts` next to the hook files it reasons about, and `install-hook`, `status` and `doctor` use it.

**Tech Stack:** TypeScript 7 (NodeNext, strict), Node 22+, vitest 5. No new dependency.

**Spec:** `docs/superpowers/specs/2026-10-09-claude-plugin-mcp-design.md`

## Global Constraints

- No new runtime dependency (`package.json` `dependencies` stays `yaml`, `cross-spawn`).
- Read-only: no tool switches, logs in, writes files or runs the command it is asked about.
- Never print a token or env var value; name variables only.
- stdout of `cloudpin mcp` carries only JSON-RPC lines; anything else goes to stderr.
- Supported protocol versions, newest first: `2026-07-28`, `2025-11-25`, `2025-06-18`, `2025-03-26`, `2024-11-05`.
- Tool names: `cloudpin_status`, `cloudpin_check`. Plugin and marketplace name: `cloudpin`; enabled key `cloudpin@cloudpin`.
- Hook entry identical to `planInstall("claude", null)`: matcher `Bash|PowerShell`, command `cloudpin hook claude`, timeout 60.
- The branch is not merged before the 1.0.0 tag. One branch (`feat/15-plugin-mcp`), pushed once at the end.
- Tests use fake providers / `tempDir()`; no test spawns a real CLI. Commit with `git commit -F <file>`.

## Review Focus

1. Windows clients send `\r\n`: a line ending in `\r` must parse (Task 1, test "accepts CRLF lines").
2. stdin chunks split a message or carry two: the loop must buffer by newline (Task 1, test "buffers split and joined chunks").
3. `cwd` relative or missing in tool args: resolved against the server's folder; a folder that doesn't exist gives an `isError` result, never a crash (Task 2, test "relative and missing cwd").
4. `command` missing, empty or not a string: `isError` result with a clear message (Task 2, test "rejects a bad command").
5. Ids `0` and strings are echoed exactly; a notification (no id) never gets an answer, even when it fails (Task 1, test "echoes ids and stays silent for notifications").

---

### Task 1: The MCP message handler and stdio loop

**Files:**
- Create: `src/mcp.ts`
- Test: `test/mcp.test.ts`

**Interfaces:**
- Produces:
  - `interface McpTool { name: string; description: string; inputSchema: object; call(args: Record<string, unknown>): Promise<unknown> }`
  - `const PROTOCOL_VERSIONS: readonly string[]`
  - `createHandler(opts: { version: string; tools: McpTool[] }): (line: string) => Promise<string | null>` (returns the JSON answer line, or null for notifications)
  - `serve(handler, input: NodeJS.ReadableStream, output: { write(s: string): unknown }): Promise<void>` (resolves when input ends)

- [ ] **Step 1: Write the failing tests** (`test/mcp.test.ts`): initialize echoes a supported version and falls back to `2026-07-28` for an unknown one; result has `capabilities.tools` and `serverInfo {name:"cloudpin", version}`; `ping` → `{}`; `tools/list` lists names, schemas and `annotations.readOnlyHint: true`; `tools/call` returns `{content:[{type:"text",text}], structuredContent}` with `text === JSON.stringify(structuredContent, null, 2)`; unknown tool → `isError: true`; a throwing tool → `isError: true` with its message; unknown method → `-32601`; bad JSON → `-32700` with `id: null`; `tools/call` without `name` → `-32602`; ids `0` and `"a"` echoed; notifications (`notifications/initialized`, and an unknown method without id) → `null`; "accepts CRLF lines"; `serve` "buffers split and joined chunks" (feed `'{"jsonrpc":"2.0","id":1,"me'` then `'thod":"ping"}\n{"jsonrpc":"2.0","id":2,"method":"ping"}\n'` through a `PassThrough`, expect two output lines in order).
- [ ] **Step 2: Run** `npx vitest run test/mcp.test.ts` — expect FAIL (module missing).
- [ ] **Step 3: Implement** `src/mcp.ts`: parse with try/catch; `isRequest = "id" in msg`; switch on method; errors as `{jsonrpc:"2.0", id, error:{code, message}}`; `serve` keeps a string buffer, splits on `\n`, trims a trailing `\r`, skips blank lines, awaits each answer in order and writes `answer + "\n"`.
- [ ] **Step 4: Run** the tests — PASS. `npm run typecheck` — exit 0.
- [ ] **Step 5: Commit** `src/mcp.ts test/mcp.test.ts`: "MCP: JSON-RPC handler and stdio loop (#15)".

### Task 2: The two read-only tools

**Files:**
- Create: `src/mcp-tools.ts`
- Modify: `src/install.ts` (add `installedHooks`, see Task 4 for the plugin line — in this task it lists settings hooks only)
- Test: `test/mcp-tools.test.ts`

**Interfaces:**
- Consumes: `McpTool` (Task 1); `collectStatus(deps, cwd, env, hooks)` (src/status.ts); `explain(command, { mode: "agent", cwd, env }, deps)` (src/explain.ts).
- Produces:
  - `installedHooks(read: (path: string) => string | null, cwd: string, env: NodeJS.ProcessEnv): string[]` in `src/install.ts` (same strings `cloudpin status` shows: `claude (project)`, `codex (personal)`, …)
  - `cloudpinTools(deps: GuardDeps, ctx: { cwd: string; env: NodeJS.ProcessEnv; read: (p: string) => string | null; exists: (p: string) => boolean }): McpTool[]`

- [ ] **Step 1: Write the failing tests:** `cloudpin_status` returns the same object as `collectStatus` for the same deps; `cloudpin_check` returns `{ mode: "agent", calls }` equal to `explain(..., "agent")`; `CLOUDPIN_SKIP=1 vercel deploy` inside `command` still blocks; "relative and missing cwd" (`cwd: "sub"` resolves against ctx.cwd; a missing folder → the tool throws "folder not found", so the handler returns `isError`); "rejects a bad command" (missing, `""`, `42` → throws "command must be a non-empty string"); both input schemas declare their properties.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement** `cloudpinTools`; move the `status` hook listing from `src/cli.ts` into `installedHooks` and use it in both places.
- [ ] **Step 4: Run** tests and typecheck — PASS, exit 0.
- [ ] **Step 5: Commit**: "MCP: cloudpin_status and cloudpin_check, read-only (#15)".

### Task 3: `cloudpin mcp` in the CLI

**Files:**
- Modify: `src/cli.ts` (case `"mcp"`, USAGE line)
- Test: real run (no unit test: the wiring is two lines over tested parts)

- [ ] **Step 1:** add `case "mcp": await serve(createHandler({ version: version(), tools: cloudpinTools(deps, {...}) }), process.stdin, process.stdout); return 0;` and the USAGE line `cloudpin mcp  Read-only MCP server for agents (stdio)`. `mcp` must not be in `src/update.ts` INTERACTIVE (it isn't), so no update notice ever reaches its stdout.
- [ ] **Step 2:** `npm run build`, then pipe an `initialize`, `tools/list` and a `cloudpin_check` line into `node dist/cli.js mcp` and read three JSON lines back; confirm nothing else is printed on stdout.
- [ ] **Step 3: Commit**: "cloudpin mcp: serve the tools over stdio (#15)".

### Task 4: The plugin, the marketplace, and one hook not two

**Files:**
- Create: `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json`, `hooks/hooks.json`, `.mcp.json`, `skills/cloudpin/SKILL.md`
- Modify: `src/install.ts` (`claudePluginEnabled`; `installedHooks` adds `claude (plugin)`), `src/cli.ts` (install-hook declines), `src/doctor.ts` (warning), `test/release-docs.test.ts` (plugin version)
- Test: `test/plugin.test.ts`, `test/install.test.ts`, `test/doctor.test.ts`

**Interfaces:**
- Produces: `claudePluginEnabled(read, cwd, env): boolean` — true when `enabledPlugins["cloudpin@cloudpin"] === true` in `hookFile("claude","user",…)`, `hookFile("claude","project",…)` or `<cwd>/.claude/settings.local.json`.

- [ ] **Step 1: Failing tests:** plugin files parse; `hooks/hooks.json` PreToolUse entry deep-equals `planInstall("claude", null)`'s; `.mcp.json` runs `cloudpin` with `["mcp"]`; plugin and marketplace names are `cloudpin`, marketplace plugin source `./`; plugin version equals package.json (in release-docs test); `claudePluginEnabled` true/false cases (missing files, bad JSON, `false`, other plugins); `installedHooks` includes `claude (plugin)`; doctor warns when plugin enabled and a settings claude hook exists, fix `cloudpin uninstall-hook claude [--user]`.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement** the files and functions. install-hook for `claude`: if `claudePluginEnabled` → print "cloudpin: the cloudpin plugin already guards Claude Code here; uninstall the plugin first if you want the settings hook instead." and return 0 without writing.
- [ ] **Step 4: Run** all tests and typecheck.
- [ ] **Step 5: Commit**: "Claude Code plugin and marketplace; one hook, not two (#15)".

### Task 5: Docs, mutation checks and the real session

**Files:** `README.md`, `SECURITY.md`, `CHANGELOG.md` (Unreleased), `AGENTS.md`

- [ ] **Step 1:** README "Claude Code plugin" section and the MCP tools; SECURITY (MCP is read-only, runs nothing); CHANGELOG; AGENTS layout rows for `src/mcp.ts`, `src/mcp-tools.ts`.
- [ ] **Step 2:** mutation checks (commit first): drop the agent-mode filter in `cloudpin_check` (use mode "shell"), drop `readOnlyHint`, make negotiation always return the newest; each must fail a test.
- [ ] **Step 3:** real session, read-only: throwaway folder with a wrong `github` pin; `claude --plugin-dir <repo> -p` asking it to list the cloudpin tools and to run `gh pr list --repo paureis/cloudpin`; expect the tools listed and the command blocked; control with the right pin.
- [ ] **Step 4:** full `npm test`, `npm run typecheck`; commit; push the branch once; open a draft PR "Closes #15", milestone 1.1.0, marked "merge after 1.0.0".
