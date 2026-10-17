# cloudpin-action: implementation plan (part 2 of #10)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans. Follow cloudpin's CLAUDE.md: one subagent at a time commits and never pushes.

**Goal:** the GitHub Action `paureis/cloudpin-action`: one step that fails a CI job when its cloud logins aren't the
accounts pinned in `.cloudpin.yml`.

**Architecture:** a composite action (`action.yml`, `shell: bash` steps) that installs a pinned cloudpin into
`$RUNNER_TEMP`, verifies npm signatures, runs `cloudpin check --json` (strict via `--only`), and hands the JSON to a
small dependency-free Node script that writes the job summary, annotations and the `result` output and sets the exit
code. The script is unit-tested with `node --test`.

**Tech Stack:** GitHub Actions composite action, bash, Node 22+ (`node:test`), no npm dependencies in the repo.

**Spec:** `docs/superpowers/specs/2026-10-16-github-action-design.md` (in the cloudpin repo). cloudpin's part 1
(`check --only`, `--json`, `CLOUDPIN_BRANCH`) is merged on cloudpin `main` (4182a1b) and ships in cloudpin 1.2.0.

Repo: `paureis/cloudpin-action`, cloned next to this one as `../cloudpin-action` (branch `main` has only
GitHub's initial commit with `LICENSE`). Work on branch `feat/1-action` cut from `main`.

## Global Constraints

- No `node_modules`, no `package.json` dependencies, no build step: plain `.mjs` run by the runner's `node`.
- Never print a credential; the summary shows only cloudpin's JSON texts (`problems`, `fix`, `error`).
- Fail closed: the step exits 0 only for `result` `match` or `unpinned`; anything unexpected (unparseable JSON,
  missing file, unknown result value) fails the step with a message.
- Third-party actions in workflows are pinned by full SHA, as in cloudpin:
  `actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1`,
  `actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1 # v7.1.0`.
- CI budget: one Linux job on pull requests and pushes to `main`, with
  `concurrency: { group: test-${{ github.event.pull_request.number || github.ref }}, cancel-in-progress: true }`.
- Files are LF: add `.gitattributes` with `* text=auto eol=lf`.
- Commits: message from a file, `git commit -F`, ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`;
  never `--no-verify` (a local hook blocks personal strings).

## Review Focus

1. Input `check` empty: the action must still be strict for every pinned cloud (two passes: a plain `--json` run
   to learn the pinned providers, then `--only` with them), and must not run `--only ""` (Task 2).
2. Input `check: "Azure, aws"`: passed through as is; cloudpin normalizes (Task 2 test case).
3. cloudpin prints something that isn't JSON (old version without `--json`, crash): the step fails with "could not
   read cloudpin's result", never passes (Task 1).
4. A `pull_request` run (detached HEAD): `CLOUDPIN_BRANCH` is `GITHUB_HEAD_REF`; on push and tags it is
   `GITHUB_REF_NAME`; `environment` input wins via `CLOUDPIN_ENV` (Task 2).
5. Windows runner: no reliance on `.bin` shims; run `node "$DIR/node_modules/cloudpin/dist/cli.js"` (Task 2).

---

### Task 1: `report.mjs`, the JSON-to-summary step (unit-tested)

**Files:** Create `src/report.mjs`, `test/report.test.mjs`, `.gitattributes`.

**Interfaces:**
- Produces: `export function summarize(jsonText: string): { result: "match"|"mismatch"|"unpinned"|"error", exitCode: 0|1, summary: string, annotations: string[] }`
  and a CLI entry: `node src/report.mjs <json-file>` that calls `summarize`, appends `summary` to
  `$GITHUB_STEP_SUMMARY`, prints each annotation line, writes `result=<value>` to `$GITHUB_OUTPUT`, and exits
  with `exitCode`. Missing env files are skipped (so it runs locally).
- `summary`: a heading line (`### cloudpin: all checked accounts match` / `account mismatch, deploy stopped` /
  `nothing is pinned` / `could not check` ), then, when there are providers, a Markdown table
  `| Cloud | Status | Details |` with one row per provider (details = problems joined with `; `, then `fix: ...`),
  then `error` when present. Escape `|` in cells.
