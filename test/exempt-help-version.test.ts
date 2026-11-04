import { describe, expect, it } from "vitest";
import type { FoundConfig } from "../src/config.js";
import { guard } from "../src/guard.js";
import { aws } from "../src/providers/aws.js";
import { azure } from "../src/providers/azure.js";
import { cloudflare } from "../src/providers/cloudflare.js";
import { gcloud } from "../src/providers/gcloud.js";
import { github } from "../src/providers/github.js";
import { kubernetes } from "../src/providers/kubernetes.js";
import { supabase } from "../src/providers/supabase.js";
import type { Exec } from "../src/types.js";
import { tempDir } from "./tmp.js";

// #146: a help or version flag exempts a command only where the CLI really stops on it.
// - Every CLI here reads the words after "--" as operands, never as flags.
// - cobra (gh, kubectl, helm) and yargs (wrangler) read `--help=false` as "no help".
// - wrangler prints its version only when no command is given (packages/wrangler/src/index.ts,
//   the default "*" command); `wrangler deploy -v` deploys.
// - az prints its version only when --version or -v is the first word (knack cli.py
//   _should_show_version); `az keyvault secret set-attributes --version` is the secret version.
// - gcloud: "--version, -v ... only available at the global level" (gcloud reference);
//   `gcloud app deploy --version v2` names the app version it deploys.
// - gh: `repo create`/`repo new`/`repo edit` take -h as --homepage (gh help reference), and an
//   extension, an alias, `gh copilot` or `gh extension exec` get --help as an argument
//   (DisableFlagParsing in cli/cli pkg/cmd/root/extension.go, alias.go, copilot, extension).
// - aws (argparse action="version", awscli/argparser.py) and the supabase CLI (effect/cli
//   action flags, Command.runWith) stop on the flag anywhere before "--".

const PROVIDERS = { aws, azure, cloudflare, gcloud, github, supabase };

describe("help and version flags that do not stop the command are checked (#146)", () => {
  it.each([
    ["cloudflare", "deploy -v"],
    ["cloudflare", "deploy --version"],
    ["cloudflare", "-v deploy"],
    ["cloudflare", "deploy --help=false"],
    ["cloudflare", "deploy -- --help"],
    ["cloudflare", "deploy --dry-run=false"],
    ["cloudflare", "deploy -- --dry-run"],
    ["azure", "keyvault secret set-attributes --vault-name v --name n --version abc --enabled false"],
    ["azure", "keyvault secret set-attributes --vault-name v --name n -v abc"],
    ["azure", "group delete -n rg -- --help"],
    ["gcloud", "app deploy --version v2"],
    ["gcloud", "app deploy -v v2"],
    ["gcloud", "compute ssh vm -- --help"],
    ["github", "repo create x --public -h https://example.com"],
    ["github", "repo new x -h https://example.com"],
    ["github", "repo edit -h https://example.com"],
    ["github", "repo delete x --yes --help=false"],
    ["github", "my-extension --help"],
    ["github", "my-extension --version"],
    ["github", "extension exec my-extension --help"],
    ["github", "copilot --help"],
    ["github", "workflow run deploy.yml -- --help"],
    // cobra finds the command past a leading flag (stripFlags), so -h is still --homepage.
    ["github", "-R o/r repo create x -h https://example.com"],
    ["github", "repo --foo create x -h https://example.com"],
    ["supabase", "db push --help=false"],
    ["supabase", "db push --version=false"],
    ["supabase", "db push -- --help"],
    ["aws", "s3 rm s3://b/k -- --version"],
  ] as const)("%s: checks %s", (name, cmd) => {
    expect(PROVIDERS[name].isExempt(cmd.split(" "))).toBe(false);
  });

  it.each([
    ["kubectl", "exec pod -- sh -c x --help"],
    ["kubectl", "delete pod x --help=false"],
    ["helm", "uninstall x --help=false"],
  ])("checks %s %s", (bin, cmd) => {
    expect(kubernetes.isExempt(cmd.split(" "), bin)).toBe(false);
  });
});

describe("help and version flags that stop the command stay exempt (#146)", () => {
  it.each([
    ["cloudflare", "-v"],
    ["cloudflare", "--version"],
    ["cloudflare", "--cwd x -v"],
    ["cloudflare", "deploy --help"],
    ["cloudflare", "deploy -h"],
    ["cloudflare", "deploy --dry-run"],
    ["azure", "--version"],
    ["azure", "-v"],
    ["azure", "vm delete -n x --help"],
    ["azure", "vm -h"],
    ["gcloud", "--version"],
    ["gcloud", "-v"],
    ["gcloud", "--project p --version"],
    ["gcloud", "app deploy --help"],
    ["gcloud", "app deploy -h"],
    ["github", "--version"],
    ["github", "--help"],
    ["github", "-h"],
    ["github", "repo create --help"],
    ["github", "repo view -h"],
    ["github", "pr merge 1 -h"],
    ["github", "extension list --help"],
    ["github", "repo --help"],
    ["github", "config -h"],
    ["supabase", "--version"],
    ["supabase", "db push --help"],
    ["supabase", "db push --version"],
    ["aws", "--version"],
    ["aws", "s3 rm s3://b/k --version"],
  ] as const)("%s: allows %s", (name, cmd) => {
    expect(PROVIDERS[name].isExempt(cmd.split(" "))).toBe(true);
  });

  it.each([
    ["kubectl", "delete pod x --help"],
    ["kubectl", "--version"],
    ["helm", "uninstall x -h"],
  ])("allows %s %s", (bin, cmd) => {
    expect(kubernetes.isExempt(cmd.split(" "), bin)).toBe(true);
  });
});

describe("guard: wrangler with a version flag, pinned to another account (#146)", () => {
  const ACTIVE = "0123456789abcdef0123456789abcdef";
  const PINNED = "fedcba9876543210fedcba9876543210";
  // `wrangler whoami --json` (packages/wrangler/src/user/whoami.ts).
  const whoami: Exec = async () => ({
    code: 0,
    stdout: JSON.stringify({ loggedIn: true, authType: "OAuth Token", accounts: [{ id: ACTIVE, name: "Acme" }] }),
    stderr: "",
  });
  const check = (args: string[]) => {
    const config: FoundConfig = { path: "/repo/.cloudpin.yml", pins: { cloudflare: { account: PINNED } } };
    return guard(
      { bin: "wrangler", args, env: {}, cwd: tempDir("cloudpin-wrangler-"), mode: "agent" },
      { providers: [cloudflare], exec: whoami, findConfig: () => config },
    );
  };

  it("blocks wrangler deploy -v", async () => {
    expect(await check(["deploy", "-v"])).toMatchObject({ action: "block" });
  });

  it("control: allows wrangler -v as exempt", async () => {
    expect(await check(["-v"])).toEqual({ action: "allow", reason: "exempt" });
  });
});
