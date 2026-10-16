# cloudpin GitHub Action: design

Issue #10, milestone 1.2.0 ("Run it everywhere", release Thursday 2026-11-05). Decided with the owner on 2026-10-16.

## Why

CI jobs often log into several clouds before deploying (Azure, AWS, Google Cloud, Vercel, GitHub, Kubernetes,
Supabase, Cloudflare). A wrong secret, a copied workflow or a stale variable can point a deploy at the wrong
account, and nothing in the job says so. cloudpin already pins the right accounts in `.cloudpin.yml`; the Action
runs that check in CI so the job stops before the deploy step.

## Goals

- One step a team adds to an existing workflow, after its cloud logins and before its deploy:
  `- uses: paureis/cloudpin-action@v1`.
- The step fails the job when a checked cloud is not installed, not logged in, or on an account other than the one
  pinned, or when cloudpin can't tell which account is active (fail closed, the same rule as everywhere else in
  cloudpin).
- The reason and the fix are readable in the step log and in the job summary.
- Works on GitHub-hosted Linux, Windows and macOS runners.
- Listed on GitHub Marketplace.

## Non-goals (for 1.2.0)

- Guarding every later command in the job (each `aws --profile ...` in a deploy step). That needs the shell wrapper
  in every step; it is a later idea, decided with the owner.
- Logging in, switching accounts, or reading or printing any credential. The Action only checks.
- A warn-only mode. A mismatch always fails the job.

## Anti-goals (a failure even if it technically works)

- Any path where a mismatch or an "I can't tell" lets the job continue green.
- Printing a token or credential value, in logs or the summary.
- Installing an unpinned or unverified cloudpin, or running npm install scripts.
- Adding work to cloudpin's own CI budget beyond one short Linux job per pull request in the new repo.

## Decided (owner, 2026-10-16)

- **Audience:** any team whose CI logs into more than one cloud, not only the owner's pipelines.
- **Location:** a separate public repo, `paureis/cloudpin-action`, because GitHub Marketplace lists one action per
  repo with `action.yml` at the root (docs.github.com, "Publishing actions in GitHub Marketplace", read 2026-10-16).
  Creating the repo needs the owner's yes; publishing to Marketplace is a checkbox on the release page that the
  owner ticks (it needs 2FA and the Marketplace developer agreement).
- **On mismatch:** fail the job, always.
- **Scope:** one check at the point where the step runs, using each CLI's active login.
- **Which clouds are checked:** an input `check` lists them (for example `azure, aws`). Each listed cloud must be
  installed, logged in and on the pinned account, or the step fails. Pinned clouds that aren't listed are ignored.
  Empty (the default) means every cloud pinned in `.cloudpin.yml`, with the same strict rule. Reason: hosted runners
  ship az, aws, gcloud, gh and kubectl preinstalled, so a laptop-style pin file would otherwise fail every job on a
  CLI the job never logs into.
- **Real-login test:** before the 1.2.0 release, one manual run against the owner's real Azure login (GitHub OIDC to
  Azure on the new repo; the owner sets it up from written steps when at home): the right pin passes and a wrong
  pin fails. Kubernetes stays the automated test.

## Changes in cloudpin itself (ship in cloudpin 1.2.0, before the Action's v1.0.0)

Settled by Claude after the builder check (the owner can override):

- **`cloudpin check --only <providers>`**: checks only the listed providers (cloudpin's pin names: azure, aws,
  gcloud, vercel, github, kubernetes, supabase, cloudflare), and a listed provider that isn't installed or isn't
  logged in fails. A provider listed but not pinned is an error, not a pass. Without `--only`, `check` behaves as
  today. The Action passes the `check` input, or every pinned provider when it's empty, so the Action is strict.
- **`cloudpin check --json`**: a machine-readable result, so the Action never parses English text: an overall
  `result` (`match`, `mismatch`, `unpinned`, `error` for an invalid pin file, "can't tell" or an unsupported pin)
  and one entry per provider with its status and the same reason and fix text the human output shows. Exit codes
  stay as they are (0 pass, 1 fail). No credential value is ever in it (the existing rule).
- **`CLOUDPIN_BRANCH`**: overrides the git branch cloudpin uses for the `branches:` environment mapping. CI checks
  out a detached HEAD on pull requests and tags, where cloudpin finds no branch today and silently falls back to
  the first environment. The Action sets it from `GITHUB_HEAD_REF`, else `GITHUB_REF_NAME`. `environment` (which
  sets `CLOUDPIN_ENV`) still wins over it, as `CLOUDPIN_ENV` wins today.

