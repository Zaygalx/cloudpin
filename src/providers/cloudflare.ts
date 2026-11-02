import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, resolve as resolvePath } from "node:path";
import { commandWords, flagValue, hasAnyFlag, hasBareFlag } from "../args.js";
import type { ProviderDef, Resolution } from "../types.js";
import { DOTENV_VARS, envFileArgs, wranglerDotenv } from "./wrangler-dotenv.js";
import { accountCacheFile, bindingFolder, commandProfile, envCredentials, profileCacheInputs, profileNote } from "./wrangler-profiles.js";

// Sources: github.com/cloudflare/workers-sdk (packages/workers-auth/src/core/factory.ts
// getActiveAccountId and getOrSelectAccountId; packages/workers-utils/src/config/
// config-helpers.ts findWranglerConfig; workers-utils/src/config-cache.ts;
// packages/wrangler/src/user/whoami.ts) and developers.cloudflare.com/workers/wrangler.
//
// The account a command uses: account_id in the Wrangler config file (the
// [env.NAME] one under --env / CLOUDFLARE_ENV, inheriting the top-level one),
// then CLOUDFLARE_ACCOUNT_ID (or CF_ACCOUNT_ID), then the project's account
// cache, then the only account the credentials can see; with several and none
// set, Wrangler asks on a terminal or fails. The config file beats the env var
// (a TODO in factory.ts says v5 may swap them). Every variable here may also
// come from the project's .env files (wrangler-dotenv.ts). An auth profile
// (#103, wrangler-profiles.ts) picks the login, and with it the account cache
// and the accounts the credentials can see.
//
// How the two meet (wrangler@4.151.3): Wrangler loads the .env files into
// process.env in a global yargs check, after the --cwd chdir (packages/wrangler/
// src/index.ts createCLIParser), and only then does the command handler pick
// the profile (core/register-yargs-command.ts createHandler, setProfile). The
// profile never reads the environment, and it holds only a login: an account
// from the config file or CLOUDFLARE_ACCOUNT_ID, from the shell or a .env file,
// still beats the profile's account cache (workers-auth core/factory.ts
// getActiveAccountId), and an API token or key from either replaces the
// profile's login (workers-auth credentials.ts getAPIToken, env first).

export const VALUE_FLAGS = new Set(["--config", "-c", "--cwd", "--env", "-e", "--env-file", "--profile"]);
const EXEMPT_COMMANDS = new Set(["login", "logout", "whoami", "auth", "docs", "types", "help", "completions"]);
// Local unless given --remote, since Wrangler v4 (developers.cloudflare.com,
// "Migrate from Wrangler v3 to v4").
const LOCAL_BY_DEFAULT = new Set(["kv key", "kv bulk", "r2 object", "d1 execute", "d1 migrations", "d1 export"]);
const CONFIG_NAMES = ["wrangler.json", "wrangler.jsonc", "wrangler.toml"];
const DEPLOY_REDIRECT = join(".wrangler", "deploy", "config.json");
const TOKEN_VARS = ["CLOUDFLARE_API_TOKEN", "CF_API_TOKEN", "CLOUDFLARE_API_KEY", "CF_API_KEY"];

export interface AccountIds {
  top?: string;
  envs?: Record<string, string>;
}

class Unreadable extends Error {}

const unquote = (key: string) => key.trim().replace(/^"(.*)"$|^'(.*)'$/, "$1$2");

/** A TOML string value: "..." or '...', with nothing but a comment after it. */
function tomlString(value: string): string {
  const m = /^"([^"\\]*)"\s*(#.*)?$/.exec(value) ?? /^'([^']*)'\s*(#.*)?$/.exec(value);
  if (!m) throw new Unreadable();
  return m[1]!;
}

/**
 * The account_id values in a wrangler.toml: top level and per [env.NAME]. A
 * small reader for the forms Wrangler's docs use (a key in a table, or a
 * dotted env.NAME.account_id at the top); any other line naming account_id
 * makes it give up, so cloudpin never guesses an account.
 */
export function accountIdsFromToml(text: string): AccountIds {
  const out: AccountIds = {};
  let table: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const header = /^\[\[?([^\]]+)\]\]?\s*(#.*)?$/.exec(line);
    if (header) {
      table = header[1]!.split(".").map(unquote);
      continue;
    }
    if (!line.includes("account_id")) continue;
    try {
      const eq = line.indexOf("=");
      if (eq === -1) throw new Unreadable();
      const key = line.slice(0, eq).split(".").map(unquote);
      const value = tomlString(line.slice(eq + 1).trim());
      const path = [...table, ...key];
      if (path.length === 1 && path[0] === "account_id") out.top = value;
      else if (path.length === 3 && path[0] === "env" && path[2] === "account_id") (out.envs ??= {})[path[1]!] = value;
      else throw new Unreadable();
    } catch {
      throw new Error(`cloudpin can't read this account_id line: ${line.slice(0, 80)}`);
    }
  }
  return out;
}

