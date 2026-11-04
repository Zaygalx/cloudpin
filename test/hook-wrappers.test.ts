import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { FoundConfig } from "../src/config.js";
import type { GuardDeps } from "../src/guard.js";
import { AGENTS, runHook } from "../src/hooks/agents.js";
import { providers } from "../src/providers/index.js";
import type { Exec } from "../src/types.js";
import { tempDir } from "./tmp.js";

// #162 through the agent hook, with the real providers and a fake Exec: each wrapper family, with the
// other account it is denied and with the pinned one allowed, in bash and in PowerShell where it runs.

const PINNED = "11111111-0000-0000-0000-000000000001";
const OTHER = "22222222-0000-0000-0000-000000000002";
const SUBSCRIPTIONS: Record<string, string> = { pinned: PINNED, other: OTHER };
const TEAMS = JSON.stringify({
  teams: [
    { id: "team_main", slug: "pinned", current: true },
    { id: "team_side", slug: "other", current: false },
  ],
  pagination: {},
});

const exec: Exec = async (bin, args, env) => {
  const value = (flag: string) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined);
  if (bin === "az") {
    const id = SUBSCRIPTIONS[value("--subscription") ?? "pinned"];
    if (!id) return { code: 1, stdout: "", stderr: "ERROR: Subscription not found." };
    return { code: 0, stdout: JSON.stringify({ id, tenantId: PINNED, name: "x" }), stderr: "" };
  }
  if (bin === "aws") {
    // The pinned account only through the pinned profile; the default profile is the other account.
    const account = (value("--profile") ?? env.AWS_PROFILE) === "pinned" ? "111111111111" : "222222222222";
    return { code: 0, stdout: JSON.stringify({ Account: account, Arn: "arn" }), stderr: "" };
  }
  if (bin === "vercel" && args[0] === "teams") return { code: 0, stdout: TEAMS, stderr: "" };
  return { code: 1, stdout: "", stderr: "unexpected call" };
};

const kubeDir = tempDir("cloudpin-162-kube-");
writeFileSync(
  join(kubeDir, "config"),
  ["apiVersion: v1", "kind: Config", "current-context: pinned", "clusters:",
    "- name: pinned", "  cluster:", "    server: https://pinned.example.com",
    "- name: other", "  cluster:", "    server: https://other.example.com",
    "contexts:", "- name: pinned", "  context:", "    cluster: pinned", "- name: other", "  context:", "    cluster: other", ""].join("\n"),
);

const config: FoundConfig = {
  path: "/repo/.cloudpin.yml",
  pins: {
    azure: { subscription: PINNED },
    aws: { account: "111111111111" },
    vercel: { team: "team_main" },
    kubernetes: { server: "https://pinned.example.com" },
  },
};
const deps: GuardDeps = { providers, exec, findConfig: () => config };
const env = { AWS_PROFILE: "pinned", VERCEL_TOKEN: "example-env-token", KUBECONFIG: join(kubeDir, "config"), KUBERC: "off", PATH: "/usr/bin" };

async function decision(command: string, tool: "Bash" | "PowerShell" = "Bash"): Promise<{ decision: string; reason: string }> {
  const input = JSON.stringify({ hook_event_name: "PreToolUse", tool_name: tool, tool_input: { command }, cwd: tempDir("cloudpin-162-") });
  const out = await runHook(AGENTS.claude, input, deps, env, undefined, "linux");
  const hook = out ? JSON.parse(out).hookSpecificOutput : undefined;
  return { decision: hook?.permissionDecision ?? "allow", reason: hook?.permissionDecisionReason ?? "" };
}

