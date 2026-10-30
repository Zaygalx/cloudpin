import { describe, expect, it } from "vitest";
import { ConfigError, type FoundConfig } from "../src/config.js";
import { guard, type GuardDeps } from "../src/guard.js";
import type { ProviderDef, Resolution } from "../src/types.js";

function fakeGithub(resolution: Resolution): ProviderDef<"github"> {
  return {
    name: "github",
    bins: ["gh"],
    isExempt: (args) => args[0] === "auth",
    resolve: async () => resolution,
    compare: (pin, id) => (pin.user === id.user ? [] : [`user: expected "${pin.user}", active is "${id.user}"`]),
    switchHint: (pin) => `gh auth switch --user ${pin.user}`,
    statusCommand: "gh auth status",
    cacheInputs: () => ({ env: [], files: [], dirs: [] }),
  };
}

const pinned: FoundConfig = { path: "/repo/.cloudpin.yml", pins: { github: { user: "paureis" } } };

function deps(resolution: Resolution, config: FoundConfig | null | Error = pinned): GuardDeps {
  return {
    providers: [fakeGithub(resolution)],
    exec: async () => ({ code: 0, stdout: "", stderr: "" }),
    findConfig: () => {
      if (config instanceof Error) throw config;
      return config;
    },
  };
}

const me: Resolution = { kind: "identity", identity: { user: "paureis" }, source: "test" };
const other: Resolution = { kind: "identity", identity: { user: "someone" }, source: "test" };
const req = (bin: string, args: string[], extra: Partial<Parameters<typeof guard>[0]> = {}) => ({
  bin,
  args,
  env: {},
  cwd: "/repo/app",
  mode: "shell" as const,
  ...extra,
});

describe("guard", () => {
  it("allows CLIs it does not guard", async () => {
    expect(await guard(req("git", ["push"]), deps(other))).toEqual({ action: "allow", reason: "not-guarded" });
  });

  it("recognises guarded CLIs by path and Windows extension", async () => {
    const v = await guard(req("C:\\Program Files\\GitHub CLI\\GH.EXE", ["pr", "list"]), deps(other));
    expect(v.action).toBe("block");
  });

  it("allows everything when no .cloudpin.yml is found", async () => {
    expect(await guard(req("gh", ["pr", "list"]), deps(other, null))).toEqual({
      action: "allow",
      reason: "no-config",
    });
  });

  it("allows a CLI the config does not pin", async () => {
    const cfg = { path: "/repo/.cloudpin.yml", pins: { aws: { account: "1" } } };
    expect(await guard(req("gh", ["pr", "list"]), deps(other, cfg))).toEqual({
      action: "allow",
      reason: "not-pinned",
    });
  });

  it("allows exempt commands without resolving", async () => {
    expect(await guard(req("gh", ["auth", "switch"]), deps(other))).toEqual({ action: "allow", reason: "exempt" });
  });

  it("allows a matching identity", async () => {
    expect(await guard(req("gh", ["pr", "list"]), deps(me))).toEqual({ action: "allow", reason: "match" });
  });

  it("blocks a mismatch with the details and how to switch", async () => {
    expect(await guard(req("gh", ["pr", "list"]), deps(other))).toEqual({
      action: "block",
      provider: "github",
      configPath: "/repo/.cloudpin.yml",
      problems: ['user: expected "paureis", active is "someone"'],
      fix: "gh auth switch --user paureis",
    });
  });

  it("blocks when logged out, suggesting the login command", async () => {
    const v = await guard(req("gh", ["pr", "list"]), deps({ kind: "logged-out", hint: "gh auth login" }));
    expect(v).toMatchObject({ action: "block", problems: ["not logged in"], fix: "gh auth login" });
  });

  it("fails closed when the identity cannot be determined", async () => {
    const v = await guard(req("gh", ["pr", "list"]), deps({ kind: "error", message: "network down" }));
    expect(v).toMatchObject({
      action: "block",
      uncertain: true,
      problems: ["network down"],
      fix: "gh auth status",
    });
  });

  it("can't tell a pinned field the identity can't be read for, and checks the rest as usual (#165)", async () => {
    const unknown = (field: string): Resolution => ({ ...me, unknown: { [field]: "user is unreadable" } });
    expect(await guard(req("gh", ["pr", "list"]), deps(unknown("user")))).toMatchObject({
      action: "block",
      uncertain: true,
      problems: ["user is unreadable"],
      fix: "gh auth status",
    });
    expect(await guard(req("gh", ["pr", "list"]), deps(unknown("host")))).toEqual({ action: "allow", reason: "match" });
  });

  it("fails closed on an invalid config file", async () => {
    const v = await guard(req("gh", ["pr", "list"]), deps(me, new ConfigError("/repo/.cloudpin.yml: bad")));
    expect(v).toMatchObject({ action: "block", problems: ["invalid config: /repo/.cloudpin.yml: bad"] });
  });

  it("honours CLOUDPIN_SKIP=1 for humans", async () => {
    const v = await guard(req("gh", ["pr", "list"], { env: { CLOUDPIN_SKIP: "1" } }), deps(other));
    expect(v).toEqual({ action: "allow", reason: "skipped" });
  });

  it("ignores CLOUDPIN_SKIP in agent mode", async () => {
    const v = await guard(req("gh", ["pr", "list"], { env: { CLOUDPIN_SKIP: "1" }, mode: "agent" }), deps(other));
    expect(v.action).toBe("block");
  });

  it("lets the command through when the pinned CLI is not installed (it fails on its own)", async () => {
    // A provider that asks the CLI, which the runner reports as missing (exit 127).
    const asksCli: ProviderDef<"github"> = {
      ...fakeGithub(me),
      resolve: async (_ctx, exec) => {
        const r = await exec("gh", ["api", "user"], {});
        return { kind: "error", message: `gh api user failed (exit ${r.code})` };
      },
    };
    const v = await guard(req("gh", ["pr", "list"]), {
      ...deps(me),
      providers: [asksCli as ProviderDef],
      exec: async () => ({ code: 127, stdout: "", stderr: "spawn gh ENOENT", notFound: true }),
    });
    expect(v).toEqual({ action: "allow", reason: "not-installed" });
  });
});