/** JSON with // and /* comments and trailing commas, as Wrangler accepts. */
function parseJsonc(text: string): unknown {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (c === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j;
    } else if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
    } else if (c === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      i = end === -1 ? text.length : end + 1;
    } else {
      out += c;
    }
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, "$1"));
}

export function accountIdsFromJsonc(text: string): AccountIds {
  const config = parseJsonc(text) as { account_id?: unknown; env?: Record<string, { account_id?: unknown }> };
  const out: AccountIds = {};
  if (typeof config.account_id === "string") out.top = config.account_id;
  for (const [name, section] of Object.entries(config.env ?? {})) {
    if (typeof section?.account_id === "string") (out.envs ??= {})[name] = section.account_id;
  }
  return out;
}

const read = (path: string): string | undefined => {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
};

function findUp(name: string, from: string, dir = false): string | undefined {
  for (let d = from; ; d = dirname(d)) {
    const candidate = join(d, name);
    try {
      if (dir ? statSync(candidate).isDirectory() : statSync(candidate).isFile()) return candidate;
    } catch {
      // not here
    }
    if (dirname(d) === d) return undefined;
  }
}

/** The config file's account for this command, or undefined if it sets none. */
function configAccount(path: string, envName: string | undefined): { account?: string; where: string } {
  const text = read(path) ?? "";
  const ids = path.endsWith(".toml") ? accountIdsFromToml(text) : accountIdsFromJsonc(text);
  const envAccount = envName === undefined ? undefined : ids.envs?.[envName];
  const where = `account_id in ${basename(path)}`;
  if (envAccount !== undefined) return { account: envAccount, where: `${where} [env.${envName}]` };
  return { account: ids.top, where };
}

/** The project-local account cache Wrangler writes after picking an account (config-cache.ts). */
function cachedAccount(start: string, env: NodeJS.ProcessEnv, file: string): { id: string; name?: string } | undefined {
  // Wrangler chooses one folder (workers-utils config-cache.ts getCacheFolder)
  // and reads only its file: WRANGLER_CACHE_DIR when non-empty, used as given
  // after the --cwd chdir; else <nearest node_modules>/.cache/wrangler if that
  // folder exists (empathic find.dir walks up from the working folder); else
  // .wrangler/cache. A missing or broken file there means no cached account.
  // The file is the active profile's (accountCacheFile).
  const modules = findUp("node_modules", start, true);
  const modulesCache = modules && join(modules, ".cache", "wrangler");
  const dir = env.WRANGLER_CACHE_DIR
    ? resolvePath(start, env.WRANGLER_CACHE_DIR)
    : modulesCache && existsSync(modulesCache)
      ? modulesCache
      : join(start, ".wrangler", "cache");
  const text = read(join(dir, file));
  if (text === undefined) return undefined;
  try {
    const account = (JSON.parse(text) as { account?: { id?: unknown; name?: unknown } }).account;
    if (typeof account?.id === "string") return { id: account.id, ...(typeof account.name === "string" ? { name: account.name } : {}) };
  } catch {
    // a broken cache is no cache, as in Wrangler (getConfigCache)
  }
  return undefined;
}

