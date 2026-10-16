import { join } from "node:path";
import type { GuardDeps } from "./guard.js";
import { AGENTS, type AgentName } from "./hooks/agents.js";
import { claudePluginEnabled, hookFile, planInstall, type Scope } from "./install.js";
import { cacheDir, home } from "./paths.js";
import { collectStatus, describe } from "./status.js";
import { isNewer, updateCheckAllowed } from "./update.js";

export type Level = "ok" | "warn" | "fail" | "info";

export interface Check {
  /** Stable name for --json, e.g. "path" or "cli:github". */
  id: string;
  level: Level;
  title: string;
  detail?: string[];
  fix?: string;
  /** Account IDs and names in this check, shortened in --json. */
  values?: string[];
}

export interface DoctorDeps {
  guard: GuardDeps;
  env: NodeJS.ProcessEnv;
  cwd: string;
  platform: NodeJS.Platform;
  /** This cloudpin's version and where it runs from. */
  version: string;
  self: string;
  node: string;
  read: (path: string) => string | null;
  writable: (dir: string) => boolean;
  /** Where a bare command name resolves on PATH, or null. */
  onPath: (name: string) => string | null;
  /** cloudpin's latest version on npm, or null if it can't be reached. */
  latest: () => Promise<string | null>;
}

// package.json "engines".
const MIN_NODE = 22;

const SHELL_LINES = {
  bash: 'eval "$(cloudpin shell-init bash)"',
  zsh: 'eval "$(cloudpin shell-init zsh)"',
  pwsh: "cloudpin shell-init pwsh | Out-String | Invoke-Expression",
};

/**
 * Profile files a shell reads at start-up, for the current user. PowerShell's
 * are from about_Profiles (learn.microsoft.com, PowerShell 7.6): on Windows
 * `Documents\PowerShell` (7) and `Documents\WindowsPowerShell` (5.1), where
 * Documents can be redirected to OneDrive; elsewhere `~/.config/powershell`.
 */
export function profileFiles(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): string[] {
  const h = home(env);
  const files = [".bashrc", ".bash_profile", ".profile"].map((f) => join(h, f));
  files.push(join(env.ZDOTDIR ?? h, ".zshrc"));
  const names = ["Microsoft.PowerShell_profile.ps1", "profile.ps1"];
  if (platform === "win32") {
    const docs = [join(env.USERPROFILE ?? h, "Documents"), ...(env.OneDrive ? [join(env.OneDrive, "Documents")] : [])];
    for (const d of docs) for (const dir of ["PowerShell", "WindowsPowerShell"]) for (const n of names) files.push(join(d, dir, n));
  } else {
    for (const n of names) files.push(join(h, ".config", "powershell", n));
  }
  return files;
}

async function selfChecks(d: DoctorDeps): Promise<Check[]> {
  const checks: Check[] = [{ id: "cloudpin", level: "ok", title: `cloudpin ${d.version}`, detail: [`running from ${d.self}`] }];
  const major = Number.parseInt(d.node, 10);
  checks.push(
    major >= MIN_NODE
      ? { id: "node", level: "ok", title: `Node.js ${d.node}` }
      : { id: "node", level: "fail", title: `Node.js ${d.node} is too old`, fix: `install Node.js ${MIN_NODE} or later` },
  );
  // You asked, so no terminal is needed; the switches that turn the daily notice off still count.
  if (!updateCheckAllowed(d.env, true)) {
    checks.push({ id: "update", level: "info", title: "newer version: not checked (update check off)" });
  } else {
    const latest = await d.latest();
    checks.push(
      latest === null
        ? { id: "update", level: "info", title: "newer version: npm could not be reached" }
        : isNewer(latest, d.version)
          ? { id: "update", level: "warn", title: `cloudpin ${latest} is available (you have ${d.version})`, fix: "npm install --global cloudpin" }
          : { id: "update", level: "ok", title: `latest version (${latest} on npm)` },
    );
  }
  const onPath = d.onPath("cloudpin");
  if (onPath === null) {
    checks.push({
      id: "path",
      level: "fail",
      title: "no cloudpin on PATH",
      detail: ["agent hooks and the shell lines run `cloudpin` by name, so they are not checking anything"],
      fix: "npm install --global cloudpin",
    });
    return checks;
  }
  const r = await d.guard.exec("cloudpin", ["--version"], d.env);
  const version = r.stdout.trim();
  if (r.code !== 0 || version === "") {
    checks.push({ id: "path", level: "warn", title: `the cloudpin on PATH (${onPath}) did not report a version`, fix: "npm install --global cloudpin" });
  } else if (version !== d.version) {
    checks.push({
      id: "path",
      level: "warn",
      title: `the cloudpin on PATH is ${version}, this one is ${d.version}`,
      detail: [`on PATH: ${onPath}`, "agent hooks and the shell lines run the one on PATH"],
      fix: "npm install --global cloudpin",
    });
  } else {
    checks.push({ id: "path", level: "ok", title: `on PATH: ${onPath}` });
  }
  return checks;
}

