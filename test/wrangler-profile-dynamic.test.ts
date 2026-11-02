import { describe, expect, it } from "vitest";
import type { FoundConfig } from "../src/config.js";
import type { GuardDeps } from "../src/guard.js";
import { AGENTS, runHook } from "../src/hooks/agents.js";
import { providers } from "../src/providers/index.js";
import type { Exec } from "../src/types.js";
import { tempDir } from "./tmp.js";

// #103 meets #160: Wrangler's --profile picks the login a command uses, so a profile name known only when the
// command runs gives "can't tell", like every other flag that picks the account.

const ACCOUNT = "0123456789abcdef0123456789abcdef";
const sent: string[][] = [];
const exec: Exec = async (bin, args) => {
  sent.push([bin, ...args]);
  return { code: 1, stdout: "", stderr: "unexpected call" };
};
const config: FoundConfig = { path: "/repo/.cloudpin.yml", pins: { cloudflare: { account: ACCOUNT } } };
const deps: GuardDeps = { providers, exec, findConfig: () => config };
const env = { HOME: tempDir("cloudpin-103-home-"), USERPROFILE: tempDir("cloudpin-103-home-") };

async function decision(command: string): Promise<{ decision: string; reason: string }> {
  const input = JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command }, cwd: tempDir("cloudpin-103-") });
  const out = await runHook(AGENTS.claude, input, deps, env);
  const hook = out ? JSON.parse(out).hookSpecificOutput : undefined;
  return { decision: hook?.permissionDecision ?? "allow", reason: hook?.permissionDecisionReason ?? "" };
}

describe("agent hook: a Wrangler --profile known only when the command runs (#103, #160)", () => {
  it.each(['wrangler deploy --profile "$P"', "wrangler deploy --profile $(cat profile)", 'wrangler deploy --profile="$P"'])(
    "can't tell for %j, and names --profile",
    async (cmd) => {
      const { decision: d, reason } = await decision(cmd);
      expect(d).toBe("deny");
      expect(reason).toContain("--profile ");
      expect(reason).toContain("can't tell");
    },
  );

  it("a literal --profile is not a can't-tell (control)", async () => {
    const { reason } = await decision("wrangler deploy --profile work");
    expect(reason).not.toContain("--profile is set");
    expect(reason).not.toMatch(/--profile .*can't tell/);
  });

  it("declares --profile among the flags its resolve reads", () => {
    expect(providers.find((p) => p.name === "cloudflare")?.targetFlags).toContain("--profile");
  });
});
