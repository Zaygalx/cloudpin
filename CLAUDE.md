# cloudpin — project rules

A CLI that pins cloud accounts (az, aws, gcloud, vercel, gh, kubectl, helm, supabase, wrangler) to a repo via a .cloudpin.yml file and blocks
commands, from a human or an AI agent, that would run on a different account. **Read `DESIGN.md` first**
(every product decision and why), then `HANDOFF.md` if it exists: the owner's local session notes (where the
last session stopped, machine notes, provider research), kept out of the repo by `.gitignore`.

Owner: Alvaro Reis (`paureis`). Do not publish to npm, change repository settings or post anywhere without the
owner's explicit yes.

## Commands

| Task | Command |
|---|---|
| Install from lockfile | `npm ci` |
| Tests | `npm test` (vitest) |
| Typecheck | `npm run typecheck` |
| Build to `dist/` | `npm run build` |
| Real-account smoke test | `npm run build` then `node scripts/smoke.mjs [provider...]` |

Run typecheck and tests as separate calls, and read each exit code; a pipe (`| grep`) hides it.

## Dependencies (bitten twice on day one)

- Incremental installs on Windows drop the platform-specific optional packages from the lockfile
  (rolldown, lightningcss), which breaks `npm ci` and CI on macOS/Linux. After adding or removing any dependency:
  delete `./node_modules` and `./package-lock.json`, run `socket npm install`, then confirm
  `grep -c '"node_modules/@rolldown/binding-' package-lock.json` is about 15 and `npm ci` succeeds.
- Keep runtime dependencies minimal (currently `yaml`, `cross-spawn`). Every dependency runs inside
  people's shell wrappers and agent hooks.

## Architecture

The source layout is the table in `AGENTS.md`. `src/exec.ts` is the only place that spawns processes.

## Rules for provider code

1. **Test first, using a fake `Exec`** (see `test/github.test.ts`). No test spawns a real CLI. Temporary
   folders come from `tempDir()` in `test/tmp.ts`, which deletes them; a bare `mkdtempSync` leaks one per run.
2. **Check every CLI behaviour against the official docs or `<cli> --help` before coding it** (flags,
   env vars, precedence, exit codes, output fields) and cite the source in a comment where it isn't obvious.
   Recorded findings go in HANDOFF.md under "Provider research".
3. **Resolve the identity the specific command will use**, not the CLI's default: flags (`--subscription`,
   `--profile`, `--scope`, `--team`, `--project`, `--hostname`) beat env vars, which beat config files.
   Pass the command's own `env` to the CLI so token env vars count.
4. **Pin and compare stable IDs**, case-insensitive only where the provider is (GUIDs, GitHub logins).
5. **Never print, log, cache or put in an error message a token or a credential value.** Messages name
   env vars, never their values. Never run `aws configure list` (it prints key tails) or anything with `--show-token`.
6. **Never spawn with `shell: true`**; use `realExec` (cross-spawn escapes Windows `.cmd` shims).
7. **Real-account smoke test with a control** for every provider that is installed here: the active
   identity must pass and a wrong pin must fail (`scripts/smoke.mjs`). A check that cannot fail proves nothing.
   Real-account tests run **read-only commands only** (list, show, whoami, GraphQL queries): never send a
   request body, `-X POST/PATCH/DELETE`, deploy or set anything on the owner's real accounts (2026-10-08: a
   stdin test turned `gh api user` into a PATCH; GitHub rejected it, but it should never have been sent).
8. Login, logout, switch, whoami, version and help commands are always exempt (`isExempt`).

## Planning: every item has a version and a target week (owner rule, 2026-10-09)

- Whatever a brainstorm or plan agrees on becomes an issue in a version milestone (0.4.0, 1.0.0, 1.1.0, ...) with a
  target week, and ROADMAP.md lists it under that version. "Unscheduled" exists only in ROADMAP's Ideas section; an
  idea gets a version when work on it starts. New work found mid-session gets a version before it is started.
- Targets are aims, not promises: a fix may ship in an unplanned patch release (x.y.z+1), and an item that slips moves
  to the next version with the reason written in its issue.

## How work runs (owner decision, 2026-10-15)

- The session is the orchestrator. Work that changes code or tests, or more than about three files, goes to one
  subagent at a time (Agent tool, `model: "opus"`) with a complete brief: the issue, the files, what done means and
  the rules here that apply. It commits on the issue branch, never pushes, and returns a question when blocked.
- The orchestrator keeps trivial edits, every GitHub write (push, PR, merge, tag), releases and owner questions.
- Verify with evidence, never the report: read the diff, re-run typecheck and tests, run the controls the rules ask for.
- Sort findings by CONTRIBUTING.md "Reviewing a change": one review round and one fix round, then stop.

## Commits

- Small commits, one concern each. Write the message to a file and use `git commit -F <file>`
  (never inline `-m` with quotes or backticks). End with:
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`
- **One branch per issue** (owner decision, 2026-10-08), e.g. `feat/12-environments`, `fix/7-heredocs`,
  `docs/...`, cut from an up-to-date `main` in this folder (no worktree). Run typecheck and tests locally,
  push the branch once when the issue is done (every push to an open PR costs a CI run), open a PR whose body
  says `Closes #N`, and squash-merge it when the `check` job is green (`gh pr checks`; `main` is protected).
  `main` stays releasable: half-done work waits on its branch.
- **CI budget** (owner rule): PRs run one Linux job (`ci.yml`); Windows and the newest Node run nightly only
  when `main` changed (`nightly.yml`; run it by hand before a release); no macOS. Read
  `node scripts/ci-minutes.mjs` at every session close.
- **Personal details stay out of the repo** (owner rule, 2026-10-08; the repo is public): no emails, usernames,
  home or drive paths, machine specifics, real account IDs or session notes in tracked files or commit messages.
  Commits use the owner's GitHub noreply address (this checkout's git config); machine notes go in the
  gitignored `HANDOFF.md`. A local pre-commit hook blocks staged personal strings; never bypass it (`--no-verify`).
- Switching branches never changes the owner's installed cloudpin; only `node scripts/dogfood.mjs install` does.
- Before any `gh` call that writes, confirm `gh auth status --active` shows `paureis`.
- **Releasing needs the owner:** in one `release/x.y.z` PR, bump the version and update the docs (owner rule): the
  CHANGELOG entry, README's `**Latest release: x.y.z**` line, ROADMAP's Shipped list, the bug-report form's example
  version, and any README/DESIGN/AGENTS text the release changes; `test/release-docs.test.ts` fails until the
  first four match `package.json`. Run Nightly on the branch, merge, then push the `vX.Y.Z` tag: `release.yml`
  stages the version on npm with provenance (trusted publishing, no token); the owner waits for "Validating" to end,
  then approves under npmjs.com > Staged Packages. Fallback if the workflow can't publish: start `npm publish
  --access public --auth-type=web` in the Terminal panel (`npm login --auth-type=web` first if npm says 404).

## Editing

- `.gitattributes` forces LF; edit files with the Edit tool rather than CRLF-sensitive sed.
