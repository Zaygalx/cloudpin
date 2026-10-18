import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { FoundConfig, Pins } from "../src/config.js";
import type { GuardDeps } from "../src/guard.js";
import { providers } from "../src/providers/index.js";
import { parseSwitchArgs, runSwitch, type SwitchIO } from "../src/switch.js";
import type { Exec } from "../src/types.js";
import { tempDir } from "./tmp.js";

// Every ID, name and server below is made up.
const SUB = "00000000-0000-0000-0000-00000000aaaa";
const OTHER_SUB = "00000000-0000-0000-0000-00000000bbbb";
const TENANT = "00000000-0000-0000-0000-00000000cccc";
const PATH = "/repo/.cloudpin.yml";

/** A pretend machine: az and gh answer from `state`, and their switch commands change it. */
function machine(opts: { azSetFails?: boolean; ghUser?: string; azSub?: string } = {}) {
  const state = { azSub: opts.azSub ?? OTHER_SUB, ghUser: opts.ghUser ?? "other-me" };
  const calls: string[] = [];
  const exec: Exec = async (bin, args, env) => {
    const line = [bin, ...args].join(" ");
    calls.push(line);
    const ok = (stdout: string) => ({ code: 0, stdout, stderr: "" });
    if (line === "az account show --output json") return ok(JSON.stringify({ id: state.azSub, tenantId: TENANT, name: "n" }));
    if (line.startsWith("az account list")) return ok(JSON.stringify([{ id: SUB, tenantId: TENANT }, { id: OTHER_SUB, tenantId: TENANT }]));
    if (line === `az account set --subscription ${SUB}`) {
      if (opts.azSetFails) return { code: 1, stdout: "", stderr: "ERROR: something went wrong\nmore" };
      state.azSub = SUB;
      return ok("");
    }
    if (line === "gh api user --hostname github.com --jq .login") return ok(`${state.ghUser}\n`);
    if (line.startsWith("gh auth status")) {
      return ok(JSON.stringify([
        { host: "github.com", login: state.ghUser, active: true },
        { host: "github.com", login: "me", active: state.ghUser === "me" },
      ]));
    }
    if (line === "gh auth switch --hostname github.com --user me") {
      state.ghUser = "me";
      return ok("");
    }
    if (line === "aws sts get-caller-identity --output json") {
      const account = env.AWS_PROFILE === "dev" ? "111111111111" : "999999999999";
      return ok(JSON.stringify({ Account: account, Arn: `arn:aws:iam::${account}:user/x` }));
    }
    if (line.startsWith("kubectl config use-context")) {
      if (line.endsWith("broken")) return { code: 1, stdout: "", stderr: "error: no context exists" };
      return ok("");
    }
    if (line.startsWith("kubectl config set-context")) return ok("");
    throw new Error(`unscripted: ${line}`);
  };
  return { exec, calls, state };
}

function deps(pins: Pins, exec: Exec, config: Partial<FoundConfig> = {}): GuardDeps {
  return { providers, exec, findConfig: () => ({ path: PATH, pins, ...config }) };
}

/** A terminal (or not) that answers questions in order and records everything printed. */
function io(opts: { tty: boolean; answers?: string[] }) {
  const answers = [...(opts.answers ?? [])];
  const questions: string[] = [];
  const out: string[] = [];
  const err: string[] = [];
  const value: SwitchIO = {
    isTTY: opts.tty,
    ask: async (q) => {
      questions.push(q);
      return answers.shift() ?? "";
    },
    out: (l) => out.push(l),
    err: (l) => err.push(l),
  };
  return { io: value, questions, out, err, text: () => [...out, ...err, ...questions].join("\n") };
}

const AZ_GH: Pins = { azure: { subscription: SUB }, github: { user: "me" } };

