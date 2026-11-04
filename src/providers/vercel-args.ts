// How the Vercel CLI parses its arguments, read by vercel.ts (#147 moved this here).
import { lstatSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { isDynamic } from "../word-expansion.js";

// Global options (vercel/vercel packages/cli/src/util/arg-common.ts globalCommandOptions; 50.35).
const GLOBAL_BOOLEAN_FLAGS: Readonly<Record<string, string>> = {
  "--help": "--help", "-h": "--help", "--version": "--version", "-v": "--version",
  "--debug": "--debug", "-d": "--debug", "--no-color": "--no-color", "--non-interactive": "--non-interactive",
};
const GLOBAL_VALUE_FLAGS = new Set([
  "--cwd", "--global-config", "-Q", "--local-config", "-A", "--scope", "-S", "--team", "-T", "--token", "-t", "--api",
]);
// Built-in commands and aliases (src/commands/index.ts; 50.35) that print their help and stop
// on --help or -h. Left out because they can run anyway: `promote <id>` and `rollback <id>`
// show help only without a deployment, and `rolling-release`/`rr` look for a literal --help or
// -h word, so `-dh` runs them. Any other word may be an extension (vercel-<word>), which Vercel
// runs without the --help it parsed itself (src/util/extension/exec.ts).
export const HELP_COMMANDS = new Set([
  "activity", "agent", "alerts", "alias", "aliases", "ln", "api", "bisect", "blob", "build", "buy", "cache",
  "certs", "cert", "contract", "crons", "cron", "curl", "deploy", "dev", "develop", "dns", "domains", "domain",
  "env", "flags", "git", "httpstat", "init", "inspect", "install", "i", "integration", "integration-resource",
  "ir", "link", "list", "ls", "logs", "log", "mcp", "microfrontends", "mf", "open", "project", "projects",
  "pull", "redeploy", "redirects", "redirect", "remove", "rm", "routes", "skills", "target", "targets", "teams",
  "team", "upgrade", "usage", "webhooks", "webhook",
]);
// Every built-in command and alias (src/commands/index.ts `commands`; 50.35). Any other first
// word runs an extension vercel-<word> if one is installed, else deploys that word as a path.
// `guidance` and `metrics` join only with FF_GUIDANCE_MODE / FF_METRICS set; read as a deploy
// path they add a folder's link to the check, never remove one.
const COMMANDS = new Set([
  ...HELP_COMMANDS, "help", "login", "logout", "promote", "rollback", "rolling-release", "rr", "switch",
  "telemetry", "whoami",
]);

/** The options a parse knows: the globals, plus a command's own (getFlagsSpecification). */
interface Spec {
  booleans: ReadonlySet<string>;
  values: ReadonlySet<string>;
}
const GLOBALS: Spec = { booleans: new Set(Object.keys(GLOBAL_BOOLEAN_FLAGS)), values: GLOBAL_VALUE_FLAGS };
const commandSpec = (booleans: string, values: string): Spec => ({
  booleans: new Set([...GLOBALS.booleans, ...booleans.split(" ")]),
  values: new Set([...GLOBALS.values, ...values.split(" ")]),
});
// The commands that link a path argument (50.35: src/commands/deploy/command.ts deployCommand
// and initSubcommand, pull/command.ts, dev/command.ts; shared options from arg-common.ts).
const DEPLOY = commandSpec(
  "-f --force --with-cache -p --public --prebuilt --prod --no-wait --skip-domain -y --yes -l --logs --guidance --no-logs --no-clipboard --json -c --confirm",
  "-e --env -b --build-env -m --meta --regions --archive -n --name --target -F --format",
);
const DEPLOY_INIT = commandSpec(
  "-f --force --with-cache -p --public --prod --skip-domain -y --yes --json -c --confirm",
  "-e --env -b --build-env -m --meta --regions --archive --target -F --format",
);
const PULL = commandSpec("--prod -y --yes", "--environment --git-branch");
const DEV = commandSpec("-L --local -y --yes -c --confirm", "-l --listen -p --port");

interface MainParse {
  /** Positionals, with the flags the spec doesn't know when permissive; the first is the command. */
  positionals: string[];
  /** The boolean flags seen; the global ones by long name. */
  flags: Set<string>;
}

/**
 * The arguments as Vercel's main() parses them (packages/cli/src/index.ts, src/util/get-args.ts):
 * arg 5.0.0 with the global options and `{ permissive: true }`. A flag it doesn't know, or an
 * unknown letter of a short group, is kept as a positional and the rest of the group is still
 * read, so `-dy whoami` has the command `-y`: no command and no extension has that name, so
 * Vercel deploys. Every word after "--" is a positional. Undefined when arg would throw (a value
 * flag not last in its group, or without a value), which stops Vercel before any command runs.
 */
export const mainParse = (args: string[]) => argParse(args, GLOBALS, true);

/**
 * The arguments as arg 5.0.0 parses them with `spec` (src/util/get-args.ts parseArguments).
 * Not permissive, as commands parse, an unknown flag is an error: undefined.
 */
function argParse(args: string[], spec: Spec, permissive: boolean): MainParse | undefined {
  const positionals: string[] = [];
  const flags = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const word = args[i]!;
    if (word === "--") {
      positionals.push(...args.slice(i + 1));
      break;
    }
    if (word.length < 2 || word[0] !== "-") {
      positionals.push(word);
      continue;
    }
    const parts = word[1] === "-" || word.length === 2 ? [word] : word.slice(1).split("").map((c) => `-${c}`);
    for (let j = 0; j < parts.length; j++) {
      const part = parts[j]!;
      const eq = part.startsWith("--") ? part.indexOf("=") : -1;
      const name = eq === -1 ? part : part.slice(0, eq);
      if (spec.booleans.has(name)) {
        flags.add(GLOBAL_BOOLEAN_FLAGS[name] ?? name);
      } else if (!spec.values.has(name)) {
        if (!permissive) return undefined;
        positionals.push(part);
      } else if (eq === -1) {
        const value = args[i + 1];
        if (j < parts.length - 1 || value === undefined || (value.length > 1 && value[0] === "-")) return undefined;
        i++;
      }
    }
  }
  return { positionals, flags };
}