Release order on 2026-11-05: cloudpin 1.2.0 first (owner approves on npm), then the Action's `v1.0.0`, whose default
`version` is 1.2.0.

## Behaviour

1. Requires Node.js on the runner (all GitHub-hosted runners have it). If `node` is missing, the step fails and
   says to add `actions/setup-node` first.
2. Installs cloudpin at a pinned version into a folder under `$RUNNER_TEMP` (`npm install --prefix ... --ignore-scripts
   cloudpin@<version>`), then verifies the installed packages' registry signatures and provenance with
   `npm audit signatures` in that folder, and fails the step if that fails (Claude's call; the builder confirms the
   command does this for a `--prefix` install and adjusts if not). Input `version` defaults to the cloudpin version
   this release of the Action was tested with; `latest` is allowed but not the default.
3. Runs `cloudpin check --json --only <list>` in the input `working-directory` (default: the repository root), with
   `CLOUDPIN_BRANCH` set as above and `CLOUDPIN_ENV` set when the input `environment` is given.
4. Writes cloudpin's human-readable result to the step log, and a short table (cloud, status, reason or fix) to the
   job summary (`$GITHUB_STEP_SUMMARY`) under a one-line heading for the result: all match, mismatch (deploy
   stopped), nothing pinned, or an error. Each failing cloud also gets an `::error::` annotation.
5. Sets the `result` output from the JSON and exits non-zero unless the result is `match` or `unpinned`. With no
   `.cloudpin.yml` the step passes and says so; with a `check` input but no `.cloudpin.yml`, it fails (the workflow
   expected pins that don't exist).

## Inputs and outputs

| Input | Default | Meaning |
|---|---|---|
| `check` | empty (every pinned cloud) | comma-separated clouds that must be logged in and match |
| `version` | the tested cloudpin version | npm version of cloudpin to install |
| `working-directory` | `.` | where to look for `.cloudpin.yml` (cloudpin searches upward from there) |
| `environment` | empty | sets `CLOUDPIN_ENV` |

Output `result`: `match`, `mismatch`, `unpinned` or `error`, for later steps' `if:` conditions.

## Shape (the builder's call where not stated)

- A composite action (`runs: using: composite`) with shell steps. No JavaScript bundle, no `node_modules`
  committed, nothing to rebuild on Dependabot bumps. Steps use `shell: bash`, which exists on all hosted runners
  including Windows (Git Bash).
- Repo contents: `action.yml`, `README.md` (usage with examples for Azure, AWS and a two-cloud job; what it does and
  doesn't do; the `.cloudpin.yml` link), `LICENSE` (MIT), `SECURITY.md` pointing to cloudpin's, and one test
  workflow. Branding (icon and color) for the Marketplace.
- Versioning: tags `v1.0.0` and a moving `v1` tag; the README tells users to pin a full commit SHA for maximum
  safety, as cloudpin's own workflows do.

## Testing

- A workflow in the new repo, on pull requests and pushes to main, one Linux job (owner's CI budget rule), that
  runs the Action from the checkout (`uses: ./`) against a real CLI without any cloud account: Kubernetes, because
  cloudpin reads the kubeconfig itself without network access. The job writes a kubeconfig whose context points at
  `https://a.example.invalid`, then:
  - a `.cloudpin.yml` pinning that server: the step must pass, output `match`;
  - a `.cloudpin.yml` pinning `https://b.example.invalid`: the step must fail (`continue-on-error` plus a check of
    its outcome and output `mismatch`), the control that proves the test can fail;
  - no `.cloudpin.yml`: passes, output `unpinned`;
  - `check: aws` with only kubernetes pinned: fails, output `error` (listed but not pinned);
  - a pin file pinning kubernetes and github, with `check: kubernetes`: passes although `gh` is logged out.
- cloudpin's own changes (`--only`, `--json`, `CLOUDPIN_BRANCH`) are built test first with fake `Exec`s in the
  cloudpin repo, on their own issue branch, before the Action uses them.
- Before the 1.2.0 release, one manual run on a Windows runner (workflow_dispatch) to confirm `shell: bash` and the
  global npm install work there.
- In cloudpin's repo: README's "Can I use it in CI?" answer and ROADMAP point to the Action; CHANGELOG under
  Unreleased.

## Left to the builder

Exact wording of the summary and README, the branding icon and color, how the composite steps pass the exit code
and output, and how the test workflow asserts the failing case.
