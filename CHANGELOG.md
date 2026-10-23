# Changelog

All notable changes to cloudpin are listed here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/).

Versions 0.1.0 to 0.4.2 (2026-10-08 to 2026-10-10) are in [docs/changelog-0.x.md](docs/changelog-0.x.md).

## [Unreleased]

### Added

- `cloudpin check --only <clouds>` and `--json` (#10): `--only azure,aws` checks just those clouds and fails one
  that isn't pinned, installed or logged in, so a CI job checks what it deploys to; `--json` prints the result
  (`match`, `mismatch`, `unpinned` or `error`) and each cloud's status, reason and fix, so tools never parse text.
  Plain `cloudpin check` prints and exits as before.
- `CLOUDPIN_BRANCH=<name>` (#10) picks the environment through the `branches` mapping when the checkout has no
  branch, as in CI on pull requests and tags. `CLOUDPIN_ENV` and `cloudpin use` still win, and an agent can't set it
  inside its own command.
- A Homebrew tap (#16): `brew install paureis/tap/cloudpin` on macOS and Linux, from
  [paureis/homebrew-tap](https://github.com/paureis/homebrew-tap). The formula installs the npm tarball, whose sha256
  is the one in each GitHub Release's attested `SHA256SUMS`; like every install, it edits no shell profile and
  installs no agent hook.
- A Scoop bucket (#17): `scoop bucket add paureis https://github.com/paureis/scoop-bucket`, then
  `scoop install paureis/cloudpin` on Windows. It runs on Scoop's own `nodejs-lts` through Scoop's exe shim, so
  arguments reach cloudpin exactly as with npm's shims (a `.cmd` launcher would let cmd.exe re-read `&`, `|`, `%`
  and `^`). Like every install, it edits no shell profile and installs no agent hook.
- Each GitHub Release also has `cloudpin-X.Y.Z-windows.zip` (#17), the file the Scoop bucket installs: the package's
  files plus their production `node_modules`, listed in `SHA256SUMS` and covered by the same signed attestation.
- The MCP server for every agent (#111): `cloudpin mcp` now hands an agent short instructions when it connects (call
  `cloudpin_status` before cloud work and `cloudpin_check` before a cloud CLI command; on a block, stop and tell the
  user the reason and the fix; never work around it), which Codex and Gemini CLI add to the model's instructions.
  [docs/mcp.md](docs/mcp.md) shows how to add the server to Codex, Cursor, VS Code, Gemini CLI, Windsurf, Claude
  Desktop or any stdio client. The server stays read-only. Each release is also listed in the official MCP Registry
  as `io.github.paureis/cloudpin` (`server.json`), by a manual workflow run once its npm version is live.

### Changed

- The update notice and `cloudpin doctor` name the upgrade command for the way cloudpin was installed (#16, #98):
  `brew upgrade cloudpin`, `scoop update cloudpin`, `pnpm add --global cloudpin`, `volta install cloudpin`,
  `yarn global add cloudpin` (Yarn classic) or `bun add --global cloudpin@latest`, otherwise
  `npm install --global cloudpin` as before; so does the error for a `.cloudpin.yml` written for a newer cloudpin.
  Global folders are found at each package manager's defaults and where its folder variables move them
  (`PNPM_HOME`, `PNPM_CONFIG_GLOBAL_DIR`, `VOLTA_HOME`, `BUN_INSTALL` and the like); one moved any other way, such
  as in a config file, still reads as npm.

### Fixed

- Windows: Codex and Copilot CLI hooks work under PowerShell's `Restricted` and `AllSigned` execution policies (#108).
  Both agents run hooks through PowerShell, which starts npm's `cloudpin.ps1` for `cloudpin`, and those policies
  block that script, so the hook failed: Codex then ran commands unchecked and Copilot CLI denied every tool.
  `cloudpin install-hook codex` and `install-hook copilot` now also write a Windows command that starts cloudpin
  through cmd.exe, which no execution policy stops, into the agent's Windows-only field: Codex's `commandWindows`
  (Codex 0.131.0 and later; older versions ignore it) and Copilot CLI's `powershell` key. It also hardens how the hook
  finds cloudpin and Node on Windows. The fields macOS and Linux read are unchanged, so a committed hook file keeps
  working there. Re-run `cloudpin install-hook <agent>` (with `--user` if that is where it is) to update a hook
  installed before; it keeps your other hooks, and Codex runs the changed hook once you review it in `/hooks`.
  Gemini CLI has no Windows-only field, so its hook stays as it was.
- `cloudpin mcp` answered `initialize` for an unknown protocol version with 2026-07-28, a revision that has no
  `initialize`. It now answers with 2025-11-25, the newest revision that has one, and no longer lists 2026-07-28
  (#111).
- `cloudpin doctor` on Windows warns when PowerShell's execution policy would stop an installed agent hook, when
  PATH has `.` or another entry that is not a full path, and when Claude Code is older than 2.1.47, which ran hooks
  through cmd.exe (#108).
- Wrangler: cloudpin now reads the `.env` files Wrangler loads into its own environment before every command
  (`.env` and `.env.local`, plus `.env.<name>` and `.env.<name>.local` with `--env <name>`, or the `--env-file`
  files, in the folder it runs in) (#116). A `CLOUDFLARE_ACCOUNT_ID` there chose the account while cloudpin checked
  the one from Wrangler's account cache or `wrangler whoami`, so a command could run on the wrong account; a
  `CLOUDFLARE_API_TOKEN` there replaced the login cloudpin checked. Both now count, as do `CLOUDFLARE_ENV` and the
  other account and credential variables, with Wrangler's precedence: a non-empty variable already set wins, and
  `account_id` in the Wrangler config still beats them all. cloudpin reads the files with the parser Wrangler uses
  (dotenv's, BSD-2-Clause, copied with its notice). A value it can't work out (one that refers to another variable,
  or a `.env.vault` that `DOTENV_KEY` would decrypt) stops the command, naming the file and variable, never the value.
  Wrangler's account cache is now read from the one folder Wrangler reads it from (`WRANGLER_CACHE_DIR`, else
  `node_modules/.cache/wrangler` if it exists, else `.wrangler/cache`); cloudpin went on to the next folder when that
  one had no account, so an old account cached elsewhere could stand in for the one Wrangler would pick.
- A Vercel token after a short flag group (`vercel -dt VALUE deploy`), or typed joined to `-t` (`-t=VALUE`,
  `-tVALUE`), was printed in full in the block and confirmation messages, in the terminal or the agent's transcript
  (#123). They now show `***` there, as they already did for `-t VALUE` and `--token=VALUE`.
- Vercel: a short flag group such as `vercel -dT other-team deploy` (`-d` is `--debug`) picks the team, the token
  (`-dt`) or the config folder (`-dQ`) the way Vercel reads it, so cloudpin checks that account instead of the active
  one (#125). A group's value also no longer passes for the command: `vercel -dT whoami deploy` isn't exempt.

## [1.1.2] - 2026-10-19

Completes the 1.1.1 security fix for Windows. Please upgrade.

### Security

- Windows: CLIs installed by npm (vercel, wrangler, ...) no longer start a `node` found in the current folder. npm's
  `.cmd` shims run `node` by name when no node.exe sits beside them, and Windows looked for it in the current folder
  first. cloudpin now tells Windows not to search the current folder for any process it starts, including the command
  `cloudpin exec` runs, as PowerShell and Git Bash already do
  ([GHSA-3cf7-5v5w-q5vr](https://github.com/paureis/cloudpin/security/advisories/GHSA-3cf7-5v5w-q5vr)).

## [1.1.1] - 2026-10-18

A security fix for Windows. Please upgrade.

### Security

- Windows: cloudpin now runs each CLI it asks about (az, gh, vercel, aws, gcloud, kubectl, helm, supabase,
  wrangler), and the command `cloudpin exec` runs, by its full path from PATH, skipping empty and relative PATH
  entries. Before, Windows' own lookup checked the current folder first, so a file named like one of those CLIs
  inside a repository could run in its place when cloudpin checked a command there
  ([GHSA-3cf7-5v5w-q5vr](https://github.com/paureis/cloudpin/security/advisories/GHSA-3cf7-5v5w-q5vr)).

## [1.1.0] - 2026-10-16

Claude Code gets a one-step plugin, and any MCP agent can ask cloudpin before it acts.

### Added

- A Claude Code plugin (#15): `claude plugin install cloudpin --marketplace paureis/cloudpin` installs the hook, a
  read-only MCP server and a skill that tells the agent to check first and stop on a block. With the plugin enabled,
  `install-hook claude` declines and `doctor` warns if a settings hook would also run.
- `cloudpin mcp` (#15): a read-only MCP server (stdio) with `cloudpin_status` and `cloudpin_check`, for any agent that
  supports MCP. No new dependency.

## [1.0.0] - 2026-10-15

The first stable release: the `.cloudpin.yml` format is stable from here on (later versions only add sections and
keys), and every agent hook except Gemini CLI's is tested inside the real agent.

### Fixed

- Variables an agent sets earlier in its command line now count (#86). `export AWS_PROFILE=other; aws ...` and
  PowerShell `$env:AWS_PROFILE = 'other'; aws ...` were checked against the default account and ran on another; and
  `GH_TOKEN=$(cat other.token) gh ...` read the token as empty. cloudpin now follows `export`, `unset` and `$env:`
  through the line, and stops a command whose account depends on a value only known when it runs, saying why. Found
  in the threat-model review.
- Cursor: a command on your Cursor allowlist runs again when the account matches (#2). cloudpin answered `ask`, which
  stopped even allowlisted commands; it now answers `allow`, which Cursor treats exactly like having no hook (measured
  in Cursor CLI 2026.10.01: commands not on the allowlist still need your approval). Wrong accounts are still blocked.

### Added

- Antigravity hooks (#80): `cloudpin install-hook antigravity` guards Antigravity CLI, the IDE and Antigravity 2.0
  (`.agents/hooks.json`, or `~/.gemini/config/hooks.json` with `--user`). Google replaced Gemini CLI with Antigravity
  CLI for free and consumer accounts on 2026-06-18. The hook checks `run_command` and text typed into a running
  terminal; it asks rather than allows when nothing is wrong, so Antigravity's own approvals still apply.
- The Copilot CLI and Antigravity CLI hooks are tested inside the real agents (#3): a wrong pin blocks the command, a
  right one lets it run, and Antigravity's own approval still applies to commands you haven't allowed.
