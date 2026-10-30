import { basename } from "node:path";
import { type ActiveEnvironment, ConfigError, findConfig, type FoundConfig, type Provider } from "./config.js";
import { envNameMatches } from "./cache.js";
import { dynamicTarget } from "./dynamic-args.js";
import { isReadOnly } from "./readonly.js";
import { type Exec, type ProviderDef, type Resolution, UNKNOWN_VALUE } from "./types.js";

export interface GuardRequest {
  /** The executable as typed or resolved, e.g. "az" or "C:\\...\\gh.exe". */
  bin: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  cwd: string;
  /** "agent" ignores CLOUDPIN_SKIP and CLOUDPIN_CONFIRM, so an agent cannot opt itself out. */
  mode: "shell" | "agent";
}

export interface GuardDeps {
  providers: ProviderDef[];
  exec: Exec;
  /** Finds the pin file and selects its environment (`env` carries CLOUDPIN_ENV). */
  findConfig: (cwd: string, env: NodeJS.ProcessEnv) => FoundConfig | null;
  /** Optional wrapper around `exec` per provider, e.g. the identity cache. */
  wrapExec?: (provider: ProviderDef, env: NodeJS.ProcessEnv, exec: Exec) => Exec;
  /**
   * Finds a command on `env`'s PATH. `status`, `doctor` and the MCP tools use it to call a CLI
   * not installed when none of its commands is found, since some providers never spawn it (#75).
   */
  onPath?: (bin: string, env: NodeJS.ProcessEnv) => string | null;
}

/** False only when `onPath` is given and finds none of the provider's commands. */
export function installed(provider: ProviderDef, env: NodeJS.ProcessEnv, onPath?: GuardDeps["onPath"]): boolean {
  return !onPath || provider.bins.some((bin) => onPath(bin, env) !== null);
}

export type Verdict =
  | {
      action: "allow";
      reason:
        | "not-guarded"
        | "no-config"
        | "not-pinned"
        | "exempt"
        | "match"
        | "skipped"
        | "confirmed"
        | "not-installed";
    }
  | {
      action: "block";
      /** True when the account could not be determined at all (a safety stop). */
      uncertain?: boolean;
      provider?: Provider;
      configPath?: string;
      environment?: ActiveEnvironment;
      problems: string[];
      fix?: string;
    }
  | {
      /** Right account, but a protected environment and a command that may change it. */
      action: "confirm";
      provider: Provider;
      configPath: string;
      environment: ActiveEnvironment;
    };

/** Normalises "C:\\x\\GH.EXE" or "/usr/bin/az" to "gh" / "az". */
export function commandName(bin: string): string {
  return basename(bin.replace(/\\/g, "/"))
    .toLowerCase()
    .replace(/\.(exe|cmd|bat|ps1)$/, "");
}

/**
 * What guard found on the way to its verdict, for `cloudpin explain`. guard
 * fills in what it gets to; the verdict never depends on it.
 */
export interface Trace {
  provider?: Provider;
  config?: FoundConfig;
  pin?: Record<string, string>;
  resolution?: Resolution;
  /** Set on a protected environment: whether the command counts as read-only. */
  readOnly?: boolean;
}

