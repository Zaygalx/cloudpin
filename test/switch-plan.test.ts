import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { CheckEntry } from "../src/check.js";
import { providers } from "../src/providers/index.js";
import { defaultKubeconfigFile, planProvider, type PlanInput } from "../src/switch-plan.js";
import type { Exec, Resolution } from "../src/types.js";
import { tempDir } from "./tmp.js";

// Every ID, name and server below is made up.
const SUB = "00000000-0000-0000-0000-00000000aaaa";
const TENANT = "00000000-0000-0000-0000-00000000tttt";

type Reply = { code: number; stdout?: string; stderr?: string; notFound?: boolean };

/** A fake Exec answering by "bin arg arg..." prefix; anything unscripted fails the test. */
function scripted(replies: Record<string, Reply>) {
  const calls: { bin: string; args: string[]; env: NodeJS.ProcessEnv }[] = [];
  const exec: Exec = async (bin, args, env) => {
    calls.push({ bin, args, env });
    const line = [bin, ...args].join(" ");
    const key = Object.keys(replies)
      .filter((k) => line === k || line.startsWith(`${k} `))
      .sort((a, b) => b.length - a.length)[0];
    if (key === undefined) throw new Error(`unscripted command: ${line}`);
    return { stdout: "", stderr: "", ...replies[key]! };
  };
  return { exec, calls };
}

const byName = (name: string) => providers.find((p) => p.name === name)!;
const mismatch = (provider: string, problems = ["wrong account"]): CheckEntry => ({ provider, status: "mismatch", problems, fix: "hint" });
const loggedOut = (provider: string, fix = "login"): CheckEntry => ({ provider, status: "not-logged-in", problems: ["not logged in"], fix });
const unknown = (provider: string): CheckEntry => ({ provider, status: "unknown", problems: ["the CLI said something odd"], fix: "look" });
const id = (identity: Record<string, string>): Resolution => ({ kind: "identity", identity, source: "t" });

function input(name: string, pin: Record<string, string>, entry: CheckEntry, rest: Partial<PlanInput> = {}): PlanInput {
  return {
    provider: byName(name),
    pin,
    entry,
    env: {},
    cwd: "/repo",
    exec: scripted({}).exec,
    envFile: false,
    ...rest,
  };
}

describe("planProvider: shared cases", () => {
  it("shows a provider on its pin as ok, and a missing CLI as not-installed, without running anything", async () => {
    const { exec, calls } = scripted({});
    const ok = await planProvider(input("azure", { subscription: SUB }, { provider: "azure", status: "match", problems: [] }, { exec }));
    expect(ok).toMatchObject({ provider: "azure", status: "ok", commands: [] });
    const missing = await planProvider(
      input("azure", { subscription: SUB }, { provider: "azure", status: "not-installed", problems: ["az is not installed here"] }, { exec }),
    );
    expect(missing).toMatchObject({ status: "not-installed", manual: ["az is not installed here"] });
    expect(calls).toEqual([]);
  });

  it("makes an unsupported provider a manual line", async () => {
    const step = await planProvider(input("azure", { subscription: SUB }, { provider: "azure", status: "unsupported", problems: ["not supported"] }));
    expect(step).toMatchObject({ status: "manual", manual: ["not supported"] });
  });
});