describe("guard with a protected environment", () => {
  const production = { name: "production", protected: true, source: 'branch "main"' };
  const prodConfig: FoundConfig = { ...pinned, environment: production };

  it("asks for confirmation before a changing command on the right account", async () => {
    expect(await guard(req("gh", ["pr", "merge", "12"]), deps(me, prodConfig))).toEqual({
      action: "confirm",
      provider: "github",
      configPath: "/repo/.cloudpin.yml",
      environment: production,
    });
  });

  it("lets read-only commands through without asking", async () => {
    expect(await guard(req("gh", ["pr", "list"]), deps(me, prodConfig))).toEqual({ action: "allow", reason: "match" });
  });

  it("uses the project's read_only rules", async () => {
    const cfg = { ...prodConfig, readOnly: { github: [["pr", "checks"]] } };
    expect(await guard(req("gh", ["pr", "checks", "12"]), deps(me, cfg))).toEqual({ action: "allow", reason: "match" });
  });

  it("does not ask on an unprotected environment", async () => {
    const cfg = { ...pinned, environment: { name: "staging", protected: false, source: "first listed" } };
    expect(await guard(req("gh", ["pr", "merge", "12"]), deps(me, cfg))).toEqual({ action: "allow", reason: "match" });
  });

  it("still blocks a wrong account, naming the environment", async () => {
    expect(await guard(req("gh", ["pr", "merge", "12"]), deps(other, prodConfig))).toMatchObject({
      action: "block",
      environment: production,
    });
  });

  it("accepts CLOUDPIN_CONFIRM=<env> from a human without a terminal", async () => {
    const env = { CLOUDPIN_CONFIRM: "production" };
    expect(await guard(req("gh", ["pr", "merge", "12"], { env }), deps(me, prodConfig))).toEqual({
      action: "allow",
      reason: "confirmed",
    });
  });

  it("ignores CLOUDPIN_CONFIRM naming another environment", async () => {
    const env = { CLOUDPIN_CONFIRM: "staging" };
    expect((await guard(req("gh", ["pr", "merge", "12"], { env }), deps(me, prodConfig))).action).toBe("confirm");
  });

  it("ignores CLOUDPIN_CONFIRM in agent mode, so an agent cannot confirm for the user", async () => {
    const env = { CLOUDPIN_CONFIRM: "production" };
    const v = await guard(req("gh", ["pr", "merge", "12"], { env, mode: "agent" }), deps(me, prodConfig));
    expect(v.action).toBe("confirm");
  });

  it("still allows exempt commands", async () => {
    expect(await guard(req("gh", ["auth", "switch"]), deps(other, prodConfig))).toEqual({ action: "allow", reason: "exempt" });
  });

  it("passes the command's environment variables to the config lookup", async () => {
    let seen: NodeJS.ProcessEnv | undefined;
    await guard(req("gh", ["pr", "list"], { env: { CLOUDPIN_ENV: "staging" } }), {
      ...deps(me),
      findConfig: (_cwd, env) => {
        seen = env;
        return pinned;
      },
    });
    expect(seen).toEqual({ CLOUDPIN_ENV: "staging" });
  });
});

describe("guard with a broken pin file", () => {
  const broken = new ConfigError('use either provider sections or "environments" at the top level, not both');

  it("still runs exempt commands, which never act on an account (#62)", async () => {
    expect(await guard(req("gh", ["auth", "status"]), deps(me, broken))).toEqual({ action: "allow", reason: "exempt" });
  });

  it("blocks every other command, as before", async () => {
    const v = await guard(req("gh", ["pr", "list"]), deps(me, broken));
    expect(v).toMatchObject({ action: "block", problems: [expect.stringMatching(/invalid config/)] });
  });
});
