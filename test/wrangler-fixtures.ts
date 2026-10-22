import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cloudflare } from "../src/providers/cloudflare.js";
import type { Exec } from "../src/types.js";
import { tempDir } from "./tmp.js";

// Shared fixtures for the Wrangler auth profile tests (#103).
export const A = "0123456789abcdef0123456789abcdef";
export const B = "fedcba9876543210fedcba9876543210";

export const whoami = (accounts: { id: string; name: string }[]) =>
  JSON.stringify({ loggedIn: true, authType: "OAuth Token", email: "dev@example.com", accounts });

export function fake() {
  const calls: string[][] = [];
  const exec: Exec = async (_bin, args) => {
    calls.push(args);
    return { code: 0, stdout: whoami([{ id: A, name: "Acme" }]), stderr: "" };
  };
  return { exec, calls };
}

export function folder(files: Record<string, string> = {}) {
  const root = tempDir("cloudpin-wrangler-");
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(join(root, name, ".."), { recursive: true });
    writeFileSync(join(root, name), content);
  }
  return root;
}

// An empty home folder, so no test reads the real Wrangler profiles.
export const noProfiles = tempDir("cloudpin-wrangler-home-");

export const resolve = (args: string[], cwd: string, env: NodeJS.ProcessEnv = {}, exec: Exec = fake().exec) =>
  cloudflare.resolve({ args, env: { HOME: noProfiles, ...env }, cwd, bin: "wrangler" }, exec);

/** A home folder whose Wrangler config (~/.wrangler) holds this directory-bindings.json. */
export function profileHome(bindings: Record<string, string> | string) {
  const home = tempDir("cloudpin-wrangler-home-");
  mkdirSync(join(home, ".wrangler", "profiles"), { recursive: true });
  const text = typeof bindings === "string" ? bindings : JSON.stringify(bindings);
  writeFileSync(join(home, ".wrangler", "profiles", "directory-bindings.json"), text);
  return { HOME: home };
}
// Wrangler matches the folder as its process.cwd() spells it: the real path outside Windows.
export const physical = (dir: string) => (process.platform === "win32" ? dir : realpathSync(dir));
export const bound = (dir: string, profile: string) => ({ [physical(dir)]: profile });
export const cacheFile = (name: string, id: string) => ({
  [`node_modules/.cache/wrangler/${name}`]: JSON.stringify({ account: { id, name: "Cached" } }),
});
