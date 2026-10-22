import { join } from "node:path";
import { AGENTS, type AgentName } from "./hooks/agents.js";
import { home } from "./paths.js";
import { providers } from "./providers/index.js";

export type Scope = "project" | "user";

const MARKER = "cloudpin hook";
const command = (agent: AgentName) => `${MARKER} ${agent}`;
// Cursor runs the hook only for commands matching this regex: as words, every
// name the hook inspects (each guarded CLI, and cloudpin itself for `cloudpin
// use`). Built from the providers so a new one can't be left out (#42).
const CURSOR_MATCHER = `\\b(${[...providers.flatMap((p) => p.bins), "cloudpin"].join("|")})\\b`;

/**
 * SystemRoot, when install-hook may write the Windows form of a hook (#108):
 * on Windows, and only a plain absolute path (a drive, then folders of
 * letters, digits, `.`, `_` and `-`), since the form is read by both cmd.exe
 * and PowerShell. Anything else (unset, relative, spaces, `&`, `%`, quotes,
 * brackets) gives null and the bare command, which `cloudpin doctor` warns about.
 */
export function windowsRoot(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string | null {
  if (platform !== "win32") return null;
  const value = Object.entries(env).find(([k]) => k.toUpperCase() === "SYSTEMROOT")?.[1] ?? "";
  return /^[A-Za-z]:(\\[\w.-]+)+\\?$/.test(value) ? value.replace(/\\$/, "") : null;
}

/**
 * The hook command for an agent's Windows-only field: cmd.exe by its full
 * path, which sets NoDefaultCurrentDirectoryInExePath and then looks up
 * `cloudpin` itself. It needs no PowerShell script, so the Restricted and
 * AllSigned execution policies can't stop it (PowerShell resolves a bare
 * `cloudpin` to npm's cloudpin.ps1), and neither that lookup nor the bare
 * `node` inside npm's cloudpin.cmd searches the current folder (Microsoft
 * docs, NeedCurrentDirectoryForExePathW). It names no cloudpin or Node path,
 * so upgrades don't break it, and it works with any shim (npm, Scoop, Volta).
 * The same string runs in every Windows shell Codex uses for hooks
 * (codex-rs/hooks/src/engine/command_runner.rs, build_command, rust-v0.154.0):
 * PowerShell `-Command` with Rust's quoting, and cmd.exe `/c "<command>"`
 * (its session shell or the %COMSPEC% fallback), where the outer cmd.exe drops
 * the first and last quote and leaves the inner pair around `&&`.
 */
const windowsCommand = (agent: AgentName, root: string) =>
  `${root}\\System32\\cmd.exe /d /s /c "set NoDefaultCurrentDirectoryInExePath=1&& ${command(agent)}"`;

/** The settings file each agent reads hooks from (each agent's hook docs). */
export function hookFile(agent: AgentName, scope: Scope, root: string, env: NodeJS.ProcessEnv): string {
  const base = scope === "project" ? root : home(env);
  switch (agent) {
    case "claude":
      return join(base, ".claude", "settings.json");
    case "codex":
      return join(base, ".codex", "hooks.json");
    case "gemini":
      return join(base, ".gemini", "settings.json");
    case "cursor":
      return join(base, ".cursor", "hooks.json");
    case "copilot":
      if (scope === "project") return join(root, ".github", "hooks", "cloudpin.json");
      return join(env.COPILOT_HOME ?? join(home(env), ".copilot"), "hooks", "cloudpin.json");
    case "antigravity":
      // antigravity.google/docs/hooks: read by Antigravity CLI, IDE and 2.0 alike.
      return scope === "project" ? join(root, ".agents", "hooks.json") : join(home(env), ".gemini", "config", "hooks.json");
  }
}

// The plugin's id in `enabledPlugins`: plugin@marketplace (.claude-plugin/*.json in this repository).
const CLAUDE_PLUGIN = "cloudpin@cloudpin";

/**
 * True when the cloudpin Claude Code plugin is enabled in the user, project or
 * local settings. Its hook then guards Claude Code, and Claude Code would run a
 * settings copy of the same hook as well (code.claude.com/docs/en/hooks).
 */
export function claudePluginEnabled(read: (path: string) => string | null, cwd: string, env: NodeJS.ProcessEnv): boolean {
  // Narrowest scope first, as Claude Code applies them: the first file that
  // mentions the plugin decides, so a project's `false` beats the user's `true`.
  // Managed settings and --plugin-dir are out of reach and not considered.
  const files = [join(cwd, ".claude", "settings.local.json"), hookFile("claude", "project", cwd, env), hookFile("claude", "user", cwd, env)];
  for (const file of files) {
    let plugins: Record<string, unknown> | undefined;
    try {
      plugins = (JSON.parse(read(file) ?? "{}") as { enabledPlugins?: Record<string, unknown> }).enabledPlugins;
    } catch {
      continue; // A settings file Claude Code can't read either.
    }
    if (plugins && Object.hasOwn(plugins, CLAUDE_PLUGIN)) return plugins[CLAUDE_PLUGIN] === true;
  }
  return false;
}

/** The installed agent hooks, as `cloudpin status` names them: "claude (project)", "codex (personal)", ... */
export function installedHooks(read: (path: string) => string | null, cwd: string, env: NodeJS.ProcessEnv): string[] {
  const hooks = (Object.keys(AGENTS) as AgentName[]).flatMap((agent) =>
    (["project", "user"] as const)
      .filter((scope) => read(hookFile(agent, scope, cwd, env))?.includes(command(agent)))
      .map((scope) => `${agent} (${scope === "user" ? "personal" : "project"})`),
  );
  return claudePluginEnabled(read, cwd, env) ? ["claude (plugin)", ...hooks] : hooks;
}

// Antigravity's hooks.json maps hook names to events, so cloudpin owns one named entry.
const ANTIGRAVITY_HOOK = "cloudpin";
const antigravityEntry = () => ({
  PreToolUse: [
    {
      matcher: "run_command|manage_task",
      hooks: [{ type: "command", command: command("antigravity"), timeout: 60 }],
    },
  ],
});

type Json = Record<string, unknown>;

function parse(existing: string | null): Json {
  if (existing === null || existing.trim() === "") return {};
  try {
    const value = JSON.parse(existing) as unknown;
    if (value && typeof value === "object" && !Array.isArray(value)) return value as Json;
  } catch {
    // fall through
  }
  throw new Error("the existing file is not valid JSON; fix or move it, then try again");
}

const render = (value: Json) => `${JSON.stringify(value, null, 2)}\n`;

/**
 * Where in the file the agent keeps its hook list, and cloudpin's entry. With
 * `root` (windowsRoot), the agents that have a Windows-only field get the
 * Windows form there, and their portable field stays bare for macOS and Linux:
 * Codex's `commandWindows`, used instead of `command` only on Windows (Codex
 * 0.131.0+, openai/codex#22159; codex-rs/hooks/src/engine/discovery.rs), and
 * Copilot CLI's `powershell` key, "Shell command for Windows", which its cloud
 * agent ignores (docs.github.com, Copilot hooks reference). Gemini CLI has no
 * such field (CommandHookConfig, packages/core/src/hooks/types.ts, v0.64.0),
 * and Claude Code (Git Bash, which sets NoDefaultCurrentDirectoryInExePath
 * itself), Cursor (PowerShell with -ExecutionPolicy Bypass) and Antigravity
 * (shell not documented) keep the bare command.
 */
function layout(agent: AgentName, root: string | null = null): { event: string; entry: Json; version?: number } {
  const cmd = command(agent);
  switch (agent) {
    case "claude":
      return {
        event: "PreToolUse",
        entry: { matcher: "Bash|PowerShell", hooks: [{ type: "command", command: cmd, timeout: 60 }] },
      };
    case "codex": {
      const hook = { type: "command", command: cmd, ...(root ? { commandWindows: windowsCommand(agent, root) } : {}) };
      return { event: "PreToolUse", entry: { matcher: "Bash", hooks: [hook] } };
    }
    case "gemini":
      return {
        event: "BeforeTool",
        entry: {
          matcher: "run_shell_command",
          hooks: [{ type: "command", name: "cloudpin", command: cmd, timeout: 60000 }],
        },
      };
    case "cursor":
      return {
        event: "beforeShellExecution",
        entry: { command: cmd, matcher: CURSOR_MATCHER, timeout: 60 },
        version: 1,
      };
    case "copilot":
      return {
        event: "preToolUse",
        entry: {
          type: "command",
          matcher: "bash|powershell",
          bash: cmd,
          powershell: root ? windowsCommand(agent, root) : cmd,
          timeoutSec: 60,
        },
        version: 1,
      };
    case "antigravity":
      throw new Error("Antigravity's file has no top-level hooks list"); // handled by name below
  }
}

/**
 * The file content with cloudpin's hook added (unchanged if already there).
 * `root` is windowsRoot() for the machine running install-hook: on Windows a
 * bare Codex or Copilot entry is upgraded in place to the Windows form, while
 * without it (macOS, Linux) an entry already in the Windows form is kept, so a
 * teammate's re-run of a committed file changes nothing.
 */
export function planInstall(
  agent: AgentName,
  existing: string | null,
  root: string | null = null,
): { content: string; alreadyInstalled: boolean } {
  const settings = parse(existing);
  if (agent === "antigravity") {
    if (Object.values(settings).some(mentionsCloudpin)) return { content: existing!, alreadyInstalled: true };
    settings[ANTIGRAVITY_HOOK] = antigravityEntry();
    return { content: render(settings), alreadyInstalled: false };
  }
  if (existing !== null && existing.includes(command(agent))) {
    const changed =
      (agent === "cursor" && updateCursorMatcher(settings)) || (root !== null && updateWindowsCommand(agent, settings, root));
    return changed ? { content: render(settings), alreadyInstalled: false } : { content: existing, alreadyInstalled: true };
  }
  const { event, entry, version } = layout(agent, root);
  if (version !== undefined && settings.version === undefined) {
    // Keep "version" first, as the agents' documented examples do.
    const reordered: Json = { version };
    for (const [k, v] of Object.entries(settings)) reordered[k] = v;
    Object.keys(settings).forEach((k) => delete settings[k]);
    Object.assign(settings, reordered);
  }
  const hooks = (settings.hooks && typeof settings.hooks === "object" ? settings.hooks : {}) as Json;
  const list = Array.isArray(hooks[event]) ? (hooks[event] as unknown[]) : [];
  hooks[event] = [...list, entry];
  settings.hooks = hooks;
  return { content: render(settings), alreadyInstalled: false };
}

const mentionsCloudpin = (value: unknown) => JSON.stringify(value).includes(MARKER);

/**
 * The line install-hook prints after writing `content`, or null. Codex runs a
 * user or project hook only while its trust hash matches, and on Windows the
 * hash covers `commandWindows` (codex-rs/hooks/src/engine/discovery.rs), so a
 * hook written or upgraded with the Windows form waits for a review in /hooks.
 */
export function afterInstallNote(agent: AgentName, content: string): string | null {
  return agent === "codex" && content.includes(command(agent)) && !bareInPowerShell(agent, content)
    ? "cloudpin: Codex runs the changed hook only after you review it in /hooks."
    : null;
}

const isWindowsForm = (value: unknown) =>
  typeof value === "string" && /\\cmd\.exe \/d \/s \/c "set NoDefaultCurrentDirectoryInExePath=1&& cloudpin hook /i.test(value);

/**
 * True when the agent runs cloudpin's hook in `content` on Windows as the bare
 * command through PowerShell, which picks npm's cloudpin.ps1 for it: Gemini
 * CLI always (no Windows-only field), Codex and Copilot CLI unless their
 * Windows-only field holds the Windows form. False for a file that isn't JSON.
 */
export function bareInPowerShell(agent: AgentName, content: string): boolean {
  let settings: Json;
  try {
    settings = parse(content);
  } catch {
    return false;
  }
  const hooks = settings.hooks as Json | undefined;
  const list = (event: string) => (Array.isArray(hooks?.[event]) ? (hooks[event] as Json[]) : []);
  switch (agent) {
    case "gemini":
      return mentionsCloudpin(settings);
    case "codex":
      return list("PreToolUse").some(
        (group) =>
          Array.isArray(group.hooks) &&
          (group.hooks as Json[]).some((h) => mentionsCloudpin(h) && !isWindowsForm(h.commandWindows ?? h.command_windows)),
      );
    case "copilot":
      // `command` is Copilot's cross-platform fallback when `powershell` is absent.
      return list("preToolUse").some((e) => mentionsCloudpin(e) && !isWindowsForm(e.powershell ?? e.command));
    default:
      return false;
  }
}

/**
 * Sets the Windows form on cloudpin's Codex and Copilot entries (layout());
 * true if any changed. Codex also reads `command_windows`, and two spellings
 * of one field would make its file unreadable, so that one is dropped.
 */
function updateWindowsCommand(agent: AgentName, settings: Json, root: string): boolean {
  const win = windowsCommand(agent, root);
  const hooks = settings.hooks as Json | undefined;
  const list = (event: string) => (Array.isArray(hooks?.[event]) ? (hooks[event] as Json[]) : []);
  let changed = false;
  const set = (entry: Json, key: string) => {
    // Windows paths ignore case: a file written where SystemRoot is C:\WINDOWS
    // is current where it is C:\Windows. Rewriting it would change Codex's
    // trust hash, so the hook would stop until reviewed, and flip back elsewhere.
    if (typeof entry[key] === "string" && (entry[key] as string).toLowerCase() === win.toLowerCase()) return;
    entry[key] = win;
    changed = true;
  };
  if (agent === "codex") {
    for (const group of list("PreToolUse")) {
      if (!Array.isArray(group.hooks)) continue;
      for (const hook of group.hooks as Json[]) {
        if (!mentionsCloudpin(hook)) continue;
        if ("command_windows" in hook) {
          delete hook.command_windows;
          changed = true;
        }
        set(hook, "commandWindows");
      }
    }
  } else if (agent === "copilot") {
    for (const entry of list("preToolUse")) if (mentionsCloudpin(entry)) set(entry, "powershell");
  }
  return changed;
}

/** Sets the current matcher on cloudpin's Cursor entries; true if any changed. */
function updateCursorMatcher(settings: Json): boolean {
  const hooks = settings.hooks as Json | undefined;
  const list = Array.isArray(hooks?.beforeShellExecution) ? (hooks.beforeShellExecution as Json[]) : [];
  let changed = false;
  for (const entry of list) {
    if (mentionsCloudpin(entry) && entry.matcher !== CURSOR_MATCHER) {
      entry.matcher = CURSOR_MATCHER;
      changed = true;
    }
  }
  return changed;
}

/**
 * The file content with cloudpin's hook removed. `content: null` means the
 * file should be deleted (Copilot's file belongs to cloudpin alone).
 */
export function planUninstall(agent: AgentName, existing: string | null): { found: boolean; content: string | null } {
  if (existing === null) return { found: false, content: null };
  const settings = parse(existing);
  if (!mentionsCloudpin(settings)) return { found: false, content: existing };
  if (agent === "copilot") return { found: true, content: null };
  if (agent === "antigravity") {
    for (const name of Object.keys(settings)) if (mentionsCloudpin(settings[name])) delete settings[name];
    return { found: true, content: Object.keys(settings).length === 0 ? null : render(settings) };
  }

  const { event } = layout(agent);
  const hooks = settings.hooks as Json;
  const list = (hooks[event] as Json[]).flatMap((group): Json[] => {
    if (!Array.isArray(group.hooks)) return mentionsCloudpin(group) ? [] : [group];
    const inner = (group.hooks as unknown[]).filter((h) => !mentionsCloudpin(h));
    return inner.length === 0 ? [] : [{ ...group, hooks: inner }];
  });
  if (list.length > 0) hooks[event] = list;
  else delete hooks[event];
  if (Object.keys(hooks).length === 0 && agent !== "cursor") delete settings.hooks;
  return { found: true, content: render(settings) };
}