- `annotations`: `::error title=cloudpin <provider>::<problems>; fix: <fix>` for each provider whose status isn't
  `match` (and for `not-installed` only when the report has `only`), plus `::error title=cloudpin::<error>` for
  `error`. Newlines in messages are encoded as `%0A` (GitHub workflow-command escaping: `%` as `%25`, CR `%0D`, LF `%0A`).

- [ ] **Step 1: Write failing tests** (`node:test`, `assert/strict`) with JSON fixtures copied from cloudpin's
  real output (the match and mismatch kubernetes reports in the part-1 PR #94 description and in
  `test/check.test.ts`):
  - match -> `result "match"`, `exitCode 0`, summary starts with `### cloudpin: all checked accounts match`, no
    annotations.
  - mismatch -> `exitCode 1`, one annotation starting `::error title=cloudpin kubernetes::server: expected`,
    summary table row contains `mismatch`.
  - unpinned -> `exitCode 0`, heading `nothing is pinned`.
  - error with `error: "invalid config: x"` -> `exitCode 1`, annotation `::error title=cloudpin::invalid config: x`.
  - not JSON (`"cloudpin: checking ..."`) and `{"result":"weird"}` -> `result "error"`, `exitCode 1`, summary says
    `could not read cloudpin's result`.
  - a problem containing `|` and a newline is escaped in the table and the annotation.
- [ ] **Step 2: Run** `node --test test/` -> FAIL.
- [ ] **Step 3: Implement** `src/report.mjs`.
- [ ] **Step 4: Run** `node --test test/` -> PASS.
- [ ] **Step 5: Commit** "report.mjs: turn cloudpin's JSON into a job summary".

### Task 2: `action.yml`

**Files:** Create `action.yml`.

**Interfaces:** consumes `src/report.mjs` (Task 1) via `${{ github.action_path }}/src/report.mjs`.

- Metadata: `name: cloudpin account check` (Marketplace-unique; the builder searches the Marketplace for the name
  and changes it if taken), `description` one line, `author: paureis`, `branding: { icon: lock, color: blue }`.
- Inputs: `check` (default `""`), `version` (default `"1.2.0"`), `working-directory` (default `"."`),
  `environment` (default `""`), and an undocumented-in-README `package` (default `""`; when set, it is passed to
  `npm install` instead of `cloudpin@<version>`, used by this repo's tests to install a tarball built from
  cloudpin `main`). Output `result` from the run step.
- Steps (all `shell: bash`, inputs passed through `env:`, never interpolated into the script text):
  1. Fail with `::error::cloudpin-action needs Node.js 22 or later; add actions/setup-node first` when `node` is
     missing or older than 22.
  2. `DIR="$RUNNER_TEMP/cloudpin"`; `npm install --prefix "$DIR" --ignore-scripts --no-audit --no-fund "$SPEC"`
     (`SPEC` = `package` input or `cloudpin@$VERSION`).
  3. When `package` is empty: `npm audit signatures --prefix "$DIR"`; a failure fails the step. (The builder runs
     it once for real against `cloudpin@1.1.0` to confirm it checks a `--prefix` install, and adjusts the command
     if not.)
  4. In `working-directory`: set `CLOUDPIN_BRANCH="${GITHUB_HEAD_REF:-$GITHUB_REF_NAME}"`, and `CLOUDPIN_ENV` when
     `environment` is set. `CLI="node $DIR/node_modules/cloudpin/dist/cli.js"`. When `check` is empty: run
     `$CLI check --json` (ignore its exit code), read the pinned provider names from its `providers` with node; if
     there are none, keep that report; else run `$CLI check --json --only <names joined by ,>`. When `check` is
     set: run `$CLI check --json --only "$CHECK"`. Save stdout to `$RUNNER_TEMP/cloudpin-report.json`, let
     stderr through to the log.
  5. `node "$GITHUB_ACTION_PATH/src/report.mjs" "$RUNNER_TEMP/cloudpin-report.json"`; its exit code is the step's.