const encoded = (script: string) => Buffer.from(script, "utf16le").toString("base64");
// Each shape with X where the account goes, and the shell that runs it.
const SHAPES: [string, "Bash" | "PowerShell"][] = [
  ["nice -n 10 az group list --subscription X", "Bash"],
  ["sudo -g wheel az group list --subscription X", "Bash"],
  ["env -C . az group list --subscription X", "Bash"],
  ["(exec -a foo az group list --subscription X)", "Bash"],
  ["stdbuf -oL az group list --subscription X", "Bash"],
  ["coproc az group list --subscription X; wait", "Bash"],
  ["timeout --signal=KILL 30 az group list --subscription X", "Bash"],
  ["watch -n 5 'kubectl --context X get pods'", "Bash"],
  ["npx -y vercel@latest deploy --scope X", "Bash"],
  ["pnpm vercel deploy --scope X", "Bash"],
  ["yarn dlx vercel deploy --scope X", "Bash"],
  ["bunx vercel@1 deploy --scope X", "Bash"],
  ["cmd //c 'echo hi & az group list --subscription X'", "Bash"],
  ["powershell -NoProfile -c 'az group list --subscription X'", "Bash"],
  ["cmd /c az group list --subscription X", "PowerShell"],
  ['cmd /c "az group list --subscription X"', "PowerShell"],
  ['powershell -NoProfile "az group list --subscription X"', "PowerShell"],
  ["pwsh -NoProfile -Comm 'az group list --subscription X'", "PowerShell"],
  ["iex 'az group list --subscription X'", "PowerShell"],
  ["'az group list --subscription X' | Invoke-Expression", "PowerShell"],
  ["Start-Process az -ArgumentList 'group','list','--subscription','X' -NoNewWindow -Wait", "PowerShell"],
  ["& (Get-Command az).Source group list --subscription X", "PowerShell"],
  ["npx wrangler@latest whoami; npx vercel deploy --scope X", "PowerShell"],
];

describe("agent hook: a wrapper or a runner no longer hides the call (#162)", () => {
  it.each(SHAPES)("denies the other account and allows the pinned one: %j (%s)", async (shape, tool) => {
    expect((await decision(shape.split("X").join("other"), tool)).decision).toBe("deny");
    expect((await decision(shape.split("X").join("pinned"), tool)).decision).toBe("allow");
  });

  it("reads -EncodedCommand", async () => {
    const line = (account: string) => `powershell -NoProfile -EncodedCommand ${encoded(`az group list --subscription ${account}`)}`;
    expect((await decision(line("other"), "PowerShell")).decision).toBe("deny");
    expect((await decision(line("pinned"), "PowerShell")).decision).toBe("allow");
  });

  it.each([
    ["env -u AWS_PROFILE aws s3 ls", "env aws s3 ls"],
    ["env -i aws s3 ls", "env -i AWS_PROFILE=pinned aws s3 ls"],
    ["(exec -c aws s3 ls)", "(exec aws s3 ls)"],
  ])("counts the variables %j removes, against %j", async (removed, kept) => {
    expect((await decision(removed)).decision).toBe("deny");
    expect((await decision(kept)).decision).toBe("allow");
  });

  it.each([
    "echo other | xargs az group list --subscription",
    "echo x | xargs -I{} az group list --subscription {}",
    "sudo -Z az group list --subscription pinned",
    "Get-Content cmd.txt | iex; az version",
    "cmd /c 'az group list --subscription %SUB%'",
    "Start-Process az -ArgumentList $a",
  ])("can't tell for %j", async (line) => {
    const tool = /\b(iex|Start-Process|cmd \/c)\b/.test(line) ? "PowerShell" : "Bash";
    const { decision: d, reason } = await decision(line, tool);
    expect(d).toBe("deny");
    expect(reason).toContain("can't tell");
  });

  it("says the words xargs adds are why it can't tell", async () => {
    expect((await decision("echo other | xargs az group list --subscription")).reason).toContain("input xargs adds");
  });

  it.each([
    ["echo x | xargs az login", "Bash"],
    ["echo x | xargs -I{} az group list --subscription pinned --query {}", "Bash"],
    ["sudo -Z ls", "Bash"],
    ["iex (Get-Content run.txt)", "PowerShell"],
    ["powershell -NoProfile -File deploy.ps1", "PowerShell"],
    ["command -v az", "Bash"],
  ] as const)("allows %j, where what it can't read can't change the account", async (line, tool) => {
    expect((await decision(line, tool)).decision).toBe("allow");
  });
});
