import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { cachedExec } from "../src/cache.js";
import { cloudflare } from "../src/providers/cloudflare.js";
import { wranglerDotenv } from "../src/providers/wrangler-dotenv.js";
import { commandProfile } from "../src/providers/wrangler-profiles.js";
import type { Exec } from "../src/types.js";
import { tempDir } from "./tmp.js";
import { A, B, cacheFile, folder, noProfiles, physical, resolve, whoami } from "./wrangler-fixtures.js";

// Where Wrangler looks for its config folder (profile bindings and logins) when a project .env moves it.
// workers-sdk wrangler@4.151.3: packages/workers-utils/src/global-wrangler-config-path.ts getGlobalConfigPath
// uses <os.homedir()>/.wrangler if it exists, else xdg-app-paths.ts xdgConfig()/.wrangler, where xdgConfig reads
// getEnv("XDG_CONFIG_HOME"), and on Windows getEnv("APPDATA"), from process.env. It is called lazily
// (workers-auth core/profile-store.ts getDirectoryBindingsPath), after packages/wrangler/src/index.ts has run
// `process.env = loadDotEnv(...)`. That replaces process.env with a plain object, so os.homedir(), which reads
// the real environment, never sees a HOME or USERPROFILE from .env.

/** A folder holding <sub>/.wrangler/profiles/directory-bindings.json with these bindings. */
function configDir(sub: string, bindings: Record<string, string>) {
  const dir = tempDir("cloudpin-wrangler-xdg-");
  mkdirSync(join(dir, sub, ".wrangler", "profiles"), { recursive: true });
  writeFileSync(join(dir, sub, ".wrangler", "profiles", "directory-bindings.json"), JSON.stringify(bindings));
  return dir;
}

/** A project whose default profile cached account A and whose "work" profile cached account B. */
const project = (dotenv: string) =>
  folder({ ".env": dotenv, ...cacheFile("wrangler-account.json", A), ...cacheFile("wrangler-account-work.json", B) });

function recording() {
  const calls: { args: string[]; env: NodeJS.ProcessEnv }[] = [];
  const exec: Exec = async (_bin, args, env) => {
    calls.push({ args, env });
    return { code: 0, stdout: whoami([{ id: A, name: "Acme" }]), stderr: "" };
  };
  return { exec, calls };
}

describe("a .env XDG_CONFIG_HOME moves Wrangler's config folder", () => {
  it("checks the account against the profile the bindings there pick", async () => {
    const root = project("");
    writeFileSync(join(root, ".env"), `XDG_CONFIG_HOME=${configDir("", { [physical(root)]: "work" })}\n`);
    expect(await resolve(["deploy"], root)).toMatchObject({
      identity: { account: B },
      source: expect.stringMatching(/\(wrangler-account-work\.json\) \(Wrangler profile "work", bound to /),
    });
  });

  it("asks whoami in the command's folder, with that XDG_CONFIG_HOME, so its Wrangler reads the same bindings", async () => {
    const root = folder();
    const xdg = configDir("", { [physical(root)]: "work" });
    writeFileSync(join(root, ".env"), `XDG_CONFIG_HOME=${xdg}\n`);
    const { exec, calls } = recording();
    await resolve(["deploy"], root, {}, exec);
    expect(calls.map((c) => c.args)).toEqual([["whoami", "--json", "--cwd", physical(root)]]);
    expect(calls[0]!.env.XDG_CONFIG_HOME).toBe(xdg);
  });

  it("keeps a non-empty XDG_CONFIG_HOME from the shell, as Wrangler's .env loading does", async () => {
    const root = project("");
    const shellXdg = configDir("", {});
    writeFileSync(join(root, ".env"), `XDG_CONFIG_HOME=${configDir("", { [physical(root)]: "work" })}\n`);
    expect(await resolve(["deploy"], root, { XDG_CONFIG_HOME: shellXdg })).toMatchObject({ identity: { account: A } });
  });

  it("control: with no XDG_CONFIG_HOME anywhere, the default profile's cache answers as before", async () => {
    const root = project("CLOUDFLARE_EMAIL=dev@example.com\n");
    expect(await resolve(["deploy"], root)).toMatchObject({
      identity: { account: A },
      source: "the account Wrangler cached for this project (wrangler-account.json)",
    });
  });

  it("control: a HOME or USERPROFILE from .env doesn't move it (os.homedir() reads the real environment)", async () => {
    const root = project("");
    const home = configDir("", { [physical(root)]: "work" });
    writeFileSync(join(root, ".env"), `HOME=${home}\nUSERPROFILE=${home}\n`);
    expect(await resolve(["deploy"], root)).toMatchObject({ identity: { account: A } });
  });

  it("keys the identity cache on it, so a .env pointing elsewhere asks whoami again", async () => {
    const root = folder();
    const first = configDir("", {});
    const second = configDir("", {});
    const shell = { HOME: noProfiles, USERPROFILE: noProfiles };
    const { exec: real, calls } = recording();
    const exec = cachedExec(real, cloudflare.cacheInputs(shell), { cacheDir: join(root, "cache"), env: {} });
    writeFileSync(join(root, ".env"), `XDG_CONFIG_HOME=${first}\n`);
    await resolve(["deploy"], root, {}, exec);
    writeFileSync(join(root, ".env"), `XDG_CONFIG_HOME=${second}\n`);
    await resolve(["deploy"], root, {}, exec);
    expect(calls.map((c) => c.env.XDG_CONFIG_HOME)).toEqual([first, second]);
    expect(cloudflare.cacheInputs({}).env).toEqual(expect.arrayContaining(["XDG_CONFIG_HOME", "APPDATA"]));
  });
});

describe("a .env APPDATA moves it on Windows", () => {
  // xdgConfig on Windows: XDG_CONFIG_HOME, else <APPDATA>\xdg.config, APPDATA falling back to
  // <home>\AppData\Roaming.
  const appData = (root: string) => configDir("xdg.config", { [root]: "work" });

  it("picks the profile bound in <APPDATA>\\xdg.config\\.wrangler when the shell has no APPDATA", () => {
    const root = folder();
    writeFileSync(join(root, ".env"), `APPDATA=${appData(root)}\n`);
    const merged = wranglerDotenv(["deploy"], { USERPROFILE: noProfiles }, root, "win32");
    if ("error" in merged) throw new Error(merged.error);
    expect(commandProfile(["deploy"], merged.env, root, "win32")).toMatchObject({ name: "work" });
  });

  it("control: the shell's own APPDATA wins, and with none anywhere the default profile applies", () => {
    const root = folder();
    writeFileSync(join(root, ".env"), `APPDATA=${appData(root)}\n`);
    const shell = wranglerDotenv(["deploy"], { USERPROFILE: noProfiles, APPDATA: tempDir("cloudpin-appdata-") }, root, "win32");
    if ("error" in shell) throw new Error(shell.error);
    expect(commandProfile(["deploy"], shell.env, root, "win32")).toMatchObject({ name: "default" });
    expect(commandProfile(["deploy"], { USERPROFILE: noProfiles }, root, "win32")).toMatchObject({ name: "default" });
  });

  it.runIf(process.platform === "win32")("checks the account against that profile on a real Windows run", async () => {
    const root = project("");
    writeFileSync(join(root, ".env"), `APPDATA=${appData(root)}\n`);
    expect(await resolve(["deploy"], root)).toMatchObject({ identity: { account: B }, source: expect.stringMatching(/profile "work"/) });
  });
});