describe("planProvider: az", () => {
  const listed = (subs: { id: string; tenantId: string }[]): Reply => ({ code: 0, stdout: JSON.stringify(subs) });

  it("runs az account set with the pinned subscription ID when the login knows it, passing the command's env", async () => {
    const { exec, calls } = scripted({ "az account list": listed([{ id: SUB.toUpperCase(), tenantId: TENANT }]) });
    const env = { AZURE_CONFIG_DIR: "/cfg" };
    const step = await planProvider(input("azure", { subscription: SUB, tenant: TENANT }, mismatch("azure"), { exec, env }));
    expect(step).toMatchObject({ status: "run", commands: [["az", "account", "set", "--subscription", SUB]], manual: [] });
    expect(calls[0]!.args).toEqual(["account", "list", "--output", "json", "--query", "[].{id:id,tenantId:tenantId}"]);
    expect(calls[0]!.env.AZURE_CONFIG_DIR).toBe("/cfg");
  });

  it("asks for az login --tenant when the subscription is not in the local cache", async () => {
    const { exec } = scripted({ "az account list": listed([{ id: "00000000-0000-0000-0000-00000000bbbb", tenantId: TENANT }]) });
    const step = await planProvider(input("azure", { subscription: SUB, tenant: TENANT }, mismatch("azure"), { exec }));
    expect(step.status).toBe("manual");
    expect(step.manual.join(" ")).toContain(`az login --tenant ${TENANT}`);
  });

  it("asks for az login when logged out, without running az", async () => {
    const { exec, calls } = scripted({});
    const step = await planProvider(input("azure", { subscription: SUB }, loggedOut("azure", "az login"), { exec }));
    expect(step).toMatchObject({ status: "manual" });
    expect(step.manual.join(" ")).toContain("az login");
    expect(calls).toEqual([]);
  });

  it("asks for a login when az account list says so, and names the failure otherwise", async () => {
    const login = await planProvider(
      input("azure", { subscription: SUB }, mismatch("azure"), { exec: scripted({ "az account list": { code: 1, stderr: "Please run 'az login' to setup account." } }).exec }),
    );
    expect(login.manual.join(" ")).toContain("az login");
    const other = await planProvider(
      input("azure", { subscription: SUB }, mismatch("azure"), { exec: scripted({ "az account list": { code: 2, stderr: "boom" } }).exec }),
    );
    expect(other).toMatchObject({ status: "manual" });
    expect(other.manual.join(" ")).toContain("exit 2");
  });

  it("never runs a subscription value that could read as a flag", async () => {
    const { exec } = scripted({ "az account list": listed([{ id: "--help", tenantId: TENANT }]) });
    const step = await planProvider(input("azure", { subscription: "--help" }, mismatch("azure"), { exec }));
    expect(step.status).toBe("manual");
    expect(step.commands).toEqual([]);
  });

  it("makes an unknown state a manual line", async () => {
    const step = await planProvider(input("azure", { subscription: SUB }, unknown("azure")));
    expect(step.status).toBe("manual");
    expect(step.manual.join(" ")).toContain("the CLI said something odd");
  });
});

describe("planProvider: gh", () => {
  const status = (accounts: { host: string; login: string; active: boolean }[]): Reply => ({ code: 0, stdout: JSON.stringify(accounts) });

  it("runs gh auth switch with both --hostname and --user when the user is logged in on that host", async () => {
    const { exec, calls } = scripted({
      "gh auth status": status([
        { host: "github.com", login: "other-me", active: true },
        { host: "github.com", login: "Pinned-Me", active: false },
      ]),
    });
    const step = await planProvider(input("github", { user: "pinned-me" }, mismatch("github"), { exec }));
    expect(step).toMatchObject({ status: "run", commands: [["gh", "auth", "switch", "--hostname", "github.com", "--user", "Pinned-Me"]] });
    // The account list comes from --json with a jq projection, so no token field ever reaches cloudpin.
    expect(calls[0]!.args).toEqual(["auth", "status", "--hostname", "github.com", "--json", "hosts", "--jq", "[.hosts[][] | {host, login, active}]"]);
    expect(calls[0]!.args).not.toContain("--show-token");
    expect(calls[0]!.args).not.toContain("-t");
  });

  it("uses the pinned host", async () => {
    const { exec } = scripted({ "gh auth status": status([{ host: "ghe.example.com", login: "me", active: false }]) });
    const step = await planProvider(input("github", { user: "me", host: "ghe.example.com" }, mismatch("github"), { exec }));
    expect(step.commands).toEqual([["gh", "auth", "switch", "--hostname", "ghe.example.com", "--user", "me"]]);
  });

  it("asks for gh auth login when the user is not logged in on that host", async () => {
    const { exec } = scripted({ "gh auth status": status([{ host: "github.com", login: "other-me", active: true }]) });
    const step = await planProvider(input("github", { user: "pinned-me" }, mismatch("github"), { exec }));
    expect(step.status).toBe("manual");
    expect(step.manual.join(" ")).toContain("gh auth login --hostname github.com");
  });

  it.each([
    [{ GH_TOKEN: "secret-value-1" }, "github.com", "GH_TOKEN"],
    [{ GITHUB_TOKEN: "secret-value-1" }, "github.com", "GITHUB_TOKEN"],
    [{ GH_ENTERPRISE_TOKEN: "secret-value-1" }, "ghe.example.com", "GH_ENTERPRISE_TOKEN"],
    [{ GITHUB_ENTERPRISE_TOKEN: "secret-value-1" }, "ghe.example.com", "GITHUB_ENTERPRISE_TOKEN"],
  ])("with %j set, says to unset it (named, never its value) and runs nothing", async (env, host, name) => {
    const { exec, calls } = scripted({});
    const step = await planProvider(input("github", { user: "me", host }, mismatch("github"), { exec, env }));
    expect(step.status).toBe("manual");
    expect(step.manual.join(" ")).toContain(`unset ${name}`);
    expect(JSON.stringify(step)).not.toContain("secret-value-1");
    expect(calls).toEqual([]);
  });

  it("ignores an enterprise token for github.com, and a github.com token for an enterprise host", async () => {
    const { exec } = scripted({ "gh auth status": status([{ host: "github.com", login: "me", active: false }]) });
    const step = await planProvider(input("github", { user: "me" }, mismatch("github"), { exec, env: { GH_ENTERPRISE_TOKEN: "x" } }));
    expect(step.status).toBe("run");
  });

  it("names a failing gh auth status without running anything else", async () => {
    const { exec } = scripted({ "gh auth status": { code: 1, stderr: "x" } });
    const step = await planProvider(input("github", { user: "me" }, mismatch("github"), { exec }));
    expect(step.status).toBe("manual");
    expect(step.manual.join(" ")).toContain("gh auth switch --hostname github.com --user me");
  });

  it("says to set GH_HOST when gh commands here target another host", async () => {
    const { exec } = scripted({ "gh auth status": status([{ host: "ghe.example.com", login: "me", active: true }]) });
    const step = await planProvider(
      input("github", { user: "me", host: "ghe.example.com" }, mismatch("github"), { exec, resolution: id({ user: "me", host: "github.com" }) }),
    );
    expect(step.manual.join(" ")).toContain("GH_HOST=ghe.example.com");
  });

  it("asks for a login when logged out", async () => {
    const step = await planProvider(input("github", { user: "me" }, loggedOut("github", "gh auth login --hostname github.com")));
    expect(step).toMatchObject({ status: "manual" });
    expect(step.manual.join(" ")).toContain("gh auth login --hostname github.com");
  });
});

