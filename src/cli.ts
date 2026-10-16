#!/usr/bin/env node
import spawn from "cross-spawn";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { cachedExec } from "./cache.js";
import { checkExitCode, formatCheckText, parseCheckArgs, runCheck } from "./check.js";
import { doctorJson, formatDoctor, runDoctor } from "./doctor.js";
import { explain, formatExplain } from "./explain.js";
import { createHandler, serve } from "./mcp.js";
import { cloudpinTools } from "./mcp-tools.js";
import { confirmProtected } from "./confirm.js";
import { CONFIG_FILE, ConfigError, findConfig } from "./config.js";
import { realExec } from "./exec.js";
import { formatBlock } from "./format.js";
import { guard, type GuardDeps } from "./guard.js";
import { AGENTS, runHook, type AgentName } from "./hooks/agents.js";
import { flagValue } from "./args.js";
import { addEnvironment, discover, renderConfig, type FoundIdentity } from "./init.js";
import { claudePluginEnabled, hookFile, installedHooks, planInstall, planUninstall } from "./install.js";
import { cacheDir, findOnPath } from "./paths.js";
import { shellInit } from "./shell-init.js";
import { buildStatus, collectStatus } from "./status.js";
import { checksForUpdates, fetchLatest, refreshIfStale, savedNotice, updateCheckAllowed } from "./update.js";
import { useCommand } from "./use.js";
import { providers } from "./providers/index.js";

/** Exit code for a blocked command, distinct from the usual 1 and 2. */
export const EXIT_BLOCKED = 3;

const USAGE = `cloudpin: a seatbelt for your cloud CLIs

Usage:
  cloudpin init [--env <name> [--protected]] [--yes] [--force]
                              Pin the accounts you are logged into now, in ./.cloudpin.yml
                              (--env adds them as one environment of the file)
  cloudpin check [--only <clouds>] [--json]
                              Check every CLI pinned in the nearest .cloudpin.yml
                              (--only azure,aws: just these, each must be installed and logged in;
                              --json: the result as JSON, for CI)
  cloudpin status [--json]    Show each CLI's active account, the pins here, and installed hooks
  cloudpin explain [--json] [--agent] -- <cmd...>
                              What cloudpin would decide for a command, and why, without running it
                              (one quoted argument is read as a full shell line; --agent: as an agent hook)
  cloudpin mcp                Read-only MCP server for agents (stdio): cloudpin_status, cloudpin_check
  cloudpin doctor [--json]    Check the whole setup (PATH, shell, hooks, pins, CLIs) and say what to fix
                              (--json is safe to paste in a bug report)
  cloudpin use [<env> | --clear]
                              Show the environments, or choose the one to use in this clone
  cloudpin exec -- <cmd...>   Run <cmd> only if it would act on the pinned account
                              (on a protected environment, changing commands ask first)
  cloudpin hook <agent>       Agent hook; reads the hook JSON on stdin
                              (claude, codex, copilot, gemini, antigravity, cursor)
  cloudpin install-hook <agent> [--user] [--yes]
  cloudpin uninstall-hook <agent> [--user] [--yes]
                              Add or remove the agent hook in this project's
                              settings (or your personal settings with --user)
  cloudpin shell-init <bash|zsh|pwsh>
                              Print shell functions that guard every supported CLI
  cloudpin version, --version

Exit codes: 0 ok, 1 usage or check failure, ${EXIT_BLOCKED} command blocked.`;

// `check` always asks the CLIs directly; `exec` and the hooks use the short-lived
// identity cache (src/cache.ts), which CLOUDPIN_NO_CACHE=1 turns off.
const onPath = (bin: string, env: NodeJS.ProcessEnv) => findOnPath(bin, env, process.platform, existsSync);
const deps: GuardDeps = { providers, exec: realExec, findConfig, onPath };
const cachedDeps: GuardDeps = {
  ...deps,
  wrapExec: (provider, env, exec) =>
    cachedExec(exec, provider.cacheInputs(env), { cacheDir: cacheDir(), env: process.env }),
};

