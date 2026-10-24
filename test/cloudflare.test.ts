import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { accountIdsFromJsonc, accountIdsFromToml, cloudflare } from "../src/providers/cloudflare.js";
import { isReadOnly } from "../src/readonly.js";
import type { Exec } from "../src/types.js";
import { tempDir } from "./tmp.js";

const A = "0123456789abcdef0123456789abcdef";
const B = "fedcba9876543210fedcba9876543210";

// `wrangler whoami --json` (packages/wrangler/src/user/whoami.ts).
const whoami = (accounts: { id: string; name: string }[]) =>
  JSON.stringify({ loggedIn: true, authType: "OAuth Token", email: "dev@example.com", accounts });

function fake(opts: { code?: number; stdout?: string; stderr?: string } = {}) {
  const calls: string[][] = [];
  const exec: Exec = async (_bin, args) => {
    calls.push(args);
    return { code: opts.code ?? 0, stdout: opts.stdout ?? whoami([{ id: A, name: "Acme" }]), stderr: opts.stderr ?? "" };
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

const resolve = (args: string[], cwd: string, env: NodeJS.ProcessEnv = {}, exec: Exec = fake().exec) =>
  cloudflare.resolve({ args, env, cwd, bin: "wrangler" }, exec);

describe("wrangler.toml account_id", () => {
  it("reads the top-level value and each [env.NAME] value", () => {
    const toml = [
      "# comment with account_id = \"nope\"",
      'name = "worker"',
      `account_id = "${A}" # trailing comment`,
      "",
      "[env.staging]",
      'name = "worker-staging"',
      "",
      '[env."production"]',
      `account_id = '${B}'`,
      "[[env.production.kv_namespaces]]",
      'binding = "KV"',
    ].join("\n");
    expect(accountIdsFromToml(toml)).toEqual({ top: A, envs: { production: B } });
  });

  it("reads a dotted env.NAME.account_id at the top level", () => {
    expect(accountIdsFromToml(`env.prod.account_id = "${B}"`)).toEqual({ envs: { prod: B } });
  });

  it("refuses an account_id in a form it does not understand, instead of guessing", () => {
    expect(() => accountIdsFromToml(`env = { prod = { account_id = "${B}" } }`)).toThrow(/can't read/);
    expect(() => accountIdsFromToml(`[vars]\naccount_id = "${B}"`)).toThrow(/can't read/);
    expect(() => accountIdsFromToml(`account_id = """${A}"""`)).toThrow(/can't read/);
  });
});

describe("wrangler.json(c) account_id", () => {
  it("reads JSONC with comments and trailing commas", () => {
    const jsonc = `{
      // the account
      "account_id": "${A}", /* inline */
      "env": { "production": { "account_id": "${B}", }, "staging": {}, },
      "vars": { "URL": "https://example.com/a//b" },
    }`;
    expect(accountIdsFromJsonc(jsonc)).toEqual({ top: A, envs: { production: B } });
  });
});

describe("cloudflare.resolve: which account a command uses", () => {
  it("takes account_id from the config file, found walking up", async () => {
    const root = folder({ "wrangler.toml": `account_id = "${A}"\n`, "src/index.ts": "" });
    const { exec, calls } = fake();
    expect(await resolve(["deploy"], join(root, "src"), {}, exec)).toEqual({
      kind: "identity",
      identity: { account: A },
      source: "account_id in wrangler.toml",
    });
    expect(calls).toEqual([]);
  });

  it("lets the config file beat CLOUDFLARE_ACCOUNT_ID, as Wrangler does", async () => {
    const root = folder({ "wrangler.toml": `account_id = "${A}"\n` });
    expect(await resolve(["deploy"], root, { CLOUDFLARE_ACCOUNT_ID: B })).toMatchObject({ identity: { account: A } });
  });

  it("uses the --env (or CLOUDFLARE_ENV) section, falling back to the top-level value", async () => {
    const root = folder({ "wrangler.toml": `account_id = "${A}"\n[env.production]\naccount_id = "${B}"\n[env.staging]\nname = "s"\n` });
    expect(await resolve(["deploy", "--env", "production"], root)).toMatchObject({ identity: { account: B }, source: "account_id in wrangler.toml [env.production]" });
    expect(await resolve(["deploy", "-e", "staging"], root)).toMatchObject({ identity: { account: A } });
    expect(await resolve(["deploy", "-e=production"], root)).toMatchObject({ identity: { account: B }, source: "account_id in wrangler.toml [env.production]" });
    expect(await resolve(["deploy"], root, { CLOUDFLARE_ENV: "production" })).toMatchObject({ identity: { account: B } });
    expect(await resolve(["deploy", "--env=staging"], root, { CLOUDFLARE_ENV: "production" })).toMatchObject({ identity: { account: A } });
  });

  it("searches wrangler.json, then wrangler.jsonc, then wrangler.toml, each all the way up", async () => {
    const root = folder({ "wrangler.json": `{ "account_id": "${A}" }`, "app/wrangler.toml": `account_id = "${B}"\n` });
    expect(await resolve(["deploy"], join(root, "app"))).toMatchObject({ identity: { account: A }, source: "account_id in wrangler.json" });
  });

  it("honours --config and --cwd", async () => {
    const root = folder({ "wrangler.toml": `account_id = "${A}"\n`, "other/w.toml": `account_id = "${B}"\n`, "other/wrangler.toml": `account_id = "${B}"\n` });
    expect(await resolve(["deploy", "-c", join("other", "w.toml")], root)).toMatchObject({ identity: { account: B } });
    expect(await resolve(["deploy", `-c=${join("other", "w.toml")}`], root)).toMatchObject({ identity: { account: B } });
    expect(await resolve(["deploy", "--cwd", "other"], root)).toMatchObject({ identity: { account: B } });
  });

  it("then CLOUDFLARE_ACCOUNT_ID (or CF_ACCOUNT_ID), then the project's account cache", async () => {
    const root = folder({ "wrangler.toml": 'name = "w"\n', "node_modules/.cache/wrangler/wrangler-account.json": JSON.stringify({ account: { id: B, name: "Side" } }) });
    expect(await resolve(["deploy"], root, { CF_ACCOUNT_ID: A })).toMatchObject({ identity: { account: A }, source: "CF_ACCOUNT_ID" });
    expect(await resolve(["deploy"], root)).toMatchObject({ identity: { account: B, label: "Side" }, source: expect.stringMatching(/cache/) });
  });

  it("otherwise asks `wrangler whoami --json`: one account is the one used", async () => {
    const root = folder();
    const { exec, calls } = fake();
    expect(await resolve(["deploy"], root, {}, exec)).toMatchObject({ identity: { account: A, label: "Acme" }, source: "the only account the credentials can see" });
    expect(calls).toEqual([["whoami", "--json"]]);
  });

  it("stops when the credentials see several accounts and none is set: Wrangler would ask or fail", async () => {
    const res = await resolve(["deploy"], folder(), {}, fake({ stdout: whoami([{ id: A, name: "Acme" }, { id: B, name: "Side" }]) }).exec);
    expect(res).toMatchObject({ kind: "error", noTarget: true, message: expect.stringMatching(/2 accounts.*account_id.*CLOUDFLARE_ACCOUNT_ID/) });
  });

  it("reports logged out", async () => {
    const out = fake({ code: 1, stdout: JSON.stringify({ loggedIn: false }) });
    expect(await resolve(["deploy"], folder(), {}, out.exec)).toEqual({ kind: "logged-out", hint: "wrangler login" });
  });

  it("stops on a config file it can't read, and on deploy --temporary", async () => {
    expect(await resolve(["deploy"], folder({ "wrangler.toml": `env = { p = { account_id = "${A}" } }` }))).toMatchObject({ kind: "error", message: expect.stringMatching(/can't read/) });
    expect(await resolve(["deploy"], folder({ "wrangler.jsonc": "{ nope" }))).toMatchObject({ kind: "error" });
    expect(await resolve(["deploy", "--temporary"], folder({ "wrangler.toml": `account_id = "${A}"\n` }))).toMatchObject({ kind: "error", message: expect.stringMatching(/temporary/) });
  });

  it("stops when a generated deploy config names another account than wrangler.toml", async () => {
    const root = folder({
      "wrangler.toml": `account_id = "${A}"\n`,
      "dist/wrangler.json": `{ "account_id": "${B}" }`,
      ".wrangler/deploy/config.json": JSON.stringify({ configPath: "../../dist/wrangler.json" }),
    });
    expect(await resolve(["deploy"], root)).toMatchObject({ kind: "error", message: expect.stringMatching(/deploy config/) });
    const same = folder({
      "wrangler.toml": `account_id = "${A}"\n`,
      "dist/wrangler.json": `{ "account_id": "${A}" }`,
      ".wrangler/deploy/config.json": JSON.stringify({ configPath: "../../dist/wrangler.json" }),
    });
    expect(await resolve(["deploy"], same)).toMatchObject({ identity: { account: A } });
  });
});

describe("cloudflare.resolve: the .env files Wrangler loads (#116)", () => {
  // A fake whoami that records the environment it was given.
  function recording(opts: { code?: number; stdout?: string; stderr?: string } = {}) {
    const envs: NodeJS.ProcessEnv[] = [];
    const exec: Exec = async (_bin, _args, env) => {
      envs.push(env);
      return { code: opts.code ?? 0, stdout: opts.stdout ?? whoami([{ id: A, name: "Acme" }]), stderr: opts.stderr ?? "" };
    };
    return { exec, envs };
  }

  it("takes CLOUDFLARE_ACCOUNT_ID from .env over the project's account cache, as Wrangler does", async () => {
    const root = folder({
      "wrangler.toml": 'name = "w"\n',
      ".env": `CLOUDFLARE_ACCOUNT_ID=${B}\n`,
      "node_modules/.cache/wrangler/wrangler-account.json": JSON.stringify({ account: { id: A, name: "Acme" } }),
    });
    const { exec, envs } = recording();
    expect(await resolve(["deploy"], root, {}, exec)).toEqual({ kind: "identity", identity: { account: B }, source: "CLOUDFLARE_ACCOUNT_ID in .env" });
    expect(envs).toEqual([]);
  });

  it("keeps the config file's account_id and the environment's own variable above .env", async () => {
    const root = folder({ "wrangler.toml": `account_id = "${A}"\n`, ".env": `CLOUDFLARE_ACCOUNT_ID=${B}\n` });
    expect(await resolve(["deploy"], root)).toMatchObject({ identity: { account: A }, source: "account_id in wrangler.toml" });
    const bare = folder({ ".env": `CLOUDFLARE_ACCOUNT_ID=${B}\n` });
    expect(await resolve(["deploy"], bare, { CLOUDFLARE_ACCOUNT_ID: A })).toMatchObject({ identity: { account: A }, source: "CLOUDFLARE_ACCOUNT_ID" });
  });

  it("uses CLOUDFLARE_ENV from .env to pick the config's [env.NAME] section, and --env to pick .env.NAME", async () => {
    const toml = `account_id = "${A}"\n[env.production]\naccount_id = "${B}"\n`;
    expect(await resolve(["deploy"], folder({ "wrangler.toml": toml, ".env": "CLOUDFLARE_ENV=production\n" }))).toMatchObject({ identity: { account: B } });
    const root = folder({ ".env": `CLOUDFLARE_ACCOUNT_ID=${A}\n`, ".env.production": `CLOUDFLARE_ACCOUNT_ID=${B}\n` });
    expect(await resolve(["deploy", "--env", "production"], root)).toMatchObject({ identity: { account: B }, source: "CLOUDFLARE_ACCOUNT_ID in .env.production" });
    expect(await resolve(["deploy"], root)).toMatchObject({ identity: { account: A } });
  });

  it("reads .env in the --cwd folder; --config doesn't move it", async () => {
    const root = folder({ ".env": `CLOUDFLARE_ACCOUNT_ID=${A}\n`, "app/.env": `CLOUDFLARE_ACCOUNT_ID=${B}\n`, "app/wrangler.toml": 'name = "w"\n' });
    expect(await resolve(["deploy", "--cwd", "app"], root)).toMatchObject({ identity: { account: B } });
    expect(await resolve(["deploy", "--config", join("app", "wrangler.toml")], root)).toMatchObject({ identity: { account: A } });
  });

  it("treats an empty CLOUDFLARE_ACCOUNT_ID as unset without falling back to CF_ACCOUNT_ID, as Wrangler does", async () => {
    // workers-utils getEnvironmentVariableFactory reads the deprecated name only
    // when the main one is absent from process.env; workers-auth then treats "" as unset.
    const cache = { "node_modules/.cache/wrangler/wrangler-account.json": JSON.stringify({ account: { id: A, name: "Acme" } }) };
    const fromFile = folder({ ...cache, ".env": `CLOUDFLARE_ACCOUNT_ID=\nCF_ACCOUNT_ID=${B}\n` });
    expect(await resolve(["deploy"], fromFile)).toMatchObject({ identity: { account: A }, source: expect.stringMatching(/cache/) });
    const fromShell = folder({ ...cache, ".env": "CLOUDFLARE_ACCOUNT_ID=\n" });
    expect(await resolve(["deploy"], fromShell, { CF_ACCOUNT_ID: B })).toMatchObject({ identity: { account: A } });
    expect(await resolve(["deploy"], folder(cache), { CLOUDFLARE_ACCOUNT_ID: "", CF_ACCOUNT_ID: B })).toMatchObject({ identity: { account: A } });
  });

  it("reads a relative WRANGLER_CACHE_DIR from the folder Wrangler runs in (after --cwd)", async () => {
    const root = folder({ "app/.env": "WRANGLER_CACHE_DIR=cache\n", "app/cache/wrangler-account.json": JSON.stringify({ account: { id: B, name: "Side" } }) });
    expect(await resolve(["deploy", "--cwd", "app"], root)).toMatchObject({ identity: { account: B, label: "Side" } });
    expect(await resolve(["deploy"], join(root, "app"), { WRANGLER_CACHE_DIR: "cache" })).toMatchObject({ identity: { account: B } });
  });

  it("reads the account cache in a WRANGLER_CACHE_DIR set by .env", async () => {
    const root = folder({ "cache/wrangler-account.json": JSON.stringify({ account: { id: B, name: "Side" } }) });
    writeFileSync(join(root, ".env"), `WRANGLER_CACHE_DIR=${join(root, "cache")}\n`);
    expect(await resolve(["deploy"], root)).toMatchObject({ identity: { account: B, label: "Side" } });
  });

  it("asks whoami with the token from .env, and names the file when it fails", async () => {
    const root = folder({ ".env": "CLOUDFLARE_API_TOKEN=token-from-dotenv\n" });
    const { exec, envs } = recording();
    await resolve(["deploy"], root, { PATH: "/bin" }, exec);
    expect(envs).toEqual([{ PATH: "/bin", CLOUDFLARE_API_TOKEN: "token-from-dotenv" }]);
    const bad = recording({ code: 1, stdout: "", stderr: "Authentication error [code: 10000]" });
    const res = await resolve(["deploy"], root, {}, bad.exec);
    expect(res).toMatchObject({ kind: "error", message: expect.stringMatching(/CLOUDFLARE_API_TOKEN is set in \.env/) });
    expect(JSON.stringify(res)).not.toContain("token-from-dotenv");
  });

  it("runs whoami in the command's --cwd folder, so Wrangler tops it up from that folder's .env", async () => {
    const root = folder({ "app/package.json": "{}" });
    const spaced = fake();
    await resolve(["deploy", "--cwd", "app"], root, {}, spaced.exec);
    expect(spaced.calls).toEqual([["whoami", "--json", "--cwd", join(root, "app")]]);
    const joined = fake();
    await resolve(["deploy", "--cwd=app"], root, {}, joined.exec);
    expect(joined.calls).toEqual([["whoami", "--json", "--cwd", join(root, "app")]]);
    const none = fake();
    await resolve(["deploy"], root, {}, none.exec);
    expect(none.calls).toEqual([["whoami", "--json"]]);
  });

  it("passes the command's own environment, the same object, when there is no .env file", async () => {
    const env = { PATH: "/bin", CLOUDFLARE_API_TOKEN: "t" };
    const { exec, envs } = recording();
    await resolve(["deploy"], folder({ "wrangler.toml": 'name = "w"\n' }), env, exec);
    expect(envs).toHaveLength(1);
    expect(envs[0]).toBe(env);
  });

  it("stops when a .env file can't be read exactly, naming the file and variable but not the value", async () => {
    const expand = await resolve(["deploy"], folder({ ".env": "CLOUDFLARE_ACCOUNT_ID=${OTHER_ACCOUNT}\n" }));
    expect(expand).toMatchObject({ kind: "error", message: expect.stringMatching(/CLOUDFLARE_ACCOUNT_ID in \.env/) });
    expect(JSON.stringify(expand)).not.toContain("OTHER_ACCOUNT");
  });

  it("is not stopped by .env lines for other tools that dotenv reads or skips", async () => {
    const env = 'GOOGLE_CREDS="{\\"type\\":\\"service_account\\"}"\nDEBUG: true\nstray line\nDATABASE_URL=postgres://${HOST}/db\n';
    expect(await resolve(["deploy"], folder({ "wrangler.toml": `account_id = "${A}"\n`, ".env": env }))).toMatchObject({ kind: "identity", identity: { account: A } });
  });
});

describe("cloudflare.isExempt", () => {
  it.each([
    [["login"]], [["logout"]], [["whoami"]], [["auth", "list"]], [["--version"]], [["deploy", "--help"]], [["docs"]], [["types"]],
    [["dev"]], [["deploy", "--dry-run"]], [["d1", "execute", "db", "--command", "select 1"]], [["kv", "key", "get", "k", "--binding", "KV"]],
    [["d1", "migrations", "apply", "db"]], [["r2", "object", "get", "b/k"]], [["d1", "execute", "db", "--local"]],
  ])("exempts local %j", (args) => {
    expect(cloudflare.isExempt(args)).toBe(true);
  });

  it.each([
    [["deploy"]], [["dev", "--remote"]], [["d1", "execute", "db", "--remote"]], [["d1", "migrations", "apply", "db", "--remote"]],
    [["kv", "namespace", "list"]], [["secret", "put", "X"]], [["tail"]], [["versions", "upload"]], [["init"]], [["d1", "list"]],
  ])("checks %j", (args) => {
    expect(cloudflare.isExempt(args)).toBe(false);
  });
});

describe("cloudflare.compare", () => {
  it("compares the account ID case-insensitively", () => {
    expect(cloudflare.compare({ account: A.toUpperCase() }, { account: A })).toEqual([]);
    expect(cloudflare.compare({ account: A }, { account: B })).toEqual([`account: pinned "${A}", the command would use "${B}"`]);
  });
});

describe("read-only wrangler commands on a protected environment", () => {
  it.each([[["deployments", "list"]], [["versions", "list"]], [["versions", "view", "abc"]], [["secret", "list"]], [["kv", "namespace", "list"]], [["d1", "list"]], [["d1", "info", "db"]], [["r2", "bucket", "list"]], [["d1", "migrations", "list", "db", "--remote"]]])(
    "trusts %j",
    (args) => {
      expect(isReadOnly("cloudflare", args, {}, {})).toBe(true);
    },
  );

  it.each([[["deploy"]], [["tail"]], [["secret", "put", "X"]], [["versions", "upload"]], [["d1", "execute", "db", "--remote"]], [["kv", "namespace", "list", "delete"]]])("asks for %j", (args) => {
    expect(isReadOnly("cloudflare", args, {}, {})).toBe(false);
  });
});

describe("cloudflare.switchHint", () => {
  it("points at the config file, since its account_id wins over CLOUDFLARE_ACCOUNT_ID", () => {
    const hint = cloudflare.switchHint({ account: A });
    expect(hint).toContain(`account_id = "${A}"`);
    expect(hint).not.toContain("CLOUDFLARE_ACCOUNT_ID");
  });
});