export const cloudflare: ProviderDef<"cloudflare"> = {
  name: "cloudflare",
  bins: ["wrangler", "wrangler2", "cf-wrangler"],
  statusCommand: "wrangler whoami",
  // The flags resolve reads (#160).
  targetFlags: ["--cwd", "--config", "-c", "--env", "-e", "--env-file", "--envFile", "--profile"],

  cacheInputs(env, platform) {
    // Only `wrangler whoami` is cached. Its OAuth logins live in the global
    // Wrangler config folder (~/.wrangler if it exists, else the XDG one):
    // config/<profile>.toml or .enc, and the folder bindings that pick one.
    // WRANGLER_API_ENVIRONMENT renames the default profile's file. XDG_CONFIG_HOME
    // and APPDATA move the folder, also when a .env file sets them. The XDG
    // folder differs per platform (wranglerConfigDirs), so it is `platform`'s (#136).
    return {
      // Every variable that decides the account, not only whoami's credentials:
      // guard blocks when a command line sets one to a value it can't know (#86,
      // #119). DOTENV_KEY picks a .env.vault over .env (wrangler-dotenv.ts). Names
      // whoami ignores can only make its cache miss, never hit wrongly.
      env: [...DOTENV_VARS, "DOTENV_KEY"],
      ...profileCacheInputs(env, platform),
    };
  },

  isExempt(args) {
    if (hasBareFlag(args, ["--help", "-h"])) return true;
    const words = commandWords(args, VALUE_FLAGS);
    // Wrangler prints its version only when no command is given (packages/wrangler/src/index.ts,
    // the default "*" command); every command accepts -v and ignores it (#146).
    if (words.length === 0) return hasBareFlag(args, ["--version", "-v"]);
    if (EXEMPT_COMMANDS.has(words[0] ?? "")) return true;
    if (words[0] === "dev") return !hasAnyFlag(args, ["--remote"]);
    if (words[0] === "deploy" && hasBareFlag(args, ["--dry-run"])) return true;
    if (LOCAL_BY_DEFAULT.has(words.slice(0, 2).join(" "))) return !hasAnyFlag(args, ["--remote", "--preview"]);
    return false;
  },

  async resolve({ args, env: commandEnv, cwd, platform }, exec): Promise<Resolution> {
    if (hasAnyFlag(args, ["--temporary"])) {
      return { kind: "error", message: "deploy --temporary uploads to a temporary preview account, not a pinned one" };
    }
    const start = resolvePath(cwd, flagValue(args, ["--cwd"]) ?? ".");
    // Wrangler adds what its .env files set to its own environment (#116); from
    // here on, env is that environment, and whoami below is asked with it.
    const dotenv = wranglerDotenv(args, commandEnv, start, platform);
    if ("error" in dotenv) return { kind: "error", message: dotenv.error };
    const { env } = dotenv;
    const inFile = (name: string) => (dotenv.from[name] ? ` in ${dotenv.from[name]}` : "");
    const given = flagValue(args, ["--config", "-c"]);
    const configPath = given !== undefined ? resolvePath(start, given) : CONFIG_NAMES.map((n) => findUp(n, start)).find(Boolean);
    const envName = flagValue(args, ["--env", "-e"]) ?? (env.CLOUDFLARE_ENV || undefined);
    // The folder whose binding picks the profile: the --config file's, else the command's.
    const folder = bindingFolder(start, platform);
    const lookup = given !== undefined ? dirname(resolvePath(folder, given)) : folder;
    let known: ReturnType<typeof commandProfile> | undefined;
    const profile = () => (known ??= commandProfile(args, env, lookup, platform));

    if (configPath !== undefined) {
      if (!existsSync(configPath)) return { kind: "error", message: `the Wrangler config file ${basename(configPath)} does not exist` };
      let fromConfig: { account?: string; where: string };
      try {
        fromConfig = configAccount(configPath, envName);
        // A build tool can redirect some commands to a generated config
        // (.wrangler/deploy/config.json); both must name the same account.
        const redirect = findUp(DEPLOY_REDIRECT, start);
        if (redirect !== undefined && given === undefined) {
          const target = (parseJsonc(read(redirect) ?? "") as { configPath?: unknown }).configPath;
          if (typeof target === "string") {
            const generated = configAccount(resolvePath(dirname(redirect), target), envName);
            if (generated.account !== undefined && generated.account.toLowerCase() !== fromConfig.account?.toLowerCase()) {
              return {
                kind: "error",
                message: `the generated deploy config (${DEPLOY_REDIRECT}) names account ${generated.account}, ${basename(configPath)} names ${fromConfig.account ?? "none"}`,
              };
            }
          }
        }
      } catch (err) {
        return { kind: "error", message: `${basename(configPath)}: ${(err as Error).message}` };
      }
      // A profile changes the login, never an account set here (factory.ts getActiveAccountId).
      if (fromConfig.account !== undefined) {
        return { kind: "identity", identity: { account: fromConfig.account }, source: fromConfig.where + profileNote(profile()) };
      }
    }

    // The first name present decides, even when empty: CF_ACCOUNT_ID is read only
    // when CLOUDFLARE_ACCOUNT_ID is absent (workers-utils environment-variables/
    // factory.ts getEnvironmentVariableFactory, `variableName in process.env`),
    // and an empty value counts as unset (workers-auth env-vars.ts
    // getCloudflareAccountIdFromEnv), so Wrangler goes on to its account cache.
    for (const name of ["CLOUDFLARE_ACCOUNT_ID", "CF_ACCOUNT_ID"]) {
      if (env[name] === undefined) continue;
      if (env[name]) return { kind: "identity", identity: { account: env[name]! }, source: name + inFile(name) + profileNote(profile()) };
      break;
    }
    const p = profile();
    if ("error" in p) return { kind: "error", message: p.error };
    const cacheName = accountCacheFile(p.name);
    const cached = cachedAccount(start, env, cacheName);
    if (cached) {
      return {
        kind: "identity",
        identity: { account: cached.id, ...(cached.name ? { label: cached.name } : {}) },
        source: `the account Wrangler cached for this project (${cacheName})${profileNote(p)}`,
      };
    }

    // whoami refuses --profile and answers for the profile of the folder it runs in
    // (commands.ts), so with profiles about it runs in the command's folder, and a
    // --profile that folder isn't bound to can't be asked about, unless credentials
    // in the environment (the command's own or its .env files') replace every
    // profile's login.
    const whoamiArgs = ["whoami", "--json"];
    if (p.inUse) {
      if (p.name !== p.folder && !envCredentials(env)) {
        const here = p.folder === "default" ? "the default profile" : `profile "${p.folder}"`;
        return {
          kind: "error",
          message: `cloudpin can't tell which account Wrangler profile "${p.name}" uses: \`wrangler whoami\` refuses --profile and reports this folder's login, ${here}; set account_id in the Wrangler config or CLOUDFLARE_ACCOUNT_ID, or run \`wrangler auth activate ${p.name}\` here`,
        };
      }
      // The command's own folder flags, so whoami picks the profile from the same
      // string: createHandler (register-yargs-command.ts) takes the folder from
      // dirname(path.resolve(--config)) without resolving links, and --config is
      // a global flag (index.ts globalFlags), so whoami accepts it.
      // --cwd also makes whoami read the command's .env files, as below.
      whoamiArgs.push("--cwd", folder);
      if (given !== undefined) whoamiArgs.push("--config", given);
    } else if (flagValue(args, ["--cwd"]) !== undefined) {
      // whoami runs in cloudpin's folder, where Wrangler tops its environment up
      // from that folder's .env; when the command has --cwd (so its Wrangler takes
      // the flag), whoami gets it too and reads the same folder. Without --cwd the
      // call is unchanged. --config doesn't move the .env folder.
      whoamiArgs.push("--cwd", start);
    }
    // With --env-file, Wrangler reads only those files and not the default .env
    // ones, for every command whoami included: workers-sdk wrangler@4.151.3,
    // packages/wrangler/src/index.ts lines 626-632 (a global flag) and 702-710
    // (a check run for every command, after the --cwd chdir), with no variable
    // that turns it off. A default .env must not lend whoami a token the command
    // won't have (#130), so whoami gets the same files, made absolute against the
    // command's folder, with or without profiles.
    for (const file of envFileArgs(args) ?? []) whoamiArgs.push("--env-file", resolvePath(start, file));
    // `wrangler whoami --json` exits non-zero when not authenticated (whoami.ts).
    const res = await exec("wrangler", whoamiArgs, env);
    let who: { loggedIn?: unknown; accounts?: { id?: unknown; name?: unknown }[] } | undefined;
    try {
      who = JSON.parse(res.stdout) as typeof who;
    } catch {
      who = undefined;
    }
    if (who?.loggedIn === false) return { kind: "logged-out", hint: p.name === "default" ? "wrangler login" : `wrangler auth create ${p.name}` };
    if (res.code !== 0 || !Array.isArray(who?.accounts)) {
      const reason = `${res.stderr}\n${res.stdout}`.split(/\r?\n/).map((l) => l.trim()).find(Boolean)?.slice(0, 300);
      const tokenVar = TOKEN_VARS.find((v) => env[v]);
      const note = tokenVar ? `; note: ${tokenVar} is set${inFile(tokenVar)} and is used instead of your wrangler login` : "";
      return { kind: "error", message: `${reason ?? `wrangler whoami failed (exit ${res.code})`}${note}` };
    }
    const accounts = who.accounts.filter((a): a is { id: string; name?: unknown } => typeof a.id === "string");
    if (accounts.length !== 1) {
      return {
        kind: "error",
        noTarget: true,
        message: `the credentials can see ${accounts.length} accounts and none is set for this command, so Wrangler would ask or fail; set account_id in the Wrangler config or CLOUDFLARE_ACCOUNT_ID`,
      };
    }
    const only = accounts[0]!;
    return {
      kind: "identity",
      identity: { account: only.id, ...(typeof only.name === "string" ? { label: only.name } : {}) },
      source: `the only account the credentials can see${profileNote(p)}`,
    };
  },

  compare(pin, identity) {
    // Account IDs are lowercase hex.
    if (identity.account?.toLowerCase() === pin.account.toLowerCase()) return [];
    return [`account: pinned "${pin.account}", the command would use "${identity.account}"`];
  },

  switchHint(pin) {
    // Not CLOUDFLARE_ACCOUNT_ID: an account_id in the config file wins over it.
    return `set account_id = "${pin.account}" in the Wrangler config (for the --env you use)`;
  },
};
