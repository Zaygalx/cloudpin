import { resolve } from "node:path";
import { formatBlock, formatConfirm } from "../format.js";
import { commandName, guard, type GuardDeps } from "../guard.js";
import { findInvocations } from "../shellwords.js";

/** How one agent hands a shell command to its hook and reads the answer. */
export interface AgentHook {
  /** Extracts the shell command and its folder, or null if the call is not a shell command. */
  parse(input: unknown): { command: string; cwd: string } | null;
  /** Output that blocks the command with `reason`. */
  deny(reason: string): string;
  /**
   * Output that makes the agent ask the user, showing `reason`. Absent when the
   * agent's hooks have no working "ask": then confirmations are denials.
   */
  ask?(reason: string): string;
  /** Output when cloudpin has no objection; must not weaken the agent's own approvals. */
  noObjection: string;
}

type Json = Record<string, unknown>;
const obj = (v: unknown): Json => (v && typeof v === "object" ? (v as Json) : {});
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

// Claude Code (code.claude.com/docs/en/hooks) and Codex (learn.chatgpt.com/docs/hooks)
// share the PreToolUse protocol: tool_input.command in, hookSpecificOutput out.
function preToolUse(tools: string[], canAsk: boolean): AgentHook {
  const decide = (permissionDecision: "deny" | "ask", reason: string) =>
    JSON.stringify({
      hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision, permissionDecisionReason: reason },
    });
  return {
    parse(input) {
      const i = obj(input);
      const command = str(obj(i.tool_input).command);
      if (!tools.includes(str(i.tool_name) ?? "") || command === undefined) return null;
      return { command, cwd: str(i.cwd) ?? process.cwd() };
    },
    deny: (reason) => decide("deny", reason),
    ...(canAsk ? { ask: (reason: string) => decide("ask", reason) } : {}),
    // Printing nothing leaves the agent's own permission rules in charge;
    // answering "allow" would bypass them.
    noObjection: "",
  };
}

export const AGENTS = {
  // Claude Code: "ask" prompts the user, showing the reason.
  claude: preToolUse(["Bash", "PowerShell"], true),
  // Codex parses "ask" but does not support it yet, and an unsupported answer
  // lets the tool call continue (learn.chatgpt.com/docs/hooks), so it denies.
  codex: preToolUse(["Bash", "PowerShell"], false),

  // GitHub Copilot CLI (docs.github.com, hooks configuration): toolArgs is a
  // JSON-encoded string in the documented example; empty output = default.
  copilot: {
    parse(input) {
      const i = obj(input);
      if (!["bash", "powershell"].includes(str(i.toolName) ?? "")) return null;
      let args: unknown = i.toolArgs;
      if (typeof args === "string") {
        try {
          args = JSON.parse(args);
        } catch {
          return null;
        }
      }
      const command = str(obj(args).command);
      return command === undefined ? null : { command, cwd: str(i.cwd) ?? process.cwd() };
    },
    deny: (reason) => JSON.stringify({ permissionDecision: "deny", permissionDecisionReason: reason }),
    // permissionDecision accepts "allow", "deny" and "ask"; the cloud agent,
    // with no user present, treats "ask" as "deny".
    ask: (reason) => JSON.stringify({ permissionDecision: "ask", permissionDecisionReason: reason }),
    noObjection: "",
  },

  // Gemini CLI (geminicli.com/docs/hooks/reference): BeforeTool, tool
  // run_shell_command with command and optional dir_path; deny = decision + reason.
  gemini: {
    parse(input) {
      const i = obj(input);
      const toolInput = obj(i.tool_input);
      const command = str(toolInput.command);
      if (str(i.tool_name) !== "run_shell_command" || command === undefined) return null;
      const base = str(i.cwd) ?? process.cwd();
      const dir = str(toolInput.dir_path);
      return { command, cwd: dir ? resolve(base, dir) : base };
    },
    deny: (reason) => JSON.stringify({ decision: "deny", reason }),
    // BeforeTool decisions are only allow and deny, so no `ask`.
    noObjection: "",
  },

  // Antigravity CLI, IDE and 2.0 (antigravity.google/docs/hooks; Gemini CLI's
  // successor, #80): PreToolUse gets camelCase { toolCall: { name, args } }.
  // run_command carries CommandLine and Cwd; manage_task with send_input types
  // Input into a running terminal, so it is checked too. `decision` is required:
  // "allow" would auto-approve and skip Antigravity's own approval, so no
  // objection is "ask" (which honours the user's "Always Allow" settings), and a
  // confirmation is "force_ask", which a cached approval can't skip.
  antigravity: {
    parse(input) {
      const i = obj(input);
      const call = obj(i.toolCall);
      const args = obj(call.args);
      const workspace = Array.isArray(i.workspacePaths) ? str(i.workspacePaths[0]) : undefined;
      const fallback = workspace ?? process.cwd();
      if (str(call.name) === "run_command") {
        const command = str(args.CommandLine);
        return command === undefined ? null : { command, cwd: str(args.Cwd) ?? fallback };
      }
      if (str(call.name) === "manage_task" && str(args.Action) === "send_input") {
        const command = str(args.Input);
        return command === undefined ? null : { command, cwd: fallback };
      }
      return null;
    },
    deny: (reason) => JSON.stringify({ decision: "deny", reason }),
    ask: (reason) => JSON.stringify({ decision: "force_ask", reason }),
    noObjection: JSON.stringify({ decision: "ask" }),
  },

  // Cursor (cursor.com/docs/agent/hooks): beforeShellExecution gets
  // { command, cwd }. Output must be valid JSON with a permission. The docs
  // don't say how "allow" relates to Cursor's own approval, so it was measured
  // (#2, Cursor CLI 2026.10.01): "allow" ran an allowlisted command and still
  // stopped one that wasn't, exactly as with no hook, while "ask" stopped even
  // the allowlisted one. So "no objection" is "allow".
  cursor: {
    parse(input) {
      const i = obj(input);
      const command = str(i.command);
      return command === undefined ? null : { command, cwd: str(i.cwd) ?? process.cwd() };
    },
    deny: (reason) =>
      JSON.stringify({
        permission: "deny",
        user_message: reason,
        agent_message: reason,
      }),
    ask: (reason) => JSON.stringify({ permission: "ask", user_message: reason, agent_message: reason }),
    noObjection: JSON.stringify({ permission: "allow" }),
  },
} satisfies Record<string, AgentHook>;

