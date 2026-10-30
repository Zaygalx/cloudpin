import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { FoundConfig } from "../src/config.js";
import type { GuardDeps } from "../src/guard.js";
import { AGENTS, runHook } from "../src/hooks/agents.js";
import { providers } from "../src/providers/index.js";
import type { Exec, ProviderDef } from "../src/types.js";
import { tempDir } from "./tmp.js";

// #160 through the agent hook, with the real providers and a fake Exec: a value cloudpin can't read in
// advance in a flag that picks the account, or an unquoted one that could expand to such flags, gives
// "can't tell"; a quoted one elsewhere, a known variable and an exempt command do not.

const PINNED = "11111111-0000-0000-0000-000000000001";
const OTHER = "22222222-0000-0000-0000-000000000002";
const SUBSCRIPTIONS: Record<string, string> = { pinned: PINNED, other: OTHER };
const TEAMS = JSON.stringify({
  teams: [
    { id: "team_main", slug: "acme", current: true },
    { id: "team_side", slug: "side", current: false },
  ],
  pagination: {},
});

const sent: string[][] = [];
const exec: Exec = async (bin, args) => {
  sent.push([bin, ...args]);
  const value = (flag: string) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined);
  if (bin === "az") {
    const id = SUBSCRIPTIONS[value("--subscription") ?? "pinned"];
    if (!id) return { code: 1, stdout: "", stderr: "ERROR: Subscription not found." };
    return { code: 0, stdout: JSON.stringify({ id, tenantId: PINNED, name: "x" }), stderr: "" };
  }
  if (bin === "aws") {
    const account = value("--profile") === "other" ? "222222222222" : "111111111111";
    return { code: 0, stdout: JSON.stringify({ Account: account, Arn: "arn" }), stderr: "" };
  }
  if (bin === "gcloud") {
    return { code: 0, stdout: JSON.stringify({ core: { account: "me@example.com", project: value("--project") ?? "pinned-proj" } }), stderr: "" };
  }
  if (bin === "vercel" && args[0] === "teams") return { code: 0, stdout: TEAMS, stderr: "" };
  return { code: 1, stdout: "", stderr: "unexpected call" };
};

const KUBECONFIG = `apiVersion: v1
kind: Config
current-context: pinned
clusters:
- name: pinned
  cluster:
    server: https://pinned.example.com
- name: other
  cluster:
    server: https://other.example.com
contexts:
- name: pinned
  context:
    cluster: pinned
- name: other
  context:
    cluster: other
`;
const kubeDir = tempDir("cloudpin-160-kube-");
writeFileSync(join(kubeDir, "config"), KUBECONFIG);

const config: FoundConfig = {
  path: "/repo/.cloudpin.yml",
  pins: {
    azure: { subscription: PINNED },
    aws: { account: "111111111111" },
    gcloud: { project: "pinned-proj" },
    vercel: { team: "team_main" },
    kubernetes: { server: "https://pinned.example.com" },
  },
};
const deps: GuardDeps = { providers, exec, findConfig: () => config };
const env = { VERCEL_TOKEN: "example-env-token", KUBECONFIG: join(kubeDir, "config"), KUBERC: "off" };

async function decision(command: string, tool: "Bash" | "PowerShell" = "Bash"): Promise<{ decision: string; reason: string }> {
  const input = JSON.stringify({ hook_event_name: "PreToolUse", tool_name: tool, tool_input: { command }, cwd: tempDir("cloudpin-160-") });
  const out = await runHook(AGENTS.claude, input, deps, env);
  const hook = out ? JSON.parse(out).hookSpecificOutput : undefined;
  return { decision: hook?.permissionDecision ?? "allow", reason: hook?.permissionDecisionReason ?? "" };
}

