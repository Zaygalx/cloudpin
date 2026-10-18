import { describe, expect, it } from "vitest";
import type { FoundConfig } from "../src/config.js";
import { explain, formatExplain } from "../src/explain.js";
import type { GuardDeps } from "../src/guard.js";
import type { ProviderDef, Resolution } from "../src/types.js";

function fakeVercel(resolve: (args: string[], env: NodeJS.ProcessEnv) => Resolution, missing = false): ProviderDef<"vercel"> {
  return {
    name: "vercel",
    bins: ["vercel", "vc"],
    isExempt: (args) => args[0] === "login" || args[0] === "whoami",
    resolve: async (ctx, exec) => {
      if (missing) {
        await exec("vercel", [], ctx.env);
        return { kind: "error", message: "spawn vercel ENOENT" };
      }
      return resolve(ctx.args, ctx.env);
    },
    compare: (pin, id) => (pin.team === id.team ? [] : [`team: pinned "${pin.team}", the command would use "${id.team}"`]),
    switchHint: (pin) => `vercel switch ${pin.team}`,
    statusCommand: "vercel whoami",
    cacheInputs: () => ({ env: [], files: [], dirs: [] }),
  };
}

const ACME: Resolution = { kind: "identity", identity: { team: "team_acme", label: "Acme" }, source: "the global current team" };
// --scope picks the team the command uses, as the real provider does.
const byScope = (args: string[]): Resolution => {
  const i = args.indexOf("--scope");
  return i === -1 ? ACME : { kind: "identity", identity: { team: args[i + 1]! }, source: "--scope" };
};

const flat: FoundConfig = { path: "/repo/.cloudpin.yml", pins: { vercel: { team: "team_acme" } } };
const prod: FoundConfig = {
  ...flat,
  environment: { name: "production", protected: true, source: 'branch "main"' },
};

function deps(config: FoundConfig | null, missing = false): GuardDeps {
  return {
    providers: [fakeVercel(byScope, missing)] as ProviderDef[],
    exec: async () => ({ code: 1, stdout: "", stderr: "", notFound: true }),
    findConfig: () => config,
  };
}

const run = (command: string | string[], config: FoundConfig | null = flat, opts: { mode?: "shell" | "agent"; env?: NodeJS.ProcessEnv; missing?: boolean } = {}) =>
  explain(command, { mode: opts.mode ?? "shell", cwd: "/repo/app", env: opts.env ?? {} }, deps(config, opts.missing));

