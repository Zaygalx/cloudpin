import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { cachedExec } from "../src/cache.js";
import { cloudflare } from "../src/providers/cloudflare.js";
import { profileForFolder } from "../src/providers/wrangler-profiles.js";
import { isReadOnly } from "../src/readonly.js";
import type { Exec } from "../src/types.js";
import { tempDir } from "./tmp.js";

// Wrangler auth profiles (#103), from workers-sdk wrangler@4.151.3: packages/workers-auth/src/profiles.ts
// (resolve, getProfileForDirectoryFromBindings), core/profile-store.ts (directory-bindings.json),
// core/factory.ts (getAccountCacheFileName) and packages/wrangler/src/user/commands.ts (whoami refuses --profile).

const A = "0123456789abcdef0123456789abcdef";
const B = "fedcba9876543210fedcba9876543210";

const whoami = (accounts: { id: string; name: string }[]) =>
  JSON.stringify({ loggedIn: true, authType: "OAuth Token", email: "dev@example.com", accounts });

function fake() {
  const calls: string[][] = [];
  const exec: Exec = async (_bin, args) => {
    calls.push(args);
    return { code: 0, stdout: whoami([{ id: A, name: "Acme" }]), stderr: "" };
  };
  return { exec, calls };
}

function folder(files: Record<string, string> = {}) {
  const root = tempDir("cloudpin-wrangler-");
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(join(root, name, ".."), { recursive: true });
    writeFileSync(join(root, name), content);
  }
  return root;
}

// An empty home folder, so no test reads the real Wrangler profiles.
const noProfiles = tempDir("cloudpin-wrangler-home-");

const resolve = (args: string[], cwd: string, env: NodeJS.ProcessEnv = {}, exec: Exec = fake().exec) =>
  cloudflare.resolve({ args, env: { HOME: noProfiles, ...env }, cwd, bin: "wrangler" }, exec);

/** A home folder whose Wrangler config (~/.wrangler) holds this directory-bindings.json. */
function profileHome(bindings: Record<string, string> | string) {
  const home = tempDir("cloudpin-wrangler-home-");
  mkdirSync(join(home, ".wrangler", "profiles"), { recursive: true });
  const text = typeof bindings === "string" ? bindings : JSON.stringify(bindings);
  writeFileSync(join(home, ".wrangler", "profiles", "directory-bindings.json"), text);
  return { HOME: home };
}
// Wrangler matches the folder as its process.cwd() spells it: the real path outside Windows.
const physical = (dir: string) => (process.platform === "win32" ? dir : realpathSync(dir));
const bound = (dir: string, profile: string) => ({ [physical(dir)]: profile });
const cacheFile = (name: string, id: string) => ({
  [`node_modules/.cache/wrangler/${name}`]: JSON.stringify({ account: { id, name: "Cached" } }),
});