async function init(flags: string[]): Promise<number> {
  const path = join(process.cwd(), CONFIG_FILE);
  const force = flags.includes("--force");
  // --env <name> adds one environment (pinned to the accounts active now) to
  // the file, or starts the file with it; without it, init writes the flat format.
  const envName = flagValue(flags, ["--env"]);
  const existing = existsSync(path) ? readFileSync(path, "utf8") : null;
  const render = (found: FoundIdentity[]) =>
    envName === undefined ? renderConfig(found) : addEnvironment(existing, envName, flags.includes("--protected"), found, force);
  if (envName === undefined && existing !== null && !force) {
    console.error(`cloudpin init: ${path} already exists (use --force to replace it, or --env <name> to add an environment)`);
    return 1;
  }
  try {
    render([]); // Report a flat file, a taken name or an invalid file before asking the CLIs.
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(`cloudpin init: ${path}: ${err.message}`);
      return 1;
    }
    throw err;
  }
  console.log("cloudpin: reading the accounts your CLIs are logged into...");
  const { found, skipped } = await discover(providers, realExec, process.env, process.cwd(), onPath);
  for (const line of skipped) console.log(`  skipped ${line}`);
  if (found.length === 0) {
    console.error("cloudpin init: no logged-in CLI found; log in to the accounts this project uses first.");
    return 1;
  }
  const text = render(found);
  console.log(`\nProposed ${CONFIG_FILE}:\n\n${text}`);
  if (!flags.includes("--yes")) {
    if (!process.stdin.isTTY) {
      console.error("cloudpin init: not a terminal; re-run with --yes to write the file.");
      return 1;
    }
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const answer = await rl.question(`Pin these accounts to this project? [y/N] `);
    rl.close();
    if (!/^y(es)?$/i.test(answer.trim())) {
      console.log("cloudpin init: nothing written.");
      return 1;
    }
  }
  writeFileSync(path, text);
  console.log(`cloudpin: wrote ${path}. Commit it so everyone on the project is protected.`);
  return 0;
}

const CHECK_USAGE = "usage: cloudpin check [--only <clouds>] [--json]";

async function check(args: string[]): Promise<number> {
  const parsed = parseCheckArgs(args);
  if ("error" in parsed) {
    console.error(`cloudpin check: ${parsed.error}\n${CHECK_USAGE}`);
    return 1;
  }
  const report = await runCheck(process.cwd(), process.env, deps, parsed.only ? { only: parsed.only } : {});
  if (parsed.json) {
    // stdout carries the JSON and nothing else.
    console.log(JSON.stringify(report, null, 2));
    return checkExitCode(report);
  }
  // An invalid pin file goes to stderr, as it always did.
  for (const line of formatCheckText(report)) (report.error !== undefined ? console.error : console.log)(line);
  return checkExitCode(report);
}

/** A file's text, or null if it can't be read. */
const readOrNull = (path: string): string | null => {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
};

const isDir = (path: string): boolean => statSync(path, { throwIfNoEntry: false })?.isDirectory() ?? false;

const version =() => (createRequire(import.meta.url)("../package.json") as { version: string }).version;

/** True if cloudpin can create and remove a file in `dir` (its own cache folder). */
function writable(dir: string): boolean {
  const probe = join(dir, `.cloudpin-doctor-${process.pid}`);
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(probe, "");
    rmSync(probe);
    return true;
  } catch {
    return false;
  }
}

/**
 * `explain [--json] [--agent] [--] <cmd...>`: one argument is a full shell line,
 * several are one command's argv. Read-only; exit 0 whatever the verdict.
 */
async function explainCommand(argv: string[]): Promise<number> {
  // Only leading --json / --agent are cloudpin's; everything after is the command's.
  const flags = new Set<string>();
  let i = 0;
  while (argv[i] === "--json" || argv[i] === "--agent") flags.add(argv[i++]!);
  if (argv[i] === "--") i++;
  const words = argv.slice(i);
  if (words.length === 0) {
    console.error('cloudpin explain: give a command, e.g. cloudpin explain -- vercel deploy --prod, or a line in quotes');
    return 1;
  }
  const command = words.length === 1 ? words[0]! : words;
  const mode = flags.has("--agent") ? "agent" : "shell";
  const calls = await explain(command, { mode, cwd: process.cwd(), env: process.env }, deps);
  if (flags.has("--json")) console.log(JSON.stringify({ mode, calls }, null, 2));
  else for (const line of formatExplain(calls, process.env)) console.log(line);
  return 0;
}

