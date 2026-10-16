import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { claudePluginEnabled, hookFile, installedHooks, planInstall, planUninstall } from "../src/install.js";
import { providers } from "../src/providers/index.js";

const ROOT = "/repo";
const HOME = "/home/me";

describe("hookFile", () => {
  it.each([
    ["claude", "project", join(ROOT, ".claude", "settings.json")],
    ["claude", "user", join(HOME, ".claude", "settings.json")],
    ["codex", "project", join(ROOT, ".codex", "hooks.json")],
    ["gemini", "user", join(HOME, ".gemini", "settings.json")],
    ["cursor", "project", join(ROOT, ".cursor", "hooks.json")],
    ["copilot", "project", join(ROOT, ".github", "hooks", "cloudpin.json")],
    ["copilot", "user", join(HOME, ".copilot", "hooks", "cloudpin.json")],
    // antigravity.google/docs/hooks: shared by Antigravity CLI, IDE and 2.0.
    ["antigravity", "project", join(ROOT, ".agents", "hooks.json")],
    ["antigravity", "user", join(HOME, ".gemini", "config", "hooks.json")],
  ] as const)("%s %s -> %s", (agent, scope, path) => {
    expect(hookFile(agent, scope, ROOT, { HOME })).toBe(path);
  });

  it("respects COPILOT_HOME", () => {
    expect(hookFile("copilot", "user", ROOT, { HOME, COPILOT_HOME: "/c" })).toBe(join("/c", "hooks", "cloudpin.json"));
  });
});

describe("planInstall", () => {
  it("creates Claude Code settings with a Bash|PowerShell PreToolUse hook", () => {
    const plan = planInstall("claude", null);
    expect(plan.alreadyInstalled).toBe(false);
    expect(JSON.parse(plan.content)).toEqual({
      hooks: {
        PreToolUse: [
          {
            matcher: "Bash|PowerShell",
            hooks: [{ type: "command", command: "cloudpin hook claude", timeout: 60 }],
          },
        ],
      },
    });
  });

  it("keeps existing settings and hooks", () => {
    const existing = JSON.stringify({
      model: "x",
      hooks: { PreToolUse: [{ matcher: "Edit", hooks: [{ type: "command", command: "lint" }] }] },
    });
    const out = JSON.parse(planInstall("claude", existing).content);
    expect(out.model).toBe("x");
    expect(out.hooks.PreToolUse).toHaveLength(2);
    expect(out.hooks.PreToolUse[0].hooks[0].command).toBe("lint");
  });

  it("is idempotent", () => {
    const once = planInstall("codex", null).content;
    const twice = planInstall("codex", once);
    expect(twice.alreadyInstalled).toBe(true);
    expect(twice.content).toBe(once);
  });

  it("writes Codex's Bash matcher", () => {
    const out = JSON.parse(planInstall("codex", null).content);
    expect(out.hooks.PreToolUse[0]).toEqual({
      matcher: "Bash",
      hooks: [{ type: "command", command: "cloudpin hook codex" }],
    });
  });

  it("writes Gemini's BeforeTool hook for run_shell_command", () => {
    const out = JSON.parse(planInstall("gemini", null).content);
    expect(out.hooks.BeforeTool[0]).toEqual({
      matcher: "run_shell_command",
      hooks: [{ type: "command", name: "cloudpin", command: "cloudpin hook gemini", timeout: 60000 }],
    });
  });

  it("writes Cursor's versioned file with a matcher limited to cloud CLIs", () => {
    const out = JSON.parse(planInstall("cursor", null).content);
    expect(out.version).toBe(1);
    const entry = out.hooks.beforeShellExecution[0];
    expect(entry.command).toBe("cloudpin hook cursor");
    const matcher = new RegExp(entry.matcher);
    expect(matcher.test("cd x && vercel deploy")).toBe(true);
    expect(matcher.test("npm test")).toBe(false);
    expect(matcher.test("ghost-cli run")).toBe(false);
  });

  it("gives Cursor a matcher that covers every guarded CLI", () => {
    const entry = JSON.parse(planInstall("cursor", null).content).hooks.beforeShellExecution[0];
    const matcher = new RegExp(entry.matcher);
    const bins = providers.flatMap((p) => p.bins);
    expect(bins).toEqual(expect.arrayContaining(["kubectl", "helm"]));
    for (const bin of bins) expect(matcher.test(`cd app && ${bin} version`), bin).toBe(true);
    // The hook also asks before an agent runs `cloudpin use <env>`.
    expect(matcher.test("cloudpin use production")).toBe(true);
  });

  it("updates an older Cursor matcher instead of calling it installed", () => {
    const old = {
      version: 1,
      hooks: {
        beforeShellExecution: [
          { command: "other-tool check" },
          { command: "cloudpin hook cursor", matcher: "\\b(az|aws|gcloud|vercel|vc|gh)\\b", timeout: 60 },
        ],
      },
    };
    const plan = planInstall("cursor", JSON.stringify(old, null, 2));
    expect(plan.alreadyInstalled).toBe(false);
    const list = JSON.parse(plan.content).hooks.beforeShellExecution;
    expect(list).toHaveLength(2);
    expect(list[0]).toEqual({ command: "other-tool check" });
    expect(new RegExp(list[1].matcher).test("kubectl delete ns prod")).toBe(true);
    expect(planInstall("cursor", plan.content).alreadyInstalled).toBe(true);
  });

  it("writes Copilot's own hook file", () => {
    expect(JSON.parse(planInstall("copilot", null).content)).toEqual({
      version: 1,
      hooks: {
        preToolUse: [
          {
            type: "command",
            matcher: "bash|powershell",
            bash: "cloudpin hook copilot",
            powershell: "cloudpin hook copilot",
            timeoutSec: 60,
          },
        ],
      },
    });
  });

  it("refuses to touch a file it cannot parse", () => {
    expect(() => planInstall("claude", "{ not json")).toThrow(/not valid JSON/);
  });
});