describe("Wrangler auth profiles: which login a command uses", () => {
  it("asks whoami in the command's folder, so it reports that folder's profile", async () => {
    const root = folder({ "app/.keep": "" });
    const env = profileHome(bound(root, "work"));
    const { exec, calls } = fake();
    expect(await resolve(["deploy"], join(root, "app"), env, exec)).toMatchObject({
      identity: { account: A },
      source: expect.stringMatching(/only account.*Wrangler profile "work", bound to /),
    });
    expect(calls).toEqual([["whoami", "--json", "--cwd", physical(join(root, "app"))]]);
  });

  it("reads the bound profile's account cache, never the default one", async () => {
    const root = folder({ ...cacheFile("wrangler-account.json", A), ...cacheFile("wrangler-account-work.json", B) });
    const env = profileHome(bound(root, "work"));
    expect(await resolve(["deploy"], root, env)).toMatchObject({ identity: { account: B }, source: expect.stringMatching(/cache.*profile "work"/) });
    // The cache follows the profile even when an API token replaces its login (factory.ts).
    expect(await resolve(["deploy"], root, { ...env, CLOUDFLARE_API_TOKEN: "t" })).toMatchObject({ identity: { account: B } });
  });

  it("takes --profile (and --profile=) over the folder's binding", async () => {
    const root = folder({ ...cacheFile("wrangler-account-work.json", A), ...cacheFile("wrangler-account-side.json", B) });
    const env = profileHome(bound(root, "work"));
    expect(await resolve(["deploy", "--profile", "side"], root, env)).toMatchObject({
      identity: { account: B },
      source: expect.stringMatching(/profile "side", from --profile/),
    });
    expect(await resolve(["--profile=side", "deploy"], root, env)).toMatchObject({ identity: { account: B } });
    const plain = folder(cacheFile("wrangler-account.json", A));
    expect(await resolve(["deploy", "--profile", "default"], plain, profileHome(bound(plain, "work")))).toMatchObject({ identity: { account: A } });
  });

  it("still lets account_id and CLOUDFLARE_ACCOUNT_ID win over any profile, and names the profile", async () => {
    const root = folder({ "wrangler.toml": `account_id = "${A}"\n`, ...cacheFile("wrangler-account-side.json", B) });
    const env = profileHome(bound(root, "work"));
    expect(await resolve(["deploy", "--profile", "side"], root, env)).toMatchObject({
      identity: { account: A },
      source: 'account_id in wrangler.toml (Wrangler profile "side", from --profile)',
    });
    expect(await resolve(["deploy"], root, env)).toMatchObject({ identity: { account: A }, source: expect.stringMatching(/profile "work"/) });
    const bare = folder();
    expect(await resolve(["deploy"], bare, { ...profileHome({}), CLOUDFLARE_ACCOUNT_ID: A })).toEqual({
      kind: "identity",
      identity: { account: A },
      source: "CLOUDFLARE_ACCOUNT_ID",
    });
  });

  it("uses the nearest bound folder above, matched only at a path boundary", async () => {
    const root = folder({ "a/b/c/.keep": "", "ab/.keep": "" });
    // <root>/a is a prefix of <root>/ab as a string, but not a folder above it.
    const env = profileHome({ ...bound(root, "outer"), ...bound(join(root, "a", "b"), "inner"), ...bound(join(root, "a"), "never") });
    expect(await resolve(["deploy"], join(root, "a", "b", "c"), env)).toMatchObject({ source: expect.stringMatching(/profile "inner"/) });
    expect(await resolve(["deploy"], join(root, "ab"), env)).toMatchObject({ source: expect.stringMatching(/profile "outer"/) });
  });

  it("matches the binding from the --config file's folder and from --cwd, as Wrangler does", async () => {
    const root = folder({ "other/w.toml": 'name = "w"\n', ...cacheFile("wrangler-account-cfg.json", B) });
    const env = profileHome(bound(join(root, "other"), "cfg"));
    expect(await resolve(["deploy", "-c", join("other", "w.toml")], root, env)).toMatchObject({ source: expect.stringMatching(/profile "cfg"/) });
    expect(await resolve(["deploy", "--cwd", "other"], root, env)).toMatchObject({ source: expect.stringMatching(/profile "cfg"/) });
  });

  it("finds the bindings in the XDG config folder when there is no ~/.wrangler", async () => {
    const root = folder(cacheFile("wrangler-account-xdg.json", B));
    const xdg = tempDir("cloudpin-wrangler-xdg-");
    mkdirSync(join(xdg, ".wrangler", "profiles"), { recursive: true });
    writeFileSync(join(xdg, ".wrangler", "profiles", "directory-bindings.json"), JSON.stringify(bound(root, "xdg")));
    expect(await resolve(["deploy"], root, { XDG_CONFIG_HOME: xdg })).toMatchObject({ identity: { account: B } });
  });
});

