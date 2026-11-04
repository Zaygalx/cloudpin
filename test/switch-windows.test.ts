import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { type FoundConfig, findConfig, type Pins } from "../src/config.js";
import type { GuardDeps } from "../src/guard.js";
import { providers } from "../src/providers/index.js";
import { findInvocations } from "../src/shellwords.js";
import { planSwitch, runSwitch, type SwitchIO } from "../src/switch.js";
import type { Exec } from "../src/types.js";
import { envFor } from "../src/user-env.js";
import { tempDir } from "./tmp.js";

// #14 on Windows, where a variable's name has no case (#119, #136): an override spelled in lowercase is still the
// override, and the same line on another platform is another variable. Every ID and name here is made up.

const ACCOUNT = "111111111111";
const SERVER = "https://kube.example.test";

const exec: Exec = async (bin, args, env) => {
  const line = [bin, ...args].join(" ");
  const ok = (stdout: string) => ({ code: 0, stdout, stderr: "" });
  if (line.startsWith("gh api user")) return ok("someone\n");
  if (line.startsWith("gh auth status")) return ok(JSON.stringify([{ host: "github.com", login: "me", active: false }]));
  if (line.startsWith("gcloud config list")) return ok(JSON.stringify({ core: { account: "other@example.test", project: "other" } }));
  if (line.startsWith("gcloud auth list")) return ok(JSON.stringify([{ account: "me@example.test" }]));
  if (line.startsWith("aws sts")) {
    const account = env.AWS_PROFILE === "dev" ? ACCOUNT : "999999999999";
    return ok(JSON.stringify({ Account: account, Arn: `arn:aws:iam::${account}:user/x` }));
  }
  if (line.startsWith("vercel teams ls")) return ok(JSON.stringify({ teams: [{ id: "team_a", slug: "acme", current: false }, { id: "team_b", slug: "side", current: true }], pagination: {} }));
  throw new Error(`unscripted: ${line}`);
};

const deps = (pins: Pins, platform: NodeJS.Platform, config: Partial<FoundConfig> = {}): GuardDeps => ({
  providers,
  exec,
  platform,
  findConfig: () => ({ path: "/repo/.cloudpin.yml", pins, ...config }),
});

const stepOf = async (name: string, pins: Pins, env: NodeJS.ProcessEnv, platform: NodeJS.Platform, cwd = "/repo") => {
  const { steps } = await planSwitch(cwd, env, deps(pins, platform), {});
  return steps.find((s) => s.provider === name)!;
};

