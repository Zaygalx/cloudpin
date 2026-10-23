import { existsSync, readFileSync } from "node:fs";
import { relative, resolve as resolvePath } from "node:path";
import { flagValue } from "../args.js";

// Wrangler loads .env files into its own process.env before every command
// (#116). Sources, github.com/cloudflare/workers-sdk at wrangler@4.151.3:
// packages/wrangler/src/index.ts (createCLIParser: a global check, run after the
// --cwd chdir, loads args["env-file"] ?? getDefaultEnvFiles(args.env), each
// resolved against the working folder) and packages/wrangler/src/config/
// dot-env.ts (loadDotEnv: dotenv 16.3.1 parses each file, later files override
// earlier ones, then dotenv-expand 12.0.2 merges them under process.env, where
// a non-empty variable already set wins and file values have ${VAR} expanded;
// on Windows names are case-insensitive). This behaviour (the four default
// files and --env-file) dates from Wrangler 4.27.0 (workers-sdk PR #9914);
// older versions read .env, or .env.<env> instead of it with --env.
// .dev.vars is separate: Worker bindings for `wrangler dev`, never Wrangler's
// own environment.

/**
 * The variables that decide which account a command uses or which credentials
 * it sends: the account, the --env section, the account cache folder, and every
 * variable cloudflare.cacheInputs keys whoami on (a test keeps them in step).
 */
export const DOTENV_VARS = [
  "CLOUDFLARE_ACCOUNT_ID",
  "CF_ACCOUNT_ID",
  "CLOUDFLARE_ENV",
  "WRANGLER_CACHE_DIR",
  "CLOUDFLARE_API_TOKEN",
  "CF_API_TOKEN",
  "CLOUDFLARE_API_KEY",
  "CF_API_KEY",
  "CLOUDFLARE_EMAIL",
  "CF_EMAIL",
  "CLOUDFLARE_AUTH_USE_KEYRING",
];

// --- Begin code from dotenv 16.3.1 -------------------------------------------
// The LINE regex and parse() below are copied from dotenv 16.3.1,
// https://github.com/motdotla/dotenv/blob/v16.3.1/lib/main.js (the version
// Wrangler 4.151.3 bundles), changed only by type annotations and formatting,
// so cloudpin reads every .env line exactly as Wrangler does. dotenv's license:
//
// Copyright (c) 2015, Scott Motte
// All rights reserved.
//
// Redistribution and use in source and binary forms, with or without
// modification, are permitted provided that the following conditions are met:
//
// * Redistributions of source code must retain the above copyright notice, this
//   list of conditions and the following disclaimer.
//
// * Redistributions in binary form must reproduce the above copyright notice,
//   this list of conditions and the following disclaimer in the documentation
//   and/or other materials provided with the distribution.
//
// THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
// AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
// IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
// DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
// FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
// DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
// SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
// CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
// OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
// OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.