describe("runSwitch in a terminal", () => {
  it("shows the plan, asks once, runs each command, re-checks and exits 0 when everything matches", async () => {
    const m = machine();
    const t = io({ tty: true, answers: ["y"] });
    const code = await runSwitch("/repo", {}, deps(AZ_GH, m.exec), { yes: false, json: false }, t.io);
    expect(t.questions).toEqual(["Run these 2 commands? [y/N] "]);
    expect(m.calls).toContain(`az account set --subscription ${SUB}`);
    expect(m.calls).toContain("gh auth switch --hostname github.com --user me");
    const text = t.out.join("\n");
    expect(text).toContain(`run: az account set --subscription ${SUB}`);
    expect(text).toContain("run: gh auth switch --hostname github.com --user me");
    expect(text).toContain("ok azure: active account matches the pin");
    expect(text).toContain("ok github: active account matches the pin");
    expect(code).toBe(0);
  });

  it("runs nothing when the answer is not yes", async () => {
    const m = machine();
    const t = io({ tty: true, answers: ["n"] });
    const code = await runSwitch("/repo", {}, deps(AZ_GH, m.exec), { yes: false, json: false }, t.io);
    expect(m.calls.filter((c) => c.includes(" set ") || c.includes(" switch "))).toEqual([]);
    expect(t.text()).toContain("nothing run");
    expect(code).toBe(1);
  });

  it("keeps going after a failing command, prints its result, and exits 1 when the re-check still mismatches", async () => {
    const m = machine({ azSetFails: true });
    const t = io({ tty: true, answers: ["yes"] });
    const code = await runSwitch("/repo", {}, deps(AZ_GH, m.exec), { yes: false, json: false }, t.io);
    expect(m.calls).toContain("gh auth switch --hostname github.com --user me");
    const text = t.out.join("\n");
    expect(text).toContain("failed (exit 1): ERROR: something went wrong");
    expect(text).toContain("ok github: active account matches the pin");
    expect(text).toMatch(/x {2}azure/);
    expect(code).toBe(1);
  });

  it("says there is nothing to switch, without asking, when everything is on its pin", async () => {
    const m = machine({ azSub: SUB, ghUser: "me" });
    const t = io({ tty: true });
    const code = await runSwitch("/repo", {}, deps(AZ_GH, m.exec), { yes: false, json: false }, t.io);
    expect(t.questions).toEqual([]);
    expect(t.out.join("\n")).toContain("ok azure: already on the pinned account");
    expect(code).toBe(0);
  });

  it("prints the environment it switches for", async () => {
    const m = machine({ azSub: SUB, ghUser: "me" });
    const t = io({ tty: true });
    await runSwitch("/repo", {}, deps(AZ_GH, m.exec, { environment: { name: "prod", protected: true, source: "CLOUDPIN_ENV" } }), { yes: false, json: false }, t.io);
    expect(t.out.join("\n")).toContain("environment: prod (protected), chosen by CLOUDPIN_ENV");
  });
});

describe("runSwitch without a terminal", () => {
  it("prints the plan and runs nothing without --yes, exiting 1", async () => {
    const m = machine();
    const t = io({ tty: false });
    const code = await runSwitch("/repo", {}, deps(AZ_GH, m.exec), { yes: false, json: false }, t.io);
    expect(t.questions).toEqual([]);
    expect(m.calls.filter((c) => c.includes("account set") || c.includes("auth switch"))).toEqual([]);
    expect(t.text()).toContain("--yes");
    expect(code).toBe(1);
  });

  it("runs with --yes, without asking", async () => {
    const m = machine();
    const t = io({ tty: false });
    const code = await runSwitch("/repo", {}, deps(AZ_GH, m.exec), { yes: true, json: false }, t.io);
    expect(t.questions).toEqual([]);
    expect(m.state).toEqual({ azSub: SUB, ghUser: "me" });
    expect(code).toBe(0);
  });
});

describe("runSwitch --json", () => {
  it("without --yes prints the plan with ran [] and after null, runs nothing and never asks", async () => {
    const m = machine();
    const t = io({ tty: true, answers: ["y"] });
    const code = await runSwitch("/repo", {}, deps(AZ_GH, m.exec), { yes: false, json: true }, t.io);
    expect(t.questions).toEqual([]);
    expect(t.out).toHaveLength(1);
    expect(JSON.parse(t.out[0]!)).toEqual({
      result: "mismatch",
      path: PATH,
      environment: null,
      plan: [
        { provider: "azure", status: "run", commands: [["az", "account", "set", "--subscription", SUB]] },
        { provider: "github", status: "run", commands: [["gh", "auth", "switch", "--hostname", "github.com", "--user", "me"]] },
      ],
      ran: [],
      after: null,
    });
    expect(m.state).toEqual({ azSub: OTHER_SUB, ghUser: "other-me" });
    expect(code).toBe(1);
  });

  it("with --yes runs, lists each command and its exit code (no output captured), and gives the re-check", async () => {
    const m = machine({ azSetFails: true });
    const t = io({ tty: false });
    const code = await runSwitch("/repo", {}, deps(AZ_GH, m.exec), { yes: true, json: true }, t.io);
    expect(t.out).toHaveLength(1);
    const json = JSON.parse(t.out[0]!);
    expect(json.ran).toEqual([
      { provider: "azure", command: ["az", "account", "set", "--subscription", SUB], code: 1 },
      { provider: "github", command: ["gh", "auth", "switch", "--hostname", "github.com", "--user", "me"], code: 0 },
    ]);
    expect(t.out[0]).not.toContain("something went wrong");
    expect(json.after).toMatchObject({
      result: "mismatch",
      path: PATH,
      providers: [
        { provider: "azure", status: "mismatch" },
        { provider: "github", status: "match", problems: [] },
      ],
    });
    expect(json.result).toBe("mismatch");
    expect(code).toBe(1);
  });

  it("reports an invalid --only as an error with an empty plan", async () => {
    const t = io({ tty: false });
    const code = await runSwitch("/repo", {}, deps(AZ_GH, machine().exec), { yes: false, json: true, only: ["nope"] }, t.io);
    const json = JSON.parse(t.out[0]!);
    expect(json).toMatchObject({ result: "error", plan: [], ran: [], after: null });
    expect(json.error).toContain('"nope"');
    expect(code).toBe(1);
  });
});

