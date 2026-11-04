import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, sep } from "node:path";

// Wrangler auth profiles (#103), checked against github.com/cloudflare/workers-sdk at wrangler@4.151.3
// and developers.cloudflare.com/workers/wrangler/profiles/ (beta since wrangler 4.106.0):
// - which profile: --profile, else the nearest folder bound by `wrangler auth activate`, else "default"
//   (packages/workers-auth/src/profiles.ts resolve). No environment variable selects one.
// - the folder: dirname of --config when given, else process.cwd() after --cwd
//   (packages/wrangler/src/core/register-yargs-command.ts createHandler).
// - bindings: <config dir>/profiles/directory-bindings.json, { "<absolute folder>": "<profile>" }
//   (packages/workers-auth/src/core/profile-store.ts).
// - a profile holds only a login; CLOUDFLARE_API_TOKEN, or CLOUDFLARE_API_KEY with CLOUDFLARE_EMAIL, replace
//   it (packages/workers-auth/src/credentials.ts getAuthFromEnv). The account cache is per profile
//   (packages/workers-auth/src/core/factory.ts getAccountCacheFileName).
// - `wrangler whoami` refuses --profile and reports the folder's profile (packages/wrangler/src/user/commands.ts).

/** The profile a command uses, and what decided it. */
export interface WranglerProfile {
  name: string;
  /** "from --profile" or "bound to <folder>"; undefined for the default profile nobody chose. */
  why?: string;
  /** The profile the folder alone resolves to, which is what `wrangler whoami` run there reports. */
  folder: string;
  /** A --profile flag or any folder binding exists, so the profile may differ from cloudpin's own folder's. */
  inUse: boolean;
}

const BINDINGS = join("profiles", "directory-bindings.json");
// packages/workers-auth/src/profiles.ts validateProfileName; "default" is accepted before it.
const VALID_NAME = /^[a-zA-Z0-9_-]+$/;
const RESERVED = ["default", "staging"];

const isDir = (path: string): boolean => {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
};

/**
 * The home folder as Wrangler sees it: os.homedir(), which reads USERPROFILE on Windows and HOME elsewhere
 * (Node docs, os.homedir), so a HOME set by MSYS or Cygwin on Windows does not count.
 */
