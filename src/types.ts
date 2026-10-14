import type { CacheInputs } from "./cache.js";
import type { Pins, Provider } from "./config.js";

/** Runs a CLI and returns its output; injected so providers are testable. */
export type Exec = (
  bin: string,
  args: string[],
  env: NodeJS.ProcessEnv,
) => Promise<{
  code: number;
  stdout: string;
  stderr: string;
  /** The executable itself could not be found (not installed or not on PATH). */
  notFound?: boolean;
}>;

export interface CommandContext {
  /** Arguments after the CLI binary, e.g. ["deploy", "--prod"]. */
  args: string[];
  env: NodeJS.ProcessEnv;
  cwd: string;
  /** The command name, e.g. "kubectl" or "helm", for providers that guard several CLIs. */
  bin?: string;
}

/** The identity a command will act as, keyed like the provider's pin section. */
export type Identity = Record<string, string>;

export type Resolution =
  | { kind: "identity"; identity: Identity; source: string }
  | { kind: "logged-out"; hint: string }
  | {
      kind: "error";
      message: string;
      /**
       * Nothing in this folder says which project or account (no link, no config):
       * normal outside a project. guard still blocks a pinned CLI; status and
       * doctor only note it for an unpinned one.
       */
      noTarget?: boolean;
    };

export interface ProviderDef<P extends Provider = Provider> {
  name: P;
  /** Executable names this provider guards. */
  bins: string[];
  /** Commands always allowed: login, logout, switch, whoami, version, help. */
  isExempt(args: string[], bin?: string): boolean;
  /** Resolves who the command in `ctx` will act as. */
  resolve(ctx: CommandContext, exec: Exec): Promise<Resolution>;
  /** Compares pinned fields to the identity; returns one line per mismatch. */
  compare(pin: NonNullable<Pins[P]>, identity: Identity): string[];
  /** Command a human would run to switch to the pinned identity. */
  switchHint(pin: NonNullable<Pins[P]>): string;
  /** Command that shows the CLI's login state, suggested when resolving fails. */
  statusCommand: string;
  /** Environment variables and files that decide the identity (cache invalidation). */
  cacheInputs(env: NodeJS.ProcessEnv): CacheInputs;
}

/**
 * A variable's value when the line sets it from something only known when it
 * runs: `$(...)`, backticks, `$OTHER`, a PowerShell expression (#86).
 */
export const UNKNOWN_VALUE = "<cloudpin: set by the command line, unknown in advance>";
