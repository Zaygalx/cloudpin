import { describe, expect, it } from "vitest";
import type { FoundConfig } from "../src/config.js";
import { explain } from "../src/explain.js";
import type { GuardDeps } from "../src/guard.js";
import { AGENTS, runHook, type AgentHook } from "../src/hooks/agents.js";
import { cloudpinTools } from "../src/mcp-tools.js";
import { azure } from "../src/providers/azure.js";
import type { Exec } from "../src/types.js";
import { tempDir } from "./tmp.js";

// #159 through the agent hooks, with the real azure provider and a fake Exec: a PowerShell command is read
// with PowerShell's rules, so each shape the 2026-10-26 audit found is denied with the wrong subscription
// and allowed with the pinned one. Claude Code names its PowerShell tool "PowerShell", Copilot CLI
// "powershell"; Codex names every shell call "Bash" and runs it in PowerShell on Windows, so there it is
// read both ways.

const PINNED = "11111111-0000-0000-0000-000000000001";
const OTHER = "22222222-0000-0000-0000-000000000002";
const SUBSCRIPTIONS: Record<string, string> = { pinned: PINNED, other: OTHER };
const sent: string[][] = [];
const exec: Exec = async (bin, args) => {
  sent.push([bin, ...args]);
  const at = args.indexOf("--subscription");
  const id = SUBSCRIPTIONS[at === -1 ? "pinned" : args[at + 1]!];
  if (bin !== "az" || !id) return { code: 1, stdout: "", stderr: "ERROR: Subscription not found." };
  return { code: 0, stdout: JSON.stringify({ id, tenantId: PINNED, name: "x" }), stderr: "" };
};
const config: FoundConfig = { path: "/repo/.cloudpin.yml", pins: { azure: { subscription: PINNED } } };
const deps: GuardDeps = { providers: [azure], exec, findConfig: () => config };

const BT = "`";
const CRLF = "\r\n";
// Each shape with SUB where the subscription goes.
const SHAPES = [
  `az group list ${BT}${CRLF}  --subscription SUB`,
  `az group list ${BT}\n  --subscription SUB`,
  `Write-Host "Done${BT}n"; az group list --subscription SUB`,
  String.raw`az group list --query "C:\build\" --subscription SUB`,
  String.raw`az group list --query "C:\my build\" --subscription SUB`,
  `$m = @'${CRLF}it's${CRLF}'@${CRLF}az group list --subscription SUB`,
  `$m = @"${CRLF}say "hi${CRLF}"@${CRLF}az group list --subscription SUB`,
  "az group list <# note #> --subscription SUB",
  "az --% group list ; --subscription SUB",
  `az ${BT}--% group list ; --subscription SUB`,
  "& { az group list --subscription SUB }",
  ". az group list --subscription SUB",
  "az group list --query 'x \"y --subscription SUB\"'",
  "$s = 'SUB'; az group list --subscription $s",
  "if ($true) { } az group list --subscription SUB",
  "function f { } az group list --subscription SUB",
  "& { return az group list --subscription SUB }",
];

type Agent = { name: string; hook: AgentHook; payload: (command: string) => object; platform?: NodeJS.Platform };
const AGENT_CASES: Agent[] = [
  { name: "Claude Code", hook: AGENTS.claude, payload: (command) => ({ tool_name: "PowerShell", tool_input: { command } }) },
  { name: "Copilot CLI", hook: AGENTS.copilot, payload: (command) => ({ toolName: "powershell", toolArgs: JSON.stringify({ command }) }) },
  { name: "Codex on Windows", hook: AGENTS.codex, payload: (command) => ({ tool_name: "Bash", tool_input: { command } }), platform: "win32" },
];

async function decision(agent: Agent, command: string): Promise<{ decision: string; reason: string }> {
  const input = JSON.stringify({ hook_event_name: "PreToolUse", cwd: tempDir("cloudpin-159-"), ...agent.payload(command) });
  const out = await runHook(agent.hook, input, deps, {}, undefined, agent.platform ?? "linux");
  if (!out) return { decision: "allow", reason: "" };
  const json = JSON.parse(out);
  const hook = json.hookSpecificOutput ?? json;
  return { decision: hook.permissionDecision, reason: hook.permissionDecisionReason };
}