/**
 * The current user's profiles as PowerShell itself reports them: `$PROFILE`
 * is the documented way to find them (about_Profiles), and the only one that
 * sees a Documents folder redirected to another drive. `-NoProfile`, so no
 * profile code runs; Windows PowerShell and PowerShell 7 each have their own.
 */
async function powershellProfiles(d: DoctorDeps): Promise<string[]> {
  const files: string[] = [];
  for (const bin of ["powershell", "pwsh"]) {
    const r = await d.guard.exec(
      bin,
      ["-NoProfile", "-NonInteractive", "-Command", "$PROFILE.CurrentUserAllHosts; $PROFILE.CurrentUserCurrentHost"],
      d.env,
    );
    if (r.code === 0) files.push(...r.stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean));
  }
  return files;
}

async function shellCheck(d: DoctorDeps): Promise<Check> {
  const candidates = [...profileFiles(d.platform, d.env), ...(d.platform === "win32" ? await powershellProfiles(d) : [])];
  const found = [...new Set(candidates)].filter((f) => d.read(f)?.includes("cloudpin shell-init"));
  if (found.length > 0) {
    return {
      id: "shell",
      level: "ok",
      title: `shell wrappers: set up in ${found.join(", ")}`,
      detail: ["a terminal opened before the line was added is not guarded until you open a new one"],
    };
  }
  const fix =
    d.platform === "win32"
      ? `add to your PowerShell profile ($PROFILE): ${SHELL_LINES.pwsh}`
      : /zsh/.test(d.env.SHELL ?? "")
        ? `add to ~/.zshrc: ${SHELL_LINES.zsh}`
        : `add to ~/.bashrc: ${SHELL_LINES.bash}`;
  return {
    id: "shell",
    level: "warn",
    title: "shell wrappers: no shell profile runs cloudpin shell-init",
    detail: ["commands you type in a terminal are not checked (agent hooks are separate)"],
    fix,
  };
}

