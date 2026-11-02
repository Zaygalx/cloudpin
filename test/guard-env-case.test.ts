import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { cachedExec } from "../src/cache.js";
import type { FoundConfig } from "../src/config.js";
import { guard, type GuardDeps, type Verdict } from "../src/guard.js";
import { aws } from "../src/providers/aws.js";
import { azure } from "../src/providers/azure.js";
import { cloudflare } from "../src/providers/cloudflare.js";
import { github } from "../src/providers/github.js";
import { findInvocations } from "../src/shellwords.js";
import type { Exec, ProviderDef } from "../src/types.js";
import { envFor } from "../src/user-env.js";
import { tempDir } from "./tmp.js";

// #119, part 2: Windows variable names are case-insensitive, and so is every
// guarded CLI there (Node's process.env, Wrangler's caseInsensitiveEnv proxy,
// Go's os.Getenv, Python's upper-cased os.environ), so `cloudflare_account_id`
// is CLOUDFLARE_ACCOUNT_ID. On Linux they are different variables. guard hands
// providers a plain object, so it folds the names itself on Windows.

const A = "0123456789abcdef0123456789abcdef";
const B = "fedcba9876543210fedcba9876543210";

function folder(files: Record<string, string> = {}) {
  const root = tempDir("cloudpin-env-case-");
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(join(root, name, ".."), { recursive: true });
    writeFileSync(join(root, name), content);
  }
  return root;
}

/** A fake `wrangler whoami` whose credentials see one account. */
const whoamiSees = (id: string): Exec => async () => ({ code: 0, stdout: JSON.stringify({ loggedIn: true, accounts: [{ id }] }), stderr: "" });

function cfDeps(platform: NodeJS.Platform, exec: Exec): GuardDeps {
  const pinnedToA: FoundConfig = { path: "/repo/.cloudpin.yml", pins: { cloudflare: { account: A } } };
  return { providers: [cloudflare], exec, findConfig: () => pinnedToA, platform };
}

const shell = (env: NodeJS.ProcessEnv, cwd: string, deps: GuardDeps, bin = "wrangler", args = ["deploy"]) =>
  guard({ bin, args, env, cwd, mode: "shell" }, deps);

/** An agent's line, as the hook builds it (findInvocations, then envFor). */
async function agentLine(line: string, cwd: string, deps: GuardDeps, base: NodeJS.ProcessEnv = {}): Promise<Verdict> {
  const [inv] = findInvocations(line, deps.providers.flatMap((p) => p.bins), cwd);
  return guard({ bin: inv!.bin, args: inv!.args, env: envFor(base, inv!, { agent: true }), cwd, mode: "agent" }, deps);
}

const mismatch = (other: string) => ({ action: "block", problems: [expect.stringContaining(other)] });
const allowed = { action: "allow", reason: "match" };