describe.each(AGENT_CASES)("agent hook: $name reads PowerShell with PowerShell's rules (#159)", (agent) => {
  it.each(SHAPES)("denies the wrong subscription and allows the pinned one: %j", async (shape) => {
    expect((await decision(agent, shape.split("SUB").join("other"))).decision).toBe("deny");
    expect((await decision(agent, shape.split("SUB").join("pinned"))).decision).toBe("allow");
  });

  it.each([
    "$a = '--subscription','other'; az group list $a",
    "$a = @('--subscription','other'); az group list @a",
    "function run { az @args }; run group list --subscription other",
  ])("can't tell when a list or a splat may hold the flag: %j", async (cmd) => {
    const { decision: d, reason } = await decision(agent, cmd);
    expect(d).toBe("deny");
    expect(reason).toContain("can't tell");
  });

  it("reads $_ and $env:X as one word that is not a flag (Codex on Windows: bash may split them, so can't tell)", async () => {
    const expected = agent.platform === "win32" ? "deny" : "allow";
    expect((await decision(agent, "'a','b' | ForEach-Object { az group show -n $_ }")).decision).toBe(expected);
    expect((await decision(agent, "az group show -n $env:RG")).decision).toBe(expected);
  });

  it("never sends a marker to the CLI", () => {
    expect(sent.flat().some((a) => a.includes("<cloudpin:"))).toBe(false);
  });
});

describe("agent hook: a shell call that names no shell (#159)", () => {
  const codex = (command: string, platform: NodeJS.Platform) =>
    decision({ name: "Codex", hook: AGENTS.codex, payload: (c) => ({ tool_name: "Bash", tool_input: { command: c } }), platform }, command);

  it("is read as bash off Windows", async () => {
    expect((await codex(`az group list ${BT}\n  --subscription other`, "linux")).decision).toBe("allow");
    expect((await codex("s=other; az group list --subscription $s", "linux")).decision).toBe("deny");
  });

  it("is read both ways on Windows, so a bash line is still checked as bash", async () => {
    expect((await codex("s=other; az group list --subscription $s", "win32")).decision).toBe("deny");
    expect((await codex(`az group list ${BT}\n  --subscription other`, "win32")).decision).toBe("deny");
    // The price: PowerShell doesn't know a bash variable, so the pinned one can't be told either.
    expect((await codex("s=pinned; az group list --subscription $s", "win32")).reason).toContain("can't tell");
    expect((await codex("az group list --subscription pinned", "win32")).decision).toBe("allow");
  });

  it("leaves Claude Code's and Copilot's Bash tool to bash", async () => {
    const bash = (command: string) => ({ tool_name: "Bash", tool_input: { command } });
    const claude = { name: "Claude Code", hook: AGENTS.claude, payload: bash, platform: "win32" as const };
    expect((await decision(claude, `az group list ${BT}\n  --subscription other`)).decision).toBe("allow");
    expect((await decision(claude, "s=other; az group list --subscription $s")).decision).toBe("deny");
  });
});

describe("explain and cloudpin_check take the shell (#159)", () => {
  const cwd = tempDir("cloudpin-159-explain-");
  const line = "az group list <# note #> --subscription other";

  it("explain reads the line as PowerShell when told, as bash by default", async () => {
    const ps = await explain(line, { mode: "agent", cwd, env: {}, shell: "powershell" }, deps);
    expect(ps.map((c) => [c.argv, c.verdict])).toEqual([[["az", "group", "list", "--subscription", "other"], "block"]]);
    const bash = await explain(line, { mode: "agent", cwd, env: {} }, deps);
    expect(bash.map((c) => c.argv)).not.toEqual(ps.map((c) => c.argv));
  });

  it("cloudpin_check accepts shell: powershell, and rejects any other value", async () => {
    const tools = cloudpinTools(deps, { cwd, env: {}, read: () => null, isDir: () => true });
    const check = tools.find((t) => t.name === "cloudpin_check")!;
    expect(JSON.stringify(check.inputSchema)).toContain('"shell"');
    const result = (await check.call({ command: line, shell: "powershell" })) as { calls: { verdict: string }[] };
    expect(result.calls.map((c) => c.verdict)).toEqual(["block"]);
    await expect(check.call({ command: line, shell: "cmd" })).rejects.toThrow(/shell/);
  });
});
