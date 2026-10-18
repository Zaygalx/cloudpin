# Notes for AI coding agents

cloudpin guards commands that touch real cloud accounts. Read [CONTRIBUTING.md](CONTRIBUTING.md) first; its
ground rules are firm. In short:

- When cloudpin can't tell which account a command would use, it blocks. Never change that to allow.
- Never print, log or cache a credential; name environment variables, never their values.
- Never spawn a process through a shell; use `realExec` in `src/exec.ts`.
- Check every CLI behaviour against its documentation or `--help` before coding it, and cite the source.
- Write the test first, with a fake `Exec`. No test may run a real CLI.
- When trying a provider against a real account, run read-only commands only.

## Commands

| Task | Command |
|---|---|
| Install from the lockfile | `npm ci` |
| Type-check | `npm run typecheck` |
| Tests | `npm test` |
| Build | `npm run build` |

Run the type-check and the tests as separate commands and read each exit code.

## Layout

| Path | What it is |
|---|---|
| `src/config.ts` | `.cloudpin.yml` parsing and lookup, environments and which one applies |
| `src/git.ts` | Branch and `cloudpin use` choice, read from the git folder without spawning git |
| `src/readonly.ts` | Which commands only read, so they skip confirmation on a protected environment |
| `src/confirm.ts`, `src/use.ts` | The terminal confirmation and `cloudpin use` |
| `src/providers/` | One file per CLI, implementing `ProviderDef` from `src/types.ts` |
| `src/guard.ts` | The allow-or-block decision |
| `src/check.ts` | `cloudpin check`: the report behind it, its text and JSON output, and `--only` |
| `src/status.ts`, `src/doctor.ts` | `cloudpin status` and `cloudpin doctor` (read-only overviews) |
| `src/explain.ts` | `cloudpin explain`: a verdict and its reasons, from guard's `Trace` |
| `src/mcp.ts`, `src/mcp-tools.ts` | `cloudpin mcp`: the JSON-RPC stdio server, and its two read-only tools |
| `plugin/`, `.claude-plugin/marketplace.json` | The Claude Code plugin (hook, MCP server, skill) and its marketplace |
| `src/shellwords.ts` | Finds CLI calls inside a full shell command line |
| `src/hooks/agents.ts` | One adapter per AI agent's hook format |
| `src/cache.ts` | The identity cache |
| `src/update.ts`, `src/install-method.ts` | The daily update notice, and how cloudpin was installed (npm, Homebrew, Scoop, pnpm, Volta, Yarn, Bun, winget, the standalone exe) so upgrade advice names the right command |
| `src/version.ts` | cloudpin's version: package.json's, or the literal the exe bundle inlines |
| `src/cli.ts` | The `cloudpin` command |
| `scripts/build-exe.mjs`, `scripts/check-exe.ps1` | The standalone `cloudpin.exe` (a Node SEA) and its zip, and the Windows checks Nightly runs on it |
| `packaging/winget/`, `docs/winget.md` | The winget manifest templates that `scripts/bump-installers.mjs --winget` fills in, and how the maintainer submits them |
| `DESIGN.md` | Product decisions and why they were made |