describe("antigravity (#80)", () => {
  // Top-level keys are hook names, each mapping events to matcher groups.
  const entry = {
    PreToolUse: [
      { matcher: "run_command|manage_task", hooks: [{ type: "command", command: "cloudpin hook antigravity", timeout: 60 }] },
    ],
  };
  const theirs = { "my-linter": { PostToolUse: [{ matcher: "run_command", hooks: [{ command: "./lint.sh" }] }] } };

  it("adds a cloudpin hook next to the user's own, idempotently", () => {
    const plan = planInstall("antigravity", JSON.stringify(theirs));
    expect(JSON.parse(plan.content)).toEqual({ ...theirs, cloudpin: entry });
    expect(planInstall("antigravity", plan.content).alreadyInstalled).toBe(true);
    expect(JSON.parse(planInstall("antigravity", null).content)).toEqual({ cloudpin: entry });
  });

  it("removes only its own hook, and deletes a file that held nothing else", () => {
    const removed = planUninstall("antigravity", planInstall("antigravity", JSON.stringify(theirs)).content);
    expect(removed.found).toBe(true);
    expect(JSON.parse(removed.content!)).toEqual(theirs);
    expect(planUninstall("antigravity", planInstall("antigravity", null).content)).toEqual({ found: true, content: null });
    expect(planUninstall("antigravity", JSON.stringify(theirs))).toMatchObject({ found: false });
  });
});

describe("planUninstall", () => {
  it("removes only cloudpin's entry and keeps everything else", () => {
    const existing = JSON.stringify({
      model: "x",
      hooks: { PreToolUse: [{ matcher: "Edit", hooks: [{ type: "command", command: "lint" }] }] },
    });
    const installed = planInstall("claude", existing).content;
    const removed = planUninstall("claude", installed);
    expect(removed.found).toBe(true);
    expect(JSON.parse(removed.content!)).toEqual(JSON.parse(existing));
  });

  it("drops empty hook sections it created", () => {
    const removed = planUninstall("gemini", planInstall("gemini", JSON.stringify({ theme: "dark" })).content);
    expect(JSON.parse(removed.content!)).toEqual({ theme: "dark" });
  });

  it("deletes Copilot's own file", () => {
    expect(planUninstall("copilot", planInstall("copilot", null).content)).toEqual({ found: true, content: null });
  });

  it("reports when nothing is installed", () => {
    expect(planUninstall("cursor", JSON.stringify({ version: 1, hooks: {} })).found).toBe(false);
    expect(planUninstall("cursor", null).found).toBe(false);
  });
});

describe("the Claude Code plugin and the settings hook", () => {
  const env = { HOME };
  const user = join(HOME, ".claude", "settings.json");
  const local = join(ROOT, ".claude", "settings.local.json");
  const enabled = JSON.stringify({ enabledPlugins: { "cloudpin@cloudpin": true } });

  it("sees the plugin enabled in user, project or local settings, and nothing else", () => {
    expect(claudePluginEnabled((p) => (p === user ? enabled : null), ROOT, env)).toBe(true);
    expect(claudePluginEnabled((p) => (p === local ? enabled : null), ROOT, env)).toBe(true);
    expect(claudePluginEnabled(() => null, ROOT, env)).toBe(false);
    expect(claudePluginEnabled(() => "{ broken", ROOT, env)).toBe(false);
    expect(claudePluginEnabled(() => JSON.stringify({ enabledPlugins: { "cloudpin@cloudpin": false } }), ROOT, env)).toBe(false);
    expect(claudePluginEnabled(() => JSON.stringify({ enabledPlugins: { "other@cloudpin": true } }), ROOT, env)).toBe(false);
  });

  it("follows Claude Code's scope order: a narrower scope's setting wins, even false", () => {
    const project = join(ROOT, ".claude", "settings.json");
    const off = JSON.stringify({ enabledPlugins: { "cloudpin@cloudpin": false } });
    const files = (map: Record<string, string>) => (p: string) => map[p] ?? null;
    expect(claudePluginEnabled(files({ [user]: enabled, [project]: off }), ROOT, env)).toBe(false);
    expect(claudePluginEnabled(files({ [user]: enabled, [local]: off }), ROOT, env)).toBe(false);
    expect(claudePluginEnabled(files({ [user]: off, [project]: enabled }), ROOT, env)).toBe(true);
    expect(claudePluginEnabled(files({ [project]: off, [local]: enabled }), ROOT, env)).toBe(true);
    // A scope that doesn't mention the plugin leaves the decision to the wider one.
    expect(claudePluginEnabled(files({ [user]: enabled, [project]: JSON.stringify({ enabledPlugins: {} }) }), ROOT, env)).toBe(true);
  });

  it("lists the plugin among the installed hooks", () => {
    expect(installedHooks((p) => (p === user ? enabled : null), ROOT, env)).toEqual(["claude (plugin)"]);
  });
});
