# Installers: Homebrew (#16) and Scoop (#17)

Owner-approved design, 2026-10-17. Ships in 1.2.0 "Run it everywhere" (Thursday 2026-11-05).

## Decisions

| Area | Decision | Why |
|---|---|---|
| Homebrew home | A tap, public repo `paureis/homebrew-tap`: `brew install paureis/tap/cloudpin` | homebrew/core needs 225 stars for a self-submission and a repo at least 30 days old (docs.brew.sh/Package-Acceptance-Policy) |
| Formula | Homebrew's Node shape: the npm registry tarball, `depends_on "node"`, `system "npm", "install", *std_npm_args`, `bin.install_symlink libexec.glob("bin/*")` (docs.brew.sh/Language-Specific-Formulae) | The registry tarball is byte for byte the GitHub Release tarball (sha512 checked against `dist.integrity` for 1.0.0 and 1.1.0), so `SHA256SUMS` gives its sha256 |
| Formula test | A functional test, not `--version` (docs.brew.sh/Formula-Cookbook): a pin file cloudpin must refuse, plus one it accepts | A test that cannot fail proves nothing |
| Tap CI | One Linux job in Homebrew's container: audit, install from source, `brew test`, and a wrong-sha256 control. No macOS runners, no bottles | Owner CI rule (no macOS); bottles are optional for a tap |
| Tap timing | Live now with 1.1.0; README links it in 1.2.0 | Earlier feedback; the update-hint fix below ships in 1.2.0 |
| Windows scope | Scoop in 1.2.0; winget moves to 1.3.0 as its own issue | winget-pkgs refuses script launchers (.cmd, .ps1) as portable installers (microsoft/winget-cli#5237), so winget needs a standalone exe (Node SEA): a bundler, about 90 MB unsigned, Defender false-positive risk, and a re-release on every Node security fix |
| Scoop home | Own bucket, public repo `paureis/scoop-bucket`: `scoop bucket add paureis https://github.com/paureis/scoop-bucket` | Scoop Main needs 500 stars and 150 forks; Extras wants an approved issue first |
| Scoop artifact | `release.yml` also builds `cloudpin-X.Y.Z-windows.zip`: `dist`, `package.json` and production `node_modules` from the lockfile (`npm ci --omit=dev`); listed in `SHA256SUMS` and covered by the attestation | The npm tarball has no `node_modules`; Scoop has no `.js` shim; an install-time `npm install` would need the network and its packages would not be covered by the manifest hash |
| Scoop launcher | No `.cmd`. The manifest's `bin` makes Scoop's exe shim run Scoop's own `nodejs-lts\current\node.exe` with `dist\cli.js` (owner decision 2026-10-17, changed from a `cloudpin.cmd` launcher) | Scoop shims a `.cmd` target only with `.cmd` and bash shims (`cmd.exe /C`, lib/core.ps1 `shim`), so cmd.exe re-parses every argument: through the shell-init wrappers `x&calc` ran calc, and `\|`, `%PATH%` and `^` were mangled. The exe shim matched npm's shims in every probed case |
| Node on Windows | `"depends": "nodejs-lts"`, and only that Node is used | The exe shim names Scoop's Node by path. A global cloudpin with a per-user nodejs-lts can't find it (README says so) |
| Bumping | A script in paureis/cloudpin reads the release's `SHA256SUMS` and rewrites the version, url and sha256 in the formula and the manifest; the release session runs it after the tag and pushes. No Excavator cron, no autobump, no cross-repo token | Releases are at least three weeks apart; no secret to store or leak |
| Update advice | `cloudpin doctor` and the update notice name the upgrade command for the way cloudpin was installed: `brew upgrade cloudpin`, `scoop update cloudpin`, otherwise `npm install --global cloudpin` | Today they always say npm, which is wrong for brew and Scoop users |

## Out of scope

- winget and the standalone exe (1.3.0).
- homebrew/core, Scoop Main or Extras: revisit when the thresholds above are met.
- Install never edits a shell profile or installs an agent hook; users still run `cloudpin shell-init` and
  `cloudpin install-hook` themselves (the formula's `caveats` and the bucket README say so).