describe("explain", () => {
  it("shows the pin, the account the command would use and why, and allows a match", async () => {
    const [call] = await run(["vercel", "ls"]);
    expect(call).toMatchObject({
      argv: ["vercel", "ls"],
      cli: "vercel",
      pinFile: "/repo/.cloudpin.yml",
      pin: { team: "team_acme" },
      identity: { team: "team_acme", label: "Acme" },
      source: "the global current team",
      verdict: "allow",
    });
    expect(call!.reason).toMatch(/matches the pin/);
  });

  it("blocks a command whose own flags pick another account, with the reason and the fix", async () => {
    const [call] = await run(["vercel", "deploy", "--scope", "team_other"]);
    expect(call).toMatchObject({ verdict: "block", identity: { team: "team_other" }, source: "--scope", fix: "vercel switch team_acme (or run cloudpin switch)" });
    expect(call!.problems).toEqual(['team: pinned "team_acme", the command would use "team_other"']);
  });

  it("asks on a protected environment for a command that may change something", async () => {
    const [call] = await run(["vercel", "deploy", "--prod"], prod);
    expect(call).toMatchObject({ verdict: "ask", environment: { name: "production", source: 'branch "main"' }, readOnly: false });
    expect(call!.reason).toMatch(/production is protected/);
  });

  it("says why a read-only command on a protected environment runs without asking", async () => {
    const [call] = await run(["vercel", "ls"], prod);
    expect(call).toMatchObject({ verdict: "allow", readOnly: true });
    expect(call!.reason).toMatch(/read-only/);
  });

  it("explains exempt, unpinned, unguarded and not-installed commands", async () => {
    expect((await run(["vercel", "login"]))[0]).toMatchObject({ verdict: "allow", reason: expect.stringMatching(/always run/) });
    expect((await run(["vercel", "ls"], null))[0]).toMatchObject({ verdict: "allow", reason: expect.stringMatching(/no \.cloudpin\.yml/) });
    expect((await run(["vercel", "ls"], { path: "/repo/.cloudpin.yml", pins: {} }))[0]).toMatchObject({
      verdict: "allow",
      reason: expect.stringMatching(/not pinned/),
    });
    expect((await run(["vercel", "ls"], flat, { missing: true }))[0]).toMatchObject({
      verdict: "allow",
      reason: expect.stringMatching(/not installed/),
    });
    expect(await run(["git", "push"])).toEqual([
      expect.objectContaining({ argv: ["git", "push"], cli: null, verdict: "allow", reason: expect.stringMatching(/doesn't guard/) }),
    ]);
  });

  it("honours CLOUDPIN_SKIP for the terminal but not for an agent", async () => {
    const other = ["vercel", "deploy", "--scope", "team_other"];
    expect((await run(other, flat, { env: { CLOUDPIN_SKIP: "1" } }))[0]!.verdict).toBe("allow");
    expect((await run(other, flat, { env: { CLOUDPIN_SKIP: "1" }, mode: "agent" }))[0]!.verdict).toBe("block");
  });

  it("finds every call in a full line, with the folder each runs in, and names env vars without their values", async () => {
    const calls = await run("cd ../web && VERCEL_TOKEN=s3cret vc deploy --scope team_other; git status; vercel ls");
    expect(calls.map((c) => [c.argv.join(" "), c.cwd, c.verdict])).toEqual([
      ["vc deploy --scope team_other", expect.stringMatching(/web$/), "block"],
      ["vercel ls", expect.stringMatching(/web$/), "allow"],
    ]);
    expect(calls[0]!.envNames).toEqual(["VERCEL_TOKEN"]);
    expect(JSON.stringify(calls)).not.toContain("s3cret");
  });

  it("says so when a line has no guarded CLI", async () => {
    const lines = formatExplain(await run("npm test && git push"), {});
    expect(lines.join("\n")).toMatch(/no command here that cloudpin guards/);
  });

  it("unwraps cloudpin exec, as the agent hook does", async () => {
    const [call] = await run("cloudpin exec -- vercel deploy --scope team_other", flat, { mode: "agent" });
    expect(call).toMatchObject({ argv: ["vercel", "deploy", "--scope", "team_other"], verdict: "block" });
  });
});

describe("formatExplain", () => {
  it("prints each call with its pin, account, verdict and fix", async () => {
    const text = formatExplain(await run(["vercel", "deploy", "--scope", "team_other"], prod), { HOME: "/home/me" }).join("\n");
    expect(text).toContain("vercel deploy --scope team_other");
    expect(text).toMatch(/pin file: +\/repo\/\.cloudpin\.yml/);
    expect(text).toMatch(/environment: +production \(protected\), chosen by branch "main"/);
    expect(text).toMatch(/would use: +team_other {2}\(from --scope\)/);
    expect(text).toMatch(/verdict: +BLOCK/);
    expect(text).toMatch(/fix: +vercel switch team_acme/);
  });
});

describe("explain --agent on a protected environment", () => {
  it("says which agents ask and which stop the command", async () => {
    const [call] = await run(["vercel", "deploy", "--prod"], prod, { mode: "agent" });
    expect(call!.verdict).toBe("ask");
    expect(call!.reason).toContain("Claude Code, Copilot CLI, Antigravity and Cursor ask you first; Codex and Gemini CLI, which can't ask, stop it");
  });
});

describe("explain: environment chosen inside the line", () => {
  const staging: FoundConfig = { ...flat, environment: { name: "staging", protected: false, source: "CLOUDPIN_ENV" } };
  const byEnv: GuardDeps = {
    ...deps(prod),
    findConfig: (_cwd, env) => (env.CLOUDPIN_ENV === "staging" ? staging : prod),
  };
  const line = "CLOUDPIN_ENV=staging vercel deploy --prod";

  it("lets a person pick the environment in the line, but not an agent", async () => {
    const human = await explain(line, { mode: "shell", cwd: "/repo/app", env: {} }, byEnv);
    expect(human[0]).toMatchObject({ verdict: "allow", environment: { name: "staging" } });
    const agent = await explain(line, { mode: "agent", cwd: "/repo/app", env: {} }, byEnv);
    expect(agent[0]).toMatchObject({ verdict: "ask", environment: { name: "production" } });
  });
});