describe("guard: lowercase Cloudflare variables count on Windows only (#119)", () => {
  it("reads a lowercase account variable from the shell's environment on win32", async () => {
    // whoami sees only the pinned account, so a missed variable would pass.
    const root = folder();
    expect(await shell({ cloudflare_account_id: B }, root, cfDeps("win32", whoamiSees(A)))).toMatchObject(mismatch(B));
    expect(await shell({ cf_account_id: B }, root, cfDeps("win32", whoamiSees(A)))).toMatchObject(mismatch(B));
    // Control: the right account passes, though whoami alone would block.
    expect(await shell({ Cloudflare_Account_Id: A }, root, cfDeps("win32", whoamiSees(B)))).toEqual(allowed);
  });

  it("ignores the same lowercase name on linux, where it is another variable", async () => {
    const root = folder();
    expect(await shell({ cloudflare_account_id: B }, root, cfDeps("linux", whoamiSees(A)))).toEqual(allowed);
    expect(await shell({ cloudflare_account_id: A }, root, cfDeps("linux", whoamiSees(B)))).toMatchObject(mismatch(B));
  });

  it("reads a lowercase assignment in an agent's line on win32, and not on linux", async () => {
    const root = folder();
    expect(await agentLine(`cloudflare_account_id=${B} wrangler deploy`, root, cfDeps("win32", whoamiSees(A)))).toMatchObject(mismatch(B));
    expect(await agentLine(`cloudflare_account_id=${A} wrangler deploy`, root, cfDeps("win32", whoamiSees(B)))).toEqual(allowed);
    expect(await agentLine(`cloudflare_account_id=${B} wrangler deploy`, root, cfDeps("linux", whoamiSees(A)))).toEqual(allowed);
  });

  it("blocks a lowercase account variable with an unknown value on win32 only", async () => {
    const root = folder();
    const line = "cloudflare_account_id=$(cat id) wrangler deploy";
    expect(await agentLine(line, root, cfDeps("win32", whoamiSees(A)))).toMatchObject({
      action: "block",
      uncertain: true,
      problems: [expect.stringContaining("CLOUDFLARE_ACCOUNT_ID is set by the command line")],
    });
    expect(await agentLine(line, root, cfDeps("linux", whoamiSees(A)))).toEqual(allowed);
  });

  it("follows a lowercase cloudflare_env to its config section on win32", async () => {
    const root = folder({ "wrangler.toml": `account_id = "${A}"\n[env.staging]\naccount_id = "${B}"\n` });
    expect(await shell({ cloudflare_env: "staging" }, root, cfDeps("win32", whoamiSees(A)))).toMatchObject(mismatch(B));
    expect(await shell({ cloudflare_env: "staging" }, root, cfDeps("linux", whoamiSees(A)))).toEqual(allowed);
  });

  it("can't tell when two spellings of an account variable hold different values on win32", async () => {
    // Which one a Windows program sees depends on the shell and the program,
    // so cloudpin blocks, naming the spellings but never the values.
    const root = folder();
    const v = await agentLine(`cloudflare_account_id=${B} wrangler deploy`, root, cfDeps("win32", whoamiSees(A)), { CLOUDFLARE_ACCOUNT_ID: A });
    expect(v).toMatchObject({ action: "block", uncertain: true, problems: [expect.stringMatching(/CLOUDFLARE_ACCOUNT_ID.*cloudflare_account_id/)] });
    expect(JSON.stringify(v)).not.toContain(B);
    // When one spelling's value is unknown, that is the reason given.
    expect(await agentLine("cloudflare_account_id=$(cat id) wrangler deploy", root, cfDeps("win32", whoamiSees(A)), { CLOUDFLARE_ACCOUNT_ID: A })).toMatchObject({
      action: "block",
      uncertain: true,
      problems: [expect.stringContaining("CLOUDFLARE_ACCOUNT_ID is set by the command line")],
    });
    // The same value twice is no conflict; on linux they are two variables anyway.
    expect(await agentLine(`cloudflare_account_id=${A} wrangler deploy`, root, cfDeps("win32", whoamiSees(B)), { CLOUDFLARE_ACCOUNT_ID: A })).toEqual(allowed);
    expect(await agentLine(`cloudflare_account_id=${B} wrangler deploy`, root, cfDeps("linux", whoamiSees(B)), { CLOUDFLARE_ACCOUNT_ID: A })).toEqual(allowed);
  });

  it("keeps one spelling of a variable that doesn't decide the account, as Node does when it spawns", async () => {
    const seen: NodeJS.ProcessEnv[] = [];
    const exec: Exec = async (_bin, _args, env) => {
      seen.push(env);
      return whoamiSees(A)(_bin, _args, env);
    };
    expect(await shell({ Path: "C:\\b", PATH: "C:\\a" }, folder(), cfDeps("win32", exec))).toEqual(allowed);
    expect(seen[0]).toEqual({ PATH: "C:\\a" });
  });
});

