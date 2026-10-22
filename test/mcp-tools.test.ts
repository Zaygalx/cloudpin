import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { FoundConfig } from "../src/config.js";
import { explain } from "../src/explain.js";
import type { GuardDeps } from "../src/guard.js";
import { hookFile, installedHooks, planInstall } from "../src/install.js";
import { CLOUDPIN_INSTRUCTIONS, cloudpinHandler, cloudpinTools } from "../src/mcp-tools.js";
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

describe("server instructions", () => {
  // Codex reads them as server-wide guidance and asks that the first 512 characters stand alone
  // (learn.chatgpt.com/docs/extend/mcp, "Server instructions").
  const head = CLOUDPIN_INSTRUCTIONS.slice(0, 512);

  it("say to check first, with both tools, inside the first 512 characters", () => {
    expect(head).toMatch(/call cloudpin_status before cloud work/i);
    expect(head).toMatch(/before running any command that uses a cloud CLI, call cloudpin_check/i);
    expect(head).toMatch(/only if the verdict is allow/i);
  });

  it("say to stop on a block or an ask, and never to work around it", () => {
    expect(head).toMatch(/on block or ask, stop and tell the user the reason and the fix/i);
    expect(head).toMatch(/never work around a block/i);
    for (const way of ["another account", "CLOUDPIN_SKIP", "environment variable", "script file"]) expect(head).toContain(way);
  });

  it("say the server only reads", () => {
    expect(head).toMatch(/never runs or switches anything/i);
  });

  it("are what `cloudpin mcp`'s handler sends at initialize, with both tools", async () => {
    const handle = cloudpinHandler(deps, ctx, "9.9.9");
    const init = JSON.parse((await handle(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25" } })))!);
    expect(init.result.instructions).toBe(CLOUDPIN_INSTRUCTIONS);
    expect(init.result.serverInfo).toEqual({ name: "cloudpin", version: "9.9.9" });
    const list = JSON.parse((await handle(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" })))!);
    expect(list.result.tools.map((t: { name: string }) => t.name)).toEqual(["cloudpin_status", "cloudpin_check"]);
  });

  it("name every CLI the tools describe, as the skill does", () => {
    const clis = ["az", "aws", "gcloud", "vercel", "gh", "kubectl", "helm", "supabase", "wrangler"];
    expect(head).toContain(clis.join(", "));
    expect(tool("cloudpin_status").description).toContain(clis.join(", "));
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