// Set by the user before starting the agent, these count; set by the agent
// inside its own command, they would let it pick a laxer environment, confirm
// for the user or skip the check, so they are dropped.
const USER_ONLY_VARS = ["CLOUDPIN_ENV", "CLOUDPIN_CONFIRM", "CLOUDPIN_SKIP"];

export function withoutUserOnlyVars(vars: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(vars).filter(([k]) => !USER_ONLY_VARS.includes(k)));
}

/** A request for the user's OK: the text an agent asks with, or the one it is denied with. */
interface Confirmation {
  ask: string;
  deny: string;
}

function useConfirmation(args: string[]): Confirmation {
  const command = ["cloudpin", ...args].join(" ");
  const what = `cloudpin: \`${command}\` changes which environment's accounts and protections apply here`;
  return {
    ask: `${what}, so it needs your OK.`,
    deny: `${what}.\n  This agent's hook cannot ask the user to confirm, so cloudpin blocks it.\n  Do not work around this; ask the user to run it themselves.`,
  };
}

export type AgentName = keyof typeof AGENTS;

/**
 * Runs cloudpin as an agent hook: finds every cloud CLI call in the command
 * and returns the agent's deny output if any would act on the wrong account,
 * or its ask output if one needs the user's OK (a protected environment, or
 * the agent switching environment with `cloudpin use`).
 */
export async function runHook(
  agent: AgentHook,
  stdin: string,
  deps: GuardDeps,
  env: NodeJS.ProcessEnv,
  deadlineMs = HOOK_DEADLINE_MS,
): Promise<string> {
  // An agent runs the command when its hook fails or times out (Claude Code
  // and Codex treat a non-zero exit other than 2 as non-blocking), so every
  // failure here must become an explicit deny.
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<string>((resolve) => {
    timer = setTimeout(
      () =>
        resolve(
          agent.deny(
            `cloudpin: checking the accounts took longer than ${Math.round(deadlineMs / 1000)}s, so the command is blocked.\n` +
              "  Do not work around this; ask the user to run it or to check `cloudpin status`.",
          ),
        ),
      deadlineMs,
    );
  });
  try {
    return await Promise.race([checkCommand(agent, stdin, deps, env), deadline]);
  } catch (err) {
    const reason = (err as Error)?.message?.split("\n")[0]?.slice(0, 200) ?? String(err);
    return agent.deny(
      `cloudpin could not check this command (${reason}), so it is blocked.\n` +
        "  Do not work around this; ask the user to run it or to check `cloudpin status`.",
    );
  } finally {
    clearTimeout(timer);
  }
}

// Below the 60-second timeout `install-hook` writes for every agent, so cloudpin
// answers before the agent gives up on it.
const HOOK_DEADLINE_MS = 45_000;

async function checkCommand(
  agent: AgentHook,
  stdin: string,
  deps: GuardDeps,
  env: NodeJS.ProcessEnv,
): Promise<string> {
  let call: { command: string; cwd: string } | null;
  try {
    call = agent.parse(JSON.parse(stdin));
  } catch {
    return agent.noObjection;
  }
  if (!call) return agent.noObjection;

  const bins = [...deps.providers.flatMap((p) => p.bins), "cloudpin"];
  const blocks: string[] = [];
  const confirmations: Confirmation[] = [];
  for (let inv of findInvocations(call.command, bins, call.cwd)) {
    if (commandName(inv.bin) === "cloudpin") {
      // A bare `cloudpin use` only shows the current environment.
      if (inv.args[0] === "use" && inv.args.length > 1) confirmations.push(useConfirmation(inv.args));
      // `cloudpin exec` checks in shell mode, where CLOUDPIN_SKIP works, so
      // the hook checks the wrapped command itself, as the agent's.
      const wrapped = inv.args[0] === "exec" ? inv.args.slice(inv.args[1] === "--" ? 2 : 1) : [];
      if (wrapped.length === 0) continue;
      inv = { ...inv, bin: wrapped[0]!, args: wrapped.slice(1) };
    }
    const verdict = await guard(
      {
        bin: inv.bin,
        args: inv.args,
        env: { ...env, ...withoutUserOnlyVars(inv.env) },
        cwd: inv.cwd ?? call.cwd,
        mode: "agent",
      },
      deps,
    );
    const argv = [inv.bin, ...inv.args];
    if (verdict.action === "block") blocks.push(formatBlock(verdict, argv, "agent"));
    else if (verdict.action === "confirm") {
      confirmations.push({
        ask: formatConfirm(verdict, argv, "agent-ask"),
        deny: formatConfirm(verdict, argv, "agent-deny"),
      });
    }
  }
  if (blocks.length > 0) return agent.deny([...blocks, ...confirmations.map((c) => c.deny)].join("\n\n"));
  if (confirmations.length === 0) return agent.noObjection;
  return agent.ask
    ? agent.ask(confirmations.map((c) => c.ask).join("\n\n"))
    : agent.deny(confirmations.map((c) => c.deny).join("\n\n"));
}