function wranglerHome(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string {
  return (platform === "win32" ? env.USERPROFILE : env.HOME) || homedir();
}

/** XDG config folder as Wrangler computes it (packages/workers-utils/src/xdg-app-paths.ts xdgConfig). */
function xdgConfig(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string {
  if (env.XDG_CONFIG_HOME) return env.XDG_CONFIG_HOME;
  const h = wranglerHome(env, platform);
  if (platform === "darwin") return join(h, "Library", "Preferences");
  if (platform === "win32") return join(env.APPDATA || join(h, "AppData", "Roaming"), "xdg.config");
  return join(h, ".config");
}

/**
 * Wrangler's global config folders: the legacy ~/.wrangler, used when it exists, and the XDG one
 * (packages/workers-utils/src/global-wrangler-config-path.ts getGlobalConfigPath).
 */
export function wranglerConfigDirs(env: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform) {
  const legacy = join(wranglerHome(env, platform), ".wrangler");
  const xdg = join(xdgConfig(env, platform), ".wrangler");
  return { active: isDir(legacy) ? legacy : xdg, all: [legacy, xdg] };
}

function validName(name: string): boolean {
  return name === "default" || (VALID_NAME.test(name) && !RESERVED.includes(name.toLowerCase()));
}

function nearest(dir: string, bindings: Record<string, string>, fold: (s: string) => string) {
  const target = fold(dir);
  const entries = Object.entries(bindings).sort(([a], [b]) => b.length - a.length);
  for (const [bound, profile] of entries) {
    const key = fold(bound);
    if (target === key || (target.startsWith(key) && target[key.length] === sep)) return { profile, dir: bound };
  }
  return undefined;
}

/**
 * The binding that covers `dir`: the longest bound folder equal to it or above it, compared as plain
 * strings like Wrangler does. Where the file system ignores letter case (Windows, macOS) the spelling
 * cloudpin was given may differ from Wrangler's process.cwd(), so a match that depends on case stops.
 */
export function profileForFolder(
  dir: string,
  bindings: Record<string, string>,
  platform: NodeJS.Platform,
): { profile: string; dir: string } | { error: string } | undefined {
  const exact = nearest(dir, bindings, (s) => s);
  if (platform === "win32" || platform === "darwin") {
    const loose = nearest(dir, bindings, (s) => s.toLowerCase());
    if (loose?.profile !== exact?.profile) {
      return {
        error: `${dir} matches the Wrangler profile binding for ${loose?.dir ?? exact?.dir} only when letter case is ignored, so cloudpin can't tell which login Wrangler uses here; check \`wrangler auth list\``,
      };
    }
  }
  return exact;
}

/**
 * The folder bindings. Wrangler reads a broken file as no bindings; cloudpin stops instead, since the
 * file may be mid-write or hand-edited and the login it would pick is then a guess.
 */
function readBindings(path: string): { bindings: Record<string, string> } | { error: string } {
  const unreadable = { error: `cloudpin can't read Wrangler's profile bindings (${BINDINGS}), so it can't tell which login this command uses` };
  if (!existsSync(path)) return { bindings: {} };
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return unreadable;
    if (!Object.values(parsed).every((v) => typeof v === "string")) return unreadable;
    return { bindings: parsed as Record<string, string> };
  } catch {
    return unreadable;
  }
}

/** Every --profile value on the command line ("--profile x" or "--profile=x"); null for a flag with no value. */
function profileFlags(args: string[]): (string | null)[] {
  const out: (string | null)[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--") break;
    if (arg === "--profile") out.push(i + 1 < args.length ? args[++i]! : null);
    else if (arg.startsWith("--profile=")) out.push(arg.slice("--profile=".length));
  }
  return out;
}

/** The folder Wrangler matches bindings against: process.cwd() is the real path outside Windows. */
export function bindingFolder(start: string, platform: NodeJS.Platform = process.platform): string {
  if (platform === "win32") return start;
  try {
    return realpathSync(start);
  } catch {
    return start;
  }
}

/** Which profile a command run with `args` in `folder` (see bindingFolder) uses. */
export function commandProfile(
  args: string[],
  env: NodeJS.ProcessEnv,
  folder: string,
  platform: NodeJS.Platform = process.platform,
): WranglerProfile | { error: string } {
  const flags = profileFlags(args);
  if (flags.length > 1) return { error: "--profile is given more than once, so cloudpin can't tell which Wrangler profile the command uses" };
  const flag = flags[0];
  if (flag === null || (flag !== undefined && !validName(flag))) {
    return { error: `Wrangler rejects the profile name ${JSON.stringify(flag ?? "")}, so cloudpin can't tell which login the command uses` };
  }
  const read = readBindings(join(wranglerConfigDirs(env, platform).active, BINDINGS));
  if ("error" in read) return read;
  const { bindings } = read;
  const match = profileForFolder(folder, bindings, platform);
  if (match && "error" in match) return match;
  if (match && !validName(match.profile)) {
    return { error: `Wrangler's profile binding for ${match.dir} names an invalid profile, so cloudpin can't tell which login this command uses` };
  }
  const folderProfile = match?.profile ?? "default";
  const inUse = flag !== undefined || Object.keys(bindings).length > 0;
  if (flag !== undefined) return { name: flag, why: "from --profile", folder: folderProfile, inUse };
  if (match) return { name: match.profile, why: `bound to ${match.dir}`, folder: folderProfile, inUse };
  return { name: "default", folder: folderProfile, inUse };
}

/** " (Wrangler profile "x", from --profile)", or "" for the default profile nobody chose. */
export function profileNote(profile: WranglerProfile | { error: string }): string {
  return "why" in profile && profile.why ? ` (Wrangler profile "${profile.name}", ${profile.why})` : "";
}

/** The account cache file for a profile (packages/workers-auth/src/core/factory.ts getAccountCacheFileName). */
export function accountCacheFile(profile: string): string {
  return profile === "default" ? "wrangler-account.json" : `wrangler-account-${profile}.json`;
}

/** A value as Wrangler reads it: the main name when present at all, else its legacy alias. */
const envValue = (env: NodeJS.ProcessEnv, name: string, alias: string) => (name in env ? env[name] : env[alias]);

/** Whether credentials in the environment replace every profile's login (credentials.ts getAuthFromEnv). */
export function envCredentials(env: NodeJS.ProcessEnv): boolean {
  const key = envValue(env, "CLOUDFLARE_API_KEY", "CF_API_KEY") && envValue(env, "CLOUDFLARE_EMAIL", "CF_EMAIL");
  return Boolean(key || envValue(env, "CLOUDFLARE_API_TOKEN", "CF_API_TOKEN"));
}

/** The files that decide which profile, and so which login, `wrangler whoami` uses. */
export function profileCacheInputs(env: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform) {
  const dirs = wranglerConfigDirs(env, platform).all;
  return { files: dirs.map((d) => join(d, BINDINGS)), dirs: dirs.map((d) => join(d, "config")) };
}
