import { join } from "node:path";
import type { AgentName } from "./hooks/agents.js";
import { home } from "./paths.js";
import { providers } from "./providers/index.js";

export type Scope = "project" | "user";

const MARKER = "cloudpin hook";
const command = (agent: AgentName) => `${MARKER} ${agent}`;
// Cursor runs the hook only for commands matching this regex: as words, every
// name the hook inspects (each guarded CLI, and cloudpin itself for `cloudpin
// use`). Built from the providers so a new one can't be left out (#42).
const CURSOR_MATCHER = `\\b(${[...providers.flatMap((p) => p.bins), "cloudpin"].join("|")})\\b`;

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

/** Where in the file the agent keeps its hook list, and cloudpin's entry. */
function layout(agent: AgentName): { event: string; entry: Json; version?: number } {
  const cmd = command(agent);
  switch (agent) {
    case "claude":
      return {
        event: "PreToolUse",
        entry: { matcher: "Bash|PowerShell", hooks: [{ type: "command", command: cmd, timeout: 60 }] },
      };
    case "codex":
      return { event: "PreToolUse", entry: { matcher: "Bash", hooks: [{ type: "command", command: cmd }] } };
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
        entry: { type: "command", matcher: "bash|powershell", bash: cmd, powershell: cmd, timeoutSec: 60 },
        version: 1,
      };
    case "antigravity":
      throw new Error("Antigravity's file has no top-level hooks list"); // handled by name below
  }
}

/** The file content with cloudpin's hook added (unchanged if already there). */
export function planInstall(agent: AgentName, existing: string | null): { content: string; alreadyInstalled: boolean } {
  const settings = parse(existing);
  if (agent === "antigravity") {
    if (Object.values(settings).some(mentionsCloudpin)) return { content: existing!, alreadyInstalled: true };
    settings[ANTIGRAVITY_HOOK] = antigravityEntry();
    return { content: render(settings), alreadyInstalled: false };
  }
  if (existing !== null && existing.includes(command(agent))) {
    if (agent === "cursor" && updateCursorMatcher(settings)) return { content: render(settings), alreadyInstalled: false };
    return { content: existing, alreadyInstalled: true };
  }
  const { event, entry, version } = layout(agent);
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
