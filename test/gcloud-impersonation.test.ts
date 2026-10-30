import { describe, expect, it } from "vitest";
import { flagValue } from "../src/args.js";
import type { Pins } from "../src/config.js";
import { guard } from "../src/guard.js";
import { gcloud } from "../src/providers/gcloud.js";
import { DYNAMIC_WORD, type Exec, UNKNOWN_VALUE } from "../src/types.js";

// #165: gcloud runs a command as another identity than the active account when it impersonates a
// service account or uses an access token. No real CLI runs here.

type ConfigFile = Record<string, Record<string, string>>;

/**
 * A fake `gcloud config list --format=json(<section.name>,...)` that looks each property up in gcloud's
 * order (properties/parsers.py `_GetPropertyWithoutCallback`): a flag given to config list, then the
 * CLOUDSDK_<SECTION>_<NAME> variable, then the configuration file. Only the projected fields come back.
 */
function fakeGcloud(file: ConfigFile = {}) {
  const calls: { args: string[]; env: NodeJS.ProcessEnv }[] = [];
  const exec: Exec = async (_bin, args, env) => {
    calls.push({ args, env });
    const out: ConfigFile = {};
    const fields = /^--format=json\((.*)\)$/.exec(args.find((a) => a.startsWith("--format=")) ?? "")?.[1] ?? "";
    for (const field of fields.split(",")) {
      const [section, name] = field.split(".") as [string, string];
      const value =
        flagValue(args, [`--${name.replace(/_/g, "-")}`]) ??
        env[`CLOUDSDK_${section.toUpperCase()}_${name.toUpperCase()}`] ??
        file[section]?.[name];
      if (value !== undefined) (out[section] ??= {})[name] = value;
    }
    return { code: 0, stdout: JSON.stringify(out), stderr: "" };
  };
  return { exec, calls };
}

const ME = "me@example.com";
const SA = "deploy@proj-1.iam.gserviceaccount.com";
const OTHER_SA = "admin@proj-1.iam.gserviceaccount.com";
const FAKE_TOKEN = "fake-test-token-example";
const active: ConfigFile = { core: { account: ME, project: "proj-1" } };
const ctx = (args: string[], env: NodeJS.ProcessEnv = {}) => ({ args, env, cwd: "/repo" });
const run = (args: string[], env: NodeJS.ProcessEnv = {}, file: ConfigFile = active) =>
  gcloud.resolve(ctx(args, env), fakeGcloud(file).exec);
const account = async (...a: Parameters<typeof run>) => {
  const res = await run(...a);
  return res.kind === "identity" ? res.identity.account : res.kind;
};

describe("gcloud.resolve: impersonation (#165)", () => {
  it("reads --impersonate-service-account, in both forms", async () => {
    expect(await account(["run", "deploy", `--impersonate-service-account=${SA}`])).toBe(SA);
    expect(await account(["run", "deploy", "--impersonate-service-account", SA])).toBe(SA);
  });

  it("reads CLOUDSDK_AUTH_IMPERSONATE_SERVICE_ACCOUNT", async () => {
    expect(await account(["run", "deploy"], { CLOUDSDK_AUTH_IMPERSONATE_SERVICE_ACCOUNT: SA })).toBe(SA);
  });

  it("reads auth/impersonate_service_account from gcloud config list", async () => {
    const { exec, calls } = fakeGcloud({ ...active, auth: { impersonate_service_account: SA } });
    const res = await gcloud.resolve(ctx(["run", "deploy"]), exec);
    expect(res).toMatchObject({ kind: "identity", identity: { account: SA, project: "proj-1" } });
    expect(calls[0]?.args.join(" ")).toContain("auth.impersonate_service_account");
  });

  it("lets the flag beat the variable, and the variable beat the property", async () => {
    const file = { ...active, auth: { impersonate_service_account: "prop@p.iam.gserviceaccount.com" } };
    const env = { CLOUDSDK_AUTH_IMPERSONATE_SERVICE_ACCOUNT: OTHER_SA };
    expect(await account(["run", "deploy", `--impersonate-service-account=${SA}`], env, file)).toBe(SA);
    expect(await account(["run", "deploy"], env, file)).toBe(OTHER_SA);
  });

  it("an empty flag turns impersonation off, as gcloud treats an empty value as unset", async () => {
    const file = { ...active, auth: { impersonate_service_account: SA } };
    expect(await account(["run", "deploy", "--impersonate-service-account="], {}, file)).toBe(ME);
  });

  it("takes the last account of a delegation chain, trimmed (store.py ParseImpersonationAccounts)", async () => {
    expect(await account(["run", "deploy", `--impersonate-service-account=${OTHER_SA}, ${SA}`])).toBe(SA);
  });

  it("can't tell a chain that ends in a comma", async () => {
    expect((await run(["run", "deploy", `--impersonate-service-account=${SA},`])).kind).toBe("error");
  });

  it("names the source of the impersonation", async () => {
    expect(await run(["run", "deploy", `--impersonate-service-account=${SA}`])).toMatchObject({
      source: expect.stringContaining("--impersonate-service-account"),
    });
  });

  it("impersonation wins over an access token, which only supplies the source credentials (store.py Load)", async () => {
    expect(await account(["run", "deploy", "--access-token-file=t.txt", `--impersonate-service-account=${SA}`])).toBe(SA);
  });
});

