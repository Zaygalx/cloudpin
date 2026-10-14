# Threat model

What cloudpin protects against, what it trusts, and what it deliberately does not try to stop. Each control names
the code that implements it, so a claim here can be checked rather than taken on trust. Report a gap through
[SECURITY.md](SECURITY.md).

## What cloudpin is for

cloudpin stops a cloud CLI command (`az`, `aws`, `gcloud`, `vercel`, `gh`, `kubectl`, `helm`, `supabase`, `wrangler`)
from running when it would act on a different account than the one the project pins in `.cloudpin.yml`. The command
can come from a person in a terminal or from an AI coding agent.

The threat is a **mistake**, not an adversary: a person or agent that is logged in to the wrong account, or whose
command picks another account through a flag, an environment variable or a linked project file, without noticing.
cloudpin is a seatbelt, not a sandbox.

## Assets

- **The cloud accounts** a project pins, and the resources in them. The harm being prevented is a deploy, change or
  delete landing on the wrong account.
- **The credentials** the CLIs hold. cloudpin must never expose them while checking.

## Actors and how much cloudpin trusts them

| Actor | Trust | What follows |
|---|---|---|
| The person at the terminal | Trusted | `CLOUDPIN_SKIP=1` and `CLOUDPIN_CONFIRM` let them override a check on purpose (`src/guard.ts`, shell mode). |
| An AI agent running commands through a hook | Trusted to mean well, not to check | The agent can't skip, confirm or pick an environment from inside its own command: hook mode drops `CLOUDPIN_SKIP`, `CLOUDPIN_CONFIRM` and `CLOUDPIN_ENV` set there (`withoutUserOnlyVars` in `src/hooks/agents.ts`), and `cloudpin use` needs the user's OK. |
| The project's `.cloudpin.yml` | Trusted as the project's own policy | Whoever controls the repository decides the pins, the protected environments and extra `read_only` commands. Cloning a repository means accepting its pin file, as with any other project configuration. |
| Each cloud CLI and its config files | Trusted to report its own identity | cloudpin asks the CLI who it is (or reads its config, for kubeconfig and linked-project files) and never second-guesses the answer. |

## Controls

- **Resolve the account the specific command will use**, not the CLI's default: its flags beat its environment
  variables, which beat its config files (`src/providers/*.ts`, one per CLI, each citing the CLI's documentation).
- **Pin stable IDs, not names**: subscription IDs, account numbers, team IDs, API server URLs (`src/config.ts`).
  Several Azure subscriptions can share the name "Azure subscription 1".
- **Fail closed, and explain**: when cloudpin can't tell which account a command would use (an expired login, a
  broken token, no network), it blocks the command and says why (`src/guard.ts`, `uncertain`). A pin file it can't
  parse also blocks every guarded command except login, logout, switch, whoami, help and version (#62, #67).
- **Agent hooks fail closed once cloudpin is running**: an error inside the hook, or a check slower than 45 seconds,
  becomes an explicit deny (`runHook` in `src/hooks/agents.ts`), because some agents (Claude Code and Codex among
  them) run the command when a hook crashes or times out. If cloudpin can't start at all (uninstalled, or not on the
  agent's PATH), there is nothing to answer and those agents run the command; `cloudpin doctor` checks that cloudpin
  is on PATH and which hooks are installed.
- **"No objection" never weakens the agent's own approvals**: each hook answers so that the agent's normal rules still
  apply. This was measured inside Cursor and Antigravity (#2, #80).
- **Whole command lines, not just the first word**: pipes, `&&`, subshells, `bash -c`, `eval`, `xargs`, `find -exec`,
  `npx` and heredocs are searched for guarded CLIs (`src/shellwords.ts`, with fuzz tests in
  `test/shellwords-fuzz.test.ts`). Variables the line sets before a call count (`export AWS_PROFILE=other;`,
  PowerShell `$env:`), and a call whose account depends on a value only known when it runs (`GH_TOKEN=$(cat f) gh`)
  is blocked as "can't tell" (#86).
- **Never touch credentials**: cloudpin only runs each CLI's read-only identity command, never prints, logs or caches
  a token, and never runs commands that print secrets (`aws configure list`, `--show-token`, `--reveal`). Error
  messages name environment variables, never their values.
- **No shell when spawning**: every process starts through `realExec` with arguments as a list
  (`src/exec.ts`, cross-spawn), so a command line is never re-interpreted by a shell.
- **A short cache that can't go stale on a switch**: a successful identity is reused for at most 5 minutes, keyed by a
  salted HMAC of the command, its identity-relevant environment variables and the CLI's account files, so
  `az account set` or a changed `GH_TOKEN` is seen immediately. Failures are never cached (`src/cache.ts`).
- **Supply chain**: two runtime dependencies (`yaml`, `cross-spawn`), npm provenance, signed GitHub Releases with build
  attestations, GitHub Actions pinned by commit, CodeQL and Socket on every pull request, and OpenSSF Scorecard
  weekly.

## Out of scope

These are real limits, stated so nobody relies on cloudpin for them:

- **A malicious or prompt-injected agent.** An agent that can write files can edit `.cloudpin.yml` to pin its current
  account, remove the hook from its own settings, or write a script and run it later (`bash deploy.sh`), which
  cloudpin can't see into. cloudpin catches an agent's honest mistake; it is not a sandbox. Use the agent's own
  permission system for that, and in it deny the agent edits to `.cloudpin.yml` and to its own hook settings file.
- **Which resource inside the account.** cloudpin checks the identity a command acts as and the account or project it
  lands in, not which repository, Vercel project, region or resource group it targets. `gh repo delete other/repo`
  passes if you are logged in as the pinned user. (A pinned Kubernetes namespace is the exception.)
- **A command cloudpin doesn't guard.** Only the CLIs above are checked. A cloud SDK called from a program, `curl` to a
  cloud API, a Terraform run, or an agent's MCP tools for a cloud provider (which never go through the shell hook) act
  on whatever credentials they find.
- **A compromised machine or PATH.** A fake `az` earlier on PATH, a tampered kubeconfig or a malicious shell profile
  can make the CLI report any identity.
- **Environment set up by someone else.** Variables set before the agent starts are the user's choice and are
  honoured, including `CLOUDPIN_ENV` and an `AWS_PROFILE` pointing at another account.
- **A shell without the wrapper.** In a terminal, protection exists only where `cloudpin shell-init` was loaded; an
  alias that runs another program instead of the CLI bypasses it, and cloudpin warns about that at shell start (#69).
- **CLIs not tested on a real account**: Wrangler (#56) and Gemini CLI are built to their documentation and tested
  with fakes, as the README says.