describe("planProvider: vercel", () => {
  const teams = (list: { id: string; slug: string; current?: boolean }[], next?: number): Reply => ({
    code: 0,
    stdout: JSON.stringify({ teams: list, pagination: { next: next ?? null } }),
  });
  const team = "team_pinned00000000000000";

  it("runs vercel teams switch <slug>, mapping the pinned ID to its slug across pages", async () => {
    const { exec, calls } = scripted({
      "vercel teams ls --format json --non-interactive": teams([{ id: "team_other", slug: "other", current: true }], 1700000000000),
      "vercel teams ls --format json --next 1700000000000": teams([{ id: team, slug: "pinned-team" }]),
    });
    const step = await planProvider(
      input("vercel", { team }, mismatch("vercel"), { exec, resolution: id({ team: "team_other", label: "other" }) }),
    );
    expect(step).toMatchObject({ status: "run", commands: [["vercel", "teams", "switch", "pinned-team"]], manual: [] });
    expect(calls).toHaveLength(2);
  });

  it("asks to log in as a member when the team is not in the list", async () => {
    const { exec } = scripted({ "vercel teams ls": teams([{ id: "team_other", slug: "other", current: true }]) });
    const step = await planProvider(input("vercel", { team }, mismatch("vercel"), { exec, resolution: id({ team: "team_other" }) }));
    expect(step.status).toBe("manual");
    expect(step.manual.join(" ")).toContain(`log in as a member of team ${team}`);
  });

  it("asks for vercel login when logged out, without running vercel", async () => {
    const { exec, calls } = scripted({});
    const step = await planProvider(input("vercel", { team }, loggedOut("vercel", "vercel login"), { exec }));
    expect(step.manual.join(" ")).toContain("vercel login");
    expect(calls).toEqual([]);
  });

  it("says vercel link when the linked project belongs to another team (teams switch does not change it)", async () => {
    const { exec, calls } = scripted({});
    const step = await planProvider(
      input("vercel", { team }, mismatch("vercel"), { exec, resolution: id({ team, projectTeam: "team_other" }) }),
    );
    expect(step.status).toBe("manual");
    expect(step.manual.join(" ")).toContain("vercel link");
    expect(calls).toEqual([]);
  });

  it("says to unset VERCEL_ORG_ID when it names another team, and still switches the current team", async () => {
    const { exec } = scripted({ "vercel teams ls": teams([{ id: team, slug: "pinned-team" }]) });
    const step = await planProvider(
      input("vercel", { team }, mismatch("vercel"), {
        exec,
        env: { VERCEL_ORG_ID: "team_other" },
        resolution: id({ team: "team_other", projectTeam: "team_other" }),
      }),
    );
    expect(step.status).toBe("run");
    expect(step.commands).toEqual([["vercel", "teams", "switch", "pinned-team"]]);
    expect(step.manual.join(" ")).toContain("unset VERCEL_ORG_ID");
  });
});