describe("planSwitch: overrides in any spelling on Windows, none of it on another platform", () => {
  const GH: Pins = { github: { user: "me" } };

  it("gh_token: gh uses it instead of the logins, so the line says to unset it; control: a run line elsewhere", async () => {
    const win = await stepOf("github", GH, { gh_token: "x" }, "win32");
    expect(win.status).toBe("manual");
    expect(win.manual.join()).toContain("unset GH_TOKEN");
    const linux = await stepOf("github", GH, { gh_token: "x" }, "linux");
    expect(linux.status).toBe("run");
    expect(linux.commands).toEqual([["gh", "auth", "switch", "--hostname", "github.com", "--user", "me"]]);
  });

  it("Github_Token and gh_enterprise_token are read the same way", async () => {
    expect((await stepOf("github", GH, { Github_Token: "x" }, "win32")).manual.join()).toContain("unset GITHUB_TOKEN");
    const host: Pins = { github: { user: "me", host: "ghe.example.test" } };
    expect((await stepOf("github", host, { gh_enterprise_token: "x" }, "win32")).manual.join()).toContain("unset GH_ENTERPRISE_TOKEN");
  });

  it("the token's value is never in the plan", async () => {
    const win = await stepOf("github", GH, { gh_token: "s3cret-value" }, "win32");
    expect(JSON.stringify(win)).not.toContain("s3cret-value");
  });

  it("cloudsdk_core_project and cloudsdk_core_account", async () => {
    const pins: Pins = { gcloud: { account: "me@example.test", project: "mine" } };
    const win = await stepOf("gcloud", pins, { cloudsdk_core_project: "p", cloudsdk_core_account: "a" }, "win32");
    expect(win.manual.join()).toContain("unset CLOUDSDK_CORE_PROJECT");
    expect(win.manual.join()).toContain("unset CLOUDSDK_CORE_ACCOUNT");
    const linux = await stepOf("gcloud", pins, { cloudsdk_core_project: "p", cloudsdk_core_account: "a" }, "linux");
    expect(linux.manual).toEqual([]);
    expect(linux.commands).toHaveLength(2);
  });

  it("cloudsdk_active_config_name makes gcloud write that configuration", async () => {
    const step = await stepOf("gcloud", { gcloud: { project: "mine" } }, { cloudsdk_active_config_name: "work" }, "win32");
    expect(step.commands).toEqual([["gcloud", "config", "set", "project", "mine", "--quiet", "--configuration", "work"]]);
  });

  it("helm_kubecontext", async () => {
    const dir = tempDir("cloudpin-switch-win-");
    const kubeconfig = join(dir, "config");
    writeFileSync(
      kubeconfig,
      `current-context: other\ncontexts:\n- name: other\n  context: { cluster: c2 }\n- name: right\n  context: { cluster: c1 }\nclusters:\n- name: c1\n  cluster: { server: ${SERVER} }\n- name: c2\n  cluster: { server: https://other.example.test }\n`,
    );
    const pins: Pins = { kubernetes: { server: SERVER } };
    const win = await stepOf("kubernetes", pins, { kubeconfig, helm_kubecontext: "other" }, "win32");
    expect(win.commands).toEqual([["kubectl", "config", "use-context", "right"]]);
    expect(win.manual.join()).toContain("unset HELM_KUBECONTEXT");
    const linux = await stepOf("kubernetes", pins, { KUBECONFIG: kubeconfig, helm_kubecontext: "other" }, "linux");
    expect(linux.manual).toEqual([]);
  });

  it("vercel_org_id: project commands use it, in any spelling", async () => {
    const step = await stepOf("vercel", { vercel: { team: "team_a" } }, { HOME: fakeVercelHome(), vercel_org_id: "team_other" }, "win32");
    expect(step.manual.join()).toContain("unset VERCEL_ORG_ID");
  });

  it("supabase_project_id", async () => {
    const pins: Pins = { supabase: { project: "abcdefghijklmnopqrst" } };
    const { steps } = await planSwitch("/repo", { supabase_project_id: "zzzzzzzzzzzzzzzzzzzz", supabase_access_token: "x" }, { ...deps(pins, "win32"), exec: async () => ({ code: 0, stdout: "[]", stderr: "" }) }, {});
    expect(steps[0]!.manual.join()).toContain("unset SUPABASE_PROJECT_ID");
  });

  it("names that differ only by case and value on the same machine: the plan never runs on a guess", async () => {
    const win = await stepOf("github", GH, { GH_TOKEN: "x", gh_token: "y" }, "win32");
    expect(win.status).toBe("manual");
    expect(win.commands).toEqual([]);
  });
});

