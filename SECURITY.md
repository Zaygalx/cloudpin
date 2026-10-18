# Security policy

## Reporting a vulnerability

Please report security problems privately through
[GitHub's private vulnerability reporting](https://github.com/paureis/cloudpin/security/advisories/new) rather than
in a public issue. You'll get a reply within a few days, and credit in the release notes if you'd like it.

Examples of what counts as a security problem here:

- a way for a command to run on an account other than the pinned one without `CLOUDPIN_SKIP`;
- a way for an agent to bypass the hook;
- cloudpin printing, logging or storing a credential;
- command injection through arguments that cloudpin passes to a CLI.

## What cloudpin does with your accounts

- It runs each CLI's own identity command (`az account show`, `aws sts get-caller-identity`, `gcloud config list`,
  `vercel teams ls`, `gh api user`, `supabase projects list`, `wrangler whoami --json`) with the same flags and
  environment as your command, and reads the result. For Kubernetes, Supabase and Wrangler it also reads project
  files that name the target (the kubeconfig, `supabase/.temp/`, the Wrangler config and its account cache).
- It never logs in or logs out, and never uses or stores a token or key. It switches accounts only when you run
  `cloudpin switch` and confirm (an agent's attempt asks you first); it then runs each CLI's own switch command
  (`az account set`, `gh auth switch`, `vercel teams switch`, `gcloud config set`, `kubectl config use-context`)
  without a shell, and only prints a login or `supabase link` for you to run. Credential files are not read, with two
  exceptions: the kubeconfig, which can hold credentials next to the cluster list, from which cloudpin takes only the
  server and namespace (and for `cloudpin switch` each context's name and cluster); and, for `cloudpin switch`, the
  AWS config file, from which it takes only profile names, `sso_account_id` and `role_arn`, skipping every other line
  (the AWS credentials file is never read). For Vercel it checks whether a login file exists, without reading it.
- It stores successful identity answers for up to five minutes in a cache file in your user cache folder. Keys are
  salted hashes, so tokens and command arguments are never written in clear.
- `cloudpin mcp`, the MCP server for agents, is read-only: its two tools report status and what cloudpin would decide
  for a command; they never run that command, log in, switch accounts or write anything.
- It has no telemetry and sends nothing about you or your accounts. Its one request of its own asks
  registry.npmjs.org for the latest cloudpin version (public data; the request names only the package), at most once
  a day, and only from cloudpin's own commands run in a terminal: never from the shell wrappers, `cloudpin exec` or the
  agent hooks, and never in CI. `cloudpin doctor` also checks when you run it. Turn it off with
  `CLOUDPIN_NO_UPDATE_CHECK=1` or `NO_UPDATE_NOTIFIER=1`.

## Verifying a release

Every version is built and published by this repository's release workflow, never from a laptop: npm shows its
provenance, and from 0.4.0 each tag also has a [GitHub Release](https://github.com/paureis/cloudpin/releases) with the
package tarball, a SHA-256 checksum file and a signed build-provenance attestation. npm packs reproducibly, so the
tarball is the same file npm serves. From 1.2.0 the release also has `cloudpin-<version>-windows.zip`, the file the
Scoop bucket installs, in the same checksum file and attestation. To check one:

```sh
gh attestation verify cloudpin-<version>.tgz --repo paureis/cloudpin
gh attestation verify cloudpin-<version>-windows.zip --repo paureis/cloudpin   # from 1.2.0
sha256sum -c --ignore-missing SHA256SUMS
npm view cloudpin@<version> dist.integrity   # npm's sha512 for the same file
```

## Supported versions

Security fixes go into the latest release.