export async function guard(req: GuardRequest, deps: GuardDeps, trace: Trace = {}): Promise<Verdict> {
  const name = commandName(req.bin);
  const provider = deps.providers.find((p) => p.bins.includes(name));
  if (!provider) return { action: "allow", reason: "not-guarded" };
  trace.provider = provider.name;

  let config: FoundConfig | null;
  try {
    config = deps.findConfig(req.cwd, req.env);
  } catch (err) {
    // A broken pin file must not silently switch protection off. Exempt
    // commands (login, whoami, help, ...) never act on an account, and are
    // what a person needs to investigate, so they still run (#62).
    if (err instanceof ConfigError) {
      if (provider.isExempt(req.args, name)) return { action: "allow", reason: "exempt" };
      return { action: "block", provider: provider.name, problems: [`invalid config: ${err.message}`] };
    }
    throw err;
  }
  if (!config) return { action: "allow", reason: "no-config" };
  trace.config = config;

  const pin = config.pins[provider.name];
  if (!pin) return { action: "allow", reason: "not-pinned" };
  trace.pin = pin as Record<string, string>;
  if (provider.isExempt(req.args, name)) return { action: "allow", reason: "exempt" };
  if (req.mode === "shell" && req.env.CLOUDPIN_SKIP === "1") return { action: "allow", reason: "skipped" };

  const base = {
    action: "block" as const,
    provider: provider.name,
    configPath: config.path,
    ...(config.environment ? { environment: config.environment } : {}),
  };
  // Track whether the CLI itself is missing: then the command would fail on
  // its own, so there is no account to protect (DESIGN.md, edge cases).
  let cliMissing = false;
  const inner = deps.wrapExec ? deps.wrapExec(provider, req.env, deps.exec) : deps.exec;
  const exec: Exec = async (bin, args, env) => {
    const result = await inner(bin, args, env);
    if (result.notFound) cliMissing = true;
    return result;
  };
  // An argument only known when it runs (#160), before resolve, so no such value reaches a CLI.
  const dynamic = dynamicTarget(req.args, provider.targetFlags ?? []);
  if (dynamic) return { ...base, uncertain: true, problems: [dynamic.problem], fix: dynamic.fix };
  // A variable the line sets from something only known when it runs (#86): if it
  // decides this CLI's account, cloudpin can't tell which account will be used.
  const identityVars = provider.cacheInputs(req.env).env;
  const unknown = Object.keys(req.env).filter((k) => req.env[k] === UNKNOWN_VALUE && envNameMatches(identityVars, k));
  if (unknown.length > 0) {
    return {
      ...base,
      uncertain: true,
      problems: [
        `${unknown.join(", ")} ${unknown.length > 1 ? "are" : "is"} set by the command line from something cloudpin can't read in advance ($(...), backticks or another variable), so it can't tell which account this command would use`,
      ],
      fix: `set ${unknown[0]} to a literal value, or run the command yourself`,
    };
  }
  // Other unknown values don't decide the account; the CLI's identity check runs without them.
  const env = Object.fromEntries(Object.entries(req.env).filter(([, v]) => v !== UNKNOWN_VALUE));
  const res = await provider.resolve({ args: req.args, env, cwd: req.cwd, bin: name }, exec);
  trace.resolution = res;
  if (res.kind === "error" && cliMissing) return { action: "allow", reason: "not-installed" };
  switch (res.kind) {
    case "logged-out":
      return { ...base, problems: ["not logged in"], fix: res.hint };
    case "error":
      // Fail closed: if we cannot tell who the command will act as, we cannot
      // promise it is the right account.
      return { ...base, uncertain: true, problems: [res.message], fix: provider.statusCommand };
    case "identity": {
      // A pinned field the command's identity can't be read for (#165), e.g. gcloud's account with an access token.
      const unread = Object.entries(res.unknown ?? {}).filter(([field]) => (pin as Record<string, string>)[field]);
      if (unread.length > 0) {
        return { ...base, uncertain: true, problems: unread.map(([, why]) => why), fix: provider.statusCommand };
      }
      // The provider and its pin come from the same key, so the cast is safe.
      const p = provider as ProviderDef<typeof provider.name>;
      const problems = p.compare(pin as never, res.identity);
      if (problems.length > 0) return { ...base, problems, fix: p.switchHint(pin as never) };
      return protectedEnvironment(req, provider.name, config, trace);
    }
  }
}

/**
 * The account is right; on a protected environment a command that may change
 * something still needs the user's yes (issue #12). Only a human can give it
 * ahead of time, with CLOUDPIN_CONFIRM=<environment>.
 */
function protectedEnvironment(req: GuardRequest, provider: Provider, config: FoundConfig, trace: Trace): Verdict {
  const environment = config.environment;
  if (!environment?.protected) return { action: "allow", reason: "match" };
  trace.readOnly = isReadOnly(provider, req.args, req.env, config.readOnly ?? {}, commandName(req.bin));
  if (trace.readOnly) return { action: "allow", reason: "match" };
  if (req.mode === "shell" && req.env.CLOUDPIN_CONFIRM === environment.name) {
    return { action: "allow", reason: "confirmed" };
  }
  return { action: "confirm", provider, configPath: config.path, environment };
}

export const defaultFindConfig = findConfig;
