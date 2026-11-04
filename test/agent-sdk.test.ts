import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { FoundConfig } from "../src/config.js";
import type { GuardDeps } from "../src/guard.js";
import { claudeHook } from "../src/hooks/claude.js";
import type { ProviderDef } from "../src/types.js";

// docs/agent-sdk.md pipes the Claude Agent SDK's PreToolUse hook input to
// `cloudpin hook claude` and returns the parsed stdout, or {} when it is empty.
// These tests hold cloudpin to that contract, and the page's snippets to the
// properties that keep them safe.

const gh: ProviderDef<"github"> = {
  name: "github",
  bins: ["gh"],
  isExempt: (args) => args[0] === "auth",
  resolve: async ({ env }) => ({ kind: "identity", identity: { user: env.FAKE_GH_USER ?? "acme-bot" }, source: "t" }),
  compare: (pin, id) => (pin.user === id.user ? [] : [`user: expected "${pin.user}", active is "${id.user}"`]),
  switchHint: (pin) => `gh auth switch --user ${pin.user}`,
  statusCommand: "gh auth status",
  cacheInputs: () => ({ env: [], files: [], dirs: [] }),
};

function depsFor(pinnedIn: string, folders: string[]): GuardDeps {
  const config: FoundConfig = { path: `${pinnedIn}/.cloudpin.yml`, pins: { github: { user: "acme-bot" } } };
  return {
    providers: [gh as ProviderDef],
    exec: async () => ({ code: 0, stdout: "", stderr: "" }),
    findConfig: (cwd) => {
      folders.push(cwd);
      return cwd === pinnedIn ? config : null;
    },
  };
}

// The PreToolUse input as the SDK's types describe it (BaseHookInput plus the
// PreToolUse fields), including the fields cloudpin doesn't use.
const sdkInput = (command: string, cwd = "/work/agent-project") =>
  JSON.stringify({
    session_id: "8a1c",
    transcript_path: "/home/u/.claude/projects/x/8a1c.jsonl",
    cwd,
    permission_mode: "default",
    agent_id: "main",
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    tool_input: { command, description: "Show the repository" },
    tool_use_id: "toolu_01",
  });

describe("cloudpin hook claude, fed the Agent SDK's hook input", () => {
  it("denies the wrong account with an SDK PreToolUse output and nothing else", async () => {
    const out = await claudeHook(sdkInput("gh repo view"), depsFor("/work/agent-project", []), { FAKE_GH_USER: "other" });
    const parsed = JSON.parse(out);
    expect(Object.keys(parsed)).toEqual(["hookSpecificOutput"]);
    expect(Object.keys(parsed.hookSpecificOutput).sort()).toEqual(["hookEventName", "permissionDecision", "permissionDecisionReason"]);
    expect(parsed.hookSpecificOutput.hookEventName).toBe("PreToolUse");
    expect(parsed.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(parsed.hookSpecificOutput.permissionDecisionReason).toContain('expected "acme-bot", active is "other"');
  });

  it("prints nothing for the right account, which the callbacks turn into {}", async () => {
    expect(await claudeHook(sdkInput("gh repo view"), depsFor("/work/agent-project", []), {})).toBe("");
  });

  it("takes the pin from the input's cwd, the agent's folder, not cloudpin's own", async () => {
    const folders: string[] = [];
    await claudeHook(sdkInput("gh repo view", "/work/other"), depsFor("/work/agent-project", folders), {});
    expect(folders).toEqual(["/work/other"]);
    expect(folders).not.toContain(process.cwd());
  });
});

const page = readFileSync(new URL("../docs/agent-sdk.md", import.meta.url), "utf8");
const fence = "```";
function snippet(lang: string): string {
  const start = page.indexOf(`${fence}${lang}\n`);
  expect(start, `a ${lang} block in docs/agent-sdk.md`).toBeGreaterThan(-1);
  const body = page.slice(start + fence.length + lang.length + 1);
  return body.slice(0, body.indexOf(`${fence}\n`));
}

describe.each(["python", "ts"])("docs/agent-sdk.md, the %s callback", (lang) => {
  const code = snippet(lang);

  it("stays under 40 lines", () => {
    expect(code.trimEnd().split("\n").length).toBeLessThanOrEqual(40);
  });

  it("starts cloudpin on Windows through cmd.exe, with a fixed line and no current-folder search", () => {
    const windows = {
      python: ['"cmd.exe"), "/d", "/s", "/c", "cloudpin hook claude"]', '"NoDefaultCurrentDirectoryInExePath": "1"'],
      ts: ['"cmd.exe"), ["/d", "/s", "/c", "cloudpin hook claude"]]', 'NoDefaultCurrentDirectoryInExePath: "1"'],
    }[lang]!;
    for (const part of windows) expect(code).toContain(part);
  });

  it("never spawns through a shell, never looks cloudpin up itself, never answers allow", () => {
    for (const bad of ["shell=True", "shell: true", "shutil.which", "create_subprocess_shell", '"allow"']) {
      expect(code).not.toContain(bad);
    }
  });

  it("denies when cloudpin fails, and loads no settings files", () => {
    expect(code).toMatch(/could not check the command/);
    expect(code).toMatch(/answer was not JSON/);
    expect(code).toMatch(lang === "python" ? /setting_sources=\[\]/ : /settingSources: \[\]/);
  });

  // A callback that raises (or rejects) lets the command run, so any error,
  // and any answer that isn't a JSON object, must become a deny.
  it("turns any error, and an answer that isn't an object, into a deny", () => {
    const guards = {
      python: ["except Exception as err:", "isinstance(answer, dict)"],
      ts: ["} catch (err) { resolve(deny(", "!Array.isArray(answer)"],
    }[lang]!;
    for (const part of guards) expect(code).toContain(part);
  });
});
