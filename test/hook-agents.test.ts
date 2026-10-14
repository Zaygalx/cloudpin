import { describe, expect, it } from "vitest";
import type { FoundConfig } from "../src/config.js";
import type { GuardDeps } from "../src/guard.js";
import { AGENTS, runHook } from "../src/hooks/agents.js";
import type { ProviderDef } from "../src/types.js";

// Fake gh whose active user comes from FAKE_GH_USER, defaulting to the pinned one.
const gh: ProviderDef<"github"> = {
  name: "github",
  bins: ["gh"],
  isExempt: (args) => args[0] === "auth",
  resolve: async ({ env }) => ({ kind: "identity", identity: { user: env.FAKE_GH_USER ?? "paureis" }, source: "t" }),
  compare: (pin, id) => (pin.user === id.user ? [] : [`user: expected "${pin.user}", active is "${id.user}"`]),
  switchHint: (pin) => `gh auth switch --user ${pin.user}`,
  statusCommand: "gh auth status",
  cacheInputs: () => ({ env: ["FAKE_GH_USER", "GH_TOKEN"], files: [], dirs: [] }),
};
const config: FoundConfig = { path: "/repo/.cloudpin.yml", pins: { github: { user: "paureis" } } };
const deps: GuardDeps = {
  providers: [gh as ProviderDef],
  exec: async () => ({ code: 0, stdout: "", stderr: "" }),
  findConfig: (cwd) => (cwd.replace(/\\/g, "/").includes("/elsewhere") ? null : config),
};
const wrong = { FAKE_GH_USER: "someone" };

// Inputs shaped as each agent's documentation describes them.
const inputs = {
  codex: (command: string) =>
    JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command }, cwd: "/repo" }),
  copilot: (command: string) =>
    JSON.stringify({ timestamp: 1, cwd: "/repo", toolName: "bash", toolArgs: JSON.stringify({ command }) }),
  gemini: (command: string, dir?: string) =>
    JSON.stringify({
      hook_event_name: "BeforeTool",
      cwd: "/repo",
      tool_name: "run_shell_command",
      tool_input: { command, ...(dir ? { dir_path: dir } : {}) },
    }),
  cursor: (command: string) => JSON.stringify({ command, cwd: "/repo", sandbox: false }),
  // antigravity.google/docs/hooks, PreToolUse example (camelCase, toolCall.args).
  antigravity: (command: string, cwd: string | undefined = "/repo") =>
    JSON.stringify({
      toolCall: { name: "run_command", args: { CommandLine: command, ...(cwd ? { Cwd: cwd } : {}), WaitMsBeforeAsync: 5000 } },
      stepIdx: 19,
      conversationId: "ec33ebf9-0cba-4100-8142-c61503f6c587",
      workspacePaths: ["/repo"],
      transcriptPath: "~/.gemini/antigravity-cli/brain/x/.system_generated/logs/transcript.jsonl",
      artifactDirectoryPath: "~/.gemini/antigravity-cli/brain/x",
      modelName: "gemini-3.6-flash-medium",
    }),
};

