import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { FoundConfig } from "../src/config.js";
import { guard } from "../src/guard.js";
import { cloudflare } from "../src/providers/cloudflare.js";
import { github } from "../src/providers/github.js";
import { kubernetes } from "../src/providers/kubernetes.js";
import { supabase } from "../src/providers/supabase.js";
import type { Exec } from "../src/types.js";
import { tempDir } from "./tmp.js";

// #153, items 1 to 3: help flags that do not stop the command.
// 1. kubectl runs a plugin (kubectl-<name> on PATH) when the first word is not a built-in command,
//    and `kubectl create <x>` runs kubectl-create-<x> when <x> is not a built-in subcommand name;
//    the plugin gets the rest of the words, --help included (kubectl 1.36.1 pkg/cmd/cmd.go
//    NewDefaultKubectlCommandWithArgs and pkg/cmd/plugin.go HandlePluginCommand). helm makes each
//    plugin a command with DisableFlagParsing, so cobra never reads its --help (helm v3.22.1
//    cmd/helm/load_plugins.go, v4.3.1 pkg/cmd/load_plugins.go; cobra command.go ParseFlags).
// 2. pflag gives a value flag the next word whatever it is (spf13/pflag flag.go parseLongArg,
//    parseSingleShortArg): `gh secret set X --body --help` sets the body to "--help" and runs.
//    effect/cli (supabase) and yargs (wrangler) never take a word that starts with "-" as a value.
// 3. yargs reads `--help false`, `-h false` and `--no-help` as help off, and the last one wins
//    (yargs-parser 21.1.1, used by yargs 17.7.2 in wrangler).

describe("kubectl and helm plugins given --help are checked (#153 item 1)", () => {
  it.each([
    ["kubectl", "myplugin --help"],
    ["kubectl", "myplugin -h"],
    ["kubectl", "myplugin sub --help"],
    ["kubectl", "create foo --help"],
    // `cm` is an alias; kubectl looks for a plugin unless the word is a subcommand's name.
    ["kubectl", "create cm x --help"],
    ["helm", "diff upgrade x chart --help"],
    // helm finds the plugin past its global flags (cobra stripFlags).
    ["helm", "-n prod myplugin --help"],
    ["helm", "--kube-context prod myplugin -h"],
  ])("checks %s %s", (bin, cmd) => {
    expect(kubernetes.isExempt(cmd.split(" "), bin)).toBe(false);
  });

  it.each([
    ["kubectl", "get pods --help"],
    ["kubectl", "--help"],
    ["kubectl", "-n web --help"],
    ["kubectl", "create --help"],
    ["kubectl", "create deployment --help"],
    ["kubectl", "create secret generic --help"],
    ["kubectl", "create -f x.yaml --help"],
    // A flag before `create` stops the plugin lookup: foundArgs[0] is the flag.
    ["kubectl", "-n web create foo --help"],
    ["kubectl", "alpha --help"],
    ["kubectl", "api-resources -h"],
    ["kubectl", "port-forward --help"],
    ["helm", "upgrade x chart --help"],
    ["helm", "ls --help"],
    ["helm", "del x -h"],
    ["helm", "--help"],
    ["helm", "-n prod uninstall x --help"],
  ])("allows %s %s", (bin, cmd) => {
    expect(kubernetes.isExempt(cmd.split(" "), bin)).toBe(true);
  });
});

describe("a value flag that swallows --help is checked (#153 item 2)", () => {
  it.each([
    "secret set X --body --help",
    "secret set X -b --help",
    "pr create --title -h",
    "pr create -t --help",
    "issue create --body x --label -h",
  ])("checks gh %s", (cmd) => {
    expect(github.isExempt(cmd.split(" "))).toBe(false);
  });

  it.each([
    ["kubectl", "apply -f x.yaml --field-manager --help"],
    ["kubectl", "delete pod x -l -h"],
    ["helm", "upgrade x chart --set --help"],
  ])("checks %s %s", (bin, cmd) => {
    expect(kubernetes.isExempt(cmd.split(" "), bin)).toBe(false);
  });

  it.each([
    "pr create --title x --help",
    "secret set X --body=y --help",
    "secret set X -b=y -h",
    "pr create --help",
    "pr view 1 -h",
    "secret set X --help --body",
  ])("allows gh %s", (cmd) => {
    expect(github.isExempt(cmd.split(" "))).toBe(true);
  });

  it.each([
    ["kubectl", "get pods -n web --help"],
    ["kubectl", "get pods -n=web --help"],
    ["helm", "upgrade x chart --set a=b -h"],
  ])("allows %s %s", (bin, cmd) => {
    expect(kubernetes.isExempt(cmd.split(" "), bin)).toBe(true);
  });

  // effect/cli consumes a flag value only from a Value token (internal/parser.ts
  // consumeFlagValueWithTokens), and yargs-parser skips a next word that starts with "-".
  it("allows supabase db push --password --help", () => {
    expect(supabase.isExempt(["db", "push", "--password", "--help"])).toBe(true);
  });

  it("allows wrangler deploy --name --help", () => {
    expect(cloudflare.isExempt(["deploy", "--name", "--help"])).toBe(true);
  });
});