describe("guard: lowercase variables of other providers on Windows (#119)", () => {
  it("GitHub: a lowercase gh_host sends cloudpin's question to that host on win32 only", async () => {
    const hosts: string[] = [];
    const exec: Exec = async (_bin, args) => {
      hosts.push(args[args.indexOf("--hostname") + 1]!);
      return { code: 0, stdout: "octocat\n", stderr: "" };
    };
    const deps = (platform: NodeJS.Platform): GuardDeps => ({
      providers: [github],
      exec,
      findConfig: () => ({ path: "/repo/.cloudpin.yml", pins: { github: { user: "octocat" } } }),
      platform,
    });
    expect(await shell({ gh_host: "ghe.example.com" }, "/repo", deps("win32"), "gh", ["repo", "list"])).toMatchObject(mismatch("ghe.example.com"));
    expect(await shell({ gh_host: "ghe.example.com" }, "/repo", deps("linux"), "gh", ["repo", "list"])).toEqual(allowed);
    expect(hosts).toEqual(["ghe.example.com", "github.com"]);
    // An unknown value in a lowercase token variable can't be told on win32.
    expect(await agentLine("gh_token=$(cat t) gh repo list", "/repo", deps("win32"))).toMatchObject({ action: "block", uncertain: true });
    expect(await agentLine("gh_token=$(cat t) gh repo list", "/repo", deps("linux"))).toEqual(allowed);
  });

  it("AWS: a lowercase aws_profile misses the identity cache on win32, so the other account is seen", async () => {
    const run = async (platform: NodeJS.Platform) => {
      const cacheDir = tempDir("cloudpin-env-case-cache-");
      const exec: Exec = async (_bin, _args, env) => {
        const account = env.AWS_PROFILE === "other" ? "999999999999" : "111111111111";
        return { code: 0, stdout: JSON.stringify({ Account: account, Arn: `arn:aws:iam::${account}:user/me` }), stderr: "" };
      };
      const deps: GuardDeps = {
        providers: [aws],
        exec,
        findConfig: () => ({ path: "/repo/.cloudpin.yml", pins: { aws: { account: "111111111111" } } }),
        wrapExec: (p: ProviderDef, env, inner) => cachedExec(inner, p.cacheInputs(env), { cacheDir, env: {} }),
        platform,
      };
      const home = tempDir("cloudpin-env-case-home-");
      const first = await shell({ HOME: home }, "/repo", deps, "aws", ["s3", "ls"]);
      const second = await shell({ HOME: home, aws_profile: "other" }, "/repo", deps, "aws", ["s3", "ls"]);
      return [first, second];
    };
    expect(await run("win32")).toEqual([allowed, expect.objectContaining(mismatch("999999999999"))]);
    // On linux aws ignores aws_profile, so the cached identity is the right one.
    expect(await run("linux")).toEqual([allowed, allowed]);
  });

  it("Azure: the identity cache watches the folder a lowercase azure_config_dir names, on win32", async () => {
    const run = async (platform: NodeJS.Platform) => {
      const cacheDir = tempDir("cloudpin-env-case-cache-");
      const configDir = folder({ "azureProfile.json": "{}" });
      let active = "11111111-1111-1111-1111-111111111111";
      const exec: Exec = async () => ({ code: 0, stdout: JSON.stringify({ id: active, tenantId: "t" }), stderr: "" });
      const deps: GuardDeps = {
        providers: [azure],
        exec,
        findConfig: () => ({ path: "/repo/.cloudpin.yml", pins: { azure: { subscription: "11111111-1111-1111-1111-111111111111" } } }),
        wrapExec: (p: ProviderDef, env, inner) => cachedExec(inner, p.cacheInputs(env), { cacheDir, env: {} }),
        platform,
      };
      const env = { HOME: tempDir("cloudpin-env-case-home-"), azure_config_dir: configDir };
      const first = await shell(env, "/repo", deps, "az", ["vm", "list"]);
      // `az account set` in that folder rewrites azureProfile.json.
      active = "22222222-2222-2222-2222-222222222222";
      writeFileSync(join(configDir, "azureProfile.json"), '{"subscriptions": []}');
      const second = await shell(env, "/repo", deps, "az", ["vm", "list"]);
      return [first, second];
    };
    expect(await run("win32")).toEqual([allowed, expect.objectContaining(mismatch("22222222"))]);
    // On linux az ignores azure_config_dir, and the default folder didn't change.
    expect(await run("linux")).toEqual([allowed, allowed]);
  });
});
