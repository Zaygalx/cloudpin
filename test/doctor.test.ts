import { join, sep } from "node:path";
import { describe, expect, it } from "vitest";
import type { FoundConfig } from "../src/config.js";
import { doctorJson, formatDoctor, runDoctor, type Check, type DoctorDeps } from "../src/doctor.js";
import { planInstall } from "../src/install.js";
import { findOnPath } from "../src/paths.js";
import type { Exec, ProviderDef, Resolution } from "../src/types.js";

const HOME = join("/", "home", "me");
const REPO = join(HOME, "work", "app");

function provider(name: "github" | "aws", res: Resolution | "missing"): ProviderDef {
  return {
    name,
    bins: [name === "github" ? "gh" : "aws"],
    statusCommand: name === "github" ? "gh auth status" : "aws sts get-caller-identity",
    cacheInputs: () => ({ env: [], files: [], dirs: [] }),
    isExempt: () => false,
    resolve: async (_ctx, exec) => {
      if (res === "missing") {
        await exec(name === "github" ? "gh" : "aws", [], {});
        return { kind: "error", message: "not found" };
      }
      return res;
    },
    compare: (pin: Record<string, string>, id) =>
      Object.entries(pin)
        .filter(([k, v]) => id[k] !== v)
        .map(([k, v]) => `${k}: pinned "${v}", active is "${id[k]}"`),
    switchHint: (pin: Record<string, string>) => `${name} switch ${Object.values(pin).join(" ")}`,
  } as ProviderDef;
}

const ME: Resolution = { kind: "identity", identity: { user: "octo-maintainer", host: "github.com" }, source: "t" };

interface Setup {
  providers?: ProviderDef[];
  config?: FoundConfig | null | Error;
  files?: Record<string, string>;
  env?: NodeJS.ProcessEnv;
  node?: string;
  onPath?: string | null;
  pathVersion?: string;
  writable?: boolean;
  platform?: NodeJS.Platform;
  latest?: string | null;
}

function deps(s: Setup = {}): DoctorDeps {
  const providers = s.providers ?? [provider("github", ME)];
  const exec: Exec = async (bin, args) => {
    if (bin === "cloudpin" && args[0] === "--version") return { code: 0, stdout: `${s.pathVersion ?? "0.3.0"}\n`, stderr: "" };
    if (bin === "aws" && s.providers?.some((p) => p.name === "aws")) return { code: 1, stdout: "", stderr: "", notFound: true };
    return { code: 0, stdout: "", stderr: "" };
  };
  const files = s.files ?? { [join(HOME, ".bashrc")]: 'eval "$(cloudpin shell-init bash)"\n' };
  return {
    guard: {
      providers,
      exec,
      findConfig: () => {
        if (s.config instanceof Error) throw s.config;
        return s.config === undefined ? null : s.config;
      },
    },
    env: { HOME, ...s.env },
    cwd: REPO,
    platform: s.platform ?? "linux",
    version: "0.3.0",
    node: s.node ?? "22.17.0",
    self: "/usr/lib/node_modules/cloudpin/dist/cli.js",
    read: (path) => files[path] ?? null,
    writable: () => s.writable ?? true,
    onPath: () => (s.onPath === undefined ? "/usr/bin/cloudpin" : s.onPath),
    latest: async () => (s.latest === undefined ? "0.3.0" : s.latest),
  };
}

const byId = (checks: Check[], id: string) => checks.filter((c) => c.id === id);
const one = (checks: Check[], id: string) => {
  const found = byId(checks, id);
  expect(found, id).toHaveLength(1);
  return found[0]!;
};

describe("runDoctor: cloudpin itself", () => {
  it("is ok when the cloudpin on PATH is this version on a supported Node", async () => {
    const checks = await runDoctor(deps());
    expect(one(checks, "cloudpin").level).toBe("ok");
    expect(one(checks, "cloudpin").title).toContain("0.3.0");
    expect(one(checks, "node").level).toBe("ok");
    expect(one(checks, "path").level).toBe("ok");
  });

  it("fails on a Node older than package.json's engines", async () => {
    const node = one(await runDoctor(deps({ node: "20.11.0" })), "node");
    expect(node.level).toBe("fail");
    expect(node.fix).toMatch(/Node\.js 22/);
  });

  it("fails when no cloudpin is on PATH, since hooks and shell lines call it by name", async () => {
    const path = one(await runDoctor(deps({ onPath: null })), "path");
    expect(path.level).toBe("fail");
    expect(path.fix).toContain("npm install --global cloudpin");
  });

  it("warns when the cloudpin on PATH is another version", async () => {
    const path = one(await runDoctor(deps({ pathVersion: "0.2.1" })), "path");
    expect(path.level).toBe("warn");
    expect(path.title).toContain("0.2.1");
  });
});