async function doctor(flags: string[]): Promise<number> {
  const d = {
    guard: deps,
    env: process.env,
    cwd: process.cwd(),
    platform: process.platform,
    version: version(),
    self: process.argv[1] ?? "",
    node: process.versions.node,
    read: readOrNull,
    writable,
    onPath: (name: string) => onPath(name, process.env),
    latest: () => fetchLatest(fetch, 3000),
  };
  const checks = await runDoctor(d);
  if (flags.includes("--json")) console.log(JSON.stringify(doctorJson(checks, d), null, 2));
  else {
    console.log("cloudpin doctor\n");
    for (const line of formatDoctor(checks, process.env)) console.log(line);
  }
  return checks.some((c) => c.level === "fail") ? 1 : 0;
}

async function exec(argv: string[]): Promise<number> {
  const [bin, ...args] = argv;
  if (!bin) {
    console.error("cloudpin exec: missing command after --");
    return 1;
  }
  const verdict = await guard({ bin, args, env: process.env, cwd: process.cwd(), mode: "shell" }, cachedDeps);
  if (verdict.action === "block") {
    console.error(formatBlock(verdict, argv, "shell"));
    return EXIT_BLOCKED;
  }
  if (verdict.action === "confirm") {
    // The prompt goes to stderr so `cmd | jq` keeps a clean stdout.
    const confirmed = await confirmProtected(verdict, argv, {
      isTTY: Boolean(process.stdin.isTTY && process.stderr.isTTY),
      ask: async (question) => {
        const rl = createInterface({ input: process.stdin, output: process.stderr });
        try {
          return await rl.question(question);
        } finally {
          rl.close();
        }
      },
      print: (line) => console.error(line),
    });
    if (!confirmed) return EXIT_BLOCKED;
  }
  return new Promise((resolve) => {
    const child = spawn(bin, args, { stdio: "inherit" });
    child.on("error", (err) => {
      console.error(`cloudpin exec: ${err.message}`);
      resolve(127);
    });
    child.on("close", (code) => resolve(code ?? 1));
  });
}

async function confirm(flags: string[], question: string): Promise<boolean> {
  if (flags.includes("--yes")) return true;
  if (!process.stdin.isTTY) {
    console.error("cloudpin: not a terminal; re-run with --yes to apply.");
    return false;
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(`${question} [y/N] `);
  rl.close();
  return /^y(es)?$/i.test(answer.trim());
}

async function hookSetup(action: "install" | "uninstall", agent: string | undefined, flags: string[]): Promise<number> {
  if (agent === undefined || !Object.hasOwn(AGENTS, agent)) {
    console.error(`cloudpin ${action}-hook: unsupported agent "${agent ?? ""}" (supported: ${Object.keys(AGENTS).join(", ")})`);
    return 1;
  }
  const name = agent as AgentName;
  const path = hookFile(name, flags.includes("--user") ? "user" : "project", process.cwd(), process.env);
  const existing = existsSync(path) ? readFileSync(path, "utf8") : null;
  try {
    if (action === "install") {
      // The plugin's hook and a settings copy would both run (code.claude.com/docs/en/hooks).
      if (name === "claude" && claudePluginEnabled(readOrNull, process.cwd(), process.env)) {
        console.log("cloudpin: the cloudpin plugin already guards Claude Code here; uninstall the plugin first if you want the settings hook instead.");
        return 0;
      }
      const plan = planInstall(name, existing);
      if (plan.alreadyInstalled) {
        console.log(`cloudpin: the ${name} hook is already in ${path}`);
        return 0;
      }
      console.log(`cloudpin: ${existing === null ? "create" : "update"} ${path} to:\n\n${plan.content}`);
      if (!(await confirm(flags, "Write this file?"))) return 1;
      if (existing !== null) writeFileSync(`${path}.cloudpin-backup`, existing);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, plan.content);
      console.log(`cloudpin: installed${existing !== null ? ` (previous file saved as ${path}.cloudpin-backup)` : ""}.`);
    } else {
      const plan = planUninstall(name, existing);
      if (!plan.found) {
        console.log(`cloudpin: no cloudpin hook in ${path}`);
        return 0;
      }
      console.log(
        plan.content === null
          ? `cloudpin: delete ${path} (it holds only cloudpin's hook)`
          : `cloudpin: update ${path} to:\n\n${plan.content}`,
      );
      if (!(await confirm(flags, "Apply this change?"))) return 1;
      writeFileSync(`${path}.cloudpin-backup`, existing!);
      if (plan.content === null) rmSync(path);
      else writeFileSync(path, plan.content);
      console.log(`cloudpin: removed (previous file saved as ${path}.cloudpin-backup).`);
    }
    return 0;
  } catch (err) {
    console.error(`cloudpin ${action}-hook: ${path}: ${(err as Error).message}`);
    return 1;
  }
}

