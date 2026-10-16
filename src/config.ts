import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { parse, YAMLParseError } from "yaml";
import { chooseEnvironment, currentBranch, findGitDir } from "./git.js";

export const CONFIG_FILE = ".cloudpin.yml";

export interface Pins {
  azure?: { subscription: string; tenant?: string };
  aws?: { account: string };
  gcloud?: { account?: string; project?: string };
  vercel?: { team: string };
  github?: { user: string; host?: string };
  kubernetes?: { server: string; namespace?: string };
  supabase?: { project: string; org?: string };
  cloudflare?: { account: string };
}

export type Provider = keyof Pins;

/** Extra read-only commands per provider, each split into its leading words. */
export type ReadOnlyRules = Partial<Record<Provider, string[][]>>;

export interface Environment {
  name: string;
  protected: boolean;
  pins: Pins;
}

export interface ProjectConfig {
  /** Null for the flat format (provider sections at the top level). */
  environments: Environment[] | null;
  /** The flat format's pins; empty when the file defines environments. */
  pins: Pins;
  branches: { pattern: string; environment: string }[];
  readOnly: ReadOnlyRules;
}

export class ConfigError extends Error {
  override name = "ConfigError";
}

const VERSION = (createRequire(import.meta.url)("../package.json") as { version: string }).version;

/**
 * From 1.0 the format only grows: later versions add sections and keys. An
 * older cloudpin still refuses a name it doesn't know (ignoring it would let a
 * typo switch protection off), but says how to get the version that knows it (#67).
 */
function unknownName(message: string): ConfigError {
  return new ConfigError(
    `${message}. If this file was written for a newer cloudpin than this one (${VERSION}), update it: npm install --global cloudpin@latest`,
  );
}

// Allowed keys per section; the first `required` entries must be present.
const SCHEMA: Record<Provider, { keys: string[]; required: string[] }> = {
  azure: { keys: ["subscription", "tenant"], required: ["subscription"] },
  aws: { keys: ["account"], required: ["account"] },
  gcloud: { keys: ["account", "project"], required: [] },
  vercel: { keys: ["team"], required: ["team"] },
  github: { keys: ["user", "host"], required: ["user"] },
  kubernetes: { keys: ["server", "namespace"], required: ["server"] },
  supabase: { keys: ["project", "org"], required: ["project"] },
  cloudflare: { keys: ["account"], required: ["account"] },
};

export const PROVIDERS = Object.keys(SCHEMA) as Provider[];

// Top-level keys that are not provider sections.
const PROJECT_KEYS = ["environments", "branches", "read_only"];
const ENV_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

export function isEnvironmentName(name: string): boolean {
  return ENV_NAME.test(name);
}

function isProvider(name: string): name is Provider {
  return Object.hasOwn(SCHEMA, name);
}