/**
 * The arguments as Vercel's parser sees them, so a short group's flags and value are read
 * (#125). Vercel parses with arg 5.0.0 (vercel/vercel packages/cli/package.json;
 * github.com/vercel/arg index.js, tag 5.0.0), which splits a single-dash word longer than two
 * characters into one flag per letter (`-dT` is `-d -T`); a last letter that takes a value
 * reads the next word, and a value letter anywhere else is an error. A value never starts
 * with "-", so splitting every such word before "--" is exact.
 */
export function splitShortGroups(args: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--") return [...out, ...args.slice(i)];
    if (arg.length > 2 && arg[0] === "-" && arg[1] !== "-") out.push(...arg.slice(1).split("").map((c) => `-${c}`));
    else out.push(arg);
  }
  return out;
}

const isDirectory = (path: string) => {
  try {
    return lstatSync(path).isDirectory();
  } catch {
    return false;
  }
};

/**
 * The folders whose link a command acts on (#147), given `base`, the folder after --cwd (which
 * Vercel chdirs into: Client `set cwd`). Most commands link `base`; these link the folder their
 * path argument names (vercel 50.35):
 * - deploy (src/commands/deploy/index.ts): deploy_default picks the subcommand from a permissive
 *   parse; `continue` links `base` (its required --id already fails the default parse); else
 *   the positionals after "deploy" (and "init") are paths resolved against `base`,
 *   validatePaths (src/util/validate-paths.ts) stops unless the first is a directory (lstat),
 *   and ensureLink links it. A path Vercel refuses deploys nothing, so `base` is read.
 * - a first word that is no command (src/index.ts main): Vercel runs vercel-<word> in `base`
 *   if it finds one (src/util/extension/exec.ts), else deploys the word. cloudpin can't tell
 *   which, so both folders count: a wrong link in either blocks.
 * - pull (src/commands/pull/index.ts): `parsedArgs.args[1] || client.cwd`, used unchecked.
 * - dev (src/commands/dev/index.ts): the first argument after "dev" (Vercel refuses a second;
 *   reading the first anyway only adds a check).
 * Undefined when the word that names the folder is known only when the command runs (#160), or
 * the first word is: that one may be any command, or the folder itself.
 */
export function linkDirs(args: string[], base: string): string[] | undefined {
  const command = mainParse(args)?.positionals[0];
  if (command && isDynamic(command)) return undefined;
  const at = (path: string | undefined) => (path ? resolvePath(base, path) : base);
  const named = (path: string | undefined) => (path && isDynamic(path) ? undefined : [at(path)]);
  if (command === "pull") return named(argParse(args, PULL, false)?.positionals[1]);
  if (command === "dev" || command === "develop") {
    const words = argParse(args, DEV, false)?.positionals.slice(1) ?? [];
    return named(words[0] === "dev" ? words[1] : words[0]);
  }
  if (!command || (command !== "deploy" && COMMANDS.has(command))) return [base];

  const strip = (words: string[], word: string) => (words[0] === word ? words.slice(1) : words);
  const sub = strip(argParse(args, DEPLOY, true)?.positionals ?? [], "deploy")[0];
  let paths: string[] = [];
  if (sub === "init") paths = strip(strip(argParse(args, DEPLOY_INIT, false)?.positionals ?? [], "deploy"), "init");
  else if (sub !== "continue") paths = strip(argParse(args, DEPLOY, false)?.positionals ?? [], "deploy");
  if (paths[0] && isDynamic(paths[0])) return undefined;
  const target = paths.length > 0 && isDirectory(at(paths[0])) ? at(paths[0]) : base;
  return command === "deploy" || target === base ? [target] : [base, target];
}
