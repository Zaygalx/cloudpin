# winget: a standalone cloudpin.exe (#96)

Owner-approved design, 2026-10-18. Ships in 1.3.0 "Fix it, see it" (Thursday 2026-12-03). The pull request stays
open and green until the 1.2.0 tag (2026-11-05) and merges after it, so 1.2.0's release assets don't change.

## Decisions

| Area | Decision | Why |
|---|---|---|
| Artifact | `cloudpin-X.Y.Z-win-x64.zip` holding `cloudpin.exe`, a Node single executable application (SEA) with cloudpin bundled inside; in `SHA256SUMS` and the build-provenance attestation | winget-pkgs refuses script launchers as portable installers (microsoft/winget-cli#5237), and the client only runs `.exe` portables |
| Node line | An exact Node 26.x (LTS from 2026-10-28, end of life 2029-04-30), pinned in one place | `--build-sea` (25.5) and an ESM main (25.7) exist only from 25; the backport to 24 was closed (nodejs/node#62119) |
| Build | In the existing ubuntu release job: `node --build-sea` with `executable` set to the official `win-x64/node.exe` of the same version, checked against `SHASUMS256.txt`; code cache and snapshot off | Node's SEA docs allow cross-platform builds with both off; no Windows minutes (owner CI rule) |
| Bundle | cloudpin, `yaml` and `cross-spawn` in one ESM file; the version inlined at build time | Inside a SEA, `require` and `import` load only built-in modules, and `import.meta.url` is the exe's path, so `../package.json` can't be read |
| Signing | None at first | winget doesn't require it (Windows Package Manager policies); revisit if its antivirus scan or Defender flags the exe. SignPath Foundation (free, shows "SignPath Foundation" as publisher) and Microsoft Artifact Signing (paid, US/Canada individuals) are the options |
| Architectures | x64 only | winget falls back to x64 under emulation on arm64 |
| Node security fixes | Nightly checks whether a newer Node 26 security release exists and opens an issue; a patch release only if the fix touches what cloudpin uses (child processes, the file system, TLS to the npm registry), otherwise the next minor | The exe embeds its runtime, so fixes reach exe users only through a new cloudpin |
| Upgrade advice | `cloudpin.exe` knows it is a SEA (`node:sea` `isSea()`): under winget's package folder it says `winget upgrade paureis.cloudpin`, elsewhere to download the latest `cloudpin-X.Y.Z-win-x64.zip` from GitHub Releases | Same rule as #16/#17/#98: name the command that upgrades this copy |
| Testing | The exe built from the branch and run on Windows with a functional check and a wrong-pin control: locally, and in Nightly's existing Windows job | A check that cannot fail proves nothing |
| winget identity | `PackageIdentifier: paureis.cloudpin`, `Publisher: paureis` | The repos' handle; no real name added anywhere new |
| Manifests | Kept in paureis/cloudpin (`packaging/winget/`) and written by `scripts/bump-installers.mjs --winget` from the release's `SHA256SUMS` | One place generates every installer's version bump |
| Submitting | The owner submits by hand, outside the session, with the owner's own token and none stored: one `wingetcreate submit` per release, first (signing Microsoft's CLA once) or later, of the manifests `bump-installers.mjs --winget` rendered after checking the zip against `SHA256SUMS` (docs/winget.md) | wingetcreate needs a classic `public_repo` PAT (fine-grained tokens still fail), which could write to every public repo of the owner's; `wingetcreate update` would download the zip and hash it itself, so it would not submit the checked manifest |

## Out of scope

- Signing, arm64, Microsoft Store.
- Replacing Scoop's or Homebrew's Node-based installs with the exe.
