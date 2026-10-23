# Roadmap

Each version below is a [milestone](https://github.com/paureis/cloudpin/milestones) with a release date and the
issues it ships. Open an [issue](https://github.com/paureis/cloudpin/issues) to vote for an idea or suggest one.

## How releases work

- **Minor releases** (1.2.0, 1.3.0, ...) come out on a Thursday, at least three weeks apart, each with a theme.
  The dates are checkpoints: work runs ahead of them, and if a release isn't ready, it slips a week.
- **In the last week before a release**, only that release's items are merged, and the maintainer uses that build
  every day. Work on the next version carries on in its own pull requests and is merged after the release.
- **Patch releases** (1.2.1, ...) go out at any time, but only for bugs that must be fixed: a command allowed on the
  wrong account, a credential exposed, a broken install. Smaller fixes wait for the next minor release.
- Anything that misses its release moves to the next one, with the reason in its issue.
- Once new features slow down, cloudpin moves to maintenance: a release when there is something worth releasing.

## 1.2.0: Run it everywhere (release 2026-11-05)

- **GitHub Action** ([#10](https://github.com/paureis/cloudpin/issues/10)): `cloudpin check` before deploy jobs.
- **Homebrew** ([#16](https://github.com/paureis/cloudpin/issues/16)): `brew install paureis/tap/cloudpin`, from
  [paureis/homebrew-tap](https://github.com/paureis/homebrew-tap).
- **Scoop** ([#17](https://github.com/paureis/cloudpin/issues/17)): a bucket, paureis/scoop-bucket, on a Windows
  zip attached to each release.
- **Upgrade advice for pnpm and Volta** ([#98](https://github.com/paureis/cloudpin/issues/98)): name the right
  upgrade command when cloudpin was installed globally with pnpm or Volta.
- **Agent hooks under PowerShell's execution policy** ([#108](https://github.com/paureis/cloudpin/issues/108)):
  Codex and Copilot CLI hooks on Windows start cloudpin through cmd.exe, so `Restricted` and `AllSigned` can't stop
  them, and `cloudpin doctor` warns about what could still stop or bypass a hook there.
- **MCP everywhere** ([#111](https://github.com/paureis/cloudpin/issues/111)): the MCP server tells every agent how
  to use it, setup snippets for Codex, Cursor, VS Code, Gemini CLI, Windsurf and Claude Desktop, and a listing in
  the official MCP Registry as `io.github.paureis/cloudpin`.
- **A 90-second demo** ([#113](https://github.com/paureis/cloudpin/issues/113)): an agent in Cursor stopped before it
  runs a command on the wrong account, for the release announcement.
- **Wrangler's `.env` files** ([#116](https://github.com/paureis/cloudpin/issues/116)): the account and login a
  project's `.env` sets for Wrangler count, and the account cache is read only from the folder Wrangler reads.
- **Vercel tokens stay hidden** ([#123](https://github.com/paureis/cloudpin/issues/123)): block and confirmation
  messages hide a token after `-dt` or joined to `-t`, never repeating it.
- **Vercel short flag groups** ([#125](https://github.com/paureis/cloudpin/issues/125)): `vercel -dT team` and
  `-dt token` are checked against the account they pick, not the active one.
- **Vercel scope** ([#127](https://github.com/paureis/cloudpin/issues/127)): `--scope` beats `--team`, and a
  `scope` in `vercel.json` or the `-A` file counts, so cloudpin checks the team Vercel will use.

## 1.3.0: Fix it, see it (release 2026-12-03)

- **`cloudpin switch`** ([#14](https://github.com/paureis/cloudpin/issues/14)): move every CLI to the pinned
  accounts in one go, after one confirmation.
- **VS Code / Cursor status bar** ([#18](https://github.com/paureis/cloudpin/issues/18)): a green or red pin
  showing whether the active accounts match the project.
- **winget** ([#96](https://github.com/paureis/cloudpin/issues/96)): winget only accepts an `.exe`, so this needs a
  standalone cloudpin (a Node single executable). Moved from 1.2.0 on 2026-10-17.
- **Wrangler auth profiles** ([#103](https://github.com/paureis/cloudpin/issues/103)): check whether Wrangler's
  new `--profile` and `wrangler auth activate` change the account a command uses, and resolve it if so.
- **Antigravity and Copilot CLI hook shells on Windows** ([#110](https://github.com/paureis/cloudpin/issues/110)):
  find which shell each one starts hook commands with, and give Antigravity the Windows form from #108 if it needs it.
- **Threat model** ([#84](https://github.com/paureis/cloudpin/issues/84)): what cloudpin protects against and what it
  doesn't, in THREAT_MODEL.md. Moved from 1.2.0 on 2026-10-18 (waiting for an outside review).
- **MCP: `cloudpin_switch_plan` and `cloudpin_doctor` tools** ([#112](https://github.com/paureis/cloudpin/issues/112)):
  two more read-only tools: the commands you would run to move each CLI to the pinned account (from `cloudpin
  switch`, nothing run), and `cloudpin doctor`'s report, so an agent can say why the hook isn't guarding.
- **Write-up** ([#114](https://github.com/paureis/cloudpin/issues/114)): why AI agents need an account guardrail, and
  how cloudpin does it, with numbers from the test suite.
- **Short flags joined with `=`** ([#118](https://github.com/paureis/cloudpin/issues/118)): read `-e=production`
  the way each CLI does, in every provider.
- **Cloudflare account variables** ([#119](https://github.com/paureis/cloudpin/issues/119)): block an account
  variable whose value cloudpin can't know, and read lowercase names on Windows.

## Ideas (not scheduled yet)

An idea gets a version when work on it starts.

- **More CLIs** ([#11](https://github.com/paureis/cloudpin/issues/11)): `terraform` workspaces, `doctl`, `flyctl`,
  `firebase`, `heroku`, `stripe`, `netlify`.
- **Wrangler against a real Cloudflare login** ([#56](https://github.com/paureis/cloudpin/issues/56)): the Cloudflare
  support is built to Wrangler's source and docs and tested with fakes; it waits for someone with a Cloudflare
  account to try it.
- **Team policy:** a shared file that requires certain projects to be pinned.
- **Fish and Nushell** wrappers.
- **OpenSSF Best Practices silver, then gold** (passing since 2026-10-08,
  [project 15321](https://www.bestpractices.dev/projects/15321)). Silver is mostly writing: governance, a code of
  conduct, a threat model, signed releases and 80% test coverage, plus a second person who could keep the project
  going. Gold needs other contributors: two-person review of most changes and a bus factor of two.

## Shipped

- **1.1.2** (2026-10-19): completes the Windows security fix: nothing cloudpin starts looks in the current folder,
  including the `node` that npm-installed CLIs run (GHSA-3cf7-5v5w-q5vr).
- **1.1.1** (2026-10-18): security fix for Windows: CLIs run by their full path from PATH, never from the
  current folder (GHSA-3cf7-5v5w-q5vr).
- **1.1.0** (2026-10-16): the Claude Code plugin and read-only MCP server
  ([#15](https://github.com/paureis/cloudpin/issues/15)); review rules in CONTRIBUTING.md
  ([#88](https://github.com/paureis/cloudpin/issues/88)).
- **1.0.0** (2026-10-15): the first stable release and the launch ([#9](https://github.com/paureis/cloudpin/issues/9)).
  The `.cloudpin.yml` format is stable; Antigravity hooks ([#80](https://github.com/paureis/cloudpin/issues/80));
  Copilot CLI, Antigravity and Cursor tested inside the agents ([#3](https://github.com/paureis/cloudpin/issues/3),
  [#2](https://github.com/paureis/cloudpin/issues/2)); go-public checklist closed
  ([#8](https://github.com/paureis/cloudpin/issues/8)).
- **0.4.2** (2026-10-10): a clearer first run: `init`, `status` and `doctor` call a CLI you don't have "not
  installed" ([#75](https://github.com/paureis/cloudpin/issues/75)).
- **0.4.1** (2026-10-09): bash and zsh wrappers that keep guarding when an alias of the CLI already exists, and warn
  about an alias that runs another program ([#69](https://github.com/paureis/cloudpin/issues/69)); pin files from a
  newer cloudpin say to update ([#67](https://github.com/paureis/cloudpin/issues/67)); GitHub Releases carry only
  the release files ([#65](https://github.com/paureis/cloudpin/issues/65)).
- **0.4.0** (2026-10-09): signed GitHub Releases with build provenance
  ([#53](https://github.com/paureis/cloudpin/issues/53)), branch protection visible to Scorecard
  ([#54](https://github.com/paureis/cloudpin/issues/54)), hand checks of the protected-environment prompt and the
  Claude Code "ask" ([#55](https://github.com/paureis/cloudpin/issues/55)), and exempt commands that run with a
  broken pin file ([#62](https://github.com/paureis/cloudpin/issues/62)).
- **0.3.1** (2026-10-09): the update notice and `cloudpin version` ([#50](https://github.com/paureis/cloudpin/issues/50)),
  and no false Supabase warning outside a project ([#48](https://github.com/paureis/cloudpin/issues/48)).
- **0.3.0** (2026-10-09): Supabase and Cloudflare Wrangler ([#37](https://github.com/paureis/cloudpin/issues/37)),
  `cloudpin doctor` ([#35](https://github.com/paureis/cloudpin/issues/35)), `cloudpin explain`
  ([#36](https://github.com/paureis/cloudpin/issues/36)), and the Cursor hook fix
  ([#42](https://github.com/paureis/cloudpin/issues/42)).
- **0.2.1** (2026-10-08): releases published from GitHub Actions with provenance
  ([#19](https://github.com/paureis/cloudpin/issues/19)), OpenSSF Scorecard
  ([#20](https://github.com/paureis/cloudpin/issues/20)) and CodeQL.
- **0.2.0** (2026-10-08): environments and protected environments ([#12](https://github.com/paureis/cloudpin/issues/12)),
  Kubernetes for `kubectl` and `helm` ([#13](https://github.com/paureis/cloudpin/issues/13); standalone `kustomize`
  never contacts a cluster, so it isn't guarded), Vercel monorepos and large teams
  ([#4](https://github.com/paureis/cloudpin/issues/4), [#5](https://github.com/paureis/cloudpin/issues/5)), command
  parser gaps ([#7](https://github.com/paureis/cloudpin/issues/7)), and safety-review fixes.
- **0.1.0** (2026-10-08): first public beta.

Details in [CHANGELOG.md](CHANGELOG.md).
