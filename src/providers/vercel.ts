import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative, resolve as resolvePath, sep } from "node:path";
import { commandWords, flagValue, hasAnyFlag } from "../args.js";
import { home } from "../paths.js";
import type { Exec, ProviderDef, Resolution } from "../types.js";

// Behaviour below was observed on vercel 50.35 through `--debug` request URLs,
// running read-only commands:
// - account-level requests use --scope/--team, else the global current team;
// - project-level requests use the linked project's orgId, overridden by
//   VERCEL_ORG_ID; a --team flag does not change the project lookup.
// A command may touch both, so both must be the pinned team.

const EXEMPT_COMMANDS = new Set(["login", "logout", "switch", "whoami", "help", "telemetry"]);
const EXEMPT_TEAMS_SUBCOMMANDS = new Set(["ls", "list", "switch"]);
// Global options that take a value (`vercel <command> --help`, Global Options; 50.35).
const GLOBAL_VALUE_FLAGS = new Set([
  "--cwd", "--global-config", "-Q", "--local-config", "-A", "--scope", "-S", "--team", "-T", "--token", "-t",
]);

/**
 * The arguments as Vercel's parser sees them, so a short group's flags and value are read
 * (#125). Vercel parses with arg 5.0.0 (vercel/vercel packages/cli/package.json;
 * github.com/vercel/arg index.js, tag 5.0.0), which splits a single-dash word longer than two
 * characters into one flag per letter (`-dT` is `-d -T`); a last letter that takes a value
 * reads the next word, and a value letter anywhere else is an error. A value never starts
 * with "-", so splitting every such word before "--" is exact.
 */
function splitShortGroups(args: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--") return [...out, ...args.slice(i)];
    if (arg.length > 2 && arg[0] === "-" && arg[1] !== "-") out.push(...arg.slice(1).split("").map((c) => `-${c}`));
    else out.push(arg);
  }
  return out;
}

interface Team {
  id: string;
  slug: string;
  current?: boolean;
}

/** Where `vercel login` may keep its credentials; only existence is checked. */
function loginDirs(env: NodeJS.ProcessEnv): string[] {
  const home = env.HOME ?? env.USERPROFILE ?? homedir();
  const dirs: string[] = [];
  if (env.APPDATA) {
    // Docs say xdg.data; this machine's CLI actually uses Data.
    dirs.push(join(env.APPDATA, "com.vercel.cli", "Data"), join(env.APPDATA, "xdg.data", "com.vercel.cli"));
  }
  if (env.XDG_DATA_HOME) dirs.push(join(env.XDG_DATA_HOME, "com.vercel.cli"));
  dirs.push(
    join(home, ".local", "share", "com.vercel.cli"),
    join(home, "Library", "Application Support", "com.vercel.cli"),
  );
  return dirs;
}