describe("planSwitch: the AWS code reads its variables in any spelling on Windows", () => {
  const PROFILES = `[profile dev]\nsso_account_id = ${ACCOUNT}\n[profile other]\nsso_account_id = 999999999999\n`;
  const PINS: Pins = { aws: { account: ACCOUNT } };

  it("aws_config_file names the file to read; control: on another platform it is another variable", async () => {
    const dir = tempDir("cloudpin-switch-win-");
    const file = join(dir, "custom-config");
    writeFileSync(file, PROFILES);
    const env = { aws_config_file: file, HOME: dir, CLOUDPIN_ENV_FILE: join(dir, "out") };
    const win = await stepOf("aws", PINS, env, "win32");
    expect(win.status).toBe("run");
    expect(win.awsProfile).toBe("dev");
    const linux = await stepOf("aws", PINS, env, "linux");
    expect(linux.status).toBe("manual");
    expect(linux.manual.join()).toContain("add a profile");
  });

  it("aws_access_key_id beats any profile, so the line says to unset the keys, naming no value", async () => {
    const win = await stepOf("aws", PINS, { aws_access_key_id: "AKIAFAKEKEYVALUE" }, "win32");
    expect(win.status).toBe("manual");
    expect(win.manual.join()).toContain("unset AWS_ACCESS_KEY_ID");
    expect(JSON.stringify(win)).not.toContain("AKIAFAKEKEYVALUE");
  });

  it("aws_profile already on that profile isn't planned again", async () => {
    const dir = tempDir("cloudpin-switch-win-");
    const file = join(dir, "config");
    writeFileSync(file, PROFILES);
    const step = await stepOf("aws", PINS, { AWS_CONFIG_FILE: file, HOME: dir, aws_profile: "other", aws_default_profile: "other" }, "win32");
    expect(step.status).toBe("manual");
    expect(step.manual.join()).toContain("export AWS_PROFILE=dev");
  });

  it("runSwitch reads cloudpin_env_file, writes the side file, and re-checks without aws_default_profile", async () => {
    const dir = tempDir("cloudpin-switch-win-");
    const file = join(dir, "config");
    const side = join(dir, "side");
    writeFileSync(file, PROFILES);
    const seen: NodeJS.ProcessEnv[] = [];
    const recording: Exec = async (bin, args, env) => {
      seen.push(env);
      return exec(bin, args, env);
    };
    const lines: string[] = [];
    const io: SwitchIO = { isTTY: false, ask: async () => "", out: (l) => lines.push(l), err: (l) => lines.push(l) };
    const code = await runSwitch(
      "/repo",
      { aws_config_file: file, HOME: dir, cloudpin_env_file: side, aws_default_profile: "other" },
      { ...deps(PINS, "win32"), exec: recording },
      { yes: true, json: false },
      io,
    );
    expect(code).toBe(0);
    expect(readFileSync(side, "utf8")).toBe("AWS_PROFILE=dev\n");
    const last = seen.at(-1)!;
    expect(last.AWS_PROFILE).toBe("dev");
    expect(Object.keys(last).map((k) => k.toUpperCase())).not.toContain("AWS_DEFAULT_PROFILE");
  });
});

describe("planSwitch: which environment on Windows", () => {
  it("a lowercase cloudpin_env picks it, as guard reads it (#136)", async () => {
    const dir = tempDir("cloudpin-switch-win-");
    writeFileSync(join(dir, ".cloudpin.yml"), "environments:\n  staging:\n    github: { user: stage-bot }\n  production:\n    github: { user: me }\n");
    const { report, steps } = await planSwitch(dir, { cloudpin_env: "production" }, { providers, exec, platform: "win32", findConfig }, {});
    expect(report.environment?.name).toBe("production");
    expect(steps.map((s) => s.commands)).toEqual([[["gh", "auth", "switch", "--hostname", "github.com", "--user", "me"]]]);
  });
});

describe("envFor: CLOUDPIN_ENV_FILE on Windows", () => {
  it("an agent's line can't set it in any spelling for guard; control: on another platform it is another variable", () => {
    const [inv] = findInvocations("cloudpin_env_file=/x gh pr list", ["gh"]);
    expect(envFor({}, inv!, { agent: true, platform: "win32" })).toEqual({});
    expect(envFor({}, inv!, { agent: true, platform: "linux" })).toEqual({ cloudpin_env_file: "/x" });
  });
});

describe("planSwitch: planning runs nothing (for a later MCP tool, #112)", () => {
  it("only read-only listings, and the guard's identity checks; no switch command, and no side file", async () => {
    const calls: string[] = [];
    const recording: Exec = async (bin, args, env) => {
      calls.push([bin, ...args].join(" "));
      return exec(bin, args, env);
    };
    const pins: Pins = { github: { user: "me" }, vercel: { team: "team_a" }, gcloud: { project: "mine" } };
    const dir = tempDir("cloudpin-switch-plan-");
    const side = join(dir, "side");
    const { steps } = await planSwitch("/repo", { HOME: fakeVercelHome(), CLOUDPIN_ENV_FILE: side }, { ...deps(pins, "linux"), exec: recording }, {});
    expect(steps.filter((s) => s.status === "run").map((s) => s.provider).sort()).toEqual(["gcloud", "github", "vercel"]);
    expect(calls.filter((c) => /auth switch|teams switch|config set|account set|use-context/.test(c))).toEqual([]);
    expect(() => readFileSync(side)).toThrow();
  });
});

/** A home folder with a Vercel login file, so the provider counts as logged in. */
function fakeVercelHome(): string {
  const dir = tempDir("cloudpin-switch-vercel-");
  const fs = join(dir, ".local", "share", "com.vercel.cli");
  mkdirSync(fs, { recursive: true });
  writeFileSync(join(fs, "auth.json"), "{}");
  return dir;
}
