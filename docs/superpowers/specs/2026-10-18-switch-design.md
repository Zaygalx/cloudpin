# `cloudpin switch` (#14)

Owner-approved design, 2026-10-18. Ships in 1.3.0 "Fix it, see it" (Thursday 2026-12-03). The base behaviour was
agreed on 2026-10-08 (issue #14): show a plan, confirm once, run, re-check. The points below were settled with the
owner on 2026-10-18; the CLI facts were checked against each CLI's docs, `--help` and source the same day (sources in
the table).

## Behaviour

1. Find the pin file and its active environment, exactly as `cloudpin check` does (`CLOUDPIN_ENV`, `cloudpin use`,
   branch mapping, first listed). `--only <list>` limits it to some providers, as in `check`.
2. Resolve each pinned provider (the same resolution `check` uses). For each one not on its pinned identity, plan one
   of:
   - **run**: one or more commands cloudpin will run (argv, never a shell string);
   - **choose**: several candidates match (two AWS profiles for the account, two kube contexts for the server); in a
     terminal the user picks one by number at the confirm, otherwise the line is skipped and lists the candidates;
   - **manual**: something cloudpin will not or cannot do (a login is missing, an env var overrides the switch, the
     CLI has no switch, or the switch would touch credentials or repo files); the line names the exact command or
     variable for the user;
   - providers already on the pinned identity show as `ok`; not installed shows as skipped, as in `check`.
3. Print the plan and ask once: `Run these N commands? [y/N]`. `--yes` skips this question. Without a terminal and
   without `--yes`, print the plan and run nothing (exit 1 if anything is not on its pin).
4. Run the **run** lines one after another, each through `realExec` (no shell). A failing command does not stop the
   others. Print each command before it runs and its result after.
5. Re-check every pinned provider (cache invalidated for the switched ones) and print the same result lines as
   `check`. Exit 0 only if every pinned, installed provider now matches; otherwise 1.

Never logs in or out, never reads or writes a credential, never prints a token. Missing logins are **skipped, the
rest run** (owner decision): the plan shows "log in as X: <login command>", and the re-check shows it still
mismatched.

## Agents (owner decision)

- The agent hook treats `cloudpin switch` like `cloudpin use <env>` today: it **asks the human** (Claude Code,
  Cursor, Copilot: `ask` with the plan summary as the reason). Agents without an `ask` (Codex, Gemini CLI,
  Antigravity) get **deny** with "ask the human to run `cloudpin switch`". `--yes` never changes the hook's decision;
  it only skips cloudpin's own y/N. A bare `cloudpin switch --help` is not asked about.