describe("yargs boolean values turn help off in wrangler (#153 item 3)", () => {
  it.each([
    "deploy --help false",
    "deploy -h false",
    "deploy --help --no-help",
    "deploy -h --no-h",
    "deploy --help true --help false",
    "deploy --help --help=false",
    "deploy --help -h=false",
  ])("checks wrangler %s", (cmd) => {
    expect(cloudflare.isExempt(cmd.split(" "))).toBe(false);
  });

  it.each([
    "deploy --help",
    "deploy -h",
    "deploy --help true",
    "deploy -h true",
    "deploy --no-help --help",
    "deploy --help false -h",
    "deploy --help x",
  ])("allows wrangler %s", (cmd) => {
    expect(cloudflare.isExempt(cmd.split(" "))).toBe(true);
  });
});

describe("guard: these commands, pinned to another account (#153)", () => {
  const KUBECONFIG = `apiVersion: v1
kind: Config
current-context: prod
clusters:
- name: prod-cluster
  cluster:
    server: https://prod.example.com
contexts:
- name: prod
  context:
    cluster: prod-cluster
    namespace: web
`;
  const noExec: Exec = async () => {
    throw new Error("kubernetes must not spawn a process");
  };
  const kube = (args: string[], bin = "kubectl") => {
    const home = tempDir("cloudpin-leftovers-kube-");
    mkdirSync(join(home, ".kube"));
    writeFileSync(join(home, ".kube", "config"), KUBECONFIG);
    const config: FoundConfig = { path: "/repo/.cloudpin.yml", pins: { kubernetes: { server: "https://other.example.com" } } };
    return guard(
      { bin, args, env: { HOME: home, USERPROFILE: home, KUBERC: "off" }, cwd: "/repo", mode: "agent" },
      { providers: [kubernetes], exec: noExec, findConfig: () => config },
    );
  };

  it("blocks kubectl myplugin --help", async () => {
    expect(await kube(["myplugin", "--help"])).toMatchObject({ action: "block" });
  });

  it("blocks helm diff upgrade --help", async () => {
    expect(await kube(["diff", "upgrade", "x", "chart", "--help"], "helm")).toMatchObject({ action: "block" });
  });

  it("control: allows kubectl get pods --help as exempt", async () => {
    expect(await kube(["get", "pods", "--help"])).toEqual({ action: "allow", reason: "exempt" });
  });

  // `gh api user --jq .login` answers with the active login.
  const ghUser: Exec = async () => ({ code: 0, stdout: "active-user\n", stderr: "" });
  const gh = (args: string[]) => {
    const config: FoundConfig = { path: "/repo/.cloudpin.yml", pins: { github: { user: "pinned-user" } } };
    return guard(
      { bin: "gh", args, env: {}, cwd: tempDir("cloudpin-leftovers-gh-"), mode: "agent" },
      { providers: [github], exec: ghUser, findConfig: () => config },
    );
  };

  it("blocks gh secret set X --body --help", async () => {
    expect(await gh(["secret", "set", "X", "--body", "--help"])).toMatchObject({ action: "block" });
  });

  it("control: allows gh secret set X --body y --help as exempt", async () => {
    expect(await gh(["secret", "set", "X", "--body", "y", "--help"])).toEqual({ action: "allow", reason: "exempt" });
  });

  const ACTIVE = "0123456789abcdef0123456789abcdef";
  const PINNED = "fedcba9876543210fedcba9876543210";
  // `wrangler whoami --json` (packages/wrangler/src/user/whoami.ts).
  const whoami: Exec = async () => ({
    code: 0,
    stdout: JSON.stringify({ loggedIn: true, authType: "OAuth Token", accounts: [{ id: ACTIVE, name: "Acme" }] }),
    stderr: "",
  });
  const wrangler = (args: string[]) => {
    const config: FoundConfig = { path: "/repo/.cloudpin.yml", pins: { cloudflare: { account: PINNED } } };
    return guard(
      { bin: "wrangler", args, env: {}, cwd: tempDir("cloudpin-leftovers-wrangler-"), mode: "agent" },
      { providers: [cloudflare], exec: whoami, findConfig: () => config },
    );
  };

  it("blocks wrangler deploy --help false", async () => {
    expect(await wrangler(["deploy", "--help", "false"])).toMatchObject({ action: "block" });
  });

  it("control: allows wrangler deploy --help as exempt", async () => {
    expect(await wrangler(["deploy", "--help"])).toEqual({ action: "allow", reason: "exempt" });
  });
});
