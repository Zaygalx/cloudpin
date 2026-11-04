import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { findConfig, type FoundConfig } from "../src/config.js";
import { guard, type GuardDeps } from "../src/guard.js";
import { AGENTS, runHook } from "../src/hooks/agents.js";
import { cloudflare } from "../src/providers/cloudflare.js";
import type { Exec, ProviderDef } from "../src/types.js";
import { tempDir } from "./tmp.js";

// #136: what #119's fold of Windows variable names left out. Windows names are
// case-insensitive, so a user's `cloudpin_env` is CLOUDPIN_ENV there; on Linux
// they are different variables. Every test sets the platform guard is given,
// so both sides run on any OS.

function folder(files: Record<string, string> = {}) {
  const root = tempDir("cloudpin-case-gaps-");
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(join(root, name, ".."), { recursive: true });
    writeFileSync(join(root, name), content);
  }
  return root;
}

// A fake gh, always on the pinned user, so only the environment decides.
const gh: ProviderDef<"github"> = {
  name: "github",
  bins: ["gh"],
  isExempt: (args) => args[0] === "auth",
  resolve: async () => ({ kind: "identity", identity: { user: "octocat" }, source: "t" }),
  compare: (pin, id) => (pin.user === id.user ? [] : [`user: expected "${pin.user}", active is "${id.user}"`]),
  switchHint: (pin) => `gh auth switch --user ${pin.user}`,
  statusCommand: "gh auth status",
  cacheInputs: () => ({ env: [], files: [], dirs: [] }),
};

// Production is listed first and protected; staging is not.
const ENVIRONMENTS = [
  "environments:",
  "  production:",
  "    protected: true",
  "    github:",
  "      user: octocat",
  "  staging:",
  "    github:",
  "      user: octocat",
  "branches:",
  "  release: staging",
  "",
].join("\n");

describe("hook: cloudpin's own variables are case-insensitive on Windows only (#136)", () => {
  const root = folder({ ".cloudpin.yml": ENVIRONMENTS });
  const deps = (platform: NodeJS.Platform): GuardDeps => ({
    providers: [gh as ProviderDef],
    exec: async () => ({ code: 0, stdout: "", stderr: "" }),
    findConfig,
    platform,
  });
  /** The hook's decision for an agent's command: "ask" on production, "none" on staging. */
  const decision = async (command: string, env: NodeJS.ProcessEnv, platform: NodeJS.Platform) => {
    const stdin = JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command }, cwd: root });
    const out = await runHook(AGENTS.claude, stdin, deps(platform), env);
    return out === "" ? "none" : JSON.parse(out).hookSpecificOutput.permissionDecision;
  };

  it("honours the user's lowercase cloudpin_env on win32, and not on linux", async () => {
    expect(await decision("gh pr merge 12", { cloudpin_env: "staging" }, "win32")).toBe("none");
    expect(await decision("gh pr merge 12", { Cloudpin_Env: "staging" }, "win32")).toBe("none");
    expect(await decision("gh pr merge 12", { cloudpin_env: "staging" }, "linux")).toBe("ask");
    // Controls: the exact name counts everywhere, and no variable means production.
    expect(await decision("gh pr merge 12", { CLOUDPIN_ENV: "staging" }, "linux")).toBe("none");
    expect(await decision("gh pr merge 12", {}, "win32")).toBe("ask");
  });

  it("honours the user's lowercase cloudpin_branch on win32, and not on linux", async () => {
    expect(await decision("gh pr merge 12", { cloudpin_branch: "release" }, "win32")).toBe("none");
    expect(await decision("gh pr merge 12", { cloudpin_branch: "release" }, "linux")).toBe("ask");
    expect(await decision("gh pr merge 12", { CLOUDPIN_BRANCH: "release" }, "linux")).toBe("none");
  });

  it("still ignores the agent's own cloudpin_env or cloudpin_branch in any spelling on win32", async () => {
    for (const line of [
      "CLOUDPIN_ENV=staging gh pr merge 12",
      "cloudpin_env=staging gh pr merge 12",
      "Cloudpin_Env=staging gh pr merge 12",
      "export cloudpin_env=staging; gh pr merge 12",
      "$env:cloudpin_env = 'staging'; gh pr merge 12",
      "cloudpin_branch=release gh pr merge 12",
    ]) {
      expect(await decision(line, {}, "win32"), line).toBe("ask");
      expect(await decision(line, {}, "linux"), line).toBe("ask");
    }
  });

  it("doesn't let the agent override or unset the user's variable in another spelling on win32", async () => {
    // The user chose production; the agent's lowercase assignment must not win.
    expect(await decision("cloudpin_env=staging gh pr merge 12", { CLOUDPIN_ENV: "production" }, "win32")).toBe("ask");
    // A plain assignment counts only for a name already exported: here, the user's own.
    expect(await decision("cloudpin_env=staging; gh pr merge 12", { cloudpin_env: "production" }, "win32")).toBe("ask");
    // The user chose staging; the agent can't unset it to fall back to production.
    expect(await decision("unset cloudpin_env; gh pr merge 12", { cloudpin_env: "staging" }, "win32")).toBe("none");
    expect(await decision("unset CLOUDPIN_ENV; gh pr merge 12", { cloudpin_env: "staging" }, "win32")).toBe("none");
  });
});

