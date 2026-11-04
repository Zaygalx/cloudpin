import type { Invocation } from "./shellwords.js";

/**
 * Variables only the user may set. Set before starting the agent, they count; set by the agent inside its own command,
 * they would let it pick a laxer environment, confirm for the user or skip the check, so they are ignored there.
 */
export const USER_ONLY_VARS = ["CLOUDPIN_ENV", "CLOUDPIN_BRANCH", "CLOUDPIN_CONFIRM", "CLOUDPIN_SKIP", "CLOUDPIN_ENV_FILE"];

// What a call started by `env -i` still has (#162): PATH, so cloudpin can find the CLI to ask it who it acts as
// (the call itself searches the system's default path), and the variables Git Bash gives every Windows
// program back (observed with `env -i node`). HOME and USERPROFILE go: the CLI falls back as the call would.
const KEPT_BY_ENV_I = ["PATH", "SYSTEMROOT", "WINDIR"];

/**
 * The environment a call runs with: `base` (the environment the line starts
 * in, or almost nothing after `env -i`), then the line's plain assignments to
 * names already exported, its `unset`s, and its exported and prefix variables.
 * With `agent`, the line can't set or unset the user-only variables, in any
 * spelling on Windows (`platform`, default this process's), where guard reads
 * `cloudpin_env` as CLOUDPIN_ENV (#136).
 */
export function envFor(
  base: NodeJS.ProcessEnv,
  inv: Invocation,
  opts: { agent?: boolean; platform?: NodeJS.Platform } = {},
): NodeJS.ProcessEnv {
  const win = (opts.platform ?? process.platform) === "win32";
  const allowed = (name: string) => !(opts.agent && USER_ONLY_VARS.includes(win ? name.toUpperCase() : name));
  const kept = ([name]: [string, unknown]) => !allowed(name) || KEPT_BY_ENV_I.includes(name.toUpperCase());
  const out: NodeJS.ProcessEnv = inv.clearEnv ? Object.fromEntries(Object.entries(base).filter(kept)) : { ...base };
  for (const [name, value] of Object.entries(inv.ifExported ?? {})) if (name in base && allowed(name)) out[name] = value;
  for (const name of inv.unset ?? []) if (allowed(name)) delete out[name];
  for (const [name, value] of Object.entries(inv.env)) if (allowed(name)) out[name] = value;
  return out;
}
