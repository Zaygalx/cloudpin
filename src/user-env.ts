import type { Invocation } from "./shellwords.js";

/**
 * Variables only the user may set. Set before starting the agent, they count; set by the agent inside its own command,
 * they would let it pick a laxer environment, confirm for the user or skip the check, so they are ignored there.
 */
export const USER_ONLY_VARS = ["CLOUDPIN_ENV", "CLOUDPIN_BRANCH", "CLOUDPIN_CONFIRM", "CLOUDPIN_SKIP"];

/**
 * The environment a call runs with: `base` (the environment the line starts
 * in), then the line's plain assignments to names already exported, its
 * `unset`s, and its exported and prefix variables. With `agent`, the line can't
 * set or unset the user-only variables.
 */
export function envFor(base: NodeJS.ProcessEnv, inv: Invocation, opts: { agent?: boolean } = {}): NodeJS.ProcessEnv {
  const allowed = (name: string) => !(opts.agent && USER_ONLY_VARS.includes(name));
  const out: NodeJS.ProcessEnv = { ...base };
  for (const [name, value] of Object.entries(inv.ifExported ?? {})) if (name in base && allowed(name)) out[name] = value;
  for (const name of inv.unset ?? []) if (allowed(name)) delete out[name];
  for (const [name, value] of Object.entries(inv.env)) if (allowed(name)) out[name] = value;
  return out;
}