describe("planProvider: gcloud", () => {
  const auth = (accounts: string[]): Reply => ({ code: 0, stdout: JSON.stringify(accounts.map((account) => ({ account, status: "" }))) });

  it("sets the account and project with --quiet when the account has credentials", async () => {
    const { exec, calls } = scripted({ "gcloud auth list --format=json": auth(["Dev@Example.com", "other@example.com"]) });
    const step = await planProvider(
      input("gcloud", { account: "dev@example.com", project: "pinned-proj" }, mismatch("gcloud"), {
        exec,
        resolution: id({ account: "other@example.com", project: "other-proj" }),
      }),
    );
    expect(step).toMatchObject({
      status: "run",
      commands: [
        ["gcloud", "config", "set", "account", "Dev@Example.com", "--quiet"],
        ["gcloud", "config", "set", "project", "pinned-proj", "--quiet"],
      ],
    });
    expect(calls).toHaveLength(1);
  });

  it("adds --configuration when CLOUDSDK_ACTIVE_CONFIG_NAME selects one, and only sets what differs", async () => {
    const { exec } = scripted({});
    const step = await planProvider(
      input("gcloud", { account: "dev@example.com", project: "pinned-proj" }, mismatch("gcloud"), {
        exec,
        env: { CLOUDSDK_ACTIVE_CONFIG_NAME: "work" },
        resolution: id({ account: "dev@example.com", project: "other-proj" }),
      }),
    );
    expect(step.commands).toEqual([["gcloud", "config", "set", "project", "pinned-proj", "--quiet", "--configuration", "work"]]);
  });

  it("asks for gcloud auth login <account> when the account has no credentials", async () => {
    const { exec } = scripted({ "gcloud auth list": auth(["other@example.com"]) });
    const step = await planProvider(
      input("gcloud", { account: "dev@example.com" }, loggedOut("gcloud", "gcloud auth login"), { exec, resolution: { kind: "logged-out", hint: "gcloud auth login" } }),
    );
    expect(step.status).toBe("manual");
    expect(step.manual.join(" ")).toContain("gcloud auth login dev@example.com");
  });

  it.each(["CLOUDSDK_CORE_ACCOUNT", "CLOUDSDK_CORE_PROJECT"])("says to unset %s, which beats the configuration", async (name) => {
    const { exec } = scripted({ "gcloud auth list": auth(["dev@example.com"]) });
    const step = await planProvider(
      input("gcloud", { account: "dev@example.com", project: "pinned-proj" }, mismatch("gcloud"), {
        exec,
        env: { [name]: "x" },
        resolution: id({ account: "other@example.com", project: "other-proj" }),
      }),
    );
    expect(step.manual.join(" ")).toContain(`unset ${name}`);
    // The other field is still switched.
    expect(step.status).toBe("run");
    expect(step.commands).toHaveLength(1);
  });

  it("never passes a configuration name with odd characters", async () => {
    const step = await planProvider(
      input("gcloud", { project: "pinned-proj" }, mismatch("gcloud"), {
        env: { CLOUDSDK_ACTIVE_CONFIG_NAME: "a;b" },
        resolution: id({ account: "a@example.com", project: "other" }),
      }),
    );
    expect(step.status).toBe("manual");
    expect(step.commands).toEqual([]);
  });
});

