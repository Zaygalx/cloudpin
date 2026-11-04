import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Exec } from "../src/types.js";
import { A, B, bound, cacheFile, folder, physical, profileHome, resolve, whoami } from "./wrangler-fixtures.js";

// Where Wrangler's .env files (#116) meet its auth profiles (#103). From workers-sdk wrangler@4.151.3:
// packages/wrangler/src/index.ts createCLIParser loads the .env files into process.env after the --cwd chdir,
// before core/register-yargs-command.ts createHandler picks the profile from --profile, else the binding of
// dirname(--config), else of the working folder. The profile holds only a login, so the account still comes
// from account_id, then CLOUDFLARE_ACCOUNT_ID (shell or .env), then the profile's account cache
// (workers-auth core/factory.ts getActiveAccountId, getAccountCacheFileName), and an API token or key from
// either source replaces the profile's login (workers-auth credentials.ts getAPIToken).

/** A fake `wrangler whoami --json` that records its arguments and environment. */
function recording() {
  const calls: { args: string[]; env: NodeJS.ProcessEnv }[] = [];
  const exec: Exec = async (_bin, args, env) => {
    calls.push({ args, env });
    return { code: 0, stdout: whoami([{ id: A, name: "Acme" }]), stderr: "" };
  };
  return { exec, calls };
}

