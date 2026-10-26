import type { ActiveEnvironment } from "./config.js";
import { commandName, guard, type GuardDeps, type Trace, type Verdict } from "./guard.js";
import { AGENTS, type AgentName } from "./hooks/agents.js";
import { home } from "./paths.js";
import { findInvocations, type Invocation } from "./shellwords.js";
import { envFor } from "./user-env.js";
import { describe } from "./status.js";
import type { Identity } from "./types.js";

export interface ExplainedCall {
  argv: string[];
  /** The folder the call runs in (after any `cd` earlier in the line). */
  cwd: string;
  /** Names of VAR=value assignments in front of the call; never their values. */
  envNames: string[];
  /** The provider that guards it, or null. */
  cli: string | null;
  pinFile?: string;
  environment?: ActiveEnvironment;
  pin?: Record<string, string>;
  /** The account the command would act as, and what decided it. */
  identity?: Identity;
  source?: string;
  /** Set on a protected environment. */
  readOnly?: boolean;
  verdict: "allow" | "block" | "ask";
  reason: string;
  problems?: string[];
  fix?: string;
}

export interface ExplainOptions {
  /** "agent" explains what an agent hook decides: CLOUDPIN_SKIP and CLOUDPIN_CONFIRM don't count. */
  mode: "shell" | "agent";
  cwd: string;
  env: NodeJS.ProcessEnv;
}

const AGENT_LABELS: Record<AgentName, string> = {
  claude: "Claude Code",
  codex: "Codex",
  copilot: "Copilot CLI",
  gemini: "Gemini CLI",
  antigravity: "Antigravity",
  cursor: "Cursor",
};

/** The agents whose hook can (or can't) ask the user, as a readable list. */
function agentsThat(canAsk: boolean): string {
  const names = (Object.keys(AGENTS) as AgentName[]).filter((a) => ("ask" in AGENTS[a]) === canAsk).map((a) => AGENT_LABELS[a]);
  return names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names.at(-1)}` : (names[0] ?? "none");
}

function reasonFor(verdict: Verdict, trace: Trace, call: Invocation, mode: ExplainOptions["mode"]): string {
  const env = trace.config?.environment;
  switch (verdict.action) {
    case "allow":
      switch (verdict.reason) {
        case "not-guarded":
          return "cloudpin doesn't guard this command";
        case "no-config":
          return "no .cloudpin.yml here or in any parent folder, so nothing is pinned";
        case "not-pinned":
          return `${trace.provider} is not pinned in ${trace.config?.path}`;
        case "exempt":
          return "login, logout, switch, whoami, help and version commands always run";
        case "skipped":
          return "CLOUDPIN_SKIP=1 skips the check (in a terminal only; agents can't use it)";
        case "not-installed":
          return `${commandName(call.bin)} is not installed here, so the command would fail on its own`;
        case "confirmed":
          return `the account matches, and CLOUDPIN_CONFIRM=${env?.name} confirms changes on this protected environment`;
        case "match":
          return trace.readOnly
            ? `the account matches the pin, and the command counts as read-only, so ${env?.name} (protected) doesn't ask`
            : "the account matches the pin";
      }
      break;
    case "block":
      return verdict.uncertain
        ? "cloudpin could not tell which account this command would use, so it stops it"
        : "the command would act on a different account than the one pinned";
    case "confirm":
      return mode === "agent"
        ? `the account matches, but ${verdict.environment.name} is protected and this command may change something: ${agentsThat(true)} ask you first; ${agentsThat(false)}, which can't ask, stop it`
        : `the account matches, but ${verdict.environment.name} is protected and this command may change something: cloudpin asks before running it`;
  }
  return "";
}

/**
 * What cloudpin would decide for a command, without running it: the argv of
 * one command, or a full shell line (every guarded call in it). Asks each CLI
 * who the command would act as, with no cache, exactly as the check does.
 */
export async function explain(command: string | string[], opts: ExplainOptions, deps: GuardDeps): Promise<ExplainedCall[]> {
  const bins = [...deps.providers.flatMap((p) => p.bins), "cloudpin"];
  const calls: Invocation[] =
    typeof command === "string"
      ? findInvocations(command, bins, opts.cwd)
      : command.length > 0
        ? [{ bin: command[0]!, args: command.slice(1), env: {} }]
        : [];
  const out: ExplainedCall[] = [];
  for (let call of calls) {
    if (commandName(call.bin) === "cloudpin") {
      // As the agent hook does: `cloudpin exec -- <cmd>` is checked as <cmd>.
      if (call.args[0] !== "exec") continue;
      const wrapped = call.args.slice(call.args[1] === "--" ? 2 : 1);
      if (wrapped.length === 0) continue;
      call = { ...call, bin: wrapped[0]!, args: wrapped.slice(1) };
    }
    const cwd = call.cwd ?? opts.cwd;
    const trace: Trace = {};
    const verdict = await guard({ bin: call.bin, args: call.args, env: envFor(opts.env, call, { agent: opts.mode === "agent" }), cwd, mode: opts.mode }, deps, trace);
    const res = trace.resolution;
    out.push({
      argv: [call.bin, ...call.args],
      cwd,
      envNames: Object.keys(call.env),
      cli: trace.provider ?? null,
      ...(trace.config ? { pinFile: trace.config.path } : {}),
      ...(trace.config?.environment ? { environment: trace.config.environment } : {}),
      ...(trace.pin ? { pin: trace.pin } : {}),
      ...(res?.kind === "identity" ? { identity: res.identity, source: res.source } : {}),
      ...(trace.readOnly !== undefined ? { readOnly: trace.readOnly } : {}),
      verdict: verdict.action === "confirm" ? "ask" : verdict.action,
      reason: reasonFor(verdict, trace, call, opts.mode),
      ...(verdict.action === "block" ? { problems: verdict.problems, ...(verdict.fix ? { fix: verdict.fix } : {}) } : {}),
    });
  }
  return out;
}

/** Each call as a short block of labelled lines. */
export function formatExplain(calls: ExplainedCall[], env: NodeJS.ProcessEnv): string[] {
  if (calls.length === 0) return ["There is no command here that cloudpin guards, so it would let the line run."];
  const tilde = (s: string) => s.split(home(env)).join("~");
  const row = (label: string, value: string) => `  ${`${label}:`.padEnd(13)}${tilde(value)}`;
  const lines: string[] = [];
  calls.forEach((c, i) => {
    if (i > 0) lines.push("");
    lines.push(`${calls.length > 1 ? `${i + 1}. ` : ""}${c.argv.join(" ")}`);
    lines.push(row("runs in", c.cwd));
    if (c.envNames.length) lines.push(row("sets", c.envNames.join(", ")));
    if (c.cli) {
      if (c.pinFile) lines.push(row("pin file", c.pinFile));
      if (c.environment) {
        const e = c.environment;
        lines.push(row("environment", `${e.name}${e.protected ? " (protected)" : ""}, chosen by ${e.source}`));
      }
      if (c.pin) lines.push(row("pinned", Object.values(c.pin).join(" / ")));
      if (c.identity) lines.push(row("would use", `${describe(c.identity)}  (from ${c.source})`));
      if (c.readOnly !== undefined) lines.push(row("read-only", c.readOnly ? "yes" : "no"));
    }
    lines.push(row("verdict", `${c.verdict.toUpperCase()}: ${c.reason}`));
    for (const p of c.problems ?? []) lines.push(row("problem", p));
    if (c.fix) lines.push(row("fix", c.fix));
  });
  return lines;
}