describe("planProvider: kubectl and helm", () => {
  const SERVER = "https://pinned.example.com:6443";
  function kubeconfig(text: string): NodeJS.ProcessEnv {
    const dir = tempDir("cloudpin-switch-kube-");
    const file = join(dir, "config");
    writeFileSync(file, text);
    return { KUBECONFIG: file, HOME: dir };
  }
  const clusters = `clusters:
- name: pinned
  cluster: { server: ${SERVER}/ }
- name: other
  cluster: { server: https://other.example.com }
`;

  it("uses the context whose cluster server is the pin, naming the file it writes", async () => {
    const env = kubeconfig(`current-context: other-ctx
contexts:
- name: other-ctx
  context: { cluster: other }
- name: pinned-ctx
  context: { cluster: pinned }
${clusters}`);
    const step = await planProvider(input("kubernetes", { server: SERVER }, mismatch("kubernetes"), { env }));
    expect(step).toMatchObject({ status: "run", commands: [["kubectl", "config", "use-context", "pinned-ctx"]] });
    expect(step.notes.join(" ")).toContain(env.KUBECONFIG!);
  });

  it("prefers a context with the pinned namespace", async () => {
    const env = kubeconfig(`current-context: other-ctx
contexts:
- name: other-ctx
  context: { cluster: other }
- name: pinned-default
  context: { cluster: pinned }
- name: pinned-web
  context: { cluster: pinned, namespace: web }
${clusters}`);
    const step = await planProvider(input("kubernetes", { server: SERVER, namespace: "web" }, mismatch("kubernetes"), { env }));
    expect(step.commands).toEqual([["kubectl", "config", "use-context", "pinned-web"]]);
  });

  it("otherwise sets the namespace on the context, after switching to it, and says so", async () => {
    const env = kubeconfig(`current-context: other-ctx
contexts:
- name: other-ctx
  context: { cluster: other }
- name: pinned-ctx
  context: { cluster: pinned }
${clusters}`);
    const step = await planProvider(input("kubernetes", { server: SERVER, namespace: "web" }, mismatch("kubernetes"), { env }));
    expect(step.commands).toEqual([
      ["kubectl", "config", "use-context", "pinned-ctx"],
      ["kubectl", "config", "set-context", "--current", "--namespace=web"],
    ]);
    // The second command must not run if the first fails: it would edit the old context.
    expect(step.chained).toBe(true);
    expect(step.notes.join(" ")).toContain('"pinned-ctx"');
  });

  it("only sets the namespace when the current context already points at the server", async () => {
    const env = kubeconfig(`current-context: pinned-ctx
contexts:
- name: pinned-ctx
  context: { cluster: pinned, namespace: default }
${clusters}`);
    const step = await planProvider(input("kubernetes", { server: SERVER, namespace: "web" }, mismatch("kubernetes"), { env }));
    expect(step.commands).toEqual([["kubectl", "config", "set-context", "--current", "--namespace=web"]]);
  });

  it("offers a choice when several contexts match", async () => {
    const env = kubeconfig(`contexts:
- name: pinned-a
  context: { cluster: pinned }
- name: pinned-b
  context: { cluster: pinned }
${clusters}`);
    const step = await planProvider(input("kubernetes", { server: SERVER }, loggedOut("kubernetes"), { env }));
    expect(step.status).toBe("choose");
    expect(step.candidates).toEqual([
      { name: "pinned-a", commands: [["kubectl", "config", "use-context", "pinned-a"]] },
      { name: "pinned-b", commands: [["kubectl", "config", "use-context", "pinned-b"]] },
    ]);
  });

  it("asks to add a context when none points at the server", async () => {
    const env = kubeconfig(`contexts:
- name: other-ctx
  context: { cluster: other }
${clusters}`);
    const step = await planProvider(input("kubernetes", { server: SERVER }, mismatch("kubernetes"), { env }));
    expect(step.status).toBe("manual");
    expect(step.manual.join(" ")).toContain(`add a context for ${SERVER}`);
  });

  it("never runs a context name with characters outside the allowed set; it is quoted in a manual line", async () => {
    const env = kubeconfig(`contexts:
- name: "bad ctx;rm -rf"
  context: { cluster: pinned }
${clusters}`);
    const step = await planProvider(input("kubernetes", { server: SERVER }, mismatch("kubernetes"), { env }));
    expect(step.status).toBe("manual");
    expect(step.commands).toEqual([]);
    expect(step.manual.join(" ")).toContain('"bad ctx;rm -rf"');
  });

  it("accepts the characters kube context names use (@ : /)", async () => {
    const env = kubeconfig(`contexts:
- name: "arn:aws:eks:eu-west-1:123456789012:cluster/pinned"
  context: { cluster: pinned }
- name: other
  context: { cluster: other }
${clusters}`);
    const step = await planProvider(input("kubernetes", { server: SERVER }, mismatch("kubernetes"), { env }));
    expect(step.commands).toEqual([["kubectl", "config", "use-context", "arn:aws:eks:eu-west-1:123456789012:cluster/pinned"]]);
  });

  it("says to unset HELM_KUBECONTEXT when it points elsewhere", async () => {
    const env = kubeconfig(`current-context: other-ctx
contexts:
- name: other-ctx
  context: { cluster: other }
- name: pinned-ctx
  context: { cluster: pinned }
${clusters}`);
    const step = await planProvider(
      input("kubernetes", { server: SERVER }, mismatch("kubernetes"), { env: { ...env, HELM_KUBECONTEXT: "other-ctx" } }),
    );
    expect(step.status).toBe("run");
    expect(step.manual.join(" ")).toContain("unset HELM_KUBECONTEXT");
  });

  it("names the kubeconfig problem instead of guessing when the file is not valid YAML", async () => {
    const env = kubeconfig("contexts: [unclosed");
    const step = await planProvider(input("kubernetes", { server: SERVER }, mismatch("kubernetes"), { env }));
    expect(step.status).toBe("manual");
  });

  it("finds the file use-context writes as client-go does", () => {
    const dir = tempDir("cloudpin-kubefile-");
    const a = join(dir, "a");
    const b = join(dir, "b");
    const sep = process.platform === "win32" ? ";" : ":";
    writeFileSync(b, "");
    expect(defaultKubeconfigFile({ KUBECONFIG: a })).toBe(a);
    expect(defaultKubeconfigFile({ KUBECONFIG: `${a}${sep}${b}` })).toBe(b);
    expect(defaultKubeconfigFile({ KUBECONFIG: `${a}${sep}${join(dir, "c")}` })).toBe(join(dir, "c"));
    expect(defaultKubeconfigFile({ HOME: dir })).toBe(join(dir, ".kube", "config"));
  });
});

