import { accessSync, constants, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, posix, win32 } from "node:path";

/** The user's home folder as the command's environment sees it. */
export function home(env: NodeJS.ProcessEnv): string {
  return env.HOME ?? env.USERPROFILE ?? homedir();
}

/** Windows roaming app data, or undefined elsewhere. */
export function appData(env: NodeJS.ProcessEnv): string | undefined {
  return env.APPDATA;
}

/**
 * Where a bare command name resolves on PATH, without spawning anything. On
 * Windows only names with a PATHEXT extension run (`cloudpin.cmd`, not the
 * extensionless script npm also writes for Git Bash), unless the name already
 * has a dot, which is tried as it is first (as the `which` package does).
 * Variable names are matched case-insensitively there, since copies of the
 * environment keep `Path`.
 *
 * Only absolute PATH entries count, and the current folder is never searched
 * (GHSA-3cf7-5v5w-q5vr, CWE-427): cmd.exe, libuv and the `which` package that
 * cross-spawn uses all look in the current folder first on Windows, and POSIX
 * reads an empty or relative entry as the current folder, so a file planted
 * in a repository would run in place of the real CLI. On Windows one pair of
 * surrounding double quotes is removed from an entry, as cmd.exe and `which` do.
 */
export function findOnPath(
  name: string,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  exists: (path: string) => boolean,
): string | null {
  const win = platform === "win32";
  const p = win ? win32 : posix;
  const get = (key: string) => (win ? Object.entries(env).find(([k]) => k.toUpperCase() === key)?.[1] : env[key]);
  const dirs = (get("PATH") ?? "")
    .split(win ? ";" : ":")
    .map((dir) => (win && dir.length > 1 && dir.startsWith('"') && dir.endsWith('"') ? dir.slice(1, -1) : dir))
    .filter((dir) => dir !== "" && p.isAbsolute(dir));
  const exts = win ? (get("PATHEXT") ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean) : [""];
  if (win && name.includes(".")) exts.unshift("");
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = p.join(dir, name + ext);
      if (exists(candidate)) return candidate;
    }
  }
  return null;
}

/**
 * The file to spawn for `bin`: a name with a path separator is used as given
 * (the user named that file), and a bare name is looked up on the PATH in
 * `env` with `findOnPath`, so it never comes from the current folder. Null
 * when it is not on PATH.
 */
export function resolveCommand(
  bin: string,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  isFile: (path: string) => boolean,
): string | null {
  if (bin.includes("/") || (platform === "win32" && bin.includes("\\"))) return bin;
  return findOnPath(bin, env, platform, isFile);
}

/** A regular file (following links) that, outside Windows, this process may execute. */
export function isExecutableFile(path: string): boolean {
  try {
    if (!statSync(path).isFile()) return false;
    if (process.platform !== "win32") accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Where cloudpin keeps its identity cache. */
export function cacheDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.CLOUDPIN_CACHE_DIR) return env.CLOUDPIN_CACHE_DIR;
  if (process.platform === "win32" && env.LOCALAPPDATA) return join(env.LOCALAPPDATA, "cloudpin", "cache");
  if (process.platform === "darwin") return join(home(env), "Library", "Caches", "cloudpin");
  return join(env.XDG_CACHE_HOME ?? join(home(env), ".cache"), "cloudpin");
}