describe("runSwitch --only", () => {
  it("plans and runs only the listed providers", async () => {
    const m = machine();
    const t = io({ tty: false });
    const code = await runSwitch("/repo", {}, deps(AZ_GH, m.exec), { yes: true, json: false, only: ["github"] }, t.io);
    expect(m.calls.some((c) => c.startsWith("az "))).toBe(false);
    expect(m.state.ghUser).toBe("me");
    expect(code).toBe(0);
  });
});

describe("runSwitch with nothing pinned", () => {
  it("says so and exits 0, as check does", async () => {
    const t = io({ tty: true });
    const code = await runSwitch("/repo", {}, { providers, exec: machine().exec, findConfig: () => null }, { yes: false, json: false }, t.io);
    expect(t.text()).toContain("nothing is pinned");
    expect(code).toBe(0);
  });
});

describe("runSwitch: choosing", () => {
  const SERVER = "https://pinned.example.com";
  function kubeEnv(names: string[]): NodeJS.ProcessEnv {
    const dir = tempDir("cloudpin-switch-choose-");
    const file = join(dir, "config");
    const contexts = names.map((n) => `- name: ${n}\n  context: { cluster: pinned }`).join("\n");
    writeFileSync(file, `current-context: elsewhere\ncontexts:\n${contexts}\n- name: elsewhere\n  context: { cluster: other }\nclusters:\n- name: pinned\n  cluster: { server: "${SERVER}" }\n- name: other\n  cluster: { server: "https://other.example.com" }\n`);
    return { KUBECONFIG: file, HOME: dir };
  }
  const KUBE: Pins = { kubernetes: { server: SERVER, namespace: "web" } };

  it("lets the user pick by number in a terminal, then asks once", async () => {
    const m = machine();
    const t = io({ tty: true, answers: ["2", "y"] });
    await runSwitch("/repo", kubeEnv(["ctx-a", "ctx-b"]), deps(KUBE, m.exec), { yes: false, json: false }, t.io);
    expect(t.questions[0]).toContain("[1-2, Enter to skip]");
    expect(t.questions[1]).toBe("Run these 2 commands? [y/N] ");
    expect(m.calls).toEqual(["kubectl config use-context ctx-b", "kubectl config set-context --current --namespace=web"]);
  });

  it("skips the line when the user picks nothing", async () => {
    const m = machine();
    const t = io({ tty: true, answers: [""] });
    const code = await runSwitch("/repo", kubeEnv(["ctx-a", "ctx-b"]), deps(KUBE, m.exec), { yes: false, json: false }, t.io);
    expect(t.questions).toHaveLength(1);
    expect(m.calls).toEqual([]);
    expect(code).toBe(1);
  });

  it("skips it and lists the candidates with --yes, without a terminal, and in JSON", async () => {
    for (const [tty, yes, json] of [[true, true, false], [false, false, false], [false, true, true]] as const) {
      const m = machine();
      const t = io({ tty, answers: ["1", "y"] });
      await runSwitch("/repo", kubeEnv(["ctx-a", "ctx-b"]), deps(KUBE, m.exec), { yes, json }, t.io);
      expect(t.questions).toEqual([]);
      expect(m.calls).toEqual([]);
      if (json) expect(JSON.parse(t.out[0]!).plan[0]).toMatchObject({ provider: "kubernetes", status: "choose", candidates: ["ctx-a", "ctx-b"] });
      else expect(t.text()).toMatch(/ctx-a[\s\S]*ctx-b/);
    }
  });

  it("does not run set-context --current after use-context failed (it would edit the old context)", async () => {
    const m = machine();
    const t = io({ tty: false });
    await runSwitch("/repo", kubeEnv(["broken"]), deps(KUBE, m.exec), { yes: true, json: false }, t.io);
    expect(m.calls).toEqual(["kubectl config use-context broken"]);
    expect(t.out.join("\n")).toContain("skipped");
  });
});

