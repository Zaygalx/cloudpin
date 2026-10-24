import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve as resolvePath } from "node:path";
import { describe, expect, it } from "vitest";
import type { FoundConfig } from "../src/config.js";
import { guard } from "../src/guard.js";
import { cloudflare } from "../src/providers/cloudflare.js";
import { parseDotenv } from "../src/providers/wrangler-dotenv.js";
import type { Exec } from "../src/types.js";
import { tempDir } from "./tmp.js";

// #130: with --env-file, Wrangler reads only those files, not the folder's
// default .env files, so cloudpin's whoami must be asked with the same files.

const A = "0123456789abcdef0123456789abcdef";
const B = "fedcba9876543210fedcba9876543210";

const whoamiJson = (id: string) => JSON.stringify({ loggedIn: true, accounts: [{ id, name: id === A ? "Acme" : "Side" }] });

function folder(files: Record<string, string> = {}) {
  const root = tempDir("cloudpin-whoami-env-file-");
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(join(root, name, ".."), { recursive: true });
    writeFileSync(join(root, name), content);
  }
  return root;
}

/** A fake whoami that records its arguments and environment. */
function recording() {
  const calls: { args: string[]; env: NodeJS.ProcessEnv }[] = [];
  const exec: Exec = async (_bin, args, env) => {
    calls.push({ args, env });
    return { code: 0, stdout: whoamiJson(A), stderr: "" };
  };
  return { exec, calls };
}

const resolve = (args: string[], cwd: string, env: NodeJS.ProcessEnv, exec: Exec) => cloudflare.resolve({ args, env, cwd, bin: "wrangler" }, exec);

describe("cloudflare.resolve: whoami reads the command's --env-file files (#130)", () => {
  const files = {
    ".env": "CLOUDFLARE_API_TOKEN=token-default\n",
    "one.env": "CLOUDFLARE_API_TOKEN=token-one\n",
    "two.env": "CLOUDFLARE_EMAIL=two@example.com\n",
    "app/.env": "CLOUDFLARE_API_TOKEN=token-app-default\n",
    "app/staging.env": "CLOUDFLARE_API_TOKEN=token-app-staging\n",
  };

  it("passes one --env-file to whoami as an absolute path, with the environment cloudpin merged from it", async () => {
    const root = folder(files);
    const { exec, calls } = recording();
    await resolve(["deploy", "--env-file", "one.env"], root, { PATH: "/bin" }, exec);
    expect(calls).toEqual([
      { args: ["whoami", "--json", "--env-file", join(root, "one.env")], env: { PATH: "/bin", CLOUDFLARE_API_TOKEN: "token-one" } },
    ]);
  });

  it("passes the --env-file=X form, and the --envFile alias, the same way", async () => {
    const root = folder(files);
    for (const args of [["deploy", "--env-file=one.env"], ["deploy", "--envFile", "one.env"], ["deploy", "--envFile=one.env"]]) {
      const { exec, calls } = recording();
      await resolve(args, root, {}, exec);
      expect(calls.map((c) => c.args)).toEqual([["whoami", "--json", "--env-file", join(root, "one.env")]]);
    }
  });

  it("passes several files in the command's order, whether repeated or after one flag", async () => {
    const root = folder(files);
    const expected = ["whoami", "--json", "--env-file", join(root, "one.env"), "--env-file", join(root, "two.env")];
    const repeated = recording();
    await resolve(["deploy", "--env-file", "one.env", "--env-file", "two.env"], root, {}, repeated.exec);
    expect(repeated.calls.map((c) => c.args)).toEqual([expected]);
    expect(repeated.calls[0]!.env).toEqual({ CLOUDFLARE_API_TOKEN: "token-one", CLOUDFLARE_EMAIL: "two@example.com" });
    const greedy = recording();
    await resolve(["deploy", "--env-file", "one.env", "two.env", "--minify"], root, {}, greedy.exec);
    expect(greedy.calls.map((c) => c.args)).toEqual([expected]);
  });

  it("resolves a relative --env-file against the --cwd folder, as Wrangler does after its chdir", async () => {
    const root = folder(files);
    const { exec, calls } = recording();
    await resolve(["deploy", "--cwd", "app", "--env-file", "staging.env"], root, {}, exec);
    expect(calls).toEqual([
      {
        args: ["whoami", "--json", "--cwd", join(root, "app"), "--env-file", join(root, "app", "staging.env")],
        env: { CLOUDFLARE_API_TOKEN: "token-app-staging" },
      },
    ]);
  });

  it("without --env-file, whoami is asked as before", async () => {
    const root = folder(files);
    const plain = recording();
    await resolve(["deploy"], root, { PATH: "/bin" }, plain.exec);
    expect(plain.calls).toEqual([{ args: ["whoami", "--json"], env: { PATH: "/bin", CLOUDFLARE_API_TOKEN: "token-default" } }]);
    const withCwd = recording();
    await resolve(["deploy", "--cwd", "app"], root, {}, withCwd.exec);
    expect(withCwd.calls).toEqual([{ args: ["whoami", "--json", "--cwd", join(root, "app")], env: { CLOUDFLARE_API_TOKEN: "token-app-default" } }]);
  });
});