describe("runDoctor: newer version", () => {
  it("is ok on the latest version, and warns with the install command when a newer one exists", async () => {
    expect(one(await runDoctor(deps()), "update").level).toBe("ok");
    const update = one(await runDoctor(deps({ latest: "0.4.0" })), "update");
    expect(update).toMatchObject({ level: "warn", fix: "npm install --global cloudpin" });
    expect(update.title).toContain("0.4.0");
  });

  it("notes when npm can't be reached, and asks nothing when the check is turned off", async () => {
    expect(one(await runDoctor(deps({ latest: null })), "update").level).toBe("info");
    let asked = false;
    const d = deps({ env: { CLOUDPIN_NO_UPDATE_CHECK: "1" } });
    d.latest = async () => ((asked = true), "0.4.0");
    expect(one(await runDoctor(d), "update")).toMatchObject({ level: "info", title: expect.stringMatching(/off/) });
    expect(asked).toBe(false);
  });
});

describe("runDoctor: shell wrappers", () => {
  it("names the profile that runs shell-init", async () => {
    const shell = one(await runDoctor(deps()), "shell");
    expect(shell.level).toBe("ok");
    expect(shell.title).toContain(join(HOME, ".bashrc"));
  });

  it("warns, with the line to add, when no profile runs shell-init", async () => {
    const shell = one(await runDoctor(deps({ files: {} })), "shell");
    expect(shell.level).toBe("warn");
    expect(shell.fix).toContain('eval "$(cloudpin shell-init bash)"');
  });

  it("looks in the Windows PowerShell profiles, including a OneDrive Documents folder", async () => {
    const profile = join("C:/Users/me/OneDrive", "Documents", "WindowsPowerShell", "Microsoft.PowerShell_profile.ps1");
    const shell = one(
      await runDoctor(
        deps({
          platform: "win32",
          env: { USERPROFILE: "C:/Users/me", HOME: undefined, OneDrive: "C:/Users/me/OneDrive" },
          files: { [profile]: "cloudpin shell-init pwsh | Out-String | Invoke-Expression\n" },
        }),
      ),
      "shell",
    );
    expect(shell.level).toBe("ok");
    expect(shell.title).toContain("OneDrive");
  });

  it("asks PowerShell for $PROFILE, which finds a Documents folder redirected elsewhere", async () => {
    const redirected = join("D:/Docs", "WindowsPowerShell", "Microsoft.PowerShell_profile.ps1");
    const d = deps({
      platform: "win32",
      env: { USERPROFILE: "C:/Users/me", HOME: undefined },
      files: { [redirected]: "cloudpin shell-init pwsh | Out-String | Invoke-Expression\n" },
    });
    const calls: string[][] = [];
    const base = d.guard.exec;
    d.guard.exec = async (bin, args, env) => {
      if (bin === "powershell") {
        calls.push(args);
        return { code: 0, stdout: `${join("D:/Docs", "WindowsPowerShell", "profile.ps1")}\r\n${redirected}\r\n`, stderr: "" };
      }
      if (bin === "pwsh") return { code: 1, stdout: "", stderr: "", notFound: true };
      return base(bin, args, env);
    };
    const shell = one(await runDoctor(d), "shell");
    expect(shell.level).toBe("ok");
    expect(shell.title).toContain(redirected);
    expect(calls[0]).toEqual(expect.arrayContaining(["-NoProfile"]));
  });
});

