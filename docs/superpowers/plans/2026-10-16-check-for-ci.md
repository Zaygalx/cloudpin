# `cloudpin check` for CI: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
> In this repo, also follow CLAUDE.md: one subagent at a time commits on the branch and never pushes.

**Goal:** give `cloudpin check` what the GitHub Action needs: `--only`, `--json` and a `CLOUDPIN_BRANCH` override.

**Architecture:** move `check()`'s logic out of `src/cli.ts` into a testable `runCheck()` in a new `src/check.ts`
that returns a report object (like `collectStatus` in `src/status.ts`); `cli.ts` parses the flags and prints the
report as today's text or as JSON. `CLOUDPIN_BRANCH` is read in `selectEnvironment` and is a user-only variable.

**Tech Stack:** TypeScript (Node 22+), vitest, fake `GuardDeps` (pattern: `test/status.test.ts`).

**Spec:** `docs/superpowers/specs/2026-10-16-github-action-design.md`, section "Changes in cloudpin itself".
The Action itself (new repo `paureis/cloudpin-action`) is a separate plan, after the owner says yes to the repo.

Branch: `feat/10-github-action` (already holds the spec commit). Issue #10, milestone 1.2.0.

## Global Constraints

- No new dependency; nothing spawns outside `src/exec.ts`; no `shell: true`.
- Never print, log or put in JSON a token or credential value (CLAUDE.md rule 5); the report carries only the
  `problems` and `fix` strings guard already produces.
- `cloudpin check` without flags prints exactly what it prints today (same lines, same exit codes): existing
  users and scripts must not see a change.