- The MCP server stays read-only: no switch tool.
- The block message (guard's `fix` text) suggests `cloudpin switch` as well as the provider's own switch hint.
- An AWS switch cannot persist in an agent's shell (each Bash call is a new shell); for agents, the AWS line says to
  pass `--profile <name>` instead.

## `--json` (owner decision)

One JSON object on stdout: `{ result, path, environment, plan: [...], ran: [...], after: <CheckReport> }`.
- Each `plan` entry: `{ provider, status: "ok" | "run" | "choose" | "manual" | "not-installed", commands?: string[][],
  candidates?: string[], reason?: string }`.
- Each `ran` entry: `{ provider, command: string[], code: number }` (no stdout or stderr captured into JSON: CLIs may
  echo account details; the re-check reports the outcome).
- `after` is the `cloudpin check --json` report shape, run after the switches.
- With `--json` cloudpin never prompts (stdout is the JSON): without `--yes` it prints the plan with `ran: []` and
  `after: null`, and runs nothing. **choose** lines are never resolved in JSON mode.

## Per CLI

| CLI | Plan | Checks before planning | Source |
|---|---|---|---|
| az | `az account set --subscription <pinned GUID>` (never a name) | The subscription is in the local cache (read-only `az account list -o json`); if not: manual "`az login --tenant <tenant>`". `AZURE_CONFIG_DIR` is honoured by passing the command's env | `az account set --help`; azure-cli `_profile.py` `set_active_subscription` (local only, exit 1 on no/ambiguous match) |
| gh | `gh auth switch --hostname <host> --user <user>` (always both flags; without a TTY gh errors when it would prompt) | `GH_TOKEN`/`GITHUB_TOKEN` (or the enterprise pair for a non-github.com host) set: manual "unset <VAR>" (gh refuses to switch then, exit 1, and the env token wins anyway). The user not logged in on that host (read the account list without any token output: prefer `gh auth status --json` if gh supports it, checked against `gh auth status --help`; never parse a token line): manual "`gh auth login --hostname <host>`" | cli.github.com/manual/gh_auth_switch; cli/cli `pkg/cmd/auth/switch/switch.go` |
| vercel | `vercel teams switch <slug>`: the pinned team ID mapped to its slug from `vercel teams ls --format json` (all pages). Use `teams switch`, not the top-level `switch`, which refuses when a token is set | Logged out (no login file or token, as the provider already checks): manual "`vercel login`" (vercel would start a login flow). Team ID not in the list: manual "log in as a member of team <id>". In a linked folder project commands use the link's `orgId`, which `switch` does not change: if the linked `orgId` (or `VERCEL_ORG_ID`) differs from the pin, manual "`vercel link`" / "unset VERCEL_ORG_ID" | vercel.com/docs/cli/switch; vercel 50.35 `src/commands/teams/switch.ts` (slug only) |
| gcloud | `gcloud config set account <a> --quiet` and/or `gcloud config set project <p> --quiet`; add `--configuration <name>` when the command's env selects one (`CLOUDSDK_ACTIVE_CONFIG_NAME`) | The account has credentials (`gcloud auth list --format=json`); if not: manual "`gcloud auth login <a>`". `CLOUDSDK_CORE_ACCOUNT`/`CLOUDSDK_CORE_PROJECT` set: manual "unset <VAR>" (env beats config). `--quiet` stops the "Are you sure" prompt `config set project` shows when it can't confirm access | cloud.google.com/sdk/gcloud/reference/config/set; `gcloud topic configurations`; SDK `surface/config/set.py` |
| kubectl / helm | `kubectl config use-context <context>` for the context whose cluster server equals the pin; with a pinned namespace prefer a context with that namespace too, otherwise add `kubectl config set-context --current --namespace=<ns>` (owner decision; it edits that context, which the plan says) | No context for the server: manual "add a context for <server> to your kubeconfig". Several: **choose**. `HELM_KUBECONTEXT` set: manual "unset HELM_KUBECONTEXT" for helm. Pass the command's env so `KUBECONFIG` counts; the plan names the file `use-context` writes (`--kubeconfig`, else the first existing `KUBECONFIG` entry, else `~/.kube/config`) | kubernetes.io kubectl `config use-context`; client-go `clientcmd/config.go` `GetDefaultFilename` |
| aws | No CLI command: the switch is `AWS_PROFILE`. Find profiles in the AWS **config** file (`AWS_CONFIG_FILE`, else `~/.aws/config`; `[default]` and `[profile name]`) whose account is the pin, offline: `sso_account_id`, or the account field of `role_arn`. Read only those keys and section names; never read the credentials file; never keep, print or log any other value | None found: manual "add a profile for account <id> (`aws configure sso`)" (profiles with only `credential_process` or static keys can't be matched offline; say so). Several: **choose**. `AWS_ACCESS_KEY_ID` set: manual "unset AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_SESSION_TOKEN" (env keys beat the profile) | docs.aws.amazon.com/cli/latest/userguide/cli-configure-files.html; aws-cli v2 `configprovider.py` (`AWS_PROFILE` before `AWS_DEFAULT_PROFILE`; botocore checks `AWS_DEFAULT_PROFILE` first) |
| supabase | **manual** only (owner decision): "`supabase link --project-ref <ref>`", noting it writes `supabase/.temp/` and fetches the project's API keys. `SUPABASE_PROJECT_ID` set: "unset SUPABASE_PROJECT_ID" | | supabase CLI `apps/cli/src/commands/link/SIDE_EFFECTS.md` |
| wrangler | **manual** only: the existing switch hint (set `account_id` in the Wrangler config) | | developers.cloudflare.com/workers/wrangler; workers-auth `factory.ts` |

Profile and context names that cloudpin runs or hands to the shell must match `^[A-Za-z0-9._@:/-]{1,128}$` (kube
contexts may contain `@`, `:` and `/`); `AWS_PROFILE` values must match `^[A-Za-z0-9._-]{1,64}$`. Anything else
becomes a manual line with the name quoted, never run.

## AWS_PROFILE in the current shell (owner decision)

- `cloudpin shell-init` also defines a `cloudpin` function (bash/zsh: `function cloudpin`; PowerShell: `function
  cloudpin`). Only for `cloudpin switch`, it creates a temp file (`mktemp`; PowerShell 5.1:
  `[IO.Path]::GetTempFileName()`), runs the real cloudpin with `CLOUDPIN_ENV_FILE=<file>`, then reads the file line
  by line and applies only `AWS_PROFILE=<value>` where the value matches `^[A-Za-z0-9._-]{1,64}$`, plus unsetting
  `AWS_DEFAULT_PROFILE`. No eval, no `Invoke-Expression`. It deletes the file and returns cloudpin's exit code. Every
  other `cloudpin ...` call passes straight through (stdio untouched, so prompts and TTY detection still work).
- `cloudpin switch` writes `AWS_PROFILE=<name>` to `CLOUDPIN_ENV_FILE` only when that variable is set and the user
  confirmed; otherwise it prints `export AWS_PROFILE=<name>` / `$env:AWS_PROFILE = '<name>'` and says it was not
  applied.
- The guarded-CLI functions' fallback check changes from `command -v cloudpin` (which a `cloudpin` function would
  satisfy even after uninstall) to `type -P cloudpin` (bash) / `whence -p cloudpin` (zsh); PowerShell's
  `-CommandType Application` check is already correct. The new function itself falls back cleanly when cloudpin is
  not installed.
- `CLOUDPIN_ENV_FILE` joins the user-only variables (`USER_ONLY_VARS`), so a command line can't set it for an agent.
- Prior art: common-fate granted's `assume` script reads fixed fields from its helper's output and exports them
  explicitly, without eval.

## Docs to change

- README and SECURITY.md: replace "never switches accounts" with "switches only when you run `cloudpin switch` and
  confirm (an agent's attempt asks you first)". README's file list: cloudpin now reads the AWS config file (profile
  names, `sso_account_id` and `role_arn` only), never the credentials file.
- DESIGN.md edge case "never logs in or changes accounts" updated the same way; the Decisions table gains a row.
- `cloudpin --help` lists `switch [--yes] [--json] [--only <list>]`.
- CHANGELOG under Unreleased; ROADMAP keeps #14 under 1.3.0.

## Out of scope

- Logging in, or running `supabase link`, or editing a Wrangler config.
- Switching for an environment other than the active one (use `CLOUDPIN_ENV=<name> cloudpin switch`).
- An MCP switch tool.

## Testing

- Unit tests with a fake `Exec` for every planner (each row above, including every manual case and the env-var
  overrides), the runner (a failing command doesn't stop the others), the re-check, the JSON shape, the no-terminal
  and `--yes` paths, the agent hook's ask/deny, the AWS config parser (fixtures with `sso_session`, `role_arn`,
  `credential_process`, static keys, odd names; a test proves no other value reaches output), and the shell-init
  function (generated text, plus running it in bash where bash exists, as the shell-init tests already do).
- Real accounts: read-only planning only (`cloudpin switch` answered "n", and `--json` without `--yes`) with a wrong-pin
  control that must produce a **run** line. Actually switching any of the owner's accounts needs the owner's explicit
  yes per account, and must switch back. gcloud has no testbed on this machine any more: unit tests only.
