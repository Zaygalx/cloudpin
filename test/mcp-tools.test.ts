import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { FoundConfig } from "../src/config.js";
import { explain } from "../src/explain.js";
import type { GuardDeps } from "../src/guard.js";
import { hookFile, installedHooks, planInstall } from "../src/install.js";
import { cloudpinTools } from "../src/mcp-tools.js";
import { collectStatus } from "../src/status.js";
import type { ProviderDef, Resolution } from "../src/types.js";

const ROOT = resolve("/work/app");
const HOME = resolve("/home/me");

function vercel(res: Resolution): ProviderDef {
  return {
    name: "vercel",
    bins: ["vercel"],
    statusCommand: "vercel whoami",
    cacheInputs: () => ({ env: [], files: [], dirs: [] }),
    isExempt: () => false,
    resolve: async () => res,
    compare: (pin: Record<string, string>, id) => (pin.team === id.team ? [] : [`team: pinned "${pin.team}", active is "${id.team}"`]),
    switchHint: (pin: Record<string, string>) => `vercel switch ${pin.team}`,
  } as ProviderDef;
}

const config: FoundConfig = { path: join(ROOT, ".cloudpin.yml"), pins: { vercel: { team: "team_acme" } } };
const deps: GuardDeps = {
  providers: [vercel({ kind: "identity", identity: { team: "team_other" }, source: "the global current team" })],
  exec: async () => ({ code: 0, stdout: "", stderr: "" }),
  findConfig: () => config,
};
const files: Record<string, string> = { [hookFile("claude", "user", ROOT, { HOME })]: planInstall("claude", null).content };
const ctx = {
  cwd: ROOT,
  env: { HOME } as NodeJS.ProcessEnv,
  read: (p: string) => files[p] ?? null,
  isDir: (p: string) => p.startsWith(resolve("/work")) && !p.endsWith(".yml"),
};
const tools = cloudpinTools(deps, ctx);
const tool = (name: string) => tools.find((t) => t.name === name)!;

describe("cloudpin_status", () => {
  it("returns what `cloudpin status --json` returns", async () => {
    const expected = await collectStatus(deps, ROOT, ctx.env, () => installedHooks(ctx.read, ROOT, ctx.env));
    expect(await tool("cloudpin_status").call({})).toEqual(expected);
    expect(expected.hooks).toEqual(["claude (personal)"]);
  });
});

describe("cloudpin_check", () => {
  it("returns what `cloudpin explain --agent --json` returns", async () => {
    const calls = await explain("vercel deploy", { mode: "agent", cwd: ROOT, env: ctx.env }, deps);
    expect(await tool("cloudpin_check").call({ command: "vercel deploy" })).toEqual({ mode: "agent", calls });
    expect(calls[0]!.verdict).toBe("block");
  });

  it("decides as the agent hook does: CLOUDPIN_SKIP in the command doesn't count", async () => {
    const res = (await tool("cloudpin_check").call({ command: "CLOUDPIN_SKIP=1 vercel deploy" })) as { calls: { verdict: string }[] };
    expect(res.calls[0]!.verdict).toBe("block");
  });

  it("rejects a bad command", async () => {
    for (const command of [undefined, "", "   ", 42]) {
      await expect(tool("cloudpin_check").call({ command })).rejects.toThrow(/command must be a non-empty string/);
    }
  });
});

describe("relative and missing cwd", () => {
  it("resolves a relative folder against the server's, and refuses one that doesn't exist", async () => {
    const res = (await tool("cloudpin_check").call({ command: "vercel ls", cwd: "sub" })) as { calls: { cwd: string }[] };
    expect(res.calls[0]!.cwd).toBe(join(ROOT, "sub"));
    await expect(tool("cloudpin_status").call({ cwd: resolve("/elsewhere") })).rejects.toThrow(/folder not found/);
    await expect(tool("cloudpin_status").call({ cwd: ".cloudpin.yml" })).rejects.toThrow(/folder not found/);
    await expect(tool("cloudpin_check").call({ command: "vercel ls", cwd: 7 })).rejects.toThrow(/cwd must be a string/);
  });
});

describe("schemas", () => {
  it("declare each tool's arguments", () => {
    expect(tool("cloudpin_status").inputSchema).toMatchObject({ type: "object", properties: { cwd: { type: "string" } } });
    expect(tool("cloudpin_check").inputSchema).toMatchObject({
      type: "object",
      properties: { command: { type: "string" }, cwd: { type: "string" } },
      required: ["command"],
    });
  });
});