// A fake `wrangler whoami --json` that loads .env files the way Wrangler does
// (packages/wrangler/src/index.ts createCLIParser: args["env-file"] ??
// getDefaultEnvFiles(args.env), resolved after the --cwd chdir; config/dot-env.ts
// loadDotEnv: later files win, then a non-empty variable already set wins),
// then answers with the token's account, or the OAuth login's when no token is set.
function wranglerLike(runIn: string, tokens: Record<string, string>, oauthAccount: string): { exec: Exec; calls: string[][] } {
  const calls: string[][] = [];
  const exec: Exec = async (_bin, args, given) => {
    calls.push(args);
    let cwd = runIn;
    let envFiles: string[] | undefined;
    for (let i = 0; i < args.length; i++) {
      if (args[i] === "--cwd") cwd = resolvePath(runIn, args[++i]!);
      else if (args[i] === "--env-file") {
        envFiles ??= [];
        while (i + 1 < args.length && !args[i + 1]!.startsWith("-")) envFiles.push(args[++i]!);
      }
    }
    const parsed: Record<string, string> = {};
    for (const file of envFiles ?? [".env", ".env.local"]) {
      let text: string;
      try {
        text = readFileSync(resolvePath(cwd, file), "utf8");
      } catch {
        continue;
      }
      Object.assign(parsed, Object.fromEntries(parseDotenv(text)));
    }
    const env = { ...given };
    for (const [key, value] of Object.entries(parsed)) if (!env[key]) env[key] = value;
    const token = env.CLOUDFLARE_API_TOKEN || env.CF_API_TOKEN;
    const account = token ? tokens[token] : oauthAccount;
    if (account === undefined) return { code: 1, stdout: "", stderr: "Authentication error [code: 10000]" };
    return { code: 0, stdout: whoamiJson(account), stderr: "" };
  };
  return { exec, calls };
}

const pinnedToA: FoundConfig = { path: "/repo/.cloudpin.yml", pins: { cloudflare: { account: A } } };

async function verdict(root: string, args: string[], tokens: Record<string, string>, env: NodeJS.ProcessEnv = {}) {
  const fake = wranglerLike(root, tokens, B);
  const result = await guard(
    { bin: "wrangler", args, env, cwd: root, mode: "shell" },
    { providers: [cloudflare], exec: fake.exec, findConfig: () => pinnedToA },
  );
  return { result, calls: fake.calls };
}

describe("guard: the issue's failure case (#130)", () => {
  // The folder's .env holds account A's token (A is pinned); the OAuth login is account B.
  const tokens = { "token-a": A, "token-b": B };

  it("blocks `deploy --env-file .env.staging` when that file sets no token, so the command runs through the login on B", async () => {
    const root = folder({ ".env": "CLOUDFLARE_API_TOKEN=token-a\n", ".env.staging": "API_HOST=staging.example.com\n" });
    const { result, calls } = await verdict(root, ["deploy", "--env-file", ".env.staging"], tokens);
    expect(result).toMatchObject({ action: "block", problems: [expect.stringContaining(`would use "${B}"`)] });
    expect(calls).toEqual([["whoami", "--json", "--env-file", join(root, ".env.staging")]]);
  });

  it("blocks when the --env-file sets the token empty, which Wrangler's .env loading would otherwise fill", async () => {
    const root = folder({ ".env": "CLOUDFLARE_API_TOKEN=token-a\n", ".env.staging": "CLOUDFLARE_API_TOKEN=\n" });
    expect((await verdict(root, ["deploy", "--env-file", ".env.staging"], tokens)).result).toMatchObject({ action: "block" });
  });

  // Controls: the same folder without --env-file runs on A, and a token the
  // --env-file sets was already masking the folder's .env (a non-empty
  // variable already set wins in loadDotEnv), so both behave as before.
  it("allows `deploy` with no --env-file: Wrangler reads .env and runs on A", async () => {
    const root = folder({ ".env": "CLOUDFLARE_API_TOKEN=token-a\n" });
    expect((await verdict(root, ["deploy"], tokens)).result).toEqual({ action: "allow", reason: "match" });
  });

  it("blocks when the --env-file sets B's token, as it did before the fix", async () => {
    const root = folder({ ".env": "CLOUDFLARE_API_TOKEN=token-a\n", ".env.staging": "CLOUDFLARE_API_TOKEN=token-b\n" });
    expect((await verdict(root, ["deploy", "--env-file", ".env.staging"], tokens)).result).toMatchObject({ action: "block" });
  });
});
