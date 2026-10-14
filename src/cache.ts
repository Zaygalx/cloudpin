import { createHmac, randomBytes } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Exec } from "./types.js";

/** What decides a CLI's identity, so a change to any of it misses the cache. */
export interface CacheInputs {
  /** Environment variable names; a trailing "*" matches a prefix (e.g. "CLOUDSDK_*"). */
  env: string[];
  /** Files whose modification (or appearance) means the account may have changed. */
  files: string[];
  /** Folders whose files are each watched (one level), e.g. an SSO token cache. */
  dirs: string[];
}

export interface CacheOptions {
  cacheDir: string;
  now?: () => number;
  /** cloudpin's own environment, for CLOUDPIN_NO_CACHE. */
  env: NodeJS.ProcessEnv;
}

const TTL_MS = 5 * 60 * 1000;
const FILE = "identity-cache.json";

interface Entry {
  at: number;
  code: number;
  stdout: string;
  stderr: string;
}

function stamp(path: string): string {
  try {
    const s = statSync(path);
    return `${s.mtimeMs}:${s.size}`;
  } catch {
    return "missing";
  }
}

function dirStamp(path: string): string[] {
  try {
    return readdirSync(path)
      .sort()
      .map((name) => `${name}=${stamp(join(path, name))}`);
  } catch {
    return ["missing"];
  }
}

/** Whether `key` is one of `names`, where a trailing "*" matches a prefix (as in CacheInputs.env). */
export function envNameMatches(names: string[], key: string): boolean {
  return names.some((n) => (n.endsWith("*") ? key.startsWith(n.slice(0, -1)) : key === n));
}

function relevantEnv(names: string[], env: NodeJS.ProcessEnv): [string, string][] {
  return Object.entries(env)
    .filter(([key, value]) => value !== undefined && envNameMatches(names, key))
    .map(([key, value]) => [key, value as string] as [string, string])
    .sort(([a], [b]) => a.localeCompare(b));
}

/** A per-install random salt, so cache keys reveal nothing about the values hashed into them. */
function salt(dir: string): Buffer {
  const path = join(dir, "salt");
  try {
    return readFileSync(path);
  } catch {
    const value = randomBytes(32);
    writeFileSync(path, value, { mode: 0o600 });
    return value;
  }
}

function load(path: string): Record<string, Entry> {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { entries?: Record<string, Entry> };
    return parsed.entries ?? {};
  } catch {
    return {};
  }
}

/**
 * Wraps an Exec so identical identity lookups are answered from a short-lived
 * cache. Only successful results are stored, keyed by a salted HMAC of the
 * command, its arguments, the identity-relevant environment and the state of
 * the CLI's account files; neither tokens nor arguments are written in clear.
 */
export function cachedExec(exec: Exec, inputs: CacheInputs, options: CacheOptions): Exec {
  if (options.env.CLOUDPIN_NO_CACHE === "1") return exec;
  const now = options.now ?? Date.now;
  return async (bin, args, env) => {
    let key: string;
    let path: string;
    try {
      mkdirSync(options.cacheDir, { recursive: true, mode: 0o700 });
      path = join(options.cacheDir, FILE);
      const material = JSON.stringify({
        bin,
        args,
        env: relevantEnv(inputs.env, env),
        files: inputs.files.map((f) => [f, stamp(f)]),
        dirs: inputs.dirs.map((d) => [d, dirStamp(d)]),
      });
      key = createHmac("sha256", salt(options.cacheDir)).update(material).digest("hex");
      const hit = load(path)[key];
      if (hit && now() - hit.at <= TTL_MS && hit.at <= now()) {
        return { code: hit.code, stdout: hit.stdout, stderr: hit.stderr };
      }
    } catch {
      // A cache that cannot be read is no cache, never a failure.
      return exec(bin, args, env);
    }

    const result = await exec(bin, args, env);
    if (result.code === 0 && !result.notFound) {
      try {
        const entries = load(path);
        for (const [k, e] of Object.entries(entries)) if (now() - e.at > TTL_MS) delete entries[k];
        entries[key] = { at: now(), code: result.code, stdout: result.stdout, stderr: result.stderr };
        const tmp = `${path}.${process.pid}.tmp`;
        writeFileSync(tmp, JSON.stringify({ version: 1, entries }), { mode: 0o600 });
        renameSync(tmp, path);
      } catch {
        // Failing to store only costs speed next time.
      }
    }
    return result;
  };
}