describe("runSwitch: AWS_PROFILE through CLOUDPIN_ENV_FILE", () => {
  const ACCOUNT = "111111111111";
  const SECRET = "TOPSECRET-example-value-1";
  function awsEnv(config: string): { env: NodeJS.ProcessEnv; file: string } {
    const dir = tempDir("cloudpin-switch-awsenv-");
    writeFileSync(join(dir, "config"), config);
    const file = join(dir, "envfile");
    writeFileSync(file, "");
    return { env: { AWS_CONFIG_FILE: join(dir, "config"), HOME: dir, CLOUDPIN_ENV_FILE: file }, file };
  }
  const AWS: Pins = { aws: { account: ACCOUNT } };
  const CONFIG = `[default]\naws_secret_access_key = ${SECRET}\n[profile dev]\nsso_account_id = ${ACCOUNT}\ncredential_process = helper --token ${SECRET}\n`;

  it("writes AWS_PROFILE=<name> to the env file once confirmed, and re-checks with it", async () => {
    const { env, file } = awsEnv(CONFIG);
    const t = io({ tty: true, answers: ["y"] });
    const code = await runSwitch("/repo", { ...env, AWS_DEFAULT_PROFILE: "old" }, deps(AWS, machine().exec), { yes: false, json: false }, t.io);
    expect(t.questions).toEqual(["Run this command? [y/N] "]);
    expect(readFileSync(file, "utf8")).toBe("AWS_PROFILE=dev\n");
    expect(t.out.join("\n")).toContain("ok aws: active account matches the pin");
    expect(code).toBe(0);
  });

  it("writes nothing when not confirmed", async () => {
    const { env, file } = awsEnv(CONFIG);
    await runSwitch("/repo", env, deps(AWS, machine().exec), { yes: false, json: false }, io({ tty: true, answers: ["n"] }).io);
    expect(readFileSync(file, "utf8")).toBe("");
  });

  it("without CLOUDPIN_ENV_FILE prints the export for the user, says it was not applied, and exits 1", async () => {
    const { env, file } = awsEnv(CONFIG);
    delete env.CLOUDPIN_ENV_FILE;
    const t = io({ tty: true, answers: ["y"] });
    const code = await runSwitch("/repo", env, deps(AWS, machine().exec), { yes: false, json: false }, t.io);
    expect(t.questions).toEqual([]);
    expect(t.text()).toContain("export AWS_PROFILE=dev");
    expect(readFileSync(file, "utf8")).toBe("");
    expect(code).toBe(1);
  });

  it("never writes a profile name outside [A-Za-z0-9._-] to the env file", async () => {
    const { env, file } = awsEnv(`[profile dev;touch]\nsso_account_id = ${ACCOUNT}\n`);
    const t = io({ tty: true, answers: ["y"] });
    await runSwitch("/repo", env, deps(AWS, machine().exec), { yes: true, json: false }, t.io);
    expect(readFileSync(file, "utf8")).toBe("");
    expect(existsSync(file)).toBe(true);
    expect(t.text()).toContain('"dev;touch"');
  });

  it("never lets another value of the AWS config file reach any output, text or JSON", async () => {
    for (const json of [false, true]) {
      for (const withFile of [true, false]) {
        const { env } = awsEnv(CONFIG);
        if (!withFile) delete env.CLOUDPIN_ENV_FILE;
        const t = io({ tty: !json, answers: ["y"] });
        await runSwitch("/repo", env, deps(AWS, machine().exec), { yes: json, json }, t.io);
        expect(t.text()).not.toContain("TOPSECRET");
        expect(t.text()).not.toContain("helper");
      }
    }
  });
});

describe("parseSwitchArgs", () => {
  it("reads --yes, --json and --only", () => {
    expect(parseSwitchArgs([])).toEqual({ yes: false, json: false });
    expect(parseSwitchArgs(["--yes", "--json", "--only", "azure,aws"])).toEqual({ yes: true, json: true, only: ["azure", "aws"] });
    expect(parseSwitchArgs(["--help"])).toEqual({ help: true });
    expect(parseSwitchArgs(["--bogus"])).toEqual({ error: 'unknown argument "--bogus"' });
  });
});