function isMapping(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Parses provider sections; `skip` names keys that belong to the caller. */
function parsePins(doc: Record<string, unknown>, skip: string[]): Pins {
  const pins: Record<string, Record<string, string>> = {};
  for (const [section, body] of Object.entries(doc)) {
    if (skip.includes(section)) continue;
    if (!isProvider(section)) {
      throw unknownName(`unknown section "${section}" (expected one of: ${[...PROVIDERS, ...PROJECT_KEYS].join(", ")})`);
    }
    const { keys, required } = SCHEMA[section];
    const fields: Record<string, string> = {};
    if (body !== "" && body !== null) {
      if (!isMapping(body)) throw new ConfigError(`${section}: expected a mapping of keys`);
      for (const [key, value] of Object.entries(body)) {
        if (!keys.includes(key)) {
          throw unknownName(`${section}: unknown key "${key}" (expected: ${keys.join(", ")})`);
        }
        if (typeof value !== "string" || value.trim() === "") {
          throw new ConfigError(`${section}: "${key}" must be a non-empty value`);
        }
        fields[key] = value.trim();
      }
    }
    for (const key of required) {
      if (!(key in fields)) throw new ConfigError(`${section}: "${key}" is required`);
    }
    if (section === "gcloud" && Object.keys(fields).length === 0) {
      throw new ConfigError('gcloud: set "account", "project" or both');
    }
    pins[section] = fields;
  }
  return pins as Pins;
}

function parseEnvironments(body: unknown): Environment[] {
  if (!isMapping(body) || Object.keys(body).length === 0) {
    throw new ConfigError("environments: define at least one environment");
  }
  return Object.entries(body).map(([name, envBody]) => {
    if (!ENV_NAME.test(name)) {
      throw new ConfigError(`environments: invalid environment name "${name}" (use letters, digits, "-", "_" or ".")`);
    }
    const section = envBody === "" || envBody === null ? {} : envBody;
    if (!isMapping(section)) throw new ConfigError(`environments.${name}: expected a mapping of provider sections`);
    // The failsafe schema reads `true` as the string "true".
    const flag = section.protected;
    if (flag !== undefined && flag !== "true" && flag !== "false") {
      throw new ConfigError(`environments.${name}: "protected" must be true or false`);
    }
    try {
      return { name, protected: flag === "true", pins: parsePins(section, ["protected"]) };
    } catch (err) {
      if (err instanceof ConfigError) throw new ConfigError(`environments.${name}: ${err.message}`);
      throw err;
    }
  });
}

function parseBranches(body: unknown, environments: Environment[] | null): ProjectConfig["branches"] {
  if (body === undefined) return [];
  if (!environments) throw new ConfigError('"branches" needs "environments" to map branches to');
  if (!isMapping(body)) throw new ConfigError("branches: expected a mapping of branch to environment");
  return Object.entries(body).map(([pattern, environment]) => {
    if (typeof environment !== "string" || !environments.some((e) => e.name === environment)) {
      throw new ConfigError(`branches: "${pattern}" maps to unknown environment "${String(environment)}"`);
    }
    return { pattern, environment };
  });
}

function parseReadOnly(body: unknown): ReadOnlyRules {
  if (body === undefined) return {};
  if (!isMapping(body)) throw new ConfigError("read_only: expected a mapping of provider to commands");
  const rules: ReadOnlyRules = {};
  for (const [provider, list] of Object.entries(body)) {
    if (!isProvider(provider)) {
      throw unknownName(`read_only: unknown provider "${provider}" (expected one of: ${PROVIDERS.join(", ")})`);
    }
    if (!Array.isArray(list)) throw new ConfigError(`read_only.${provider}: expected a list of commands`);
    rules[provider] = list.map((entry) => {
      const words = typeof entry === "string" ? entry.trim().split(/\s+/).filter(Boolean) : [];
      if (words.length === 0) throw new ConfigError(`read_only.${provider}: entries must be non-empty commands`);
      return words;
    });
  }
  return rules;
}

export function parseConfig(text: string): ProjectConfig {
  let doc: unknown;
  try {
    // The failsafe schema reads every scalar as a string, so an unquoted AWS
    // account ID such as 012345678901 keeps its leading zero.
    doc = parse(text, { schema: "failsafe" });
  } catch (err) {
    if (err instanceof YAMLParseError) throw new ConfigError(err.message);
    throw err;
  }
  if (doc === null || doc === undefined || doc === "") return { environments: null, pins: {}, branches: [], readOnly: {} };
  if (!isMapping(doc)) throw new ConfigError("expected a mapping of provider sections");

  let environments: Environment[] | null = null;
  let pins: Pins = {};
  if ("environments" in doc) {
    if (Object.keys(doc).some(isProvider)) {
      throw new ConfigError('use either provider sections or "environments" at the top level, not both');
    }
    environments = parseEnvironments(doc.environments);
  } else {
    pins = parsePins(doc, PROJECT_KEYS);
  }
  return {
    environments,
    pins,
    branches: parseBranches(doc.branches, environments),
    readOnly: parseReadOnly(doc.read_only),
  };
}

export interface ActiveEnvironment {
  name: string;
  protected: boolean;
  /** Why this environment applies, e.g. `branch "main"`. */
  source: string;
}

export interface Selection {
  env: NodeJS.ProcessEnv;
  /** The environment remembered by `cloudpin use`. */
  chosen?: string | null;
  /** The checked-out git branch, null when detached or outside a repository. */
  branch?: string | null;
}

function globToRegExp(pattern: string): RegExp {
  const body = pattern.split("*").map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*");
  return new RegExp(`^${body}$`);
}

/**
 * Picks the environment that applies (owner decision, issue #12): CLOUDPIN_ENV,
 * then `cloudpin use`, then the branch mapping (an exact name before patterns)
 * for CLOUDPIN_BRANCH if set (CI on a detached checkout, #10), else the
 * checked-out branch, then the first environment listed. Null for the flat
 * format. An unknown name is an error, never a guess.
 */
export function selectEnvironment(
  project: ProjectConfig,
  sel: Selection,
): (ActiveEnvironment & { pins: Pins }) | null {
  const envs = project.environments;
  if (!envs) return null;
  const pick = (name: string, source: string, origin: string) => {
    const found = envs.find((e) => e.name === name);
    if (!found) {
      throw new ConfigError(
        `${origin} names unknown environment "${name}" (defined: ${envs.map((e) => e.name).join(", ")})`,
      );
    }
    return { name: found.name, protected: found.protected, source, pins: found.pins };
  };
  if (sel.env.CLOUDPIN_ENV) return pick(sel.env.CLOUDPIN_ENV, "CLOUDPIN_ENV", "CLOUDPIN_ENV");
  if (sel.chosen) return pick(sel.chosen, "cloudpin use", "the environment chosen with `cloudpin use`");
  const fromVar = Boolean(sel.env.CLOUDPIN_BRANCH);
  const branch = sel.env.CLOUDPIN_BRANCH || sel.branch;
  if (branch) {
    const rule =
      project.branches.find((b) => !b.pattern.includes("*") && b.pattern === branch) ??
      project.branches.find((b) => b.pattern.includes("*") && globToRegExp(b.pattern).test(branch));
    if (rule) return pick(rule.environment, `branch "${branch}"${fromVar ? " (CLOUDPIN_BRANCH)" : ""}`, "branches");
  }
  const first = envs[0]!;
  return { name: first.name, protected: first.protected, source: "first listed", pins: first.pins };
}

export interface FoundConfig {
  path: string;
  /** The pins that apply here: the flat file's, or the selected environment's. */
  pins: Pins;
  /** Set when the file defines environments. */
  environment?: ActiveEnvironment;
  readOnly?: ReadOnlyRules;
}

/**
 * Finds the nearest .cloudpin.yml at or above `startDir` and, if it defines
 * environments, selects one using `env` and the git repository at `startDir`.
 */
export function findConfig(startDir: string, env: NodeJS.ProcessEnv = process.env): FoundConfig | null {
  const path = locateConfig(startDir);
  if (!path) return null;
  try {
    const project = parseConfig(readFileSync(path, "utf8"));
    if (!project.environments) return { path, pins: project.pins, readOnly: project.readOnly };
    const gitDir = findGitDir(startDir);
    const selected = selectEnvironment(project, {
      env,
      chosen: gitDir ? chooseEnvironment(gitDir) : null,
      branch: gitDir ? currentBranch(gitDir) : null,
    })!;
    const { pins, ...environment } = selected;
    return { path, pins, environment, readOnly: project.readOnly };
  } catch (err) {
    if (err instanceof ConfigError) {
      throw new ConfigError(`${path}: ${err.message}`);
    }
    throw err;
  }
}

/** The path of the nearest .cloudpin.yml at or above `startDir`, without reading it. */
export function locateConfig(startDir: string): string | null {
  let dir = startDir;
  for (;;) {
    const path = join(dir, CONFIG_FILE);
    if (existsSync(path)) return path;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}