- [ ] **Step 1: Write** `action.yml` as above.
- [ ] **Step 2: Validate** the YAML parses (`node -e` with no YAML library is not possible; use
  `python -c "import yaml,sys; yaml.safe_load(open('action.yml'))"` if Python with PyYAML is present, else rely
  on Task 3's run) and `bash -n` each `run:` block extracted to a temp file.
- [ ] **Step 3: Commit** "action.yml: install, check, report".

### Task 3: test workflow

**Files:** Create `.github/workflows/test.yml`, `test/fixtures/kubeconfig`.

- Triggers: `pull_request`, `push` to `main`, `workflow_dispatch` (with a `runner` choice input, default
  `ubuntu-latest`, so the owner can run it once on `windows-latest` before release). Concurrency and SHA pins as in
  the constraints. `permissions: contents: read`.
- One job: checkout this repo; checkout `paureis/cloudpin` at `main` into `cloudpin-src`; setup-node 22;
  `npm ci && npm run build && npm pack` there; set `KUBECONFIG` to `test/fixtures/kubeconfig` (one context, server
  `https://a.example.invalid`); `node --test test/`; then, each in its own temp folder with its own `.cloudpin.yml`,
  `uses: ./` with `package: <the tarball>`:
  - pin `https://a.example.invalid`, `check: kubernetes` -> outcome success, output `match`;
  - pin `https://b.example.invalid`, `check: kubernetes`, `continue-on-error: true` -> a following step asserts
    outcome `failure` and output `mismatch` (the control);
  - no `.cloudpin.yml`, `check` empty -> success, `unpinned`;
  - pin kubernetes only, `check: aws` -> failure, `error`;
  - pin kubernetes and github, `check: kubernetes` -> success although `gh` isn't logged in;
  - pin kubernetes, `check` empty -> success, `match` (the two-pass path).
- [ ] **Step 1: Write** the workflow and fixture.
- [ ] **Step 2: Lint** with `actionlint` if available on PATH; otherwise note it.
- [ ] **Step 3: Commit** "test workflow: real runs against a fake kubeconfig, with a failing control".
  (The orchestrator pushes and reads the run; the job's green run is this task's real test.)

### Task 4: README and SECURITY

**Files:** Create `README.md`, `SECURITY.md`.

- README: what it does (one paragraph), usage after the cloud logins and before the deploy, three examples
  (Azure with `azure/login`, AWS with `aws-actions/configure-aws-credentials`, a two-cloud job with
  `check: azure, aws`), inputs and output tables, what it doesn't do (no login, no switching, checks the logins at
  that step, not each later command), pin by full SHA recommendation, link to cloudpin's `.cloudpin.yml` docs. Mark
  the Azure and AWS examples "written from the official docs" until the owner's real Azure run. MIT.
- SECURITY.md: one paragraph pointing to cloudpin's SECURITY.md and private vulnerability reporting.
- [ ] **Step 1: Write** both. **Step 2: Commit** "README and SECURITY".

## After the plan (the orchestrator and the owner)

- Orchestrator: verify (diff, `node --test`), push `feat/1-action` once, open the PR, read the test run; merge when
  green. Branch protection on the new repo is a settings change: ask the owner.
- Owner, at home: the real Azure run (OIDC federated credential on an Azure app, repo variables), right pin passes
  and a wrong pin fails; one `workflow_dispatch` run on `windows-latest`.
- Release day 2026-11-05: cloudpin 1.2.0 first; then tag `v1.0.0` and `v1` here and publish the release with the
  Marketplace checkbox (the owner's click). cloudpin's README "Can I use it in CI?" then points to the Action.
