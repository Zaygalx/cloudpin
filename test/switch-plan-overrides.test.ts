import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { CheckEntry } from "../src/check.js";
import { type FoundConfig, findConfig, PROVIDERS, type Pins } from "../src/config.js";
import { guard } from "../src/guard.js";
import { providers } from "../src/providers/index.js";
import { runSwitch, type SwitchIO } from "../src/switch.js";
import { planProvider, type PlanInput } from "../src/switch-plan.js";
import type { Exec, Resolution } from "../src/types.js";
import { tempDir } from "./tmp.js";

// #14 against what providers learned after the design was written: gcloud impersonation (#165), the local Vercel
// config's scope (#127), helm's own variables (#133), Wrangler's auth profiles and account variables (#103, #119).
// Every ID and name here is made up.

const byName = (name: string) => providers.find((p) => p.name === name)!;
const mismatch = (provider: string): CheckEntry => ({ provider, status: "mismatch", problems: ["wrong account"], fix: "hint" });
const id = (identity: Record<string, string>, source = "t"): Resolution => ({ kind: "identity", identity, source });
const noExec: Exec = async (bin, args) => {
  throw new Error(`unscripted: ${[bin, ...args].join(" ")}`);
};
const input = (name: string, pin: Record<string, string>, rest: Partial<PlanInput> = {}): PlanInput => ({
  provider: byName(name),
  pin,
  entry: mismatch(name),
  env: {},
  cwd: "/repo",
  exec: noExec,
  envFile: false,
  ...rest,
});

describe("planProvider: gcloud impersonation (#165)", () => {
  const impersonated = id({ account: "sa@p.iam.gserviceaccount.test", project: "mine", label: "impersonated" }, "auth/impersonate_service_account");

  it("config set account would change nothing, so it isn't planned: the line says what to clear", async () => {
    const step = await planProvider(input("gcloud", { account: "me@example.test" }, { resolution: impersonated }));
    expect(step.status).toBe("manual");
    expect(step.commands).toEqual([]);
    expect(step.manual.join()).toContain("gcloud config unset auth/impersonate_service_account");
  });

  it("names the variable when the variable is what sets it", async () => {
    const step = await planProvider(input("gcloud", { account: "me@example.test" }, { resolution: impersonated, env: { CLOUDSDK_AUTH_IMPERSONATE_SERVICE_ACCOUNT: "sa@p.iam.gserviceaccount.test" } }));
    expect(step.manual.join()).toContain("unset CLOUDSDK_AUTH_IMPERSONATE_SERVICE_ACCOUNT");
    expect(step.manual.join()).not.toContain("config unset");
  });

  it("a project pin still switches: impersonation doesn't decide the project", async () => {
    const res = id({ account: "sa@p.iam.gserviceaccount.test", project: "other", label: "impersonated" });
    const step = await planProvider(input("gcloud", { project: "mine" }, { resolution: res }));
    expect(step.commands).toEqual([["gcloud", "config", "set", "project", "mine", "--quiet"]]);
    expect(step.manual).toEqual([]);
  });

  it("control: without impersonation the account switch is planned", async () => {
    const exec: Exec = async () => ({ code: 0, stdout: JSON.stringify([{ account: "me@example.test" }]), stderr: "" });
    const step = await planProvider(input("gcloud", { account: "me@example.test" }, { resolution: id({ account: "other@example.test", project: "" }), exec }));
    expect(step.commands).toEqual([["gcloud", "config", "set", "account", "me@example.test", "--quiet"]]);
  });
});

describe("planProvider: the local Vercel config's scope (#127)", () => {
  const folder = (file: string, body: unknown) => {
    const dir = tempDir("cloudpin-switch-vercel-");
    writeFileSync(join(dir, file), JSON.stringify(body));
    return dir;
  };
  const listing = JSON.stringify({ teams: [{ id: "team_a", slug: "acme" }, { id: "team_b", slug: "side", current: true }], pagination: {} });
  const exec: Exec = async () => ({ code: 0, stdout: listing, stderr: "" });
  const onOther = id({ team: "team_b", label: "side" });

  it("a scope in vercel.json beats the active team, so a team switch wouldn't help: the line says so", async () => {
    const step = await planProvider(input("vercel", { team: "team_a" }, { resolution: onOther, cwd: folder("vercel.json", { scope: "side" }), exec }));
    expect(step.status).toBe("manual");
    expect(step.commands).toEqual([]);
    expect(step.manual.join()).toContain('"side"');
    expect(step.manual.join()).toContain("vercel.json");
  });

  it("control: a vercel.json with no scope plans the team switch", async () => {
    const step = await planProvider(input("vercel", { team: "team_a" }, { resolution: onOther, cwd: folder("vercel.json", { name: "x" }), exec }));
    expect(step.commands).toEqual([["vercel", "teams", "switch", "acme"]]);
  });
});