- Exit codes: 0 when the result is `match` or `unpinned`; 1 otherwise (today's meaning).
- Provider names in `--only` are the pin section names: `azure, aws, gcloud, vercel, github, kubernetes, supabase,
  cloudflare` (`PROVIDERS` in `src/config.ts`).
- Tests use `tempDir()` from `test/tmp.ts` for folders; no test spawns a real CLI.
- Commits: message written to a file, `git commit -F`, ending with
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`; never `--no-verify`.

## Review Focus

1. An agent writes `CLOUDPIN_BRANCH=main aws s3 rm ...` to pick a laxer environment: must be ignored in agent
   mode, exactly like `CLOUDPIN_ENV` (test in Task 1).
2. `--only "Azure, aws"` (spaces, capitals, as typed in a workflow input): accepted as `azure` and `aws` (Task 2).
3. `--only aws` when aws is pinned but not installed on the runner: fails, it must never pass as "nothing to
   check" (Task 2).
4. `--only ""` or `--only ,` (an empty Action input passed through): a usage error, not "check nothing and pass"
   (Task 3).
5. `--only kubernetes` with no `.cloudpin.yml` at all: result `error`, exit 1 (Task 2).

---

### Task 1: `CLOUDPIN_BRANCH`

**Files:**
- Modify: `src/config.ts` (`selectEnvironment`, around lines 233-258)
- Modify: `src/shellwords.ts:29` (`USER_ONLY_VARS`)
- Modify: `src/mcp-tools.ts:59` (comment only: add CLOUDPIN_BRANCH to the list)
- Test: `test/environments.test.ts`, `test/shellwords.test.ts`

**Interfaces:**
- Produces: `selectEnvironment` treats `sel.env.CLOUDPIN_BRANCH` (non-empty) as the branch, before `sel.branch`.
  `source` reads `branch "<name>" (CLOUDPIN_BRANCH)` when it came from the variable.

- [ ] **Step 1: Write the failing tests** in `test/environments.test.ts` (reuse the file's `project` fixture with
  `branches` mapping `main` to `production`, first environment `staging`):
  - `uses CLOUDPIN_BRANCH on a detached HEAD`: `selectEnvironment(project, { env: { CLOUDPIN_BRANCH: "main" }, branch: null })`
    matches `{ name: "production", source: 'branch "main" (CLOUDPIN_BRANCH)' }`.
  - `CLOUDPIN_BRANCH beats the checked-out branch`: `{ env: { CLOUDPIN_BRANCH: "main" }, branch: "feature/x" }` gives
    `production`.
  - `CLOUDPIN_ENV and cloudpin use still win`: `{ env: { CLOUDPIN_ENV: "staging", CLOUDPIN_BRANCH: "main" } }` gives
    `staging`; `{ env: { CLOUDPIN_BRANCH: "main" }, chosen: "staging" }` gives `staging`.
  - `ignores an empty CLOUDPIN_BRANCH`: `{ env: { CLOUDPIN_BRANCH: "" }, branch: "main" }` gives `production` with
    source `branch "main"`.
  And in `test/shellwords.test.ts`, next to the existing USER_ONLY_VARS cases: an agent line
  `CLOUDPIN_BRANCH=main aws s3 ls` does not put `CLOUDPIN_BRANCH` in the call's env (copy the existing
  `CLOUDPIN_ENV` agent test and change the name).
- [ ] **Step 2: Run** `npx vitest run test/environments.test.ts test/shellwords.test.ts`. Expected: the new tests
  FAIL, the old ones pass.
- [ ] **Step 3: Implement** in `selectEnvironment`: `const branch = sel.env.CLOUDPIN_BRANCH || sel.branch`, used in
  the branch-mapping step, with the source suffix above when the variable supplied it. Add `"CLOUDPIN_BRANCH"` to
  `USER_ONLY_VARS`. Update the JSDoc order comment above `selectEnvironment`.
- [ ] **Step 4: Run** `npm run typecheck`, then `npm test`. Expected: all pass.
- [ ] **Step 5: Commit** "CLOUDPIN_BRANCH: pick the environment by branch on a detached HEAD (#10)".

### Task 2: `runCheck()` in `src/check.ts`

**Files:**
- Create: `src/check.ts`
- Modify: `src/cli.ts` (`check()` at lines 120-173 becomes a thin wrapper; Task 3 adds the flags)
- Test: `test/check.test.ts`

**Interfaces:**
- Consumes: `GuardDeps`, `guard()` from `src/guard.ts`; `PROVIDERS`, `ConfigError` from `src/config.ts`.
- Produces:
  ```ts
  export type CheckStatus = "match" | "mismatch" | "not-logged-in" | "unknown" | "not-installed" | "unsupported";
  export interface CheckEntry { provider: string; status: CheckStatus; problems: string[]; fix?: string }
  export interface CheckReport {
    result: "match" | "mismatch" | "unpinned" | "error";
    path: string | null;
    environment: { name: string; protected: boolean; source: string } | null;
    error?: string;          // invalid config, or a bad --only list
    providers: CheckEntry[]; // pinned providers, in PROVIDERS order (only the listed ones with --only)
  }
  export async function runCheck(
    cwd: string, env: NodeJS.ProcessEnv, deps: GuardDeps, opts?: { only?: string[] },
  ): Promise<CheckReport>
  export const checkExitCode = (r: CheckReport): 0 | 1 => (r.result === "match" || r.result === "unpinned" ? 0 : 1);
  ```
- Rules (the spec's, made exact):
  - Guard each pinned provider as `check()` does today (`mode: "agent"`, so `CLOUDPIN_SKIP` can't pass a check).
  - Status: allow `not-installed` -> `not-installed`; allow or confirm -> `match`; block with `uncertain` ->
    `unknown`; block whose problems are exactly `["not logged in"]` -> `not-logged-in`; other block -> `mismatch`;
    a pin this version has no provider for -> `unsupported`.
  - Without `only`: `not-installed` is not a failure (today's behaviour).
  - With `only`: names are trimmed and lowercased; an unknown name, or a name not pinned in the selected pins, makes
    `result: "error"` with `error` naming it; a listed provider that is `not-installed` is a failure.
  - `result`: invalid config -> `error`; no config -> `unpinned`, or `error` when `only` was given; any `unknown` or
    `unsupported` -> `error`; else any `mismatch`, `not-logged-in` or (with `only`) `not-installed` -> `mismatch`;
    else `match`.

- [ ] **Step 1: Write the failing tests** in `test/check.test.ts`, with a fake provider and `deps` helper copied from
  `test/status.test.ts`:
  - `match`: github pinned `user: me`, identity `me` -> `{ result: "match", providers: [{ provider: "github", status: "match" }] }`, exit 0.
  - `mismatch`: identity `other` -> `result "mismatch"`, entry `status "mismatch"` with the compare problem and
    `fix: "switch"`, exit 1.
  - `not-logged-in`: resolution `{ kind: "logged-out", hint: "gh auth login" }` -> entry `not-logged-in`, `fix`
    `"gh auth login"`, result `mismatch`.
  - `unknown`: resolution `{ kind: "error", message: "boom" }` with the CLI on PATH -> entry `unknown`, result `error`.
  - `unpinned`: `findConfig` returns null -> `{ result: "unpinned", path: null, providers: [] }`, exit 0.
  - `invalid config`: `findConfig` throws `new ConfigError("bad")` -> `result "error"`, `error` contains `bad`.
  - `only filters`: github and aws pinned, aws logged out, `only: ["github"]` -> result `match`, one entry.
  - `only normalizes`: `only: [" GitHub "]` behaves as `["github"]`.
  - `only: listed but not installed fails`: `onPath` returns null for gh, `only: ["github"]` -> entry
    `not-installed`, result `mismatch`, exit 1; the same without `only` -> result `match`.
  - `only: unknown or unpinned name`: `only: ["nope"]` and `only: ["aws"]` with only github pinned -> result
    `error`, `error` names the provider.
  - `only without a pin file`: `findConfig` null, `only: ["github"]` -> result `error`.
- [ ] **Step 2: Run** `npx vitest run test/check.test.ts`. Expected: FAIL (module not found).
- [ ] **Step 3: Implement** `runCheck` and `checkExitCode` in `src/check.ts`, and make `cli.ts`'s `check()` call
  `runCheck(process.cwd(), process.env, deps)` and print the report with a `formatCheckText(report): string[]`
  exported from `src/check.ts` that reproduces today's lines exactly (the `cloudpin: checking ...`,
  `  environment: ...`, `  ok`, `  -`, `  x`, `  ?` lines and the "no .cloudpin.yml" and "invalid config" messages;
  copy the strings from the current `check()`).
- [ ] **Step 4: Add a text-format test**: `formatCheckText` of the `mismatch` and `not-installed` reports equals the
  exact lines the current `check()` prints for those cases (copy them from today's code), so the plain output
  can't drift.
- [ ] **Step 5: Run** `npm run typecheck`, then `npm test`. Expected: all pass.
- [ ] **Step 6: Commit** "check: a testable report behind cloudpin check (#10)".

### Task 3: `--only` and `--json` flags, docs

**Files:**
- Modify: `src/cli.ts` (the `case "check":` dispatch around line 367, and the usage text)
- Modify: `README.md` (the `cloudpin check` example around line 79, "Can I use it in CI?" around line 348, the
  Configuration variables table around line 305), `CHANGELOG.md` (Unreleased, "Added"), `AGENTS.md` (layout table:
  `src/check.ts`)
- Test: `test/check.test.ts` (argument parsing)

**Interfaces:**
- Consumes: `runCheck`, `checkExitCode`, `formatCheckText` from Task 2.
- Produces: `export function parseCheckArgs(args: string[]): { json: boolean; only?: string[] } | { error: string }`
  in `src/check.ts`. Accepted forms: `--json`, `--only a,b`, `--only=a,b`; anything else is an error.
  `--json` prints `JSON.stringify(report, null, 2)` and nothing else on stdout.

- [ ] **Step 1: Write the failing tests**:
  - `parseCheckArgs([])` -> `{ json: false }`; `["--json"]` -> `{ json: true }`;
    `["--only", "azure, aws"]` -> `{ json: false, only: ["azure", " aws"] }` (split on commas, not trimmed:
    `runCheck` normalizes); `["--only=azure,aws", "--json"]` -> `{ json: true, only: ["azure", "aws"] }`;
    `["--only"]`, `["--only", ""]`, `["--only", " , "]` (no name left after trimming) -> `{ error }` mentioning `--only`;
    `["--frob"]` -> `{ error }` naming `--frob`.
- [ ] **Step 2: Run** `npx vitest run test/check.test.ts`. Expected: the new tests FAIL.
- [ ] **Step 3: Implement** `parseCheckArgs`, and in `cli.ts`: on `{ error }` print it with the check usage line to
  stderr and return 1; otherwise run `runCheck` with `only`, print JSON or `formatCheckText`, return
  `checkExitCode`. Usage text: `cloudpin check [--only <clouds>] [--json]` with one line explaining each.
- [ ] **Step 4: Docs.** README: document both flags next to the `cloudpin check` example; "Can I use it in CI?"
  mentions `--only` for runners with preinstalled CLIs; Configuration table gains
  `| CLOUDPIN_BRANCH=<name> | Use this branch for the branches mapping, e.g. in CI on a detached checkout (ignored for agents) |`.
  CHANGELOG Unreleased "Added": one bullet for `check --only` and `--json`, one for `CLOUDPIN_BRANCH`, both `(#10)`.
  AGENTS.md: a row for `src/check.ts`.
- [ ] **Step 5: Manual check** with the built CLI: `npm run build`, then in a temp folder with a kubeconfig whose
  context server is `https://a.example.invalid` (set `KUBECONFIG` to it) and a `.cloudpin.yml` pinning
  `kubernetes: server: "https://a.example.invalid"`: `node <repo>/dist/cli.js check --json --only kubernetes`
  prints `"result": "match"` and exits 0; change the pin to `https://b.example.invalid`: `"result": "mismatch"`,
  exit 1 (the control). Plain `check` prints the same lines as before the change.
- [ ] **Step 6: Run** `npm run typecheck`, then `npm test`. Expected: all pass.
- [ ] **Step 7: Commit** "check --only and --json, documented (#10)".
