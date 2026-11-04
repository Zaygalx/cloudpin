import { win32 } from "node:path";
import type { Check, DoctorDeps } from "./doctor.js";
import type { AgentName } from "./hooks/agents.js";
import { bareInPowerShell, claudePluginEnabled, hookFile, windowsRoot, type Scope } from "./install.js";
import { isNewer } from "./update.js";

// cloudpin doctor's Windows checks (#108), split from src/doctor.ts (#141).

/** The agents that run hooks through PowerShell on Windows (research for #108: each agent's source or docs). */
const POWERSHELL_AGENTS: AgentName[] = ["codex", "gemini", "copilot"];

/**
 * Codex and Copilot CLI hooks in the bare form, and every Gemini CLI hook,
 * under an execution policy that blocks npm's cloudpin.ps1, the file
 * PowerShell picks for a bare `cloudpin`. Asks the PowerShell the agents
 * prefer (pwsh when on PATH, else Windows PowerShell) for its effective
 * policy, and only when such a hook is installed and that shim is there.
 */
async function executionPolicyChecks(d: DoctorDeps): Promise<Check[]> {
  const bare = POWERSHELL_AGENTS.flatMap((agent) =>
    (["project", "user"] as Scope[])
      .filter((scope) => {
        const content = d.read(hookFile(agent, scope, d.cwd, d.env));
        return content !== null && content.includes(`cloudpin hook ${agent}`) && bareInPowerShell(agent, content);
      })
      .map((scope) => ({ agent, scope })),
  );
  if (bare.length === 0) return [];
  const shim = d.onPath("cloudpin");
  if (shim === null || d.read(win32.join(win32.dirname(shim), "cloudpin.ps1")) === null) return [];
  const bin = d.onPath("pwsh") ? "pwsh" : "powershell";
  const r = await d.guard.exec(bin, ["-NoProfile", "-NonInteractive", "-Command", "Get-ExecutionPolicy"], d.env);
  const policy = r.code === 0 ? r.stdout.trim() : "";
  if (!["Restricted", "AllSigned"].includes(policy)) return [];
  return bare.map(({ agent, scope }): Check => ({
    id: "exec-policy",
    level: "warn",
    title: `${agent} hook (${scope === "user" ? "personal" : "project"}): PowerShell's execution policy is ${policy}, so the hook can't start`,
    detail: [
      `${agent} runs \`cloudpin hook ${agent}\` through PowerShell, which picks npm's cloudpin.ps1, and ${policy} blocks that script`,
      agent === "copilot" ? "Copilot CLI then denies every tool call" : "the agent then runs commands without cloudpin's check",
    ],
    fix:
      agent === "gemini"
        ? "Set-ExecutionPolicy -Scope CurrentUser RemoteSigned (Gemini CLI has no Windows-only hook command, so its hook needs cloudpin.ps1)"
        : `cloudpin install-hook ${agent}${scope === "user" ? " --user" : ""}`,
  }));
}

// Claude Code 2.1.47's changelog: hooks on Windows run through Git Bash "instead of cmd.exe".
const CLAUDE_GIT_BASH = "2.1.47";

/** Windows only: what could make an agent's hook start something other than cloudpin, or not start (#108). */
export async function windowsChecks(d: DoctorDeps): Promise<Check[]> {
  if (d.platform !== "win32") return [];
  const checks: Check[] = [];
  if (windowsRoot(d.env, d.platform) === null) {
    checks.push({
      id: "hook-shell",
      level: "warn",
      title: "SystemRoot is not a plain folder path such as C:\\Windows",
      detail: ["so install-hook writes the bare command for Codex and Copilot CLI, which PowerShell runs through cloudpin.ps1"],
      fix: "check SystemRoot in a new terminal, then run cloudpin install-hook again for those agents",
    });
  }
  checks.push(...(await executionPolicyChecks(d)));

  const path = Object.entries(d.env).find(([k]) => k.toUpperCase() === "PATH")?.[1] ?? "";
  const relative = path
    .split(";")
    .map((e) => (e.length > 1 && e.startsWith('"') && e.endsWith('"') ? e.slice(1, -1) : e))
    .filter((e) => e !== "" && !win32.isAbsolute(e));
  if (relative.length > 0) {
    checks.push({
      id: "path-relative",
      level: "warn",
      title: "PATH has entries that are not full paths",
      detail: [
        relative.map((e) => `"${e}"`).join(", "),
        "shells read them from the current folder, so a program in a repository could run in place of a real one, cloudpin included",
      ],
      fix: "remove them from PATH, or write each as a full path",
    });
  }

  const claudeHook =
    claudePluginEnabled(d.read, d.cwd, d.env) ||
    (["project", "user"] as Scope[]).some((scope) => d.read(hookFile("claude", scope, d.cwd, d.env))?.includes("cloudpin hook claude"));
  if (claudeHook) {
    const r = await d.guard.exec("claude", ["--version"], d.env);
    const version = r.code === 0 ? /\d+\.\d+\.\d+/.exec(r.stdout)?.[0] : undefined;
    if (version !== undefined && isNewer(CLAUDE_GIT_BASH, version)) {
      checks.push({
        id: "claude-version",
        level: "warn",
        title: `Claude Code ${version} runs hooks through cmd.exe`,
        detail: ["cmd.exe looks for cloudpin and node in the project folder before PATH; from 2.1.47 Claude Code uses Git Bash"],
        fix: "update Claude Code: claude update",
      });
    }
  }
  return checks;
}
