import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  afterInstallNote,
  claudePluginEnabled,
  hookFile,
  installedHooks,
  planInstall,
  planUninstall,
  windowsRoot,
} from "../src/install.js";
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

describe("windowsRoot (#108)", () => {
  it("is SystemRoot on Windows, whatever the variable's casing, without a trailing backslash", () => {
    expect(windowsRoot({ SystemRoot: "C:\\Windows" }, "win32")).toBe("C:\\Windows");
    expect(windowsRoot({ SYSTEMROOT: "D:\\WINNT\\" }, "win32")).toBe("D:\\WINNT");
  });

  it("is null off Windows, so macOS and Linux write the bare command", () => {
    expect(windowsRoot({ SystemRoot: "C:\\Windows" }, "linux")).toBeNull();
    expect(windowsRoot({ SystemRoot: "C:\\Windows" }, "darwin")).toBeNull();
  });

  // Anything cmd.exe or PowerShell could split or read as syntax falls back to the bare command.
  it.each([undefined, "", "Windows", "\\Windows", "C:Windows", "\\\\server\\share\\Windows", "C:\\My Windows", "C:\\Win&dows", 'C:\\Win"dows', "C:\\Win%x%", "C:\\Win(1)", "C:\\Win;x", "C:/Windows"])(
    "is null for SystemRoot %j",
    (value) => {
      expect(windowsRoot(value === undefined ? {} : { SystemRoot: value }, "win32")).toBeNull();
    },
  );
});

describe("planInstall on Windows (#108)", () => {
  const WIN = "C:\\Windows";
  const form = (agent: string, root = WIN) =>
    `${root}\\System32\\cmd.exe /d /s /c "set NoDefaultCurrentDirectoryInExePath=1&& cloudpin hook ${agent}"`;

  it("writes Codex's commandWindows next to the portable command", () => {
    const out = JSON.parse(planInstall("codex", null, WIN).content);
    expect(out.hooks.PreToolUse[0]).toEqual({
      matcher: "Bash",
      hooks: [{ type: "command", command: "cloudpin hook codex", commandWindows: form("codex") }],
    });
  });

  it("writes Copilot's powershell key and leaves its bash key bare", () => {
    const entry = JSON.parse(planInstall("copilot", null, WIN).content).hooks.preToolUse[0];
    expect(entry).toEqual({
      type: "command",
      matcher: "bash|powershell",
      bash: "cloudpin hook copilot",
      powershell: form("copilot"),
      timeoutSec: 60,
    });
  });

  it.each(["claude", "gemini", "cursor", "antigravity"] as const)("leaves %s bare", (agent) => {
    expect(planInstall(agent, null, WIN).content).toBe(planInstall(agent, null).content);
  });

  const theirs = { type: "command", command: "lint" };
  const bareCodex = {
    model: "x",
    hooks: {
      PreToolUse: [
        { matcher: "Bash", hooks: [theirs, { type: "command", command: "cloudpin hook codex" }] },
        { matcher: "Edit", hooks: [theirs] },
      ],
      PostToolUse: [{ hooks: [theirs] }],
    },
  };

  it("upgrades a bare Codex entry in place, keeps the user's hooks, and is then idempotent", () => {
    const plan = planInstall("codex", JSON.stringify(bareCodex, null, 2), WIN);
    expect(plan.alreadyInstalled).toBe(false);
    const expected = structuredClone(bareCodex);
    (expected.hooks.PreToolUse[0]!.hooks[1] as Record<string, string>).commandWindows = form("codex");
    expect(JSON.parse(plan.content)).toEqual(expected);
    const again = planInstall("codex", plan.content, WIN);
    expect(again).toEqual({ content: plan.content, alreadyInstalled: true });
  });

  it("replaces Codex's command_windows alias instead of adding a second field", () => {
    const old = { hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "cloudpin hook codex", command_windows: "cloudpin hook codex" }] }] } };
    const hook = JSON.parse(planInstall("codex", JSON.stringify(old), WIN).content).hooks.PreToolUse[0].hooks[0];
    expect(hook).toEqual({ type: "command", command: "cloudpin hook codex", commandWindows: form("codex") });
  });

  it("upgrades a bare Copilot entry in place, and is then idempotent", () => {
    const bare = planInstall("copilot", null).content;
    const plan = planInstall("copilot", bare, WIN);
    expect(plan.alreadyInstalled).toBe(false);
    expect(plan.content).toBe(planInstall("copilot", null, WIN).content);
    expect(planInstall("copilot", plan.content, WIN).alreadyInstalled).toBe(true);
  });

  it("rewrites a Windows form made for another SystemRoot", () => {
    const other = planInstall("codex", null, "D:\\Windows").content;
    const plan = planInstall("codex", other, WIN);
    expect(plan.alreadyInstalled).toBe(false);
    expect(plan.content).toBe(planInstall("codex", null, WIN).content);
  });

  it("treats a form that differs only in the case of SystemRoot as current (Windows paths ignore case)", () => {
    // Rewriting it would change Codex's trust hash, and the next machine would flip it back.
    for (const agent of ["codex", "copilot"] as const) {
      const upper = planInstall(agent, null, "C:\\WINDOWS").content;
      expect(upper).toContain("C:\\\\WINDOWS\\\\System32"); // control: the file holds the upper-case form
      expect(planInstall(agent, upper, WIN)).toEqual({ content: upper, alreadyInstalled: true });
    }
  });

  it("names the Codex /hooks review after writing the Windows form, and nothing otherwise", () => {
    const note = "cloudpin: Codex runs the changed hook only after you review it in /hooks.";
    expect(afterInstallNote("codex", planInstall("codex", null, WIN).content)).toBe(note);
    expect(afterInstallNote("codex", planInstall("codex", JSON.stringify(bareCodex), WIN).content)).toBe(note);
    expect(afterInstallNote("codex", planInstall("codex", null).content)).toBeNull();
    expect(afterInstallNote("copilot", planInstall("copilot", null, WIN).content)).toBeNull();
    expect(afterInstallNote("claude", planInstall("claude", null).content)).toBeNull();
  });

  it("keeps the Windows form off Windows or without a usable SystemRoot (a teammate's re-run changes nothing)", () => {
    for (const agent of ["codex", "copilot"] as const) {
      const win = planInstall(agent, null, WIN).content;
      expect(win).toContain("cmd.exe"); // control: this is the Windows form
      expect(planInstall(agent, win)).toEqual({ content: win, alreadyInstalled: true });
      expect(planInstall(agent, win, windowsRoot({}, "win32"))).toEqual({ content: win, alreadyInstalled: true });
    }
  });

  it("is recognised by status and removed by uninstall-hook, like the bare form", () => {
    const env = { HOME };
    for (const agent of ["codex", "copilot"] as const) {
      const content = planInstall(agent, null, WIN).content;
      expect(installedHooks((p) => (p === hookFile(agent, "user", ROOT, env) ? content : null), ROOT, env)).toEqual([`${agent} (personal)`]);
    }
    const codex = planInstall("codex", JSON.stringify(bareCodex), WIN).content;
    const removed = JSON.parse(planUninstall("codex", codex).content!);
    expect(removed.hooks.PreToolUse).toEqual([
      { matcher: "Bash", hooks: [theirs] },
      { matcher: "Edit", hooks: [theirs] },
    ]);
    expect(planUninstall("copilot", planInstall("copilot", null, WIN).content)).toEqual({ found: true, content: null });
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