const LINE = /(?:^|^)\s*(?:export\s+)?([\w.-]+)(?:\s*=\s*?|:\s+?)(\s*'(?:\\'|[^'])*'|\s*"(?:\\"|[^"])*"|\s*`(?:\\`|[^`])*`|[^#\r\n]+)?\s*(?:#.*)?(?:$|$)/mg;

// Parse src into an Object
function parse(src: string): Record<string, string> {
  const obj: Record<string, string> = {};

  // Convert buffer to string
  let lines = src.toString();

  // Convert line breaks to same format
  lines = lines.replace(/\r\n?/mg, "\n");

  let match: RegExpExecArray | null;
  while ((match = LINE.exec(lines)) != null) {
    const key = match[1]!;

    // Default undefined or null to empty string
    let value = match[2] || "";

    // Remove whitespace
    value = value.trim();

    // Check if double quoted
    const maybeQuote = value[0];

    // Remove surrounding quotes
    value = value.replace(/^(['"`])([\s\S]*)\1$/mg, "$2");

    // Expand newlines if double quoted
    if (maybeQuote === '"') {
      value = value.replace(/\\n/g, "\n");
      value = value.replace(/\\r/g, "\r");
    }

    // Add to object
    obj[key] = value;
  }

  return obj;
}
// --- End code from dotenv 16.3.1 ---------------------------------------------

/** The variables a .env text sets, read by dotenv 16.3.1's own parse(); it never fails. */
export function parseDotenv(text: string): Map<string, string> {
  return new Map(Object.entries(parse(text)));
}

/**
 * The files given with --env-file (or --envFile, its camel-case alias), or
 * undefined. yargs-parser 21 arrays are greedy: each word after the flag, up to
 * the next one starting with "-", is another file, also after --env-file=X.
 */
export function envFileArgs(args: string[]): string[] | undefined {
  let files: string[] | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--") break;
    const name = ["--env-file", "--envFile"].find((n) => arg === n || arg.startsWith(`${n}=`));
    if (name === undefined) continue;
    files ??= [];
    if (arg !== name) files.push(arg.slice(name.length + 1));
    while (i + 1 < args.length && !/^-(?!\d+(\.\d+)?$|\.\d+$)/.test(args[i + 1]!)) files.push(args[++i]!);
  }
  return files;
}

/** Wrangler's getDefaultEnvFiles: .env and .env.local, then .env.<env> and .env.<env>.local with --env. */
function defaultEnvFiles(envName: string | undefined): string[] {
  const files = [".env", ".env.local"];
  if (envName !== undefined) files.push(`.env.${envName}`, `.env.${envName}.local`);
  return files;
}

function readEnvFile(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    // dotenv's configDotenv returns any read error (missing, a folder, no
    // permission) and Wrangler's loadDotEnv only debug-logs it: the file is skipped.
    return undefined;
  }
}

export interface WranglerEnv {
  /** The command's environment plus what the .env files add for DOTENV_VARS; the same object when they add nothing. */
  env: NodeJS.ProcessEnv;
  /** For each variable a file set, that file (relative to the folder). */
  from: Record<string, string>;
}

/**
 * The environment Wrangler would give itself for this command: `env` (the
 * command's own) with the DOTENV_VARS the .env files set, read from `start`
 * (the folder after --cwd; --config doesn't move it). Returns an error, naming
 * the file and variable but never a value, when cloudpin can't work out a value
 * Wrangler would use (a $ expansion, or a .vault file DOTENV_KEY would decrypt).
 */
export function wranglerDotenv(
  args: string[],
  env: NodeJS.ProcessEnv,
  start: string,
  platform: NodeJS.Platform = process.platform,
): WranglerEnv | { error: string } {
  const fold = (name: string) => (platform === "win32" ? name.toUpperCase() : name);
  const canonical = new Map(DOTENV_VARS.map((n) => [fold(n), n]));
  const names = envFileArgs(args) ?? defaultEnvFiles(flagValue(args, ["--env", "-e"]));

  // The merged file values, later files winning, keyed by canonical name.
  const merged = new Map<string, { value: string; file: string }>();
  // dotenv 16.3.1 config() (which Wrangler calls) decrypts <file>.vault instead
  // of the file when DOTENV_KEY is non-empty and the vault exists (lib/main.js
  // _dotenvKey, _vaultPath); cloudpin can't decrypt it, so it can't tell.
  const keyName = Object.keys(env).find((k) => fold(k) === fold("DOTENV_KEY"));
  const dotenvKey = keyName === undefined ? undefined : env[keyName];
  for (const name of names) {
    const path = resolvePath(start, name);
    const file = relative(start, path) || name;
    const vault = path.endsWith(".vault") ? path : `${path}.vault`;
    if (dotenvKey && existsSync(vault)) {
      const vaultFile = relative(start, vault) || vault;
      return {
        error: `DOTENV_KEY is set and ${vaultFile} exists, so Wrangler decrypts that file instead of ${file}, which cloudpin can't do: unset DOTENV_KEY for this command, or remove ${vaultFile}`,
      };
    }
    const text = readEnvFile(path);
    if (text === undefined) continue;
    for (const [key, value] of parseDotenv(text)) {
      const name = canonical.get(fold(key));
      if (name !== undefined) merged.set(name, { value, file });
    }
  }
  if (merged.size === 0) return { env, from: {} };

  let out: NodeJS.ProcessEnv | undefined;
  const from: Record<string, string> = {};
  for (const [name, { value, file }] of merged) {
    const keys = Object.keys(env).filter((k) => fold(k) === fold(name));
    const current = keys.length > 0 ? env[keys[keys.length - 1]!] : undefined;
    // dotenv-expand 12.0.2 expand(): a non-empty variable already set wins.
    if (current && current !== value) continue;
    if (value.includes("$")) {
      return {
        error: `${name} in ${file} refers to another variable ($), which cloudpin doesn't expand, so it can't tell the value Wrangler would use: write the value itself in ${file}, or set ${name} in the environment`,
      };
    }
    out ??= { ...env };
    for (const k of keys) delete out[k];
    out[name] = value;
    from[name] = file;
  }
  return { env: out ?? env, from };
}
