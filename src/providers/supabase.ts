import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve as resolvePath } from "node:path";
import { commandWords, flagValue, hasBareFlag } from "../args.js";
import { home } from "../paths.js";
import type { ProviderDef } from "../types.js";

// Sources: the CLI's command docs and source at github.com/supabase/cli
// (apps/cli: config/project-ref.layer.ts, config/command-settings.layer.ts,
// command-internal/db-target-flags.ts, commands/*/SIDE_EFFECTS.md; the Go
// code in apps/cli-go agrees), and `supabase --help` on 2.117.
//
// A command's project: --project-ref, then SUPABASE_PROJECT_ID, then the ref
// `supabase link` wrote to <workdir>/supabase/.temp/project-ref; with none, the
// CLI prompts on a terminal or fails. The workdir is --workdir, then
// SUPABASE_WORKDIR, else the nearest folder up with supabase/config.toml.

// Global options that take a value (`supabase --help`), and per-command ones
// that name the target.
export const VALUE_FLAGS = new Set([
  "--workdir", "--profile", "--output-format", "--output", "-o", "--log-level", "--completions", "--network-id",
  "--dns-resolver", "--agent", "--project-ref", "--project-id", "--db-url",
]);
// Account switching and the local stack never act on a remote project.
const EXEMPT_COMMANDS = new Set(["login", "logout", "link", "unlink", "init", "start", "stop", "status", "completion", "telemetry", "help"]);
const LOCAL_SUBCOMMANDS = new Set(["functions new", "functions serve", "migration new", "test new", "db start"]);
// Target the local database unless given --linked (db-target-flags.ts).
const LOCAL_BY_DEFAULT = new Set([
  "db reset", "db diff", "db lint", "db advisors", "migration up", "migration down", "migration squash",
]);
const PROJECT_REF = /^[a-z]{20}$/;
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);
const TOKEN_VAR = "SUPABASE_ACCESS_TOKEN";

/** A boolean flag's value: `--x` or `--x=true` is on, `--x=false` off; the last one wins. */
function boolFlag(args: string[], name: string): boolean {
  let on = false;
  for (const arg of args) {
    if (arg === "--") break;
    if (arg === name) on = true;
    else if (arg.startsWith(`${name}=`)) on = arg.slice(name.length + 1) !== "false";
  }
  return on;
}

function isLocalUrl(url: string): boolean {
  try {
    return LOCAL_HOSTS.has(new URL(url).hostname);
  } catch {
    return false;
  }
}

function workdir(args: string[], env: NodeJS.ProcessEnv, cwd: string): string {
  const given = flagValue(args, ["--workdir"]) ?? (env.SUPABASE_WORKDIR || undefined);
  if (given !== undefined) return resolvePath(cwd, given);
  for (let dir = cwd; ; dir = dirname(dir)) {
    if (existsSync(join(dir, "supabase", "config.toml"))) return dir;
    if (dirname(dir) === dir) return cwd;
  }
}

const read = (path: string): string | undefined => {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
};

/**
 * The first line of the CLI's error output. 2.117 prints errors as JSON, e.g.
 * {"_tag":"Error","error":{"code":"...","message":"..."}} (observed), so the
 * message is taken out of it.
 */
function errorMessage(text: string): string | undefined {
  const line = text.split(/\r?\n/).map((l) => l.trim()).find(Boolean);
  if (!line?.startsWith("{")) return line;
  try {
    const j = JSON.parse(line) as { message?: unknown; error?: { message?: unknown } };
    const message = j.error?.message ?? j.message;
    return typeof message === "string" ? message : line;
  } catch {
    return line;
  }
}

interface ListedProject {
  id?: unknown;
  ref?: unknown;
  organization_slug?: unknown;
  name?: unknown;
}