describe("gcloud.resolve: access tokens (#165)", () => {
  const unknownAccount = async (args: string[], env: NodeJS.ProcessEnv = {}, file: ConfigFile = active) => {
    const res = await run(args, env, file);
    expect(res).toMatchObject({ kind: "identity", identity: { account: "", project: "proj-1" } });
    return res.kind === "identity" ? (res.unknown?.account ?? "") : "";
  };

  it("--access-token-file: the account can't be told, the project still can", async () => {
    expect(await unknownAccount(["run", "deploy", "--access-token-file", "t.txt"])).toContain("--access-token-file");
  });

  it("CLOUDSDK_AUTH_ACCESS_TOKEN_FILE and auth/access_token_file", async () => {
    expect(await unknownAccount(["run", "deploy"], { CLOUDSDK_AUTH_ACCESS_TOKEN_FILE: "t.txt" })).toContain("access_token_file");
    expect(await unknownAccount(["run", "deploy"], {}, { ...active, auth: { access_token_file: "t.txt" } })).toContain(
      "access_token_file",
    );
  });

  it("CLOUDSDK_AUTH_ACCESS_TOKEN, without ever showing its value", async () => {
    const reason = await unknownAccount(["run", "deploy"], { CLOUDSDK_AUTH_ACCESS_TOKEN: FAKE_TOKEN });
    expect(reason).toContain("CLOUDSDK_AUTH_ACCESS_TOKEN");
    expect(reason).not.toContain(FAKE_TOKEN);
  });

  it("auth/credential_file_override", async () => {
    const file = { ...active, auth: { credential_file_override: "key.json" } };
    expect(await unknownAccount(["run", "deploy"], {}, file)).toContain("credential_file_override");
  });

  it("an access token with no active account is not 'logged out'", async () => {
    const file = { core: { project: "proj-1" } };
    expect(await unknownAccount(["run", "deploy", "--access-token-file=t.txt"], {}, file)).not.toBe("");
  });

  it("an empty --access-token-file turns a token file property off", async () => {
    const file = { ...active, auth: { access_token_file: "t.txt" } };
    expect(await account(["run", "deploy", "--access-token-file="], {}, file)).toBe(ME);
  });
});

describe("gcloud.compare with another identity (#165)", () => {
  it("says impersonating, or that an access token's account can't be told", async () => {
    const impersonated = await run(["run", "deploy", `--impersonate-service-account=${SA}`]);
    const token = await run(["run", "deploy", "--access-token-file=t.txt"]);
    if (impersonated.kind !== "identity" || token.kind !== "identity") throw new Error("expected identities");
    expect(gcloud.compare({ account: ME }, impersonated.identity)).toEqual([`account: expected "${ME}", impersonating "${SA}"`]);
    expect(gcloud.compare({ account: ME }, token.identity)).toEqual([
      `account: expected "${ME}", the command uses an access token, whose account cloudpin can't tell`,
    ]);
  });
});