describe("runDoctor: agent hooks", () => {
  it("lists each installed hook as ok", async () => {
    const files = { [join(REPO, ".claude", "settings.json")]: planInstall("claude", null).content };
    const hooks = byId(await runDoctor(deps({ files })), "hook");
    expect(hooks).toHaveLength(1);
    expect(hooks[0]!.level).toBe("ok");
    expect(hooks[0]!.title).toMatch(/claude.*project/i);
  });

  it("warns about an out-of-date hook and gives the command that updates it", async () => {
    const old = JSON.stringify({
      version: 1,
      hooks: { beforeShellExecution: [{ command: "cloudpin hook cursor", matcher: "\\b(gh)\\b", timeout: 60 }] },
    });
    const hook = one(await runDoctor(deps({ files: { [join(HOME, ".cursor", "hooks.json")]: old } })), "hook");
    expect(hook.level).toBe("warn");
    expect(hook.fix).toBe("cloudpin install-hook cursor --user");
  });

  it("fails on a hook file that is not valid JSON, since the agent can't read it either", async () => {
    const files = { [join(REPO, ".codex", "hooks.json")]: '{ "hooks": { cloudpin hook codex' };
    const hook = one(await runDoctor(deps({ files })), "hook");
    expect(hook.level).toBe("fail");
  });

  it("says so when no agent hook is installed", async () => {
    const hook = one(await runDoctor(deps()), "hooks");
    expect(hook.level).toBe("info");
    expect(hook.fix).toContain("cloudpin install-hook");
  });
});

describe("runDoctor: CLIs and pins", () => {
  const config = (pins: FoundConfig["pins"]): FoundConfig => ({ path: join(REPO, ".cloudpin.yml"), pins });

  it("passes a pinned CLI whose account matches", async () => {
    const cli = one(await runDoctor(deps({ config: config({ github: { user: "octo-maintainer" } }) })), "cli:github");
    expect(cli.level).toBe("ok");
  });

  it("fails a pinned CLI on another account, with the switch command", async () => {
    const cli = one(await runDoctor(deps({ config: config({ github: { user: "acme-bot" } }) })), "cli:github");
    expect(cli.level).toBe("fail");
    expect(cli.detail?.join("\n")).toContain("acme-bot");
    expect(cli.fix).toBe("github switch acme-bot");
  });

  it("fails a pinned CLI whose account can't be told, since its commands will be stopped", async () => {
    const providers = [provider("github", { kind: "error", message: "Bad credentials (HTTP 401)" })];
    const cli = one(await runDoctor(deps({ providers, config: config({ github: { user: "x" } }) })), "cli:github");
    expect(cli.level).toBe("fail");
    expect(cli.fix).toBe("gh auth status");
  });

  it("only notes a CLI that is not installed or not pinned", async () => {
    const providers = [provider("github", ME), provider("aws", "missing")];
    const checks = await runDoctor(deps({ providers }));
    expect(one(checks, "cli:github").level).toBe("info");
    expect(one(checks, "cli:aws").level).toBe("info");
    expect(one(checks, "cli:aws").title).toContain("not installed");
  });

  it("names the pin file and the environment that applies", async () => {
    const found: FoundConfig = {
      ...config({ github: { user: "octo-maintainer" } }),
      environment: { name: "production", protected: true, source: 'branch "main"' },
    };
    const pins = one(await runDoctor(deps({ config: found })), "pins");
    expect(pins.level).toBe("ok");
    expect(pins.detail?.join("\n")).toMatch(/production.*protected.*branch "main"/);
  });

  it("fails on an invalid pin file", async () => {
    const pins = one(await runDoctor(deps({ config: new Error("line 2: unknown provider \"azur\"") })), "pins");
    expect(pins.level).toBe("fail");
    expect(pins.title).toContain("azur");
  });

  it("notes when there is no pin file", async () => {
    const pins = one(await runDoctor(deps()), "pins");
    expect(pins.level).toBe("info");
    expect(pins.fix).toBe("cloudpin init");
  });
});

describe("runDoctor: a CLI with nothing to target in this folder", () => {
  const noProject = provider("github", { kind: "error", message: "no project for this command", noTarget: true });

  it("is a plain note when the CLI is not pinned here", async () => {
    const cli = one(await runDoctor(deps({ providers: [noProject] })), "cli:github");
    expect(cli.level).toBe("info");
    expect(cli.title).toMatch(/nothing in this folder/);
  });

  it("still fails when the CLI is pinned, since its commands are stopped", async () => {
    const config: FoundConfig = { path: join(REPO, ".cloudpin.yml"), pins: { github: { user: "x" } } };
    expect(one(await runDoctor(deps({ providers: [noProject], config })), "cli:github").level).toBe("fail");
  });
});

