import { join } from "node:path";
import { flagValue, hasBareFlag, leadingWords } from "../args.js";
import { appData, home } from "../paths.js";
import type { ProviderDef } from "../types.js";

const DEFAULT_HOST = "github.com";
const EXEMPT_COMMANDS = new Set(["auth", "version", "help", "completion"]);
// Built-in commands and their aliases (`gh help reference` and each `--help`, gh 2.88), where
// cobra prints the help instead of running the command. Left out: `copilot`, and any other word
// (an extension or an alias), which gets --help as an argument (DisableFlagParsing in cli/cli
// pkg/cmd/copilot, pkg/cmd/root/extension.go and alias.go).
const HELP_COMMANDS = new Set([
  "agent-task", "agent-tasks", "agent", "agents", "alias", "api", "attestation", "at", "browse", "cache",
  "codespace", "cs", "config", "extension", "extensions", "ext", "gist", "gpg-key", "issue", "label",
  "licenses", "org", "pr", "preview", "project", "release", "repo", "ruleset", "rs", "run", "search",
  "secret", "ssh-key", "status", "variable", "workflow",
]);
// Groups whose subcommand decides: `extension exec` also passes --help on (DisableFlagParsing in
// pkg/cmd/extension/command.go), and cobra gives -h to a command's own flag when it has one:
// --homepage in `repo create`/`repo new`/`repo edit`, --host in `config get/list/set`.
const SUBCOMMAND_GROUPS = new Set(["extension", "extensions", "ext", "repo", "config"]);
const NOT_HELP = new Set(["exec"]);
const H_NOT_HELP = new Set(["repo create", "repo new", "repo edit", "config get", "config list", "config set"]);
// gh exits 4 when a command needs authentication (`gh help exit-codes`).
const EXIT_AUTH_REQUIRED = 4;
const TOKEN_VARS = ["GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN"];

export const github: ProviderDef<"github"> = {
  name: "github",
  bins: ["gh"],
  statusCommand: "gh auth status",
  // The flags resolve reads (#160).
  targetFlags: ["--hostname"],

  cacheInputs(env) {
    // hosts.yml holds the active user per host; `gh auth switch` rewrites it.
    const dirs = [env.GH_CONFIG_DIR, env.XDG_CONFIG_HOME && join(env.XDG_CONFIG_HOME, "gh"),
      appData(env) && join(appData(env)!, "GitHub CLI"), join(home(env), ".config", "gh")];
    return {
      env: [...TOKEN_VARS, "GH_HOST", "GH_CONFIG_DIR", "XDG_CONFIG_HOME"],
      files: dirs.filter((d): d is string => Boolean(d)).map((d) => join(d, "hosts.yml")),
      dirs: [],
    };
  },

  isExempt(args) {
    const [first, second] = leadingWords(args);
    // --version is a flag of the root command only (#146). With a flag before the first word,
    // cobra still finds the command after it, so only flags alone are read here.
    if (first === undefined) {
      return args.every((a) => a.startsWith("-")) && hasBareFlag(args, ["--version", "--help", "-h"]);
    }
    if (EXEMPT_COMMANDS.has(first)) return true;
    if (!HELP_COMMANDS.has(first)) return false;
    if (SUBCOMMAND_GROUPS.has(first)) {
      // A word after a flag may still be the subcommand; with none, it's the group's own help.
      if (second === undefined && args.slice(1).some((a) => !a.startsWith("-"))) return false;
      if (second !== undefined && NOT_HELP.has(second)) return false;
    }
    if (hasBareFlag(args, ["--help"])) return true;
    return hasBareFlag(args, ["-h"]) && !H_NOT_HELP.has(`${first} ${second}`);
  },

  async resolve({ args, env }, exec) {
    const host = flagValue(args, ["--hostname"]) ?? env.GH_HOST ?? DEFAULT_HOST;
    // Asking the API (instead of reading gh's config) means GH_TOKEN,
    // GITHUB_TOKEN and enterprise tokens are honoured exactly as gh would.
    const res = await exec("gh", ["api", "user", "--hostname", host, "--jq", ".login"], env);
    if (res.code === EXIT_AUTH_REQUIRED) {
      return { kind: "logged-out", hint: `gh auth login --hostname ${host}` };
    }
    const login = res.stdout.trim();
    if (res.code !== 0 || login === "") {
      // gh prints its reason as "gh: <message>" on stderr (e.g. "gh: Bad credentials (HTTP 401)").
      const reason = /^gh: .+$/m.exec(res.stderr)?.[0].trim().slice(0, 300);
      // Token variables silently replace the stored login (`gh help environment`);
      // name the one in effect, never its value.
      const tokenVar = TOKEN_VARS.find((name) => env[name]);
      const note = tokenVar ? `; note: ${tokenVar} is set and is used instead of your gh login` : "";
      return { kind: "error", message: `${reason ?? `gh api user failed (exit ${res.code})`}${note}` };
    }
    return { kind: "identity", identity: { user: login, host }, source: "gh api user" };
  },

  compare(pin, identity) {
    const out: string[] = [];
    const host = pin.host ?? DEFAULT_HOST;
    if (identity.host?.toLowerCase() !== host.toLowerCase()) {
      out.push(`host: expected "${host}", active is "${identity.host}"`);
    }
    // GitHub logins are case-insensitive.
    if (identity.user?.toLowerCase() !== pin.user.toLowerCase()) {
      out.push(`user: expected "${pin.user}", active is "${identity.user}"`);
    }
    return out;
  },

  switchHint(pin) {
    const host = pin.host && pin.host !== DEFAULT_HOST ? ` --hostname ${pin.host}` : "";
    return `gh auth switch${host} --user ${pin.user}`;
  },
};
