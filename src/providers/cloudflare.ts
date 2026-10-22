import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, resolve as resolvePath } from "node:path";
import { commandWords, flagValue, hasAnyFlag } from "../args.js";
import type { ProviderDef, Resolution } from "../types.js";
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
// (a TODO in factory.ts says v5 may swap them). An auth profile (#103,
// wrangler-profiles.ts) picks the login, and with it the account cache and
// the accounts the credentials can see.

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
  const modules = findUp("node_modules", start, true);
  const dirs = [
    env.WRANGLER_CACHE_DIR,
    modules && join(modules, ".cache", "wrangler"),
    join(start, ".wrangler", "cache"),
  ].filter((d): d is string => Boolean(d));
  for (const dir of dirs) {
    const text = read(join(dir, file));
    if (text === undefined) continue;
    try {
      const account = (JSON.parse(text) as { account?: { id?: unknown; name?: unknown } }).account;
      if (typeof account?.id === "string") return { id: account.id, ...(typeof account.name === "string" ? { name: account.name } : {}) };
    } catch {
      // a broken cache is no cache, as in Wrangler
    }
    return undefined;
  }
  return undefined;
}

export const cloudflare: ProviderDef<"cloudflare"> = {
  name: "cloudflare",
  bins: ["wrangler", "wrangler2", "cf-wrangler"],
  statusCommand: "wrangler whoami",

  cacheInputs(env) {
    // Only `wrangler whoami` is cached. Its OAuth logins live in the global
    // Wrangler config folder (~/.wrangler if it exists, else the XDG one):
    // config/<profile>.toml or .enc, and the folder bindings that pick one.
    // WRANGLER_API_ENVIRONMENT renames the default profile's file.
    return {
      env: [...TOKEN_VARS, "CLOUDFLARE_EMAIL", "CF_EMAIL", "CLOUDFLARE_AUTH_USE_KEYRING", "WRANGLER_API_ENVIRONMENT"],
      ...profileCacheInputs(env),
    };
  },

  isExempt(args) {
    if (hasAnyFlag(args, ["--help", "-h", "--version", "-v"])) return true;
    const words = commandWords(args, VALUE_FLAGS);
    if (EXEMPT_COMMANDS.has(words[0] ?? "")) return true;
    if (words[0] === "dev") return !hasAnyFlag(args, ["--remote"]);
    if (words[0] === "deploy" && hasAnyFlag(args, ["--dry-run"])) return true;
    if (LOCAL_BY_DEFAULT.has(words.slice(0, 2).join(" "))) return !hasAnyFlag(args, ["--remote", "--preview"]);
    return false;
  },

  async resolve({ args, env, cwd }, exec): Promise<Resolution> {
    if (hasAnyFlag(args, ["--temporary"])) {
      return { kind: "error", message: "deploy --temporary uploads to a temporary preview account, not a pinned one" };
    }
    const start = resolvePath(cwd, flagValue(args, ["--cwd"]) ?? ".");
    const given = flagValue(args, ["--config", "-c"]);
    const configPath = given !== undefined ? resolvePath(start, given) : CONFIG_NAMES.map((n) => findUp(n, start)).find(Boolean);
    const envName = flagValue(args, ["--env", "-e"]) ?? (env.CLOUDFLARE_ENV || undefined);
    // The folder whose binding picks the profile: the --config file's, else the command's.
    const folder = bindingFolder(start);
    const lookup = given !== undefined ? dirname(resolvePath(folder, given)) : folder;
    let known: ReturnType<typeof commandProfile> | undefined;
    const profile = () => (known ??= commandProfile(args, env, lookup));

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

    for (const name of ["CLOUDFLARE_ACCOUNT_ID", "CF_ACCOUNT_ID"]) {
      if (env[name]) return { kind: "identity", identity: { account: env[name]! }, source: name + profileNote(profile()) };
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
    // in the environment replace every profile's login.
    const whoamiArgs = ["whoami", "--json"];
    if (p.inUse) {
      if (p.name !== p.folder && !envCredentials(env)) {
        const here = p.folder === "default" ? "the default profile" : `profile "${p.folder}"`;
        return {
          kind: "error",
          message: `cloudpin can't tell which account Wrangler profile "${p.name}" uses: \`wrangler whoami\` refuses --profile and reports this folder's login, ${here}; set account_id in the Wrangler config or CLOUDFLARE_ACCOUNT_ID, or run \`wrangler auth activate ${p.name}\` here`,
        };
      }
      whoamiArgs.push("--cwd", lookup);
    }
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
      const note = tokenVar ? `; note: ${tokenVar} is set and is used instead of your wrangler login` : "";
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