async function readStdin(): Promise<string> {
  let data = "";
  for await (const chunk of process.stdin) data += String(chunk);
  return data;
}

async function hook(agent: string | undefined): Promise<number> {
  if (agent === undefined || !Object.hasOwn(AGENTS, agent)) {
    console.error(`cloudpin hook: unsupported agent "${agent ?? ""}" (supported: ${Object.keys(AGENTS).join(", ")})`);
    return 1;
  }
  const out = await runHook(AGENTS[agent as AgentName], await readStdin(), cachedDeps, process.env);
  if (out) process.stdout.write(`${out}\n`);
  return 0;
}

export async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  switch (command) {
    case "init":
      return init(rest);
    case "check":
      return check(rest);
    case "use": {
      const result = useCommand(rest, process.cwd(), process.env);
      for (const line of result.lines) (result.code === 0 ? console.log : console.error)(line);
      return result.code;
    }
    case "exec":
      return exec(rest[0] === "--" ? rest.slice(1) : rest);
    case "hook":
      return hook(rest[0]);
    case "status": {
      const hooks = () => installedHooks(readOrNull, process.cwd(), process.env);
      if (rest.includes("--json")) {
        console.log(JSON.stringify(await collectStatus(cachedDeps, process.cwd(), process.env, hooks), null, 2));
        return 0;
      }
      for (const line of await buildStatus(cachedDeps, process.cwd(), process.env, hooks)) console.log(line);
      return 0;
    }
    case "explain":
      return explainCommand(rest);
    case "mcp": {
      // Fresh answers (no identity cache), like check and explain. stdout carries only JSON-RPC lines.
      const tools = cloudpinTools(deps, { cwd: process.cwd(), env: process.env, read: readOrNull, isDir });
      await serve(createHandler({ version: version(), tools }), process.stdin, process.stdout);
      return 0;
    }
    case "doctor":
      return doctor(rest);
    case "install-hook":
      return hookSetup("install", rest[0], rest.slice(1));
    case "uninstall-hook":
      return hookSetup("uninstall", rest[0], rest.slice(1));
    case "shell-init":
      try {
        process.stdout.write(shellInit(rest[0] ?? "", providers.flatMap((p) => p.bins)));
        return 0;
      } catch (err) {
        console.error(`cloudpin shell-init: ${(err as Error).message}`);
        return 1;
      }
    case "version":
    case "--version":
    case "-v": {
      console.log(version());
      return 0;
    }
    case undefined:
    case "help":
    case "--help":
    case "-h":
      console.log(USAGE);
      return 0;
    default:
      console.error(`cloudpin: unknown command "${command}"\n\n${USAGE}`);
      return 1;
  }
}

/**
 * After the command: the saved update notice, then at most once a day a fresh
 * look at npm (src/update.ts). Only for cloudpin's own interactive commands.
 */
async function updateNotice(command: string | undefined): Promise<void> {
  if (!checksForUpdates(command) || !updateCheckAllowed(process.env, Boolean(process.stdout.isTTY && process.stderr.isTTY))) return;
  const stateFile = join(cacheDir(), "update-check.json");
  const notice = savedNotice(version(), stateFile);
  if (notice) console.error(`\n${notice}`);
  await refreshIfStale({ now: Date.now, stateFile, fetchLatest: () => fetchLatest() });
}

const argv = process.argv.slice(2);
process.exitCode = await main(argv);
await updateNotice(argv[0]);
