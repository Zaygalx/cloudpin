import { describe, expect, it } from "vitest";
import { checkExitCode, formatCheckText, parseCheckArgs, runCheck, type CheckReport } from "../src/check.js";
import { ConfigError, type FoundConfig } from "../src/config.js";
import type { GuardDeps } from "../src/guard.js";
import type { Exec, ProviderDef, Resolution } from "../src/types.js";

function provider(name: "github" | "aws", res: Resolution): ProviderDef {
  return {
    name,
    bins: [name === "github" ? "gh" : "aws"],
    statusCommand: name === "github" ? "gh auth status" : "aws sts get-caller-identity",
    cacheInputs: () => ({ env: [], files: [], dirs: [] }),
    isExempt: () => false,
    resolve: async () => res,
    compare: (pin: Record<string, string>, id) =>
      Object.entries(pin)
        .filter(([k, v]) => id[k] !== v)
        .map(([k, v]) => `${k}: expected "${v}", active is "${id[k]}"`),
    switchHint: () => "switch",
  } as ProviderDef;
}

const deps = (
  config: FoundConfig | null | (() => FoundConfig | null),
  providers: ProviderDef[],
  onPath?: GuardDeps["onPath"],
): GuardDeps => ({
  providers,
  exec: async () => ({ code: 0, stdout: "", stderr: "" }),
  findConfig: typeof config === "function" ? config : () => config,
  ...(onPath ? { onPath } : {}),
});

const PATH = "/repo/.cloudpin.yml";
const as = (user: string): Resolution => ({ kind: "identity", identity: { user }, source: "t" });
const githubPinned: FoundConfig = { path: PATH, pins: { github: { user: "me" } } };
const bothPinned: FoundConfig = { path: PATH, pins: { github: { user: "me" }, aws: { account: "1" } } };
const loggedOutAws = provider("aws", { kind: "logged-out", hint: "aws login" });

/** A provider that spawns its CLI and finds it missing: guard's own "not-installed". */
function missingCli(name: "github" | "aws"): ProviderDef {
  const bin = name === "github" ? "gh" : "aws";
  return {
    ...provider(name, as("unused")),
    resolve: async (_req: unknown, exec: Exec) => {
      await exec(bin, ["--version"], {});
      return { kind: "error", message: `${bin} not found` };
    },
  } as ProviderDef;
}
const notFoundExec: Exec = async () => ({ code: 127, stdout: "", stderr: "", notFound: true });