describe("guard with a gcloud pin (#165)", () => {
  const check = async (pin: NonNullable<Pins["gcloud"]>, args: string[], env: NodeJS.ProcessEnv = {}, file = active) => {
    const fake = fakeGcloud(file);
    const verdict = await guard(
      { bin: "gcloud", args: ["run", "deploy", ...args], env, cwd: "/repo", mode: "agent" },
      { providers: [gcloud], exec: fake.exec, findConfig: () => ({ path: "/repo/.cloudpin.yml", pins: { gcloud: pin } }) },
    );
    return { ...verdict, calls: fake.calls.length };
  };

  it("control: no impersonation is unchanged (right account allowed, wrong one blocked)", async () => {
    expect(await check({ account: ME }, [])).toMatchObject({ action: "allow", reason: "match" });
    expect(await check({ account: "other@example.com" }, [])).toMatchObject({ action: "block" });
  });

  it("blocks a pinned account impersonating another service account, saying so", async () => {
    const v = await check({ account: ME }, [`--impersonate-service-account=${SA}`]);
    expect(v).toMatchObject({ action: "block", problems: [expect.stringContaining(`impersonating "${SA}"`)] });
    expect(v).not.toHaveProperty("uncertain", true);
  });

  it("blocks impersonation set by the variable or the property", async () => {
    const env = { CLOUDSDK_AUTH_IMPERSONATE_SERVICE_ACCOUNT: SA };
    expect(await check({ account: ME }, [], env)).toMatchObject({ action: "block" });
    expect(await check({ account: ME }, [], {}, { ...active, auth: { impersonate_service_account: SA } })).toMatchObject({
      action: "block",
    });
  });

  it("allows impersonating the pinned service account, case-insensitively, also at the end of a chain", async () => {
    expect(await check({ account: SA.toUpperCase() }, [`--impersonate-service-account=${SA}`])).toMatchObject({ action: "allow" });
    expect(await check({ account: SA }, [`--impersonate-service-account=${OTHER_SA},${SA}`])).toMatchObject({ action: "allow" });
    expect(await check({ account: SA }, [`--impersonate-service-account=${SA},${OTHER_SA}`])).toMatchObject({ action: "block" });
  });

  it("a project-only pin still checks only the project while impersonating", async () => {
    expect(await check({ project: "proj-1" }, [`--impersonate-service-account=${SA}`])).toMatchObject({ action: "allow" });
    expect(await check({ project: "proj-2" }, [`--impersonate-service-account=${SA}`])).toMatchObject({ action: "block" });
  });

  it("stops an access token when the account is pinned, as 'can't tell'", async () => {
    const v = await check({ account: ME }, [], { CLOUDSDK_AUTH_ACCESS_TOKEN: FAKE_TOKEN });
    expect(v).toMatchObject({ action: "block", uncertain: true, problems: [expect.stringContaining("CLOUDSDK_AUTH_ACCESS_TOKEN")] });
    expect(JSON.stringify(v)).not.toContain(FAKE_TOKEN);
    expect(await check({ account: ME, project: "proj-1" }, ["--access-token-file=t.txt"])).toMatchObject({ uncertain: true });
  });

  it("a project-only pin keeps its project check with an access token", async () => {
    expect(await check({ project: "proj-1" }, ["--access-token-file=t.txt"])).toMatchObject({ action: "allow" });
    expect(await check({ project: "proj-2" }, ["--access-token-file=t.txt"])).toMatchObject({ action: "block" });
  });

  it("a run-time value in either flag is 'can't tell', before gcloud runs", async () => {
    for (const flag of ["--impersonate-service-account", "--access-token-file"]) {
      const v = await check({ project: "proj-1" }, [flag, DYNAMIC_WORD]);
      expect(v).toMatchObject({ action: "block", uncertain: true, problems: [expect.stringContaining(flag)], calls: 0 });
      expect(await check({ project: "proj-1" }, [`${flag}=${DYNAMIC_WORD}`])).toMatchObject({ uncertain: true, calls: 0 });
    }
  });

  it("a variable set from something unknown is 'can't tell' (#86)", async () => {
    for (const name of ["CLOUDSDK_AUTH_IMPERSONATE_SERVICE_ACCOUNT", "CLOUDSDK_AUTH_ACCESS_TOKEN_FILE", "CLOUDSDK_AUTH_ACCESS_TOKEN"]) {
      expect(await check({ project: "proj-1" }, [], { [name]: UNKNOWN_VALUE })).toMatchObject({ uncertain: true, calls: 0 });
    }
  });
});
