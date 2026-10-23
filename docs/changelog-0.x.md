# Changelog: 0.x

cloudpin's releases before 1.0.0, moved here from [CHANGELOG.md](../CHANGELOG.md) on 2026-10-23 to keep that file
short. Newer versions are listed there.

## [0.4.2] - 2026-10-10

A clearer first run: CLIs you don't have are called "not installed".

### Fixed

- `init`, `status`, `doctor` and the MCP `cloudpin_status` say "not installed" for a CLI that isn't (#75). `init` used
  to print `az account show failed (exit 127)` or `spawn wrangler ENOENT`, and `status` and `doctor` told someone
  without Vercel, kubectl or Supabase to log in to it.

## [0.4.1] - 2026-10-09

Shell wrappers that survive your aliases, a clear message for pin files from a newer cloudpin, and cleaner GitHub
Releases.

### Fixed

- The bash and zsh wrappers no longer break on an existing alias of a guarded CLI (#69). Before, such an alias left
  that CLI unguarded without a word, and in zsh every CLI after it too. An alias that calls the CLI itself is now
  guarded; one that runs another program (`kubectl=kubecolor`) can't be, so each new shell warns about it, in
  PowerShell as well.
- GitHub Releases carry only the tarball, its signed bundle and `SHA256SUMS` (#65): v0.4.0 also got the repo's
  logo and demo SVGs, since removed by hand. The verify commands in the release notes now line up.
- A `.cloudpin.yml` section or key that this cloudpin doesn't know is still refused, but the message now says the
  file may need a newer cloudpin, with your version and the update command (#67). From 1.0 the format only adds
  names, so this is what a teammate on an older version will see.

## [0.4.0] - 2026-10-09

Releases you can verify, and exempt commands that still run when the pin file is broken.

### Fixed

- A broken `.cloudpin.yml` no longer blocks exempt commands such as `gh auth status`, `az login` or `--help` (#62):
  they never act on an account and are what you need to investigate. Every other guarded command is still stopped.

### Added

- A GitHub Release for every tag (#53): the package tarball (the same file npm serves), its SHA-256 checksum and a
  signed build-provenance attestation, with the CHANGELOG section and how to verify a download as notes. See
  SECURITY.md, Verifying a release.

## [0.3.1] - 2026-10-09

An update notice, and a quieter `doctor` and `status` outside Supabase projects.

### Added

- An update notice (#50): at most once a day, cloudpin's own commands run in a terminal ask registry.npmjs.org for
  the latest version and say in one line when a newer one is out. Never from the shell wrappers, `exec` or the agent
  hooks, never in CI; off with `CLOUDPIN_NO_UPDATE_CHECK=1` or `NO_UPDATE_NOTIFIER=1`. `cloudpin doctor` checks too,
  and `cloudpin version` works as well as `--version`.

### Fixed

- `cloudpin doctor` and `cloudpin status` no longer warn about Supabase (or Wrangler) in a folder that has no
  project for it (#48); they note it instead. A pinned CLI with nothing to target is still stopped.

## [0.3.0] - 2026-10-09

Two more CLIs, two commands for when something looks off, and a fix for Cursor users. The `.cloudpin.yml`
format is backwards compatible (new `supabase` and `cloudflare` sections). **Cursor users: re-run
`cloudpin install-hook cursor`** (see Fixed).

### Added

- Supabase CLI (#37): pin the project ref, and optionally the organisation. The project a command targets is worked
  out offline, in the CLI's own order (`--project-ref`, `SUPABASE_PROJECT_ID`, the ref `supabase link` saved, with
  `--workdir` / `SUPABASE_WORKDIR`); a linked branch counts as its parent project; the organisation comes from
  `supabase projects list`. Local-stack commands are never blocked; a remote `--db-url` is stopped.
- Cloudflare Wrangler (#37): pin the account ID. The account follows Wrangler's order: `account_id` in
  `wrangler.json` / `wrangler.jsonc` / `wrangler.toml` (its `[env.NAME]` under `--env` or `CLOUDFLARE_ENV`), then
  `CLOUDFLARE_ACCOUNT_ID`, then the project's account cache, then the credentials' only account; several accounts
  with none set is stopped. A config file cloudpin can't read, `deploy --temporary`, and a generated deploy config
  naming another account are stopped too. Built to Wrangler's source and docs; not yet run against a real login.
- `cloudpin explain` (#36): what cloudpin would decide for a command, and why, without running it: the pin file and
  environment, the pinned value, the account the command would use and what decided it (its own flags and env), whether
  it counts as read-only, and the verdict with its reason and fix. A quoted line shows every call in it and the folder
  each runs in; `--agent` explains what an agent hook decides; `--json` for tools. Env vars set in the line are named,
  never shown.
- `cloudpin doctor` (#35): checks the whole setup, read-only, and gives the fix for each problem: the `cloudpin`
  on PATH (the one hooks and shell lines run) and its version, Node.js, the shell profiles that run `shell-init`
  (PowerShell's own `$PROFILE` included), each agent hook and whether it is out of date, the pin file and its
  environment, each CLI's account against its pin, and the identity cache folder. Exit 1 if anything fails.
  `--json` shortens account IDs and writes the home folder as `~`, for bug reports; the bug report form asks for it.

### Fixed

- The Cursor hook now runs for `kubectl`, `helm` and `cloudpin use` commands (#42). Its command filter was written
  before 0.2.0 added Kubernetes, so Cursor let those commands through without asking cloudpin. **Cursor users:
  re-run `cloudpin install-hook cursor`** (add `--user` if you installed it for your user); it now updates the
  filter instead of saying the hook is already installed.

### Changed

- `cloudpin init` no longer writes a docs URL into the `.cloudpin.yml` header (#39).

## [0.2.1] - 2026-10-08

The first release published from GitHub Actions. No change to how cloudpin behaves.

### Added

- Releases are published from GitHub Actions with npm trusted publishing and provenance (#19): npm shows which
  commit and workflow built each version.
- An OpenSSF Scorecard workflow (weekly) and badge (#20), and CodeQL static analysis.

## [0.2.0] - 2026-10-08

Environments, Kubernetes, and fixes from a safety review. The `.cloudpin.yml` format is backwards compatible.

### Added

- `cloudpin status`: each CLI's active account, the pins that apply here, and the installed agent hooks;
  `--json` for tools (the MCP server and editor extension build on it).
- Environments (#12): one `.cloudpin.yml` can pin several environments (`environments:`), chosen by
  `CLOUDPIN_ENV`, `cloudpin use <name>`, a `branches` mapping or the first listed. `cloudpin init --env <name>
  [--protected]` adds one; `status`, `check` and every message name the active environment.
- Protected environments: on the right account, commands that may change something ask first (a y/N prompt, the
  agent's own "ask" in Claude Code, Copilot CLI and Cursor, a block in Codex and Gemini CLI, `CLOUDPIN_CONFIRM` in CI).
  Read-only commands are listed per CLI and can be extended with `read_only:`.

- Kubernetes (#13): a `kubernetes:` section pins the cluster API server URL and, optionally, the namespace, for
  `kubectl` and `helm`. The target is read from the kubeconfig the way kubectl does (flags, `KUBECONFIG` merging,
  helm's `HELM_*` variables, kuberc), without contacting the cluster.

- Vercel monorepos linked with `vercel link --repo` (#4): the team of the project a command acts on is read from
  `.vercel/repo.json` the way the CLI picks it; if the folder matches no project, every linked project's team must
  match the pin.

### Changed

- The flat `.cloudpin.yml` format keeps working unchanged; it is now the single-environment case.

### Fixed

- The identity cache no longer holds the whole `gcloud config list` output, which can include credentials such as
  `proxy/password` (#22); only the account and project are requested. A kubeconfig server URL with
  `user:password@` is shown without it.
- Logins and account switches are recognised after global flags (#21), e.g. `aws --profile p sso login` or
  `vercel --scope t switch`; before, a logged-out command like these could be blocked.
- Agent hooks fail closed: an unexpected error or a check slower than 45 seconds now blocks the command instead of
  letting the agent run it (agents treat a failed or timed-out hook as no objection).
- Messages no longer repeat the value of `--token`, `--password`, `--kube-token` or Vercel's `-t`.
- Command parsing (#7): an apostrophe in heredoc data no longer hides the commands after it; heredocs and
  here-strings fed to a shell are checked; a `cd` inside `( )`, `$( )` or `bash -c` no longer applies to later
  commands; commands held in variables and PowerShell `$x = <command>` assignments are checked.
- Vercel: every page of `vercel teams ls` is read (#5). With the current team on a later page, cloudpin assumed
  the Hobby team, so a command on another team could pass if the Hobby team was pinned.
- An agent could skip the check by wrapping a command in `cloudpin exec` (shell mode, where `CLOUDPIN_SKIP` works);
  the agent hook now checks the wrapped command as the agent's.

## [0.1.0] - 2026-10-08

First public beta.

### Added

- `.cloudpin.yml` pins accounts per project for `az`, `aws`, `gcloud`, `vercel` / `vc` and `gh`; the nearest file
  above the current folder wins.
- Identity checks that follow each command's own flags and environment, including Vercel commands that touch both a
  team and a linked project.
- `cloudpin init`, `check`, `exec`, `shell-init` (bash, zsh, PowerShell), `hook`, `install-hook` and
  `uninstall-hook`.
- Agent hooks for Claude Code, Codex, Cursor, Gemini CLI and GitHub Copilot CLI.
- A five-minute identity cache that is dropped as soon as any account file, variable or flag changes.
- Plain "could not tell" messages when an account can't be determined, with the CLI's own reason.