describe("planProvider: aws", () => {
  const ACCOUNT = "111111111111";
  function awsConfig(text: string, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
    const dir = tempDir("cloudpin-switch-aws-");
    const file = join(dir, "config");
    writeFileSync(file, text);
    return { AWS_CONFIG_FILE: file, HOME: dir, ...extra };
  }

  it("plans AWS_PROFILE for the one profile naming the account, when the shell function can apply it", async () => {
    const env = awsConfig(`[profile dev]\nsso_account_id = ${ACCOUNT}\n[profile other]\nsso_account_id = 999999999999\n`);
    const step = await planProvider(input("aws", { account: ACCOUNT }, mismatch("aws"), { env, envFile: true }));
    expect(step).toMatchObject({ status: "run", awsProfile: "dev", commands: [] });
  });

  it("without the shell function, prints the export for the user and says an agent should pass --profile", async () => {
    const env = awsConfig(`[profile dev]\nsso_account_id = ${ACCOUNT}\n`);
    const step = await planProvider(input("aws", { account: ACCOUNT }, mismatch("aws"), { env, envFile: false }));
    expect(step.status).toBe("manual");
    const text = step.manual.join(" ");
    expect(text).toContain("export AWS_PROFILE=dev");
    expect(text).toContain("$env:AWS_PROFILE = 'dev'");
    expect(text).toContain("--profile dev");
  });

  it("offers a choice between several profiles for the account", async () => {
    const env = awsConfig(`[profile a]\nsso_account_id = ${ACCOUNT}\n[profile b]\nrole_arn = arn:aws:iam::${ACCOUNT}:role/R\n`);
    const step = await planProvider(input("aws", { account: ACCOUNT }, mismatch("aws"), { env, envFile: true }));
    expect(step.status).toBe("choose");
    expect(step.candidates).toEqual([
      { name: "a", commands: [], awsProfile: "a" },
      { name: "b", commands: [], awsProfile: "b" },
    ]);
  });

  it("asks to add a profile when none names the account, saying credential_process and static keys can't be matched", async () => {
    const env = awsConfig(`[profile p]\ncredential_process = helper\n`);
    const step = await planProvider(input("aws", { account: ACCOUNT }, mismatch("aws"), { env, envFile: true }));
    expect(step.status).toBe("manual");
    const text = step.manual.join(" ");
    expect(text).toContain(`add a profile for account ${ACCOUNT}`);
    expect(text).toContain("aws configure sso");
    expect(text).toContain("credential_process");
  });

  it("says to unset the key variables when AWS_ACCESS_KEY_ID is set, naming them only", async () => {
    const env = awsConfig(`[profile dev]\nsso_account_id = ${ACCOUNT}\n`, { AWS_ACCESS_KEY_ID: "AKIAEXAMPLEVALUE0000", AWS_SECRET_ACCESS_KEY: "s3cr3t-value" });
    const step = await planProvider(input("aws", { account: ACCOUNT }, mismatch("aws"), { env, envFile: true }));
    expect(step.status).toBe("manual");
    expect(step.manual.join(" ")).toContain("unset AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_SESSION_TOKEN");
    expect(JSON.stringify(step)).not.toContain("AKIAEXAMPLEVALUE0000");
    expect(JSON.stringify(step)).not.toContain("s3cr3t-value");
  });

  it("never plans a profile name outside [A-Za-z0-9._-]; it is quoted in a manual line instead", async () => {
    const env = awsConfig(`[profile odd;name]\nsso_account_id = ${ACCOUNT}\n`);
    const step = await planProvider(input("aws", { account: ACCOUNT }, mismatch("aws"), { env, envFile: true }));
    expect(step.status).toBe("manual");
    expect(step.awsProfile).toBeUndefined();
    expect(step.manual.join(" ")).toContain('"odd;name"');
  });

  it("asks for the SSO login when the profile in use already names the account but is logged out", async () => {
    const env = awsConfig(`[profile dev]\nsso_account_id = ${ACCOUNT}\n`, { AWS_PROFILE: "dev" });
    const step = await planProvider(input("aws", { account: ACCOUNT }, loggedOut("aws", "aws sso login --profile dev"), { env, envFile: true }));
    expect(step.status).toBe("manual");
    expect(step.manual.join(" ")).toContain("aws sso login --profile dev");
  });

  it("treats [default] as the profile in use when no profile variable is set, so a logged-out default asks for the login", async () => {
    const env = awsConfig(`[default]\nsso_account_id = ${ACCOUNT}\n`);
    const step = await planProvider(input("aws", { account: ACCOUNT }, loggedOut("aws", "aws sso login"), { env, envFile: true }));
    expect(step.status).toBe("manual");
    expect(step.awsProfile).toBeUndefined();
    expect(step.manual.join(" ")).toContain("log in: aws sso login");
  });

  it("never puts another value of the config file in the plan", async () => {
    const env = awsConfig(
      `[profile dev]\naws_secret_access_key = TOPSECRETVALUE\ncredential_process = run --token TOPSECRET2\nsso_account_id = ${ACCOUNT}\n`,
    );
    for (const envFile of [true, false]) {
      const step = await planProvider(input("aws", { account: ACCOUNT }, mismatch("aws"), { env, envFile }));
      expect(JSON.stringify(step)).not.toMatch(/TOPSECRET/);
    }
  });
});

