import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { cachedExec } from "../src/cache.js";
import { cloudflare } from "../src/providers/cloudflare.js";
import type { Exec } from "../src/types.js";
import { tempDir } from "./tmp.js";

// #136: the identity cache keys `wrangler whoami` on Wrangler's logins, in
// <global config folder>/config (default.toml, one file per profile) and the
// profile bindings next to it (#103). The folder is ~/.wrangler if it exists,
// else the XDG one, which differs per platform (workers-sdk
// packages/workers-utils/src/global-wrangler-config-path.ts getGlobalConfigPath
// and xdg-app-paths.ts xdgConfig): XDG_CONFIG_HOME when non-empty, else
// %APPDATA%\xdg.config on Windows, ~/Library/Preferences on macOS, ~/.config elsewhere.

/** What the cache watches for the Wrangler folders under `bases` (legacy home first, then XDG). */
const watching = (...bases: string[]) => ({
  files: bases.map((b) => join(b, ".wrangler", "profiles", "directory-bindings.json")),
  dirs: bases.map((b) => join(b, ".wrangler", "config")),
});
const watched = (env: NodeJS.ProcessEnv, platform: NodeJS.Platform) => {
  const { files, dirs } = cloudflare.cacheInputs(env, platform);
  return { files, dirs };
};
const loginFile = (base: string) => join(base, ".wrangler", "config", "default.toml");

describe("cloudflare.cacheInputs: the login folder Wrangler writes, per platform (#136)", () => {
  const home = "/home/u";

  it("watches %APPDATA%\\xdg.config\\.wrangler on win32", () => {
    const appData = join("C:", "Users", "u", "AppData", "Roaming");
    expect(watched({ USERPROFILE: home, APPDATA: appData }, "win32")).toEqual(watching(home, join(appData, "xdg.config")));
    // Without APPDATA, Wrangler falls back to <home>\AppData\Roaming (windowsAppData).
    expect(watched({ USERPROFILE: home }, "win32")).toEqual(watching(home, join(home, "AppData", "Roaming", "xdg.config")));
  });

  it("watches ~/Library/Preferences/.wrangler on darwin", () => {
    expect(watched({ HOME: home }, "darwin")).toEqual(watching(home, join(home, "Library", "Preferences")));
  });

  it("watches ~/.config/.wrangler on linux", () => {
    expect(watched({ HOME: home }, "linux")).toEqual(watching(home, join(home, ".config")));
  });

  it("follows a non-empty XDG_CONFIG_HOME on every platform, and ignores an empty one", () => {
    const xdg = "/x/config";
    for (const platform of ["win32", "darwin", "linux"] as const) {
      // Wrangler's home is USERPROFILE on Windows and HOME elsewhere (os.homedir), so both are set.
      const env = { HOME: home, USERPROFILE: home, APPDATA: "/a", XDG_CONFIG_HOME: xdg };
      expect(watched(env, platform), platform).toEqual(watching(home, xdg));
    }
    // xdg-portable's valOrPath: an empty value counts as unset.
    expect(watched({ HOME: home, XDG_CONFIG_HOME: "" }, "linux")).toEqual(watching(home, join(home, ".config")));
  });
});

describe("identity cache: a re-login in the Windows folder drops the cached whoami (#136)", () => {
  it("asks whoami again after %APPDATA%\\xdg.config\\.wrangler\\config\\default.toml changes", async () => {
    const appData = tempDir("cloudpin-wrangler-appdata-");
    const env = { USERPROFILE: tempDir("cloudpin-wrangler-home-"), APPDATA: appData };
    const file = loginFile(join(appData, "xdg.config"));
    mkdirSync(join(file, ".."), { recursive: true });
    writeFileSync(file, "oauth_token = \"first\"\n");
    let calls = 0;
    const exec: Exec = async () => ({ code: 0, stdout: String(++calls), stderr: "" });
    const cached = cachedExec(exec, cloudflare.cacheInputs(env, "win32"), { cacheDir: tempDir("cloudpin-wrangler-cache-"), env: {} });
    await cached("wrangler", ["whoami", "--json"], env);
    await cached("wrangler", ["whoami", "--json"], env);
    expect(calls).toBe(1);
    // `wrangler login` rewrites the file, with a different size, so the stamp changes.
    writeFileSync(file, "oauth_token = \"second, longer\"\n");
    await cached("wrangler", ["whoami", "--json"], env);
    expect(calls).toBe(2);
  });
});