describe("Wrangler .env files and auth profiles together", () => {
  it("takes CLOUDFLARE_ACCOUNT_ID from .env over the bound profile's account cache, and names both", async () => {
    const root = folder({ ".env": `CLOUDFLARE_ACCOUNT_ID=${A}\n`, ...cacheFile("wrangler-account-work.json", B) });
    const { exec, calls } = recording();
    expect(await resolve(["deploy"], root, profileHome(bound(root, "work")), exec)).toEqual({
      kind: "identity",
      identity: { account: A },
      source: `CLOUDFLARE_ACCOUNT_ID in .env (Wrangler profile "work", bound to ${physical(root)})`,
    });
    expect(calls).toEqual([]);
  });

  it("does not need the profile when .env names the account, even if the bindings can't be read", async () => {
    const root = folder({ ".env": `CLOUDFLARE_ACCOUNT_ID=${A}\n` });
    expect(await resolve(["deploy"], root, profileHome("{ broken"))).toMatchObject({ identity: { account: A }, source: "CLOUDFLARE_ACCOUNT_ID in .env" });
  });

  it("reads the profile's account cache in the WRANGLER_CACHE_DIR a .env file sets", async () => {
    const root = folder({
      "custom/wrangler-account-work.json": JSON.stringify({ account: { id: B, name: "Work" } }),
      "custom/wrangler-account.json": JSON.stringify({ account: { id: A, name: "Default" } }),
      ...cacheFile("wrangler-account-work.json", A),
    });
    writeFileSync(join(root, ".env"), `WRANGLER_CACHE_DIR=${join(root, "custom")}\n`);
    expect(await resolve(["deploy"], root, profileHome(bound(root, "work")))).toMatchObject({
      identity: { account: B, label: "Work" },
      source: expect.stringMatching(/\(wrangler-account-work\.json\) \(Wrangler profile "work"/),
    });
  });

  it("looks for the profile's cache file only in the one folder Wrangler picks", async () => {
    // node_modules/.cache/wrangler exists (with the default profile's file only), so Wrangler never reads
    // .wrangler/cache, where an older cache of the work profile sits.
    const root = folder({ ...cacheFile("wrangler-account.json", B) });
    mkdirSync(join(root, ".wrangler", "cache"), { recursive: true });
    writeFileSync(join(root, ".wrangler", "cache", "wrangler-account-work.json"), JSON.stringify({ account: { id: B } }));
    const { exec, calls } = recording();
    expect(await resolve(["deploy"], root, profileHome(bound(root, "work")), exec)).toMatchObject({
      identity: { account: A },
      source: expect.stringMatching(/^the only account the credentials can see \(Wrangler profile "work"/),
    });
    expect(calls).toHaveLength(1);
  });

  it("lets a token from .env stand in for a --profile the folder isn't bound to, and asks whoami with it", async () => {
    const root = folder();
    const env = profileHome(bound(root, "work"));
    expect(await resolve(["deploy", "--profile", "side"], root, env)).toMatchObject({
      kind: "error",
      message: expect.stringMatching(/can't tell which account Wrangler profile "side" uses/),
    });
    writeFileSync(join(root, ".env"), "CLOUDFLARE_API_TOKEN=token-from-dotenv\n");
    const { exec, calls } = recording();
    expect(await resolve(["deploy", "--profile", "side"], root, env, exec)).toMatchObject({ identity: { account: A } });
    expect(calls.map((c) => c.args)).toEqual([["whoami", "--json", "--cwd", physical(root)]]);
    expect(calls[0]!.env.CLOUDFLARE_API_TOKEN).toBe("token-from-dotenv");
  });

  it("counts a global API key from the shell paired with CLOUDFLARE_EMAIL from .env", async () => {
    const root = folder({ ".env": "CLOUDFLARE_EMAIL=dev@example.com\n" });
    const env = { ...profileHome(bound(root, "work")), CLOUDFLARE_API_KEY: "key" };
    const { exec, calls } = recording();
    expect(await resolve(["deploy", "--profile", "side"], root, env, exec)).toMatchObject({ identity: { account: A } });
    expect(calls).toHaveLength(1);
  });

  it("reads .env from the working folder but the profile from the --config file's folder", async () => {
    // Wrangler never reads sub/.env here: --config doesn't move the working folder.
    const root = folder({
      "sub/.env": `CLOUDFLARE_ACCOUNT_ID=${A}\n`,
      "sub/wrangler.toml": 'name = "w"\n',
      ...cacheFile("wrangler-account-work.json", B),
    });
    const { exec, calls } = recording();
    expect(await resolve(["deploy", "--config", "sub/wrangler.toml"], root, profileHome(bound(join(root, "sub"), "work")), exec)).toMatchObject({
      identity: { account: B },
      source: expect.stringMatching(/^the account Wrangler cached .*\(wrangler-account-work\.json\) \(Wrangler profile "work", bound to /),
    });
    expect(calls).toEqual([]);
  });

  it("asks whoami in the command's --cwd folder with that folder's .env when profiles are in use", async () => {
    const root = folder({ "app/.env": "CLOUDFLARE_API_TOKEN=app-token\n" });
    const { exec, calls } = recording();
    await resolve(["deploy", "--cwd", "app"], root, profileHome(bound(join(root, "app"), "work")), exec);
    expect(calls.map((c) => c.args)).toEqual([["whoami", "--json", "--cwd", physical(join(root, "app"))]]);
    expect(calls[0]!.env.CLOUDFLARE_API_TOKEN).toBe("app-token");
  });

  it("passes the command's --env-file files to whoami after the profile's --cwd and --config (#130)", async () => {
    // With --env-file, Wrangler reads only those files (index.ts createCLIParser), whoami included, so the
    // folder's .env token must not reach it; the files are resolved against the --cwd folder.
    const root = folder({
      "app/.env": "CLOUDFLARE_API_TOKEN=default-token\n",
      "app/staging.env": "CLOUDFLARE_EMAIL=dev@example.com\n",
      "app/sub/wrangler.toml": 'name = "w"\n',
    });
    const env = profileHome(bound(join(root, "app", "sub"), "work"));
    const { exec, calls } = recording();
    const args = ["deploy", "--cwd", "app", "--config", "sub/wrangler.toml", "--env-file", "staging.env"];
    expect(await resolve(args, root, env, exec)).toMatchObject({ identity: { account: A }, source: expect.stringMatching(/profile "work"/) });
    expect(calls.map((c) => c.args)).toEqual([
      ["whoami", "--json", "--cwd", physical(join(root, "app")), "--config", "sub/wrangler.toml", "--env-file", join(root, "app", "staging.env")],
    ]);
    expect(calls[0]!.env.CLOUDFLARE_API_TOKEN).toBeUndefined();
    expect(calls[0]!.env.CLOUDFLARE_EMAIL).toBe("dev@example.com");
  });

  it("goes past an empty CLOUDFLARE_ACCOUNT_ID, and ignores CF_ACCOUNT_ID, to the profile's account cache", async () => {
    const root = folder(cacheFile("wrangler-account-work.json", B));
    const env = { ...profileHome(bound(root, "work")), CLOUDFLARE_ACCOUNT_ID: "", CF_ACCOUNT_ID: A };
    expect(await resolve(["deploy"], root, env)).toMatchObject({ identity: { account: B }, source: expect.stringMatching(/profile "work"/) });
  });

  it("passes WRANGLER_API_ENVIRONMENT from .env to whoami, so the identity cache keys on it", async () => {
    // It picks the default profile's login file and the API whoami asks (workers-auth credential-store/
    // file-store.ts getAuthConfigFilePath, env-vars.ts), and is read from process.env after the .env load.
    const root = folder({ ".env": "WRANGLER_API_ENVIRONMENT=staging\n" });
    const { exec, calls } = recording();
    await resolve(["deploy"], root, profileHome(bound(root, "work")), exec);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.env.WRANGLER_API_ENVIRONMENT).toBe("staging");
  });
});