describe("runCheck", () => {
  it("match", async () => {
    const report = await runCheck("/repo", {}, deps(githubPinned, [provider("github", as("me"))]));
    expect(report).toMatchObject({
      result: "match",
      path: PATH,
      environment: null,
      providers: [{ provider: "github", status: "match", problems: [] }],
    });
    expect(checkExitCode(report)).toBe(0);
  });

  it("mismatch", async () => {
    const report = await runCheck("/repo", {}, deps(githubPinned, [provider("github", as("other"))]));
    expect(report.result).toBe("mismatch");
    expect(report.providers).toEqual([
      { provider: "github", status: "mismatch", problems: ['user: expected "me", active is "other"'], fix: "switch (or run cloudpin switch)" },
    ]);
    expect(checkExitCode(report)).toBe(1);
  });

  it("not logged in", async () => {
    const report = await runCheck(
      "/repo",
      {},
      deps(githubPinned, [provider("github", { kind: "logged-out", hint: "gh auth login" })]),
    );
    expect(report.result).toBe("mismatch");
    expect(report.providers).toEqual([
      { provider: "github", status: "not-logged-in", problems: ["not logged in"], fix: "gh auth login" },
    ]);
    expect(checkExitCode(report)).toBe(1);
  });

  it("unknown: cloudpin can't tell which account is active", async () => {
    const report = await runCheck(
      "/repo",
      {},
      deps(githubPinned, [provider("github", { kind: "error", message: "boom" })], () => "/usr/bin/gh"),
    );
    expect(report.result).toBe("error");
    expect(report.providers).toEqual([
      { provider: "github", status: "unknown", problems: ["boom"], fix: "gh auth status" },
    ]);
    expect(checkExitCode(report)).toBe(1);
  });

  it("unpinned: no pin file", async () => {
    const report = await runCheck("/repo", {}, deps(null, [provider("github", as("me"))]));
    expect(report).toEqual({ result: "unpinned", path: null, environment: null, providers: [] });
    expect(checkExitCode(report)).toBe(0);
  });

  it("invalid config", async () => {
    const report = await runCheck(
      "/repo",
      {},
      deps(() => {
        throw new ConfigError("bad");
      }, [provider("github", as("me"))]),
    );
    expect(report.result).toBe("error");
    expect(report.error).toContain("bad");
    expect(report.providers).toEqual([]);
    expect(checkExitCode(report)).toBe(1);
  });

  it("carries the selected environment", async () => {
    const config: FoundConfig = {
      ...githubPinned,
      environment: { name: "production", protected: true, source: 'branch "main" (CLOUDPIN_BRANCH)' },
    };
    const report = await runCheck("/repo", {}, deps(config, [provider("github", as("me"))]));
    // A match on a protected environment is guard's "confirm": still a match for check.
    expect(report).toMatchObject({
      result: "match",
      environment: { name: "production", protected: true, source: 'branch "main" (CLOUDPIN_BRANCH)' },
      providers: [{ provider: "github", status: "match" }],
    });
  });

  it("reports a pin this version has no provider for as unsupported", async () => {
    const report = await runCheck("/repo", {}, deps(bothPinned, [provider("github", as("me"))]));
    expect(report.result).toBe("error");
    expect(report.providers).toEqual([
      {
        provider: "aws",
        status: "unsupported",
        problems: ["pinned, but not supported by this version of cloudpin yet"],
      },
      { provider: "github", status: "match", problems: [] },
    ]);
  });

  it("ignores CLOUDPIN_SKIP: a check can't be skipped into a pass", async () => {
    const report = await runCheck("/repo", { CLOUDPIN_SKIP: "1" }, deps(githubPinned, [provider("github", as("other"))]));
    expect(report.result).toBe("mismatch");
  });

  describe("with only", () => {
    it("filters to the listed providers", async () => {
      const report = await runCheck("/repo", {}, deps(bothPinned, [provider("github", as("me")), loggedOutAws]), {
        only: ["github"],
      });
      expect(report.result).toBe("match");
      expect(report.providers).toEqual([{ provider: "github", status: "match", problems: [] }]);
    });

    it("normalizes names as typed in a workflow input", async () => {
      const report = await runCheck("/repo", {}, deps(bothPinned, [provider("github", as("me")), loggedOutAws]), {
        only: [" GitHub "],
      });
      expect(report.result).toBe("match");
      expect(report.providers.map((p) => p.provider)).toEqual(["github"]);
    });

    it("fails a listed provider that is not installed; without only that is not a failure", async () => {
      const d = deps(githubPinned, [provider("github", as("me"))], () => null);
      const strict = await runCheck("/repo", {}, d, { only: ["github"] });
      expect(strict.result).toBe("mismatch");
      expect(strict.providers).toEqual([
        { provider: "github", status: "not-installed", problems: ["gh is not installed here"] },
      ]);
      expect(checkExitCode(strict)).toBe(1);
      expect((await runCheck("/repo", {}, d)).result).toBe("match");
    });

    it("fails a listed provider guard finds missing (the CLI is not found when spawned)", async () => {
      const d: GuardDeps = { ...deps(githubPinned, [missingCli("github")]), exec: notFoundExec };
      const strict = await runCheck("/repo", {}, d, { only: ["github"] });
      expect(strict.providers).toEqual([
        { provider: "github", status: "not-installed", problems: ["gh is not installed here"] },
      ]);
      expect(strict.result).toBe("mismatch");
      const lax = await runCheck("/repo", {}, d);
      expect(lax.providers[0]!.status).toBe("not-installed");
      expect(lax.result).toBe("match");
    });

    it.each([
      [["nope"], /"nope"/],
      [["aws"], /aws/],
    ])("refuses %j: unknown, or not pinned here", async (only, message) => {
      const report = await runCheck("/repo", {}, deps(githubPinned, [provider("github", as("me")), loggedOutAws]), {
        only,
      });
      expect(report.result).toBe("error");
      expect(report.error).toMatch(message);
      expect(report.providers).toEqual([]);
      expect(checkExitCode(report)).toBe(1);
    });

    it("refuses a list with no name in it", async () => {
      const report = await runCheck("/repo", {}, deps(githubPinned, [provider("github", as("me"))]), { only: [" ", ""] });
      expect(report.result).toBe("error");
      expect(report.error).toMatch(/--only/);
    });

    it("is an error without a pin file", async () => {
      const report = await runCheck("/repo", {}, deps(null, [provider("github", as("me"))]), { only: ["github"] });
      expect(report.result).toBe("error");
      expect(report.error).toMatch(/\.cloudpin\.yml/);
      expect(checkExitCode(report)).toBe(1);
    });
  });
});