function hookChecks(d: DoctorDeps): Check[] {
  const checks: Check[] = [];
  for (const agent of Object.keys(AGENTS) as AgentName[]) {
    for (const scope of ["project", "user"] as Scope[]) {
      const file = hookFile(agent, scope, d.cwd, d.env);
      const content = d.read(file);
      if (content === null || !content.includes(`cloudpin hook ${agent}`)) continue;
      const where = `${agent} hook (${scope === "user" ? "personal" : "project"})`;
      const install = `cloudpin install-hook ${agent}${scope === "user" ? " --user" : ""}`;
      let current: boolean;
      try {
        current = planInstall(agent, content).alreadyInstalled;
      } catch {
        checks.push({
          id: "hook",
          level: "fail",
          title: `${where}: ${file} is not valid JSON`,
          detail: ["the agent can't read it either, so the hook may not run"],
          fix: `fix or move the file, then run ${install}`,
        });
        continue;
      }
      checks.push(
        current
          ? { id: "hook", level: "ok", title: `${where}: ${file}` }
          : {
              id: "hook",
              level: "warn",
              title: `${where}: out of date in ${file}`,
              detail: ["an older cloudpin wrote it; it may miss commands this version checks"],
              fix: install,
            },
      );
    }
  }
  if (claudePluginEnabled(d.read, d.cwd, d.env)) {
    checks.unshift({ id: "hook", level: "ok", title: "claude plugin: enabled (it guards Claude Code)" });
    for (const scope of ["project", "user"] as Scope[]) {
      if (!d.read(hookFile("claude", scope, d.cwd, d.env))?.includes("cloudpin hook claude")) continue;
      const where = scope === "user" ? "personal" : "project";
      checks.push({
        id: "hook-twice",
        level: "warn",
        title: `claude: the cloudpin plugin and a ${where} settings hook both guard Claude Code`,
        detail: ["Claude Code runs both, so every command is checked twice"],
        fix: `cloudpin uninstall-hook claude${scope === "user" ? " --user" : ""}`,
      });
    }
  }
  if (checks.length === 0) {
    checks.push({
      id: "hooks",
      level: "info",
      title: "agent hooks: none installed here or for your user",
      fix: `cloudpin install-hook <agent> [--user]  (${Object.keys(AGENTS).join(", ")})`,
    });
  }
  return checks;
}

// Identity values that identify nobody, so --json keeps them.
const PUBLIC_VALUES = new Set(["github.com", "default"]);

async function pinAndCliChecks(d: DoctorDeps): Promise<Check[]> {
  // Fresh answers from each CLI, as `cloudpin check` does: no cache.
  const status = await collectStatus(d.guard, d.cwd, d.env, () => []);
  const checks: Check[] = [];
  if (status.configError) {
    checks.push({
      id: "pins",
      level: "fail",
      title: `pin file: invalid (${status.configError})`,
      detail: ["every guarded command here is stopped until it is fixed"],
      fix: "fix the file (README, Configuration)",
    });
  } else if (status.pinFile === null) {
    checks.push({ id: "pins", level: "info", title: "pin file: none here or in any parent folder", fix: "cloudpin init" });
  } else {
    const env = status.environment;
    checks.push({
      id: "pins",
      level: "ok",
      title: `pin file: ${status.pinFile}`,
      ...(env
        ? { detail: [`environment: ${env.name}${env.protected ? " (protected)" : ""}, chosen by ${env.source}`] }
        : {}),
    });
  }

  for (const p of status.providers) {
    const provider = d.guard.providers.find((x) => x.name === p.name)!;
    const id = `cli:${p.name}`;
    if (p.state === "not-installed") {
      checks.push({ id, level: "info", title: `${p.name}: not installed` });
    } else if (p.state === "logged-out") {
      const pinned = status.pinFile !== null && !status.configError && pinnedHere(d, p.name);
      checks.push({
        id,
        level: pinned ? "warn" : "info",
        title: `${p.name}: not logged in`,
        ...(pinned ? { detail: ["it is pinned here, so its commands are stopped until you log in"] } : {}),
        fix: p.hint,
      });
    } else if (p.state === "no-target") {
      const pinned = pinnedHere(d, p.name);
      checks.push({
        id,
        level: pinned ? "fail" : "info",
        title: `${p.name}: nothing in this folder says which project or account`,
        detail: [p.message, ...(pinned ? ["it is pinned here, so its commands will be stopped"] : [])],
      });
    } else if (p.state === "error") {
      const pinned = pinnedHere(d, p.name);
      checks.push({
        id,
        level: pinned ? "fail" : "warn",
        title: `${p.name}: could not tell which account is active`,
        detail: [p.message, ...(pinned ? ["it is pinned here, so its commands will be stopped"] : [])],
        fix: provider.statusCommand,
      });
    } else {
      const values = [...Object.values(p.identity), ...Object.values(p.pin ?? {})].filter((v) => v && !PUBLIC_VALUES.has(v));
      if (!p.pin) {
        checks.push({ id, level: "info", title: `${p.name}: ${describe(p.identity)} (not pinned here)`, values });
      } else if (p.match) {
        checks.push({ id, level: "ok", title: `${p.name}: ${describe(p.identity)} matches the pin`, values });
      } else {
        checks.push({
          id,
          level: "fail",
          title: `${p.name}: the active account does not match the pin`,
          detail: p.problems ?? [],
          fix: provider.switchHint(p.pin as never),
          values,
        });
      }
    }
  }
  return checks;
}

