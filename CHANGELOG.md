# Changelog

All notable changes to cloudpin are listed here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/).

Versions 0.1.0 to 0.4.2 (2026-10-08 to 2026-10-10) are in [docs/changelog-0.x.md](docs/changelog-0.x.md).

## [Unreleased]

### Added

- [THREAT_MODEL.md](THREAT_MODEL.md) (#84): what cloudpin protects against, what it trusts, the code behind each control,
  and what it deliberately doesn't try to stop.
- A standalone `cloudpin.exe` for 64-bit Windows (#96), in each GitHub Release as `cloudpin-X.Y.Z-win-x64.zip`
  (listed in `SHA256SUMS` and covered by the signed attestation): a Node.js single executable application with
  cloudpin and its two dependencies inside, built with the exact Node.js 26 pinned in `scripts/exe-node-version.txt`,
  so it needs no Node.js installed. It names its own upgrade: `winget upgrade paureis.cloudpin` when winget installed
  it, otherwise to download the latest zip. Nightly opens an issue when a newer Node.js 26 security release appears.
- winget manifests for `paureis.cloudpin` (#96) in `packaging/winget/`: a portable zip installing `cloudpin.exe` as
  the `cloudpin` command. `node scripts/bump-installers.mjs X.Y.Z --winget <dir>` renders them for a release, after
  checking the exe zip against `SHA256SUMS`, and `docs/winget.md` lists the maintainer's steps to submit them.
- MCP: a third read-only tool, `cloudpin_doctor` (#112): the same report as `cloudpin doctor --json` (cloudpin on
  PATH, shell wrappers, agent hooks, on Windows the PowerShell execution policy, the pin file and each CLI's account,
  each with its fix), so an agent can tell you why cloudpin isn't guarding. Account IDs are shortened, and it skips
  the identity cache check, which writes a file.
- Docs: [Guard a Claude Agent SDK app](docs/agent-sdk.md) (#142). An app that loads project settings needs no code;
  for one that loads none, there is a Python and a TypeScript `PreToolUse` callback that denies on every error.
- `cloudpin switch [--yes] [--json] [--only <clouds>]` (#14) switches each pinned CLI to its pinned account. It shows a
  plan, asks once, runs each CLI's own switch command without a shell (`az account set`, `gh auth switch --hostname
  --user`, `vercel teams switch <slug>`, `gcloud config set ... --quiet`, `kubectl config use-context` and, for a pinned
  namespace, `set-context --current --namespace`), then checks again, exiting 0 only when every pinned, installed CLI
  matches. When several kube contexts or AWS profiles fit, you pick one by number in a terminal. What it won't do is named for you: a missing login, `supabase link`, a Wrangler config edit, or
  something that overrides the switch (`GH_TOKEN`, `CLOUDSDK_CORE_PROJECT`, `AWS_ACCESS_KEY_ID`, `VERCEL_ORG_ID`,
  `HELM_KUBECONTEXT`, gcloud impersonation, a scope in `vercel.json`, in any spelling on Windows). AWS profiles are
  found in the AWS config file, reading only profile names, `sso_account_id` and `role_arn` (never the credentials
  file). `--json` prints the plan, what ran and the `check --json` report after, and never prompts. An agent's `cloudpin switch` asks you first, with `--yes` too and however it is spelled (agents whose
  hooks can't ask are told to ask you to run it). A blocked command's fix also suggests it, except for Supabase and
  Wrangler.
- `cloudpin shell-init` also defines a `cloudpin` function (#14), so `cloudpin switch` can set `AWS_PROFILE` in your
  shell: it applies only an `AWS_PROFILE=<name>` line from a temporary file (never eval), and passes every other command
  straight through. The guarded shell functions now look for the cloudpin executable with `type -P` (bash) or
  `whence -p` (zsh), so that function can't make them think cloudpin is still installed after an uninstall.

### Security

- `cloudpin explain` (text and `--json`) and the MCP `cloudpin_check` tool no longer repeat a token or password from
  the command line (#134): `--token`, kubectl's `--token` and `--password`, helm's `--kube-token` and the other
  credential flags are masked, as in cloudpin's own block messages, also inside `cmd /c`, `powershell -Command` and
  `-EncodedCommand`. The verdict is still worked out from the real values.

### Fixed

- Short flags joined with `=` (for example, `wrangler deploy -e=production`) were ignored by the shared
  argument reader, so cloudpin could resolve the account without the requested environment (#118). It now
  reads the joined form only for the CLIs that accept it, starting with Wrangler.
- Vercel: `-y` inside a short group (`vercel project inspect -dy`) asks on a protected environment, since it can create
  and link a project, and `vercel teams change` and the `team` alias are exempt like `teams switch` (#148).
- Help no longer exempts a command that runs anyway (#153): a kubectl or helm plugin given `--help` (it gets the flag
  as an argument), a value flag that takes it (`gh secret set X --body --help`), and Wrangler's `--help false` and
  `--no-help`. `gh ... --web --help` is checked as well, at the cost of one check.
- Vercel: `vercel deploy <dir>`, a bare `vercel <dir>`, `vercel pull <dir>` and `vercel dev <dir>` are checked against
  the link of the folder they name, not the one they run in (#147). A folder known only when the command runs
  (`vercel deploy "$D"`) stops as "can't tell".
- kubectl: a kuberc alias whose arguments hold a short flag group (`-itnprod`, `-iA`, `-is <url>`) is read as the
  group it is, and a short flag's value is the next word whole, so `kubectl logs pod -c -n x` is not namespace x. The
  user's own short flags after an alias follow the alias command's letters (#140).
- Wrangler auth profiles (#103): a command run with `--profile`, or in a folder bound by `wrangler auth activate`,
  is checked against that profile's login and its own account cache, not the default one. When nothing else names
  the account and Wrangler can't be asked about the profile (a `--profile` the folder isn't bound to, with no API
  token or key in the environment or the project's `.env` files), it stops the command. `cloudpin explain` names the
  profile and why. Profiles are read from Wrangler's config folder, which an `XDG_CONFIG_HOME` or (on Windows)
  `APPDATA` set in `.env` moves.
- Cloudflare account variables (#119): a command line that sets `CLOUDFLARE_ACCOUNT_ID`, `CF_ACCOUNT_ID`,
  `CLOUDFLARE_ENV`, `WRANGLER_CACHE_DIR`, `DOTENV_KEY` or another variable that picks Wrangler's account to a value
  cloudpin can't know (`$(...)`, backticks, `$OTHER`) stops as "can't tell" instead of being checked without it.
- Windows: variable names are read without regard to case, as Windows and the CLIs do (#119), so a lowercase
  `gh_token`, `aws_profile`, `azure_config_dir` or `cloudflare_account_id` counts. One variable set in two spellings
  to different values stops as "can't tell".
- Windows: cloudpin's own variables are read without regard to case too (#136): a lowercase `cloudpin_env`,
  `cloudpin_branch`, `cloudpin_confirm` or `cloudpin_skip` you set counts, and an agent still can't set or unset
  `CLOUDPIN_ENV` or `CLOUDPIN_BRANCH` in any spelling. The read-only check on a protected environment reads folded
  names, so a lowercase `aws_config_file` counts there as well.
- Agent hooks: what `cloudpin exec` starts is read as a command of its own (#14), so a call behind a wrapper or a shell
  inside it, as in `cloudpin exec -- bash -c 'az ...'` or `cloudpin exec -- npx wrangler ...`, is checked instead of
  passing as an unguarded `bash` or `npx`.
- Agent hooks: a `cloudpin` call whose subcommand is only known when it runs (`cloudpin $x`) asks you first (#14), since
  it may be `cloudpin use` or `cloudpin switch`. Cursor's matcher finds a CLI in any case (`AZ.CMD`).

## [1.2.1] - 2026-10-29

Fixes agent-hook gaps where a command could run on the wrong account without being checked (1.2.0 and earlier have
them). Please upgrade.

### Fixed

- Agent hooks: a heredoc inside `$( )`, as in `git commit -m "$(cat <<'EOF' ... it's ... EOF)" && az ...`, no
  longer hides the calls after it. Carriage returns are dropped as Git Bash does, `(( ))` and `$(( ))` are read as
  arithmetic, and `$'...'` is decoded ([#161](https://github.com/paureis/cloudpin/issues/161)).
- Agent hooks: an account flag whose value is only known when the command runs (`--subscription $(cat f)`,
  `--context="$X"`, an unknown `$VAR` or `"$@"`) gives "can't tell" instead of being read as empty. A variable set
  earlier on the same line is substituted, which also ends a false block. An unquoted `$( )` counts as one word that is
  not a flag ([#160](https://github.com/paureis/cloudpin/issues/160)).
- Agent hooks read PowerShell commands with PowerShell's rules: Claude Code's and Copilot's PowerShell tools, and on
  Windows the agents that don't name their shell (Codex, Gemini CLI, Cursor, Antigravity) are read both ways, and every
  call either reading finds is checked. Each call is also checked as Windows PowerShell 5.1 would pass it. `cloudpin
  explain --powershell` and `cloudpin_check`'s `shell` argument take the dialect
  ([#159](https://github.com/paureis/cloudpin/issues/159)).
- Agent hooks find the call behind wrappers and runners: `env`, `sudo`, `nice`, `timeout`, `exec`, `command`,
  `xargs`, `watch`, `npx`, `npm exec`, `pnpm`, `yarn`, `bunx`, `cmd /c`, `powershell -Command` and
  `-EncodedCommand`, `Invoke-Expression` and `Start-Process` ([#162](https://github.com/paureis/cloudpin/issues/162)).
- gcloud: `--impersonate-service-account` (and its variable and property) is checked as the account the command runs
  as, the last one in a delegation chain. An access token or token file gives "can't tell" for an account pin; a
  project pin is still checked ([#165](https://github.com/paureis/cloudpin/issues/165)).

### Changed

- These fixes fail closed, so some lines that ran before now stop as "can't tell": `... | xargs <guarded CLI>`,
  cmd's `%VAR%`, `^`, `if`, `for` and `start`, an `Invoke-Expression` or `-EncodedCommand` that can't be read, and on
  Windows a bash variable or `$env:X` in a command from an agent that doesn't name its shell. Run such a command
  yourself, or write the values out.

## [1.2.0] - 2026-10-29

Run it everywhere: a GitHub Action, Homebrew and Scoop, the MCP server for every agent, and sharper Vercel and
Wrangler account checks.

### Added

- A GitHub Action, [paureis/cloudpin-action](https://github.com/paureis/cloudpin-action) (#10): `uses:
  paureis/cloudpin-action@v1` after a job's cloud logins fails the job before it deploys to an account other than the
  pinned one, with a job summary and an annotation per failing cloud.
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

- Agent hooks and `cloudpin explain` read shell redirections and process substitutions as the shell does (#154, #156):
  `az 2>&1 group list --subscription other` and `az group list <(true) --subscription other` were read as ending at
  `2>` or `<`, which hid the `--subscription` after them and checked the default account instead. Redirection words
  (`> out.txt`, `2>/dev/null`) are no longer taken as arguments.
- A help or version flag no longer exempts a command the CLI still runs (#146): `vercel deploy --prod -v`, a deploy
  flag before an exempt word (`vercel --prod --name whoami`), `vercel promote <id> --help`, `wrangler deploy -v`,
  `gcloud app deploy --version v2`, `az keyvault secret set-attributes --version x` and `gh repo create x -h <url>`
  are checked, and so is any CLI's `--help` after `--` or written `--help=false`.
- kubectl and helm: `-itn other-ns`, `-is <server>` and `-Aw` are checked against the namespace and server they pick (#133), and
  `KUBECONFIG=$(...)`, `HELM_NAMESPACE=$(...)` or Supabase's `SUPABASE_PROJECT_ID=$(...)` stop the command as "can't tell".
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
- Wrangler with `--env-file`: cloudpin's `wrangler whoami` now reads the same files, so a token in the folder's
  default `.env` can no longer make it vouch for an account the command won't use (#130).
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
- Vercel: `--scope` beats `--team` whatever their order, and with neither, the `scope` in `vercel.json` (or the
  `-A` file) picks the team, as in Vercel; a local config that can't be read stops the command (#127).

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