describe("Wrangler auth profiles: when cloudpin can't tell, it stops", () => {
  it("stops when --profile names a profile whoami can't be asked about", async () => {
    const root = folder();
    const { exec, calls } = fake();
    const res = await resolve(["deploy", "--profile", "side"], root, profileHome(bound(root, "work")), exec);
    expect(res).toMatchObject({
      kind: "error",
      message: expect.stringMatching(/can't tell which account Wrangler profile "side" uses.*wrangler auth activate side/),
    });
    expect(await resolve(["deploy", "--profile", "side"], folder(), {}, exec)).toMatchObject({ kind: "error", message: expect.stringMatching(/the default profile/) });
    expect(calls).toEqual([]);
  });

  it("asks whoami for a --profile the folder is bound to, or when env credentials replace every profile", async () => {
    const root = folder();
    const env = profileHome(bound(root, "work"));
    expect(await resolve(["deploy", "--profile", "work"], root, env)).toMatchObject({ identity: { account: A } });
    expect(await resolve(["deploy", "--profile", "side"], root, { ...env, CLOUDFLARE_API_TOKEN: "t" })).toMatchObject({ identity: { account: A } });
    expect(await resolve(["deploy", "--profile", "side"], root, { ...env, CF_API_KEY: "k", CF_EMAIL: "e" })).toMatchObject({ identity: { account: A } });
    // A key without its email is not used (credentials.ts getAuthFromEnv), so the profile's login would be.
    expect(await resolve(["deploy", "--profile", "side"], root, { ...env, CLOUDFLARE_API_KEY: "k" })).toMatchObject({ kind: "error" });
  });

  it("stops when it can't read the bindings, or the profile is invalid or given twice", async () => {
    const root = folder();
    expect(await resolve(["deploy"], root, profileHome("{ broken"))).toMatchObject({ kind: "error", message: expect.stringMatching(/directory-bindings\.json/) });
    expect(await resolve(["deploy"], root, profileHome(JSON.stringify({ [physical(root)]: 7 })))).toMatchObject({ kind: "error" });
    expect(await resolve(["deploy"], root, profileHome(bound(root, "../x")))).toMatchObject({ kind: "error" });
    const env = profileHome({});
    expect(await resolve(["deploy", "--profile", "a", "--profile", "b"], root, env)).toMatchObject({ kind: "error", message: expect.stringMatching(/more than once/) });
    expect(await resolve(["deploy", "--profile=../x"], root, env)).toMatchObject({ kind: "error" });
    expect(await resolve(["deploy", "--profile", "staging"], root, env)).toMatchObject({ kind: "error" });
    expect(await resolve(["deploy", "--profile"], root, env)).toMatchObject({ kind: "error" });
  });

  it("stops on Windows and macOS when a binding matches only with other letter case", () => {
    const dir = join(tempDir("cloudpin-wrangler-case-"), "Proj");
    const lower = { [dir.toLowerCase()]: "work" };
    expect(profileForFolder(dir, lower, "win32")).toEqual({ error: expect.stringMatching(/letter case/) });
    expect(profileForFolder(dir, lower, "darwin")).toEqual({ error: expect.stringMatching(/letter case/) });
    expect(profileForFolder(dir, lower, "linux")).toBeUndefined();
    expect(profileForFolder(dir, { [dir]: "work" }, "win32")).toEqual({ profile: "work", dir });
  });
});

describe("Wrangler auth profiles: cache and exemptions", () => {
  it("keys the identity cache on the profile: folders bound to two logins never share an answer", async () => {
    const root = folder({ "work/.keep": "", "side/.keep": "" });
    const env = profileHome({ ...bound(join(root, "work"), "work"), ...bound(join(root, "side"), "side") });
    let calls = 0;
    // Answers as Wrangler would: with the login of the folder whoami runs in.
    const real: Exec = async (_bin, args) => {
      calls++;
      const side = (args[args.indexOf("--cwd") + 1] ?? "").endsWith("side");
      return { code: 0, stdout: whoami([{ id: side ? B : A, name: "x" }]), stderr: "" };
    };
    const exec = cachedExec(real, cloudflare.cacheInputs(env), { cacheDir: join(root, "cache"), env: {} });
    expect(await resolve(["deploy"], join(root, "work"), env, exec)).toMatchObject({ identity: { account: A } });
    expect(await resolve(["deploy"], join(root, "side"), env, exec)).toMatchObject({ identity: { account: B } });
    expect(await resolve(["deploy"], join(root, "work"), env, exec)).toMatchObject({ identity: { account: A } });
    expect(calls).toBe(2);
  });

  it("asks again after `wrangler auth activate` rebinds the folder", async () => {
    const root = folder({ "app/.keep": "" });
    const env = profileHome(bound(join(root, "app"), "work"));
    let login = A;
    let calls = 0;
    const real: Exec = async () => {
      calls++;
      return { code: 0, stdout: whoami([{ id: login, name: "x" }]), stderr: "" };
    };
    const exec = cachedExec(real, cloudflare.cacheInputs(env), { cacheDir: join(root, "cache"), env: {} });
    expect(await resolve(["deploy"], join(root, "app"), env, exec)).toMatchObject({ identity: { account: A } });
    writeFileSync(join(env.HOME, ".wrangler", "profiles", "directory-bindings.json"), JSON.stringify(bound(join(root, "app"), "second")));
    login = B;
    expect(await resolve(["deploy"], join(root, "app"), env, exec)).toMatchObject({ identity: { account: B } });
    expect(calls).toBe(2);
  });

  it("watches the bindings file and every profile's credential files", () => {
    const { HOME } = profileHome({});
    const inputs = cloudflare.cacheInputs({ HOME });
    expect(inputs.files).toContain(join(HOME, ".wrangler", "profiles", "directory-bindings.json"));
    expect(inputs.dirs).toContain(join(HOME, ".wrangler", "config"));
    expect(inputs.env).toContain("WRANGLER_API_ENVIRONMENT");
  });

  it("reads --profile as a flag with a value, so exempt and read-only commands stay so", () => {
    expect(cloudflare.isExempt(["--profile", "work", "dev"])).toBe(true);
    expect(cloudflare.isExempt(["auth", "activate", "work", "."])).toBe(true);
    expect(cloudflare.isExempt(["auth", "create", "work"])).toBe(true);
    expect(cloudflare.isExempt(["auth", "deactivate"])).toBe(true);
    expect(cloudflare.isExempt(["auth", "list"])).toBe(true);
    expect(cloudflare.isExempt(["--profile", "work", "deploy"])).toBe(false);
    expect(isReadOnly("cloudflare", ["--profile", "work", "d1", "list"], {}, {})).toBe(true);
  });
});