describe("planProvider: supabase and wrangler (manual only)", () => {
  it("supabase: names supabase link and what it writes, never runs it", async () => {
    const { exec, calls } = scripted({});
    const step = await planProvider(input("supabase", { project: "abcdefghijklmnopqrst" }, mismatch("supabase"), { exec }));
    expect(step.status).toBe("manual");
    const text = step.manual.join(" ");
    expect(text).toContain("supabase link --project-ref abcdefghijklmnopqrst");
    expect(text).toContain("supabase/.temp/");
    expect(text).toContain("API keys");
    expect(calls).toEqual([]);
  });

  it("supabase: says to unset SUPABASE_PROJECT_ID", async () => {
    const step = await planProvider(
      input("supabase", { project: "abcdefghijklmnopqrst" }, mismatch("supabase"), { env: { SUPABASE_PROJECT_ID: "zzzzzzzzzzzzzzzzzzzz" } }),
    );
    expect(step.manual.join(" ")).toContain("unset SUPABASE_PROJECT_ID");
  });

  it("wrangler: gives the existing switch hint", async () => {
    const step = await planProvider(input("cloudflare", { account: "0123456789abcdef0123456789abcdef" }, mismatch("cloudflare")));
    expect(step.status).toBe("manual");
    expect(step.manual.join(" ")).toContain('set account_id = "0123456789abcdef0123456789abcdef" in the Wrangler config');
  });
});