describe("formatCheckText", () => {
  // These are the exact lines `cloudpin check` printed before runCheck existed (src/cli.ts, 1.1.0).
  it("prints a mismatch as before", async () => {
    const report = await runCheck("/repo", {}, deps(githubPinned, [provider("github", as("other"))]));
    expect(formatCheckText(report)).toEqual([
      "cloudpin: checking /repo/.cloudpin.yml",
      "  x  github",
      '     - user: expected "me", active is "other"',
      "     fix: switch (or run cloudpin switch)",
    ]);
  });

  it("prints not installed and a match as before", async () => {
    // Only aws spawns (and finds nothing); github resolves without spawning.
    const report = await runCheck("/repo", {}, {
      ...deps(bothPinned, [provider("github", as("me")), missingCli("aws")]),
      exec: notFoundExec,
    });
    expect(report.result).toBe("match");
    expect(formatCheckText(report)).toEqual([
      "cloudpin: checking /repo/.cloudpin.yml",
      "  -  aws: aws is not installed here, nothing to check",
      "  ok github: active account matches the pin",
    ]);
  });

  it("with only, prints a missing CLI as a failure, not as nothing to check", async () => {
    const d = deps(githubPinned, [provider("github", as("me"))], () => null);
    const report = await runCheck("/repo", {}, d, { only: [" GitHub "] });
    expect(report.only).toEqual(["github"]);
    const lines = formatCheckText(report);
    expect(lines).toContain("  x  github: gh is not installed here");
    expect(lines.some((line) => line.includes("nothing to check"))).toBe(false);
  });

  it("prints the environment, can't-tell, not logged in and unsupported as before", () => {
    const report: CheckReport = {
      result: "error",
      path: PATH,
      environment: { name: "production", protected: true, source: "CLOUDPIN_ENV" },
      providers: [
        { provider: "azure", status: "unknown", problems: ["boom"], fix: "az account show" },
        { provider: "aws", status: "not-logged-in", problems: ["not logged in"], fix: "aws login" },
        { provider: "github", status: "unsupported", problems: ["pinned, but not supported by this version of cloudpin yet"] },
      ],
    };
    expect(formatCheckText(report)).toEqual([
      "cloudpin: checking /repo/.cloudpin.yml",
      "  environment: production (protected), chosen by CLOUDPIN_ENV",
      "  x  azure: could not tell which account is active, so commands will be stopped",
      "     - reason: boom",
      "     to see what is wrong: az account show",
      "  x  aws",
      "     - not logged in",
      "     fix: aws login",
      "  ? github: pinned, but not supported by this version of cloudpin yet",
    ]);
  });

  it("prints no pin file and an invalid one as before", async () => {
    expect(formatCheckText(await runCheck("/repo", {}, deps(null, [])))).toEqual([
      "cloudpin: no .cloudpin.yml found here or in any parent folder; nothing is pinned.",
    ]);
    const invalid = await runCheck(
      "/repo",
      {},
      deps(() => {
        throw new ConfigError("/repo/.cloudpin.yml: bad");
      }, []),
    );
    expect(formatCheckText(invalid)).toEqual(["cloudpin: invalid config: /repo/.cloudpin.yml: bad"]);
  });
});

describe("parseCheckArgs", () => {
  it.each([
    [[], { json: false }],
    [["--json"], { json: true }],
    // Split on commas only: runCheck trims and lowercases.
    [["--only", "azure, aws"], { json: false, only: ["azure", " aws"] }],
    [["--only=azure,aws", "--json"], { json: true, only: ["azure", "aws"] }],
    [["--json", "--only", "Azure"], { json: true, only: ["Azure"] }],
    // Repeated --only adds to the list: stricter, never laxer.
    [["--only", "azure", "--only=aws"], { json: false, only: ["azure", "aws"] }],
  ])("accepts %j", (args, expected) => {
    expect(parseCheckArgs(args)).toEqual(expected);
  });

  it.each([[["--only"]], [["--only", ""]], [["--only", " , "]], [["--only="]], [["--only", ","]], [["--only", "--json"]]])(
    "refuses %j: --only needs at least one name (an empty workflow input must not check nothing)",
    (args) => {
      const parsed = parseCheckArgs(args);
      expect(parsed).toHaveProperty("error");
      expect((parsed as { error: string }).error).toMatch(/--only/);
    },
  );

  it.each([[["--frob"]], [["aws"]], [["--json", "--frob"]]])("refuses anything else: %j", (args) => {
    const parsed = parseCheckArgs(args);
    expect(parsed).toHaveProperty("error");
    expect((parsed as { error: string }).error).toContain(args[args.length - 1]!);
  });
});