describe("guard: CLOUDPIN_CONFIRM and CLOUDPIN_SKIP are case-insensitive on Windows only (#136)", () => {
  const production: FoundConfig = {
    path: "/repo/.cloudpin.yml",
    pins: { github: { user: "octocat" } },
    environment: { name: "production", protected: true, source: "first listed" },
  };
  const deps = (platform: NodeJS.Platform): GuardDeps => ({
    providers: [gh as ProviderDef],
    exec: async () => ({ code: 0, stdout: "", stderr: "" }),
    findConfig: () => production,
    platform,
  });
  const run = (env: NodeJS.ProcessEnv, platform: NodeJS.Platform, mode: "shell" | "agent" = "shell") =>
    guard({ bin: "gh", args: ["pr", "merge", "12"], env, cwd: "/repo", mode }, deps(platform));

  it("confirms with a lowercase cloudpin_confirm in a terminal on win32, and not on linux", async () => {
    expect(await run({ cloudpin_confirm: "production" }, "win32")).toEqual({ action: "allow", reason: "confirmed" });
    expect(await run({ cloudpin_confirm: "production" }, "linux")).toMatchObject({ action: "confirm" });
    expect(await run({ CLOUDPIN_CONFIRM: "production" }, "linux")).toEqual({ action: "allow", reason: "confirmed" });
    // An agent can't confirm, in any spelling.
    expect(await run({ cloudpin_confirm: "production" }, "win32", "agent")).toMatchObject({ action: "confirm" });
  });

  it("skips with a lowercase cloudpin_skip in a terminal on win32, and not on linux", async () => {
    expect(await run({ cloudpin_skip: "1" }, "win32")).toEqual({ action: "allow", reason: "skipped" });
    expect(await run({ cloudpin_skip: "1" }, "linux")).toMatchObject({ action: "confirm" });
    expect(await run({ cloudpin_skip: "1" }, "win32", "agent")).toMatchObject({ action: "confirm" });
  });
});

describe("guard: the read-only check sees a lowercase aws_config_file on Windows only (#136)", () => {
  // An AWS CLI alias file next to the config file means no aws command is
  // trusted as read-only (readonly.ts awsAliasFiles), so a protected
  // environment asks even for `aws s3 ls`.
  const fakeAws: ProviderDef<"aws"> = {
    name: "aws",
    bins: ["aws"],
    isExempt: () => false,
    resolve: async () => ({ kind: "identity", identity: { account: "111122223333" }, source: "t" }),
    compare: (pin, id) => (pin.account === id.account ? [] : ["account differs"]),
    switchHint: () => "aws sso login",
    statusCommand: "aws sts get-caller-identity",
    cacheInputs: () => ({ env: [], files: [], dirs: [] }),
  };
  const production: FoundConfig = {
    path: "/repo/.cloudpin.yml",
    pins: { aws: { account: "111122223333" } },
    environment: { name: "production", protected: true, source: "first listed" },
  };
  const awsDir = folder({ "cli/alias": "[toplevel]\n" });
  const home = folder();
  const run = (env: NodeJS.ProcessEnv, platform: NodeJS.Platform) =>
    guard(
      { bin: "aws", args: ["s3", "ls"], env: { HOME: home, ...env }, cwd: "/repo", mode: "agent" },
      { providers: [fakeAws as ProviderDef], exec: async () => ({ code: 0, stdout: "", stderr: "" }), findConfig: () => production, platform },
    );

  it("asks on win32 when a lowercase aws_config_file points next to an alias file", async () => {
    expect(await run({ aws_config_file: join(awsDir, "config") }, "win32")).toMatchObject({ action: "confirm" });
    // linux: a different variable, so the AWS CLI reads its default config and `s3 ls` only reads.
    expect(await run({ aws_config_file: join(awsDir, "config") }, "linux")).toEqual({ action: "allow", reason: "match" });
    // Control: the exact name asks everywhere.
    expect(await run({ AWS_CONFIG_FILE: join(awsDir, "config") }, "linux")).toMatchObject({ action: "confirm" });
  });
});

describe("guard: names inside Wrangler's .env files fold by the platform guard is given (#136)", () => {
  const A = "0123456789abcdef0123456789abcdef";
  const B = "fedcba9876543210fedcba9876543210";
  const whoamiSeesA: Exec = async () => ({ code: 0, stdout: JSON.stringify({ loggedIn: true, accounts: [{ id: A }] }), stderr: "" });
  const pinnedToA: FoundConfig = { path: "/repo/.cloudpin.yml", pins: { cloudflare: { account: A } } };
  const run = (cwd: string, platform: NodeJS.Platform) =>
    guard(
      { bin: "wrangler", args: ["deploy"], env: {}, cwd, mode: "agent" },
      { providers: [cloudflare], exec: whoamiSeesA, findConfig: () => pinnedToA, platform },
    );

  it("reads a lowercase cloudflare_account_id in .env on win32, and not on linux", async () => {
    const root = folder({ ".env": `cloudflare_account_id=${B}\n` });
    expect(await run(root, "win32")).toMatchObject({ action: "block", problems: [expect.stringContaining(B)] });
    // Wrangler folds .env names on Windows only (config/dot-env.ts), so on linux whoami decides.
    expect(await run(root, "linux")).toEqual({ action: "allow", reason: "match" });
    // Control: the exact name counts everywhere.
    const exact = folder({ ".env": `CLOUDFLARE_ACCOUNT_ID=${B}\n` });
    expect(await run(exact, "linux")).toMatchObject({ action: "block", problems: [expect.stringContaining(B)] });
  });
});