describe("agent hook: an account flag whose value is known only when the command runs (#160)", () => {
  it.each([
    ["az group list --subscription $(cat sub.txt)", "--subscription"],
    ["az group list --subscription=$(cat sub.txt)", "--subscription"],
    ["vercel deploy --scope `cat team`", "--scope"],
    ['az group list --subscription "$(cat sub.txt)"', "--subscription"],
    ['az group list --subscription="$(cat sub.txt)"', "--subscription"],
    ["az group list --subscription `cat sub.txt`", "--subscription"],
    ['az group list --subscription "$SUB"', "--subscription"],
    ["kubectl --context $(cat ctx) delete pod x", "--context"],
    ['kubectl --context="$(cat ctx)" delete pod x', "--context"],
    ['kubectl delete pod x -n "$NS"', "-n"],
    ['kubectl delete pod x -itn "$NS"', "-n"],
    ['aws s3 ls --profile "$P"', "--profile"],
    ['vercel deploy --scope "$(cat team)"', "--scope"],
    ['gcloud compute instances list --project "$(cat project)"', "--project"],
  ])("can't tell for %j, and names %s", async (cmd, flag) => {
    const { decision: d, reason } = await decision(cmd);
    expect(d).toBe("deny");
    expect(reason).toContain(`${flag} `);
    expect(reason).toContain("can't tell");
  });

  it.each([
    "az group list $EXTRA",
    'az group list "$@"',
    "az group list $@",
    'az group list "${args[@]}"',
    "az group list $*",
    "az group list ${EXTRA:-}",
    "az group list -x$(cat a)",
    'az group list "--sub$(echo scription)" other',
    // A function's "$@" (#163 lists the shape; the call inside it is found).
    'run() { az "$@" -o table; }; run group list --subscription other',
  ])("can't tell for %j, which could expand to flags", async (cmd) => {
    const { decision: d, reason } = await decision(cmd);
    expect(d).toBe("deny");
    expect(reason).toContain("can't tell");
  });

  it("never sends a value it can't read to a CLI", async () => {
    sent.length = 0;
    for (const cmd of [
      'az group list --subscription "$(cat s)"',
      'aws s3 ls --profile "$P"',
      'gcloud compute instances list --project "$(cat p)" --account "$A" --configuration "$C"',
      'vercel deploy --scope "$S" --token "$T" --global-config "$G" --team "$T2"',
    ]) {
      await decision(cmd);
    }
    expect(sent.filter((call) => call.some((a) => a.includes("<cloudpin")))).toEqual([]);
  });

  it.each([
    ['FLAGS="--subscription other"; az group list $FLAGS', "deny"],
    ['FLAGS="--subscription pinned"; az group list $FLAGS', "allow"],
    ["s=other; az group list --subscription $s", "deny"],
    ["s=pinned; az group list --subscription $s", "allow"],
    ['s=pinned; az group list --subscription "$s"', "allow"],
    ["P=other; aws s3 ls --profile $P", "deny"],
    ["P=default; aws s3 ls --profile $P", "allow"],
  ])("substitutes a variable set earlier on the line: %j", async (cmd, want) => {
    expect((await decision(cmd)).decision).toBe(want);
  });

  it.each([
    // A quoted value it can't read, in a flag that doesn't pick the account.
    'az storage blob upload --file "$(ls *.zip)" --subscription pinned',
    'az storage blob upload --file "$(ls *.zip)"',
    'az group create -n "rg-$(date +%s)" -l westeurope',
    'kubectl delete pod "$(cat pod.txt)"',
    'gh pr create --body "$(cat <<\'EOF\'\nIt\'s done\nEOF\n)" && vercel deploy --scope acme',
    'vercel deploy --scope acme -m "$MSG"',
    // An unquoted $( ) or backticks is one word that is not a flag (owner decision).
    "kubectl logs $(kubectl get pod -l app=x -o name)",
    "az resource delete --ids $(az resource list --query [].id -o tsv)",
    "kubectl delete pod `cat pods.txt`",
    "az group show -n rg-$(date +%s)",
    "az $(cat cmd.txt)",
    // A $(( )) number and a <( ) path are one word each.
    "az group list --top $(( 2 + 3 ))",
    // Exempt commands stay exempt.
    "az login --tenant $(cat tenant.txt)",
    "az account show --subscription $(cat sub.txt)",
    "kubectl config use-context $(cat ctx)",
    "aws configure get region --profile $P",
    "gcloud config set project $(cat p)",
    "vercel whoami --scope $(cat t)",
    "az group list --subscription $(cat sub.txt) --help",
  ])("allows %j", async (cmd) => {
    expect((await decision(cmd)).decision).toBe("allow");
  });

  it("from Claude Code's PowerShell tool, substitutes a variable set on the line", async () => {
    expect((await decision("$s = 'pinned'; az group list --subscription $s", "PowerShell")).decision).toBe("allow");
    expect((await decision("$s = 'other'; az group list --subscription $s", "PowerShell")).decision).toBe("deny");
  });
});

describe("each provider declares the flags its resolve reads (#160)", () => {
  // The provider's own file, plus the helper files whose flag reads it relies on.
  const FILES: Record<string, string[]> = { cloudflare: ["cloudflare.ts", "wrangler-dotenv.ts"] };
  const read = (file: string) => readFileSync(new URL(`../src/providers/${file}`, import.meta.url), "utf8");

  /** The flag names a file reads: literals in flagValue(args, [...]) and kubernetes' flag(args, [...], "-x") calls. */
  function flagsRead(source: string): string[] {
    const names: string[] = [];
    for (const call of source.matchAll(/\b(?:flagValue|flag)\(args, \[([^\]]*)\](?:, "(-\w)")?\)/g)) {
      const list = call[1]!.trim();
      if (/^[A-Za-z_]\w*$/.test(list)) {
        // A loop over a constant, e.g. `for (const flag of IDENTITY_FLAGS) flagValue(args, [flag])`.
        const constant = new RegExp(`for \\(const ${list} of (\\w+)\\)`).exec(source)?.[1];
        const items = constant && new RegExp(`const ${constant} = \\[([^\\]]*)\\]`).exec(source)?.[1];
        expect(items, `flagValue(args, [${list}]) reads a list the test can't find`).toBeTruthy();
        names.push(...[...items!.matchAll(/"(-[^"]+)"/g)].map((m) => m[1]!));
      } else names.push(...[...list.matchAll(/"(-[^"]+)"/g)].map((m) => m[1]!));
      if (call[2]) names.push(call[2]);
    }
    for (const list of source.matchAll(/const name = \[([^\]]*)\]\.find/g)) names.push(...[...list[1]!.matchAll(/"(-[^"]+)"/g)].map((m) => m[1]!));
    return names;
  }

  it.each(providers.map((p) => [p.name, p] as const))("%s", (name, provider: ProviderDef) => {
    const read_ = flagsRead((FILES[name] ?? [`${name}.ts`]).map(read).join("\n"));
    expect(read_.length).toBeGreaterThan(0);
    expect(read_.filter((flag) => !provider.targetFlags?.includes(flag))).toEqual([]);
  });

  it("the scan finds every flag a known provider reads (control)", () => {
    expect(flagsRead(read("gcloud.ts")).sort()).toEqual(["--account", "--configuration", "--project"]);
    expect(flagsRead(read("kubernetes.ts"))).toEqual(expect.arrayContaining(["--context", "--namespace", "-n", "-s", "--kuberc"]));
  });
});