// #86: variables set earlier in the agent's line decide the account the CLI uses.
describe("runHook: environment set earlier in the line", () => {
  const decision = async (command: string, env: NodeJS.ProcessEnv = {}) =>
    JSON.parse((await runHook(AGENTS.codex, inputs.codex(command), deps, env)) || "{}").hookSpecificOutput?.permissionDecision ?? "none";

  it("denies when an export earlier in the line switches to the wrong account", async () => {
    expect(await decision("export FAKE_GH_USER=someone; gh pr list")).toBe("deny");
    expect(await decision("$env:FAKE_GH_USER = 'someone'; gh pr list")).toBe("deny");
    expect(await decision("export FAKE_GH_USER=paureis; gh pr list")).toBe("none");
  });

  it("counts a plain assignment only when the variable is already exported", async () => {
    expect(await decision("FAKE_GH_USER=someone; gh pr list")).toBe("none");
    expect(await decision("FAKE_GH_USER=someone; gh pr list", { FAKE_GH_USER: "paureis" })).toBe("deny");
  });

  it("follows unset", async () => {
    expect(await decision("unset FAKE_GH_USER; gh pr list", { FAKE_GH_USER: "someone" })).toBe("none");
  });

  it("denies, saying why, when a variable that decides the account is set from something unknown in advance", async () => {
    const out = JSON.parse(await runHook(AGENTS.codex, inputs.codex("GH_TOKEN=$(cat other.token) gh repo list"), deps, {}));
    expect(out.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(out.hookSpecificOutput.permissionDecisionReason).toContain("GH_TOKEN");
    expect(await decision("export GH_TOKEN=$(cat other.token); gh repo list")).toBe("deny");
  });

  it("ignores an unknown value for a variable that doesn't decide the account", async () => {
    expect(await decision("export PAGER=$(which less); gh pr list")).toBe("none");
  });
});

describe("runHook: codex (same protocol as Claude Code)", () => {
  it("denies through hookSpecificOutput", async () => {
    const out = JSON.parse(await runHook(AGENTS.codex, inputs.codex("gh pr list"), deps, wrong));
    expect(out.hookSpecificOutput).toMatchObject({ hookEventName: "PreToolUse", permissionDecision: "deny" });
  });
  it("prints nothing when there is no problem", async () => {
    expect(await runHook(AGENTS.codex, inputs.codex("gh pr list"), deps, {})).toBe("");
  });
});

describe("runHook: copilot", () => {
  it("parses the JSON-encoded toolArgs and denies with permissionDecision", async () => {
    const out = JSON.parse(await runHook(AGENTS.copilot, inputs.copilot("gh pr list"), deps, wrong));
    expect(out.permissionDecision).toBe("deny");
    expect(out.permissionDecisionReason).toContain("blocked `gh pr list`");
  });
  it("also accepts toolArgs as an object, and the powershell tool", async () => {
    const input = JSON.stringify({ cwd: "/repo", toolName: "powershell", toolArgs: { command: "gh pr list" } });
    expect(JSON.parse(await runHook(AGENTS.copilot, input, deps, wrong)).permissionDecision).toBe("deny");
  });
  it("prints nothing when there is no problem (default behaviour)", async () => {
    expect(await runHook(AGENTS.copilot, inputs.copilot("gh pr list"), deps, {})).toBe("");
  });
});

describe("runHook: gemini", () => {
  it("denies with decision and reason", async () => {
    const out = JSON.parse(await runHook(AGENTS.gemini, inputs.gemini("gh pr list"), deps, wrong));
    expect(out.decision).toBe("deny");
    expect(out.reason).toContain("blocked `gh pr list`");
  });
  it("checks against dir_path when the command runs elsewhere", async () => {
    // /elsewhere has no pin file, so nothing is blocked there.
    expect(await runHook(AGENTS.gemini, inputs.gemini("gh pr list", "/elsewhere"), deps, wrong)).toBe("");
  });
  it("ignores other tools", async () => {
    const input = JSON.stringify({ cwd: "/repo", tool_name: "write_file", tool_input: { content: "gh" } });
    expect(await runHook(AGENTS.gemini, input, deps, wrong)).toBe("");
  });
});

describe("runHook: antigravity (#80)", () => {
  const sendInput = (Input: string) =>
    JSON.stringify({ toolCall: { name: "manage_task", args: { Action: "send_input", TaskId: "t1", Input } }, workspacePaths: ["/repo"] });

  it("denies run_command with decision and reason", async () => {
    const out = JSON.parse(await runHook(AGENTS.antigravity, inputs.antigravity("gh pr list"), deps, wrong));
    expect(out.decision).toBe("deny");
    expect(out.reason).toContain("blocked `gh pr list`");
  });
  it("answers ask, never allow, when there is no problem: allow would skip Antigravity's own approval", async () => {
    expect(JSON.parse(await runHook(AGENTS.antigravity, inputs.antigravity("gh pr list"), deps, {}))).toEqual({ decision: "ask" });
  });
  it("checks against Cwd, and falls back to the first workspace path without one", async () => {
    expect(JSON.parse(await runHook(AGENTS.antigravity, inputs.antigravity("gh pr list", "/elsewhere"), deps, wrong)).decision).toBe("ask");
    expect(JSON.parse(await runHook(AGENTS.antigravity, inputs.antigravity("gh pr list", undefined), deps, wrong)).decision).toBe("deny");
  });
  it("checks text typed into a running terminal (manage_task send_input)", async () => {
    expect(JSON.parse(await runHook(AGENTS.antigravity, sendInput("gh pr list\n"), deps, wrong)).decision).toBe("deny");
    const list = JSON.stringify({ toolCall: { name: "manage_task", args: { Action: "list" } }, workspacePaths: ["/repo"] });
    expect(JSON.parse(await runHook(AGENTS.antigravity, list, deps, wrong))).toEqual({ decision: "ask" });
  });
  it("ignores other tools and answers valid JSON even for unreadable input", async () => {
    const view = JSON.stringify({ toolCall: { name: "view_file", args: { AbsolutePath: "/repo/gh" } }, workspacePaths: ["/repo"] });
    expect(JSON.parse(await runHook(AGENTS.antigravity, view, deps, wrong))).toEqual({ decision: "ask" });
    expect(JSON.parse(await runHook(AGENTS.antigravity, "not json", deps, wrong))).toEqual({ decision: "ask" });
  });
});

describe("runHook: cursor", () => {
  it("denies with messages for the user and the agent", async () => {
    const out = JSON.parse(await runHook(AGENTS.cursor, inputs.cursor("gh pr list"), deps, wrong));
    expect(out.permission).toBe("deny");
    expect(out.user_message).toContain("blocked `gh pr list`");
    expect(out.agent_message).toContain("ask the user");
  });
  it("answers allow when there is no problem, which leaves Cursor's own approval rules in charge (#2)", async () => {
    // Measured in Cursor CLI 2026.10.01: "allow" ran an allowlisted command and still stopped one that wasn't,
    // exactly as with no hook; "ask" stopped even the allowlisted one.
    expect(JSON.parse(await runHook(AGENTS.cursor, inputs.cursor("gh pr list"), deps, {}))).toEqual({
      permission: "allow",
    });
  });
});

describe("runHook: input that is not for us", () => {
  it.each(Object.keys(AGENTS))("%s stays out of the way on invalid JSON", async (name) => {
    const agent = AGENTS[name as keyof typeof AGENTS];
    expect(await runHook(agent, "not json", deps, wrong)).toBe(agent.noObjection);
  });
});

describe("runHook: protected environments", () => {
  const production: FoundConfig = {
    ...config,
    environment: { name: "production", protected: true, source: 'branch "main"' },
  };
  const staging: FoundConfig = { ...config, environment: { name: "staging", protected: false, source: "CLOUDPIN_ENV" } };
  // CLOUDPIN_ENV=staging selects staging, as the real findConfig would.
  const envDeps: GuardDeps = { ...deps, findConfig: (_cwd, env) => (env.CLOUDPIN_ENV === "staging" ? staging : production) };
  const claude = (command: string) =>
    JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command }, cwd: "/repo" });

  it("claude asks the user, showing why", async () => {
    const out = JSON.parse(await runHook(AGENTS.claude, claude("gh pr merge 12"), envDeps, {}));
    expect(out.hookSpecificOutput).toMatchObject({ hookEventName: "PreToolUse", permissionDecision: "ask" });
    expect(out.hookSpecificOutput.permissionDecisionReason).toContain('protected environment "production"');
  });

  it("says nothing for a read-only command", async () => {
    expect(await runHook(AGENTS.claude, claude("gh pr list"), envDeps, {})).toBe("");
  });

  it("denies when another call in the same command is on the wrong account", async () => {
    const out = JSON.parse(
      await runHook(AGENTS.claude, claude("gh pr merge 12 && FAKE_GH_USER=someone gh pr list"), envDeps, {}),
    );
    expect(out.hookSpecificOutput.permissionDecision).toBe("deny");
  });

  it("codex denies, because its hooks ignore ask and would run the command", async () => {
    // learn.chatgpt.com/docs/hooks: "ask" is parsed but not supported, and the tool call continues.
    const out = JSON.parse(await runHook(AGENTS.codex, inputs.codex("gh pr merge 12"), envDeps, {}));
    expect(out.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(out.hookSpecificOutput.permissionDecisionReason).toContain("ask the user to run it themselves");
  });

  it("copilot asks", async () => {
    const out = JSON.parse(await runHook(AGENTS.copilot, inputs.copilot("gh pr merge 12"), envDeps, {}));
    expect(out).toMatchObject({ permissionDecision: "ask" });
    expect(out.permissionDecisionReason).toContain("needs your OK");
  });

  it("gemini denies, having no ask decision", async () => {
    const out = JSON.parse(await runHook(AGENTS.gemini, inputs.gemini("gh pr merge 12"), envDeps, {}));
    expect(out.decision).toBe("deny");
  });

  it("antigravity force-asks, so a cached Always Allow can't skip the confirmation", async () => {
    const out = JSON.parse(await runHook(AGENTS.antigravity, inputs.antigravity("gh pr merge 12"), envDeps, {}));
    expect(out.decision).toBe("force_ask");
    expect(out.reason).toContain("needs your OK");
  });

  it("cursor asks, with messages for the user and the agent", async () => {
    const out = JSON.parse(await runHook(AGENTS.cursor, inputs.cursor("gh pr merge 12"), envDeps, {}));
    expect(out.permission).toBe("ask");
    expect(out.user_message).toContain("needs your OK");
    expect(out.agent_message).toContain("needs your OK");
  });

  it("ignores CLOUDPIN_ENV and CLOUDPIN_CONFIRM set inside the agent's command", async () => {
    for (const prefix of ["CLOUDPIN_ENV=staging", "CLOUDPIN_CONFIRM=production"]) {
      const out = JSON.parse(await runHook(AGENTS.claude, claude(`${prefix} gh pr merge 12`), envDeps, {}));
      expect(out.hookSpecificOutput.permissionDecision).toBe("ask");
    }
  });

  it("honours CLOUDPIN_ENV the user set before starting the agent", async () => {
    expect(await runHook(AGENTS.claude, claude("gh pr merge 12"), envDeps, { CLOUDPIN_ENV: "staging" })).toBe("");
  });

  it("asks before an agent switches environment with cloudpin use", async () => {
    const out = JSON.parse(await runHook(AGENTS.claude, claude("cloudpin use staging && gh pr merge 12"), envDeps, {}));
    expect(out.hookSpecificOutput.permissionDecision).toBe("ask");
    expect(out.hookSpecificOutput.permissionDecisionReason).toContain("cloudpin use staging");
    const codex = JSON.parse(await runHook(AGENTS.codex, inputs.codex("npx cloudpin use --clear"), deps, {}));
    expect(codex.hookSpecificOutput.permissionDecision).toBe("deny");
  });

  it("lets an agent read the current environment with a bare cloudpin use", async () => {
    expect(await runHook(AGENTS.claude, claude("cloudpin use"), deps, {})).toBe("");
  });
});

describe("runHook: cloudpin exec inside an agent's command", () => {
  const claude = (command: string) =>
    JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command }, cwd: "/repo" });

  it("checks the wrapped command in agent mode, so CLOUDPIN_SKIP cannot skip it", async () => {
    for (const command of ["CLOUDPIN_SKIP=1 cloudpin exec -- gh pr list", "cloudpin exec gh pr list"]) {
      const out = JSON.parse(await runHook(AGENTS.claude, claude(command), deps, wrong));
      expect(out.hookSpecificOutput.permissionDecision).toBe("deny");
    }
  });
});
