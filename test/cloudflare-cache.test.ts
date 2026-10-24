import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { cloudflare } from "../src/providers/cloudflare.js";
import type { Exec } from "../src/types.js";
import { tempDir } from "./tmp.js";

// The project account cache Wrangler reads (workers-utils config-cache.ts
// getCacheFolder): one folder is chosen, and only its wrangler-account.json counts.

const A = "0123456789abcdef0123456789abcdef";
const B = "fedcba9876543210fedcba9876543210";

// `wrangler whoami --json` that sees account A only.
const exec: Exec = async () => ({ code: 0, stdout: JSON.stringify({ loggedIn: true, accounts: [{ id: A, name: "Acme" }] }), stderr: "" });

function folder(files: Record<string, string>) {
  const root = tempDir("cloudpin-wrangler-cache-");
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(join(root, name, ".."), { recursive: true });
    writeFileSync(join(root, name), content);
  }
  return root;
}

const resolve = (cwd: string, env: NodeJS.ProcessEnv = {}) => cloudflare.resolve({ args: ["deploy"], env, cwd, bin: "wrangler" }, exec);
const cacheFile = (id: string) => JSON.stringify({ account: { id, name: "Cached" } });
const fromWhoami = { identity: { account: A }, source: "the only account the credentials can see" };

describe("cloudflare.resolve: the one account cache folder Wrangler reads", () => {
  it("reads only WRANGLER_CACHE_DIR when set, even when it has no account file or a broken one", async () => {
    const root = folder({ "empty-cache/other.json": "{}", "node_modules/.cache/wrangler/wrangler-account.json": cacheFile(B) });
    expect(await resolve(root, { WRANGLER_CACHE_DIR: join(root, "empty-cache") })).toMatchObject(fromWhoami);
    const broken = folder({ "bad/wrangler-account.json": "{ nope", ".wrangler/cache/wrangler-account.json": cacheFile(B) });
    expect(await resolve(broken, { WRANGLER_CACHE_DIR: join(broken, "bad") })).toMatchObject(fromWhoami);
  });

  it("reads only node_modules/.cache/wrangler when that folder exists, even without an account file", async () => {
    const root = folder({ "node_modules/.cache/wrangler/pages.json": "{}", ".wrangler/cache/wrangler-account.json": cacheFile(B) });
    expect(await resolve(root)).toMatchObject(fromWhoami);
  });

  it("uses the chosen folder's file: WRANGLER_CACHE_DIR, else node_modules/.cache/wrangler, else .wrangler/cache", async () => {
    const all = folder({
      "custom/wrangler-account.json": cacheFile(B),
      "node_modules/.cache/wrangler/wrangler-account.json": cacheFile(A),
      ".wrangler/cache/wrangler-account.json": cacheFile(A),
    });
    expect(await resolve(all, { WRANGLER_CACHE_DIR: join(all, "custom") })).toMatchObject({ identity: { account: B } });
    const modules = folder({ "node_modules/.cache/wrangler/wrangler-account.json": cacheFile(B), ".wrangler/cache/wrangler-account.json": cacheFile(A) });
    expect(await resolve(modules, { WRANGLER_CACHE_DIR: "" })).toMatchObject({ identity: { account: B } });
    const local = folder({ "node_modules/some-package/index.js": "", ".wrangler/cache/wrangler-account.json": cacheFile(B) });
    expect(await resolve(local)).toMatchObject({ identity: { account: B } });
  });
});