export const supabase: ProviderDef<"supabase"> = {
  name: "supabase",
  bins: ["supabase"],
  statusCommand: "supabase projects list",

  cacheInputs(env) {
    // The token may also be in the OS keyring, which can't be stamped; a
    // `supabase login` there shows up after the cache's five minutes.
    const dir = env.SUPABASE_HOME ?? join(home(env), ".supabase");
    return {
      // SUPABASE_PROJECT_ID and SUPABASE_WORKDIR pick the project, not the login; they are
      // listed so guard stops a command that sets them from an unknown value (#86, #133).
      env: [TOKEN_VAR, "SUPABASE_PROFILE", "SUPABASE_HOME", "SUPABASE_NO_KEYRING", "SUPABASE_PROJECT_ID", "SUPABASE_WORKDIR"],
      files: [join(dir, "access-token"), join(dir, "profile")],
      dirs: [],
    };
  },

  isExempt(args) {
    // effect/cli runs the help and version actions instead of the command wherever they come
    // before "--" (Effect-TS/effect-smol unstable/cli Command.ts runWith).
    if (hasBareFlag(args, ["--help", "-h", "--version", "-v"])) return true;
    const dbUrl = flagValue(args, ["--db-url"]);
    if (dbUrl !== undefined) return isLocalUrl(dbUrl);
    const words = commandWords(args, VALUE_FLAGS);
    if (EXEMPT_COMMANDS.has(words[0] ?? "")) return true;
    const pair = words.slice(0, 2).join(" ");
    if (LOCAL_SUBCOMMANDS.has(pair)) return true;
    // --db-url beats --local, which beats --linked (db-target-flags.ts).
    if (boolFlag(args, "--local")) return true;
    return LOCAL_BY_DEFAULT.has(pair) && !boolFlag(args, "--linked");
  },

  async resolve({ args, env, cwd }, exec) {
    if (flagValue(args, ["--db-url"]) !== undefined) {
      // Never echo the URL: it usually carries a password.
      return {
        kind: "error",
        message: "--db-url names a database by URL, so cloudpin can't tell which project it is; use --linked or --project-ref",
      };
    }
    const words = commandWords(args, VALUE_FLAGS);
    let ref: string | undefined;
    let source = "";
    let branch: string | undefined;
    if (words[0] === "projects" && words[1] === "delete" && words[2]) {
      [ref, source] = [words[2], "the projects delete argument"];
    } else if (flagValue(args, ["--project-ref"]) !== undefined) {
      [ref, source] = [flagValue(args, ["--project-ref"]), "--project-ref"];
    } else if (words[0] === "gen" && flagValue(args, ["--project-id"]) !== undefined) {
      [ref, source] = [flagValue(args, ["--project-id"]), "--project-id"];
    } else if (env.SUPABASE_PROJECT_ID) {
      [ref, source] = [env.SUPABASE_PROJECT_ID, "SUPABASE_PROJECT_ID"];
    } else {
      const temp = join(workdir(args, env, cwd), "supabase", ".temp");
      ref = read(join(temp, "project-ref"))?.trim() || undefined;
      source = "supabase/.temp/project-ref (supabase link)";
      // Linked to a branch, the file holds the branch's own ref; `link` keeps
      // the parent project in linked-project.json.
      const parent = read(join(temp, "linked-project.json"));
      if (ref && parent) {
        try {
          const p = (JSON.parse(parent) as { ref?: unknown }).ref;
          if (typeof p === "string" && PROJECT_REF.test(p) && p !== ref) [branch, ref] = [ref, p];
        } catch {
          // An unreadable cache file: compare the ref itself.
        }
      }
    }
    if (!ref) {
      return {
        kind: "error",
        noTarget: true,
        message: "no Supabase project for this command: run `supabase link --project-ref <ref>` here, or pass --project-ref",
      };
    }
    if (!PROJECT_REF.test(ref)) {
      return {
        kind: "error",
        message: `"${ref}" from ${source} is not a project ref (20 lowercase letters); cloudpin can't tell which project a branch name or ID belongs to`,
      };
    }

    // The organisation comes from the API: the one read-only list of the
    // projects the token can see (`supabase projects list --help`).
    const profile = flagValue(args, ["--profile"]);
    const res = await exec("supabase", ["projects", "list", "--output-format", "json", ...(profile ? ["--profile", profile] : [])], env);
    const note = env[TOKEN_VAR] ? `; note: ${TOKEN_VAR} is set and is used instead of your supabase login` : "";
    if (res.code !== 0) {
      const text = `${res.stderr}\n${res.stdout}`;
      if (/Access token not provided|need to be logged.in/i.test(text)) return { kind: "logged-out", hint: "supabase login" };
      const reason = errorMessage(text)?.slice(0, 300);
      return { kind: "error", message: `${reason ?? `supabase projects list failed (exit ${res.code})`}${note}` };
    }
    let projects: ListedProject[];
    try {
      const parsed = JSON.parse(res.stdout) as { projects?: ListedProject[] } | ListedProject[];
      projects = Array.isArray(parsed) ? parsed : (parsed.projects ?? []);
    } catch {
      return { kind: "error", message: "could not read the output of supabase projects list" };
    }
    const found = projects.find((p) => p.id === ref || p.ref === ref);
    if (!found) return { kind: "error", message: `the logged-in account can't see project ${ref}${note}` };
    const identity: Record<string, string> = { project: ref };
    if (typeof found.organization_slug === "string") identity.org = found.organization_slug;
    if (typeof found.name === "string") identity.name = found.name;
    if (branch) identity.branch = branch;
    return { kind: "identity", identity, source };
  },

  compare(pin, identity) {
    const out: string[] = [];
    // Project refs are lowercase by definition (PROJECT_REF).
    if (identity.project !== pin.project) out.push(`project: pinned "${pin.project}", the command would use "${identity.project}"`);
    if (pin.org !== undefined && identity.org !== pin.org) out.push(`org: pinned "${pin.org}", the project is in "${identity.org}"`);
    return out;
  },

  switchHint(pin) {
    return `supabase link --project-ref ${pin.project}`;
  },
};