function pinnedHere(d: DoctorDeps, name: string): boolean {
  try {
    return Boolean(d.guard.findConfig(d.cwd, d.env)?.pins[name as never]);
  } catch {
    return false;
  }
}

function cacheCheck(d: DoctorDeps): Check {
  if (d.env.CLOUDPIN_NO_CACHE === "1") return { id: "cache", level: "info", title: "identity cache: off (CLOUDPIN_NO_CACHE=1)" };
  const dir = cacheDir(d.env);
  return d.writable(dir)
    ? { id: "cache", level: "ok", title: `identity cache: ${dir}` }
    : {
        id: "cache",
        level: "warn",
        title: `identity cache: can't write ${dir}`,
        detail: ["commands are still checked, only slower: each one asks the CLI again"],
        fix: "set CLOUDPIN_CACHE_DIR to a folder you can write, or CLOUDPIN_NO_CACHE=1",
      };
}

/** Every check, read-only: cloudpin, shell wrappers, agent hooks, the pin file, each CLI, the cache. */
export async function runDoctor(d: DoctorDeps): Promise<Check[]> {
  return [...(await selfChecks(d)), await shellCheck(d), ...hookChecks(d), ...(await pinAndCliChecks(d)), cacheCheck(d)];
}

const tildify = (text: string, env: NodeJS.ProcessEnv) => text.split(home(env)).join("~");

const LABEL: Record<Level, string> = { ok: "ok  ", warn: "warn", fail: "fail", info: "-   " };

/** One line per check, its details and fix underneath, then a summary line. */
export function formatDoctor(checks: Check[], env: NodeJS.ProcessEnv): string[] {
  const lines: string[] = [];
  for (const c of checks) {
    lines.push(tildify(`  ${LABEL[c.level]}  ${c.title}`, env));
    for (const line of c.detail ?? []) lines.push(tildify(`        ${line}`, env));
    if (c.fix) lines.push(tildify(`        fix: ${c.fix}`, env));
  }
  const fails = checks.filter((c) => c.level === "fail").length;
  const warns = checks.filter((c) => c.level === "warn").length;
  lines.push(
    "",
    fails + warns === 0
      ? "Everything cloudpin needs looks right."
      : `${fails} problem${fails === 1 ? "" : "s"}, ${warns} warning${warns === 1 ? "" : "s"}.`,
  );
  return lines;
}

/** Shortens an account ID or name to its last four characters. */
const shorten = (value: string) => `…${value.length > 4 ? value.slice(-4) : ""}`;

/**
 * The checks as JSON for a bug report, safe to paste in a public issue:
 * account IDs and names shortened to their last four characters, the home
 * folder written as ~. Nothing in it comes from the environment's values.
 */
export function doctorJson(checks: Check[], d: Pick<DoctorDeps, "version" | "node" | "platform" | "env">) {
  const clean = (c: Check) => {
    const values = [...new Set(c.values ?? [])].sort((a, b) => b.length - a.length);
    const scrub = (s: string) => tildify(values.reduce((t, v) => t.split(v).join(shorten(v)), s), d.env);
    const { values: _values, ...rest } = c;
    return {
      ...rest,
      title: scrub(c.title),
      ...(c.detail ? { detail: c.detail.map(scrub) } : {}),
      ...(c.fix ? { fix: scrub(c.fix) } : {}),
    };
  };
  return { cloudpin: d.version, node: d.node, platform: d.platform, checks: checks.map(clean) };
}