describe("planProvider: helm's own variables (#133)", () => {
  const SERVER = "https://kube.example.test";
  const kubeconfig = () => {
    const dir = tempDir("cloudpin-switch-kube-");
    const file = join(dir, "config");
    writeFileSync(
      file,
      `current-context: other\ncontexts:\n- name: other\n  context: { cluster: c2 }\n- name: right\n  context: { cluster: c1, namespace: web }\nclusters:\n- name: c1\n  cluster: { server: ${SERVER} }\n- name: c2\n  cluster: { server: https://other.example.test }\n`,
    );
    return file;
  };

  it("HELM_KUBEAPISERVER on another server: helm uses it, so the line says to unset it", async () => {
    const step = await planProvider(input("kubernetes", { server: SERVER }, { env: { KUBECONFIG: kubeconfig(), HELM_KUBEAPISERVER: "https://elsewhere.example.test" } }));
    expect(step.manual.join()).toContain("unset HELM_KUBEAPISERVER");
  });

  it("HELM_NAMESPACE other than the pinned namespace", async () => {
    const step = await planProvider(input("kubernetes", { server: SERVER, namespace: "web" }, { env: { KUBECONFIG: kubeconfig(), HELM_NAMESPACE: "prod" } }));
    expect(step.manual.join()).toContain("unset HELM_NAMESPACE");
  });

  it("controls: the same server, the pinned namespace, or no namespace pin say nothing", async () => {
    for (const [pin, extra] of [
      [{ server: SERVER }, { HELM_KUBEAPISERVER: `${SERVER}/` }],
      [{ server: SERVER, namespace: "web" }, { HELM_NAMESPACE: "web" }],
      [{ server: SERVER }, { HELM_NAMESPACE: "anything" }],
    ] as [Record<string, string>, NodeJS.ProcessEnv][]) {
      const step = await planProvider(input("kubernetes", pin, { env: { KUBECONFIG: kubeconfig(), ...extra } }));
      expect(step.manual, JSON.stringify(extra)).toEqual([]);
    }
  });
});

describe("planProvider: Wrangler stays a manual line, and it is still true (#103, #119)", () => {
  const ACCOUNT = "0123456789abcdef0123456789abcdef";
  const OTHER = "fedcba9876543210fedcba9876543210";

  it("the line names the config file, and runs nothing", async () => {
    const step = await planProvider(input("cloudflare", { account: ACCOUNT }));
    expect(step.status).toBe("manual");
    expect(step.commands).toEqual([]);
    expect(step.manual).toEqual([`set account_id = "${ACCOUNT}" in the Wrangler config (for the --env you use)`]);
  });

  it("following it beats CLOUDFLARE_ACCOUNT_ID and CF_ACCOUNT_ID (the config file wins), in guard itself", async () => {
    const dir = tempDir("cloudpin-switch-wrangler-");
    writeFileSync(join(dir, ".cloudpin.yml"), `cloudflare:\n  account: ${ACCOUNT}\n`);
    const deps = { providers, exec: noExec, findConfig };
    const env = { CLOUDFLARE_ACCOUNT_ID: OTHER, CF_ACCOUNT_ID: OTHER };
    expect((await guard({ bin: "wrangler", args: ["deploy"], env, cwd: dir, mode: "agent" }, deps)).action).toBe("block");
    writeFileSync(join(dir, "wrangler.toml"), `account_id = "${ACCOUNT}"\n`);
    expect(await guard({ bin: "wrangler", args: ["deploy"], env, cwd: dir, mode: "agent" }, deps)).toEqual({ action: "allow", reason: "match" });
  });

  it("logged out in an auth profile: the line gives the profile's login, as guard's fix does", async () => {
    const step = await planProvider(input("cloudflare", { account: ACCOUNT }, { entry: { provider: "cloudflare", status: "not-logged-in", problems: ["not logged in"], fix: "wrangler auth create work" } }));
    expect(step.manual[0]).toBe("log in: wrangler auth create work");
  });

  it("the block message doesn't send anyone to cloudpin switch, for Wrangler or Supabase", async () => {
    const dir = tempDir("cloudpin-switch-wrangler-");
    writeFileSync(join(dir, ".cloudpin.yml"), `cloudflare:\n  account: ${ACCOUNT}\n`);
    const v = await guard({ bin: "wrangler", args: ["deploy"], env: { CLOUDFLARE_ACCOUNT_ID: OTHER }, cwd: dir, mode: "agent" }, { providers, exec: noExec, findConfig });
    expect(v).toMatchObject({ action: "block" });
    expect(JSON.stringify(v)).not.toContain("cloudpin switch");
  });
});

describe("cloudpin switch --only and every current provider", () => {
  const PINS: Pins = {
    azure: { subscription: "00000000-0000-0000-0000-00000000aaaa" },
    aws: { account: "111111111111" },
    gcloud: { project: "mine" },
    vercel: { team: "team_a" },
    github: { user: "me" },
    kubernetes: { server: "https://kube.example.test" },
    supabase: { project: "abcdefghijklmnopqrst" },
    cloudflare: { account: "0123456789abcdef0123456789abcdef" },
  };

  it("the pins above are every provider cloudpin has, and each has a planner", () => {
    expect(Object.keys(PINS).sort()).toEqual([...PROVIDERS].sort());
    expect(providers.map((p) => p.name).sort()).toEqual([...PROVIDERS].sort());
  });

  it.each(PROVIDERS)("--only %s plans just that one, in text and JSON", async (name) => {
    const config: FoundConfig = { path: "/repo/.cloudpin.yml", pins: PINS };
    const lines: string[] = [];
    const io: SwitchIO = { isTTY: false, ask: async () => "", out: (l) => lines.push(l), err: (l) => lines.push(l) };
    // Nothing is installed: the point is that the name is accepted and nothing else is planned.
    const exec: Exec = async () => ({ code: 127, stdout: "", stderr: "", notFound: true });
    const dir = tempDir("cloudpin-switch-only-");
    mkdirSync(join(dir, "home"));
    await runSwitch(dir, { HOME: join(dir, "home") }, { providers, exec, findConfig: () => config }, { yes: false, json: true, only: [name] }, io);
    const json = JSON.parse(lines[0]!);
    expect(json.error).toBeUndefined();
    expect(json.plan.map((p: { provider: string }) => p.provider)).toEqual([name]);
    expect(json.ran).toEqual([]);
  });
});