const readJson = (path: string): Record<string, unknown> | undefined => {
  try {
    const value: unknown = JSON.parse(readFileSync(path, "utf8"));
    return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
};
const nonEmpty = (v: unknown): v is string => typeof v === "string" && v !== "";

/**
 * The `scope` of the local config Vercel reads at startup (vercel/vercel packages/cli/src/
 * util/get-config.ts, called in src/index.ts before `--cwd` changes folder): the `-A` file,
 * resolved against the folder the command runs in, else vercel.json there, else now.json
 * (read up to vercel 50; later versions refuse it and exit). A file Vercel would fail on, or
 * that cloudpin cannot read, is an error: the command's team can't be told.
 */
function localScope(cwd: string, file: string | undefined): string | undefined | { error: string } {
  const paths = file !== undefined ? [resolvePath(cwd, file)] : [join(cwd, "vercel.json"), join(cwd, "now.json")];
  const found: unknown[] = [];
  for (const path of paths) {
    if (file === undefined && !existsSync(path)) continue;
    try {
      found.push(JSON.parse(readFileSync(path, "utf8")));
    } catch {
      return { error: `could not read ${path} as JSON, so the scope Vercel would use is unknown` };
    }
  }
  const config = found[0];
  return config && typeof config === "object" && nonEmpty((config as { scope?: unknown }).scope)
    ? (config as { scope: string }).scope
    : undefined;
}

interface RepoProject {
  id?: unknown;
  name?: unknown;
  directory?: unknown;
  orgId?: unknown;
}

/**
 * The teams of the projects a command in `dir` can act on, as the Vercel CLI
 * picks them (vercel/vercel packages/cli/src/util/projects/link.ts and
 * util/link/repo.ts): a `.vercel/project.json` in the folder itself, else the
 * nearest `.vercel/repo.json` above it (`vercel link --repo`, below the home
 * folder), using the deepest project whose directory holds the folder, or every
 * project when none does (the CLI would then ask). Empty when not linked.
 */
function linkedTeams(dir: string, project: string | undefined, homeDir: string): string[] | { error: string } {
  const own = readJson(join(dir, ".vercel", "project.json"));
  // A project.json without both IDs (e.g. settings only, from `vercel pull`) is not a link.
  if (own && nonEmpty(own.orgId) && nonEmpty(own.projectId)) return [own.orgId];

  for (let current = dir; current !== homeDir; ) {
    const repoPath = join(current, ".vercel", "repo.json");
    if (existsSync(repoPath)) {
      const repo = readJson(repoPath);
      const all = (Array.isArray(repo?.projects) ? repo.projects : []) as RepoProject[];
      const rel = relative(current, dir).split(sep).join("/") || ".";
      const holding = all
        .filter((p) => typeof p.directory === "string")
        .filter((p) => p.directory === "." || rel === p.directory || rel.startsWith(`${p.directory as string}/`));
      const depthOf = (p: RepoProject) => (p.directory === "." ? 0 : (p.directory as string).split("/").length);
      const deepest = Math.max(-1, ...holding.map(depthOf));
      let candidates = holding.filter((p) => depthOf(p) === deepest);
      if (candidates.length === 0) candidates = all;
      if (project) {
        const named = candidates.filter((p) => p.id === project || p.name === project);
        if (named.length > 0) candidates = named;
      }
      const teams = new Set<string>();
      for (const p of candidates) {
        const org = nonEmpty(p.orgId) ? p.orgId : repo?.orgId;
        if (!nonEmpty(org)) return { error: `${repoPath} has no orgId for project "${String(p.name ?? p.id)}"; re-link it with vercel link --repo` };
        teams.add(org);
      }
      return [...teams].sort();
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return [];
}

// Each page is one more CLI call; past this, something is wrong.
const MAX_TEAM_PAGES = 25;

/**
 * Every team the user belongs to. `vercel teams ls --format json` returns one
 * page, `{ teams, pagination: { next } }`, and `--next <ms>` asks for the
 * following one (`vercel teams ls --help`). All pages are read: the team
 * marked current may be on any of them, and missing it would wrongly mean the
 * Hobby team. Pages that never end, or repeat, fail closed.
 */
async function listTeams(exec: Exec, common: string[], env: NodeJS.ProcessEnv): Promise<Team[] | Resolution> {
  const teams: Team[] = [];
  let next: number | undefined;
  for (let page = 0; page < MAX_TEAM_PAGES; page++) {
    const args = ["teams", "ls", "--format", "json", ...(next === undefined ? [] : ["--next", String(next)]), ...common];
    const listed = await exec("vercel", args, env);
    if (listed.code !== 0) return failure(listed.stderr, listed.code, "vercel teams ls");
    let body: { teams?: Team[]; pagination?: { next?: unknown } };
    try {
      body = JSON.parse(listed.stdout) as typeof body;
    } catch {
      return { kind: "error", message: "could not read vercel teams ls output" };
    }
    teams.push(...(body.teams ?? []));
    const following = body.pagination?.next;
    if (typeof following !== "number" || !following) return teams;
    if (following === next) return { kind: "error", message: "vercel teams ls pages did not advance" };
    next = following;
  }
  return { kind: "error", message: `vercel teams ls returned more than ${MAX_TEAM_PAGES} pages` };
}

function failure(stderr: string, code: number, what: string): Resolution {
  const reason = /^Error: (.+)$/m.exec(stderr)?.[1]?.trim().slice(0, 300);
  return { kind: "error", message: reason ? `vercel: ${reason}` : `${what} failed (exit ${code})` };
}

export const vercel: ProviderDef<"vercel"> = {
  name: "vercel",
  bins: ["vercel", "vc"],
  statusCommand: "vercel whoami",

  cacheInputs(env) {
    // config.json holds currentTeam (`vercel switch` rewrites it); auth.json is
    // only stat'ed, never read. The linked project is read fresh every time.
    return {
      env: ["VERCEL_TOKEN", "VERCEL_ORG_ID", "VERCEL_PROJECT_ID", "XDG_DATA_HOME", "APPDATA", "HOME"],
      files: loginDirs(env).flatMap((d) => [join(d, "config.json"), join(d, "auth.json")]),
      dirs: [],
    };
  },

  isExempt(args) {
    if (hasAnyFlag(args, ["--version", "-v", "--help", "-h"])) return true;
    const [first, second] = commandWords(splitShortGroups(args), GLOBAL_VALUE_FLAGS);
    if (first === undefined) return false;
    if (EXEMPT_COMMANDS.has(first)) return true;
    return first === "teams" && second !== undefined && EXEMPT_TEAMS_SUBCOMMANDS.has(second);
  },

  async resolve({ args: typed, env, cwd }, exec) {
    const args = splitShortGroups(typed);
    const token = flagValue(args, ["--token", "-t"]);
    const globalConfig = flagValue(args, ["--global-config", "-Q"]);

    // Logged out, vercel waits for a login indefinitely (even non-interactive),
    // so detect that first from the presence of a token or a login file.
    const dirs = globalConfig ? [resolvePath(cwd, globalConfig)] : loginDirs(env);
    if (!token && !env.VERCEL_TOKEN && !dirs.some((d) => existsSync(join(d, "auth.json")))) {
      return { kind: "logged-out", hint: "vercel login" };
    }

    // Vercel's order (packages/cli/src/index.ts): --scope || --team || the local config's
    // scope; arg keeps the last occurrence of each flag.
    const local = localScope(cwd, flagValue(args, ["--local-config", "-A"]));
    if (typeof local === "object") return { kind: "error", message: local.error };
    const explicit = flagValue(args, ["--scope", "-S"]) || flagValue(args, ["--team", "-T"]) || local;

    const common = ["--non-interactive"];
    if (token) common.push("--token", token);
    if (globalConfig) common.push("--global-config", globalConfig);

    const listed = await listTeams(exec, common, env);
    if (!Array.isArray(listed)) return listed;
    const teams = listed;
    const toId = (value: string) => teams.find((t) => t.id === value || t.slug === value)?.id ?? value;
    const slugOf = (id: string) => teams.find((t) => t.id === id)?.slug ?? "";

    // The team account-level requests use.
    let team: string;
    if (explicit) {
      team = toId(explicit);
    } else {
      const current = teams.find((t) => t.current);
      if (current) {
        team = current.id;
      } else {
        // No current team: the CLI uses the user's Hobby team.
        const user = await exec("vercel", ["api", "/v2/user", "--raw", ...common], env);
        if (user.code !== 0) return failure(user.stderr, user.code, "vercel api /v2/user");
        try {
          team = (JSON.parse(user.stdout) as { user: { defaultTeamId: string } }).user.defaultTeamId;
        } catch {
          return { kind: "error", message: "could not read vercel api /v2/user output" };
        }
      }
    }

    const identity: Record<string, string> = { team, label: slugOf(team) };
    // The team project-level requests use.
    const projectDir = resolvePath(cwd, flagValue(args, ["--cwd"]) ?? ".");
    let projectTeams: string[];
    if (env.VERCEL_ORG_ID) {
      projectTeams = [env.VERCEL_ORG_ID];
    } else {
      const linked = linkedTeams(projectDir, flagValue(args, ["--project"]), home(env));
      if ("error" in linked) return { kind: "error", message: linked.error };
      projectTeams = linked;
    }
    // Several when a repository link leaves the project open; each must be the pinned team.
    if (projectTeams.length > 0) identity.projectTeam = [...new Set(projectTeams.map(toId))].join(",");
    return { kind: "identity", identity, source: "vercel teams ls" };
  },

  compare(pin, identity) {
    const out: string[] = [];
    if (identity.team !== pin.team) {
      const slug = identity.label ? ` (${identity.label})` : "";
      out.push(`team: expected "${pin.team}", active is "${identity.team}"${slug}`);
    }
    for (const projectTeam of identity.projectTeam?.split(",") ?? []) {
      if (projectTeam !== pin.team) {
        out.push(`linked project: belongs to team "${projectTeam}", expected "${pin.team}"`);
      }
    }
    return out;
  },

  switchHint(pin) {
    // `vercel switch [name]` takes a slug, so open the picker and name the ID.
    return `vercel switch (choose the team with ID ${pin.team})`;
  },
};
