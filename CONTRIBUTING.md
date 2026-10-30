# Contributing to cloudpin

Thanks for helping. Bug reports, new CLIs and fixes are all welcome.

## Setup

```sh
git clone https://github.com/paureis/cloudpin.git
cd cloudpin
npm ci
npm run build
npm test
```

Node.js 22 or later. Pull requests run the tests on Linux with Node 22; Windows and Node 24 run nightly.

## Ground rules

cloudpin sits in front of commands that touch real cloud accounts, so a few rules are firm:

1. **Never weaken the default.** When cloudpin cannot tell which account a command would use, it blocks and
   explains why. Changes that let a command through on uncertainty will not be merged.
2. **Never print, log or cache a credential.** Messages may name an environment variable, never its value.
3. **Never spawn through a shell.** Use `realExec` in `src/exec.ts`.
4. **Check CLI behaviour against its documentation or `--help`**, and say where it came from in a comment when
   it isn't obvious. If you observed it instead, say what you ran.
5. **Tests first.** Provider tests use a fake `Exec` (see `test/github.test.ts`); no test spawns a real CLI.

## Adding a CLI

### First, find out how the CLI picks its account

Answer these from the CLI's docs, `--help` or source before writing code, and link the answers in your pull request.
`src/providers/supabase.ts` and `src/providers/cloudflare.ts` show what that looks like.

1. **Which account or project does a command act on**, and in what order do flags, environment variables, files in
   the project folder and files in the home folder decide it? Watch for surprises: in Wrangler, `account_id` in the
   config file beats `CLOUDFLARE_ACCOUNT_ID`.
2. **Which token variables replace the stored login** (like `GH_TOKEN` for `gh`)?
3. **Is there a read-only command that names the account**, ideally with JSON output? What does it print, and with
   which exit code, when you are logged out or the token is bad?
4. **Which commands never touch the account** (login, logout, help, version, a local emulator or dev server, local
   files), and which flags switch a command between local and remote?
5. **Which commands only read**, so they can run on a protected environment without asking? Keep that list short:
   anything not on it asks, so a mistake can only make cloudpin too careful.

What to pin: a stable ID (subscription ID, account ID, project ref), never a display name.

### Then build it

1. Its pin section in `src/config.ts` (`Pins` and `SCHEMA`), and in `src/init.ts` (`PIN_FIELDS`).
2. `src/providers/<name>.ts` implementing `ProviderDef`: `isExempt`, `resolve`, `compare`, `switchHint`,
   `statusCommand`, `cacheInputs` and `targetFlags` (every flag `resolve` reads, so a value only known when the
   command runs gives "can't tell"; `test/hook-dynamic-values.test.ts` checks the list). Register it in
   `src/providers/index.ts`.
3. Its read-only rules in `src/readonly.ts` (TypeScript will tell you the entry is missing).
4. Tests first, in `test/<name>.test.ts`: a fake `Exec` (see `test/github.test.ts`) and `tempDir()` from
   `test/tmp.ts` for folders. Cover each source of the account and their order, logged out, a bad token (named,
   never printed), "can't tell" (which must stop the command), exempt and read-only commands.
5. Break your own code on purpose (swap two sources, drop a check) and make sure a test fails each time.
6. If you have the CLI, try it for real: `npm run build && node scripts/smoke.mjs <name>`, with **read-only commands
   only**. The active account must pass and a wrong pin must fail.
7. Docs: the README's CLI table (and a paragraph if the CLI has a twist), and a CHANGELOG entry under Unreleased.

`resolve` must return the identity *the specific command* would use, so flags such as `--profile` and
environment variables count. When it can't tell, it returns an error, and cloudpin stops the command with that
reason. `cacheInputs` must list every variable and file that can change the answer of a CLI call that `resolve` makes.

## Pull requests

- Keep each pull request to one change, with tests.
- Run `npm run typecheck` and `npm test` before pushing.
- Add a line to `CHANGELOG.md` under "Unreleased".

## Reviewing a change

A review finding names a failure: this input, this wrong result. Without one it is a preference, and the change
doesn't wait for it. Findings are sorted by what they break:

| Kind | For example | What happens |
|---|---|---|
| Must fix | a command runs on the wrong account (also when cloudpin can't tell); a credential is printed, logged or cached; a test sends a write to a real account; install or the user's shell breaks; a test or the type-check fails | fixed before merging |
| Fix if cheap | a false block; a wrong or misleading message; new behaviour without a test; a doc the change made untrue | fixed in the same pull request when it is small and in the changed lines; otherwise an issue |
| Leave | style, naming, refactors, checks for states that can't happen, anything outside the change | not changed; a real bug outside the change gets its own issue |

Weigh the fix as well as the problem. A small fix in the code that decides (`src/guard.ts`, `src/shellwords.ts`, a
provider's `resolve`) can break more than it repairs; if the problem is minor, open an issue instead.

So reviews end:

- every fix comes with a test that fails without it;
- the second look covers only the fix, not the whole change again;
- one review round and one fix round. If the second look finds something new, a must-fix goes to the maintainer and
  anything else becomes an issue.

## Reporting a bug

Open an [issue](https://github.com/paureis/cloudpin/issues/new/choose) with the command, what you expected, and
what happened. Redact account IDs if you prefer; never paste tokens. For security problems, see
[SECURITY.md](SECURITY.md).