describe("runDoctor: identity cache", () => {
  it("warns when the cache folder can't be written (checks still run, only slower)", async () => {
    const cache = one(await runDoctor(deps({ writable: false })), "cache");
    expect(cache.level).toBe("warn");
    expect(cache.fix).toMatch(/CLOUDPIN_CACHE_DIR|CLOUDPIN_NO_CACHE/);
  });

  it("notes a cache turned off with CLOUDPIN_NO_CACHE", async () => {
    expect(one(await runDoctor(deps({ env: { CLOUDPIN_NO_CACHE: "1" } })), "cache").level).toBe("info");
  });
});

describe("formatDoctor and doctorJson", () => {
  const setup = (): DoctorDeps =>
    deps({
      config: { path: join(REPO, ".cloudpin.yml"), pins: { github: { user: "acme-bot" } } },
      env: { GH_TOKEN: "ghp_doNotPrintThisTokenValue123" },
    });

  it("prints one line per check with its level, then the fix", async () => {
    const lines = formatDoctor(await runDoctor(setup()), { HOME });
    const text = lines.join("\n");
    expect(text).toMatch(/^ {2}fail {2}github/m);
    expect(text).toMatch(/^ {8}fix: github switch acme-bot$/m);
    expect(text).toContain(join("~", "work", "app", ".cloudpin.yml"));
    expect(text).not.toContain(HOME + sep);
    expect(lines.at(-1)).toMatch(/1 problem/);
  });

  it("makes --json safe to paste in a public issue: short IDs, ~ for home, no token", async () => {
    const d = setup();
    const json = doctorJson(await runDoctor(d), d);
    const text = JSON.stringify(json);
    expect(text).not.toContain("ghp_doNotPrintThisTokenValue123");
    expect(text).not.toContain("octo-maintainer");
    expect(text).not.toContain("acme-bot");
    expect(text).toContain("…-bot");
    expect(text).not.toContain(JSON.stringify(HOME + sep).slice(1, -1));
    expect(json).toMatchObject({ cloudpin: "0.3.0", node: "22.17.0", platform: "linux" });
  });
});

describe("findOnPath", () => {
  it("finds a command in PATH order, with PATHEXT on Windows", () => {
    const a = join("/", "a");
    const b = join("/", "b");
    const files = new Set([join(b, "cloudpin.CMD"), join(b, "cloudpin"), join(a, "other")]);
    const exists = (p: string) => files.has(p);
    expect(findOnPath("cloudpin", { PATH: [a, b].join(";"), PATHEXT: ".EXE;.CMD" }, "win32", exists)).toBe(join(b, "cloudpin.CMD"));
    expect(findOnPath("cloudpin", { PATH: [a, b].join(":") }, "linux", exists)).toBe(join(b, "cloudpin"));
    expect(findOnPath("missing", { PATH: [a, b].join(":") }, "linux", exists)).toBeNull();
    expect(findOnPath("cloudpin", {}, "linux", exists)).toBeNull();
  });
});

describe("runDoctor: the Claude Code plugin", () => {
  const enabled = JSON.stringify({ enabledPlugins: { "cloudpin@cloudpin": true } });
  const userSettings = join(HOME, ".claude", "settings.json");

  it("is ok on its own", async () => {
    const hooks = byId(await runDoctor(deps({ files: { [userSettings]: enabled } })), "hook");
    expect(hooks).toEqual([expect.objectContaining({ level: "ok", title: expect.stringMatching(/claude plugin/) })]);
  });

  it("warns when a settings hook also guards Claude Code, since both would run", async () => {
    const settings = JSON.parse(planInstall("claude", null).content);
    const files = { [userSettings]: JSON.stringify({ ...settings, enabledPlugins: { "cloudpin@cloudpin": true } }) };
    const twice = one(await runDoctor(deps({ files })), "hook-twice");
    expect(twice.level).toBe("warn");
    expect(twice.fix).toBe("cloudpin uninstall-hook claude --user");
  });
});
