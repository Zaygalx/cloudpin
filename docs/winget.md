# Submitting cloudpin to winget (#96)

The maintainer does this by hand after a release, outside any agent session. Nothing here runs in CI, and no token is
stored anywhere. The manifests come from `packaging/winget/`, filled in by
`node scripts/bump-installers.mjs X.Y.Z --winget <dir>`, which checks the release's `cloudpin-X.Y.Z-win-x64.zip`
against its attested `SHA256SUMS` first. `wingetcreate submit` then opens the pull request on
[microsoft/winget-pkgs](https://github.com/microsoft/winget-pkgs) from a fork in your account.

Sources: winget-pkgs'
[FirstContribution.md](https://github.com/microsoft/winget-pkgs/blob/master/doc/FirstContribution.md),
[Authoring.md](https://github.com/microsoft/winget-pkgs/blob/master/doc/Authoring.md) and
[ValidationFailureGuide.md](https://github.com/microsoft/winget-pkgs/blob/master/doc/ValidationFailureGuide.md);
winget-create's [submit](https://github.com/microsoft/winget-create/blob/main/doc/submit.md) and
[token](https://github.com/microsoft/winget-create/blob/main/doc/token.md) docs; GitHub's
[Creating a personal access token (classic)](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens#creating-a-personal-access-token-classic).
Anything marked **(unverified)** was not in those docs; check it the first time and fix this page.

Every release, first or later, uses the same steps. Later versions use `wingetcreate submit` too, not
`wingetcreate update`: `update` downloads the zip and computes its own hash, and can fill in metadata from the
repository, so what it submits is not the manifest rendered and checked here. Replace `X.Y.Z` with the version,
without a `v`. The commands are for PowerShell.

## Before you start

- The `vX.Y.Z` GitHub Release is published (not a draft) and its assets include `cloudpin-X.Y.Z-win-x64.zip` and
  `SHA256SUMS`.
- No pull request for `paureis.cloudpin` X.Y.Z is already open on
  [microsoft/winget-pkgs](https://github.com/microsoft/winget-pkgs/pulls?q=is%3Apr+paureis.cloudpin).
- wingetcreate is installed. If `wingetcreate --help` says the command is not found, run
  `winget install wingetcreate` and open a new terminal.

## 1. Render and check the manifests

1. In a cloudpin checkout at the `vX.Y.Z` tag, run `npm ci` once, then
   `node scripts/bump-installers.mjs X.Y.Z --winget $env:TEMP\cloudpin-winget`.
   You should see the folder `...\cloudpin-winget\manifests\p\paureis\cloudpin\X.Y.Z:`, the three file names, and
   `version X.Y.Z, sha256 <64 uppercase hex>, release date <YYYY-MM-DD>`. The date is the release's publish date in
   UTC; pass `--date YYYY-MM-DD` to choose another.
2. Run `winget validate --manifest $env:TEMP\cloudpin-winget\manifests\p\paureis\cloudpin\X.Y.Z`.
   You should see `Manifest validation succeeded.`
3. Optional: test the install in Windows Sandbox with winget-pkgs'
   [`Tools\SandboxTest.ps1`](https://github.com/microsoft/winget-pkgs/blob/master/doc/tools/SandboxTest.md). Testing it
   on your own machine instead needs `winget settings --enable LocalManifestFiles` from an administrator terminal,
   which changes a winget setting; it is your call.

## 2. Make a token for this release

wingetcreate needs a classic token with `public_repo`; fine-grained tokens don't work with it
([winget-create#595](https://github.com/microsoft/winget-create/issues/595)). That scope can write to every public
repository you own, so keep it short-lived.

1. Open <https://github.com/settings/tokens> (your profile picture > **Settings** > **Developer settings** >
   **Personal access tokens** > **Tokens (classic)**).
2. Click **Generate new token**, then **Generate new token (classic)**.
   You should see a form with **Note**, **Expiration** and **Select scopes**.
3. In **Note**, type `wingetcreate cloudpin X.Y.Z`.
4. In **Expiration**, choose **7 days**.
5. Under **Select scopes**, tick only **public_repo** (inside **repo**; leave **repo** itself and everything else
   unticked).
6. Click **Generate token**.
   You should see the new token once, starting with `ghp_`.
7. Copy it into your password manager. Never paste it into a chat, an issue or a command line.

## 3. Submit

1. Open a new PowerShell window. Run `$env:WINGET_CREATE_GITHUB_TOKEN = Read-Host "GitHub token" -MaskInput`
   (PowerShell 7) and paste the token when asked.
   You should see only asterisks. The variable lives in this window only. wingetcreate reads it when no `--token` is
   given (`TokenHelper.cs` in winget-create's source), and `--token` on the command line "may result in the token being
   logged", in winget-create's own words.
   In Windows PowerShell 5.1, which has no `-MaskInput`, run
   `$s = Read-Host "GitHub token" -AsSecureString; $env:WINGET_CREATE_GITHUB_TOKEN = [Net.NetworkCredential]::new('', $s).Password`
   instead.
2. Run, for the first version:
   `wingetcreate submit --prtitle "New package: paureis.cloudpin version X.Y.Z" $env:TEMP\cloudpin-winget\manifests\p\paureis\cloudpin\X.Y.Z`
   and for every later version:
   `wingetcreate submit --prtitle "Update: paureis.cloudpin to X.Y.Z" $env:TEMP\cloudpin-winget\manifests\p\paureis\cloudpin\X.Y.Z`
   (the titles are the ones winget-pkgs' pull request template asks for).
   You should see your browser open the new pull request on microsoft/winget-pkgs, with only the three
   `manifests/p/paureis/cloudpin/X.Y.Z/` files in its **Files changed** tab. The fork it comes from,
   `paureis/winget-pkgs`, is created the first time **(unverified: the fork's name and when it is created)**.
3. Run `Remove-Item Env:WINGET_CREATE_GITHUB_TOKEN`, or close the window.
4. If the pull request's description has winget-pkgs' checklist **(unverified: what wingetcreate writes there)**,
   tick what is true: the CLA (after step 4.1 the first time), no other open pull request for this version, one
   manifest, validated with `winget validate`.

## 4. Watch the pull request

1. **First submission only:** the Microsoft CLA bot comments on the pull request and the PR gets the **Needs-CLA**
   label. Follow the bot's comment; it asks you to reply with a line such as
   `@microsoft-github-policy-service agree` **(unverified: copy the exact line from the bot's comment)**.
   You should see the bot confirm and **Needs-CLA** go away. You sign it once for all Microsoft repositories.
2. Wait for the validation labels. **Azure-Pipeline-Passed** means the automated tests passed;
   **Validation-Completed** means all checks passed and a moderator can merge it. A first package also gets a manual
   review, so it can take days.
3. If the PR gets **Needs-Author-Feedback**, answer within 5 days: after that it gets **No-Recent-Activity**, and 3
   days later it is closed.
4. When it merges, wait for the index to update **(unverified: how long it takes)**, then on a Windows machine run
   `winget install paureis.cloudpin`, open a new terminal and run `cloudpin --version`.
   You should see `X.Y.Z`. `cloudpin doctor` should name `winget upgrade paureis.cloudpin` as the upgrade command.
5. Delete the token at <https://github.com/settings/tokens>: click **Delete** next to `wingetcreate cloudpin X.Y.Z`
   and confirm. It also expires by itself after 7 days.

## If validation fails

Each error label has its own entry in winget-pkgs'
[ValidationFailureGuide.md](https://github.com/microsoft/winget-pkgs/blob/master/doc/ValidationFailureGuide.md).
The ones this package can hit:

- **Error-Hash-Mismatch**: the zip on the release changed after the manifest was rendered. Never replace a release
  asset; if it happened, cut a new patch release and render again.
- **Binary-Validation-Error**: winget's antivirus scan flagged the installer, or its hash or URL failed. Check the hash
  with `winget hash <the downloaded zip>` against `SHA256SUMS`. If a scanner flagged it, submit `cloudpin.exe` to
  Microsoft as a false positive at <https://www.microsoft.com/wdsi/filesubmission> **(unverified: the form's
  choices)**. This label can't be waived by a moderator: the PR passes only after the detection is cleared and
  validation runs again.
- **Validation-Defender-Error**: Defender flagged the installed exe. Install it, run a full Defender scan, and if you
  can reproduce the detection, submit the file for false-positive analysis as above; if you can't, say so in a PR
  comment.
- **Validation-Executable-Error**: validation could not run the exe. `cloudpin` with no arguments prints its help and
  exits 0 (checked with the npm build; Nightly's `scripts/check-exe.ps1` runs the exe with `--version`), and
  `cloudpin --version` prints the version; say that in a PR comment, since only an administrator can clear this
  label.
- **Portable-Archive**: a moderator label for portable zips that need special handling, listed as blocking. Read the
  moderator's comment **(unverified: what they will ask for; other portable zip packages, such as
  `Wakatime.CLIWakatime`, merge with the same layout)**.

If antivirus or Defender keeps flagging an unsigned exe, signing is the next step (out of scope for now; the design's
**Signing** row): [SignPath Foundation](https://signpath.org/) is free for open source and shows "SignPath Foundation"
as the publisher; Microsoft Artifact Signing is paid and open to individuals in the US and Canada. Open an issue to
decide, before the next release.

## Schema version

The templates use manifest schema 1.28.0, which winget-pkgs merges today (for example
`Microsoft.SafetyScanner` 1.461.74.0) and `winget validate` 1.29 accepts. The pull request template's checklist still
says 1.12. Every field the templates use also exists in 1.12.0, so if a moderator asks for it, change `1.28.0` to
`1.12.0` in the three files' `ManifestVersion` and `$schema` lines and render again.
