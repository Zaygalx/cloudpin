import { resolve } from "node:path";
import { doctorJson, runDoctor, type Check, type DoctorDeps } from "./doctor.js";
import { explain } from "./explain.js";
import type { GuardDeps } from "./guard.js";
import { installedHooks } from "./install.js";
import { createHandler, type McpTool } from "./mcp.js";
import { cacheDir } from "./paths.js";
import { collectStatus } from "./status.js";

/** What doctor needs to know about this cloudpin and machine, apart from the folder, environment and files. */
export type DoctorHost = Pick<DoctorDeps, "platform" | "version" | "self" | "install" | "realpath" | "node" | "onPath" | "latest">;

export interface ToolContext {
  /** The server's folder; Claude Code starts it in the project. */
  cwd: string;
  env: NodeJS.ProcessEnv;
  read: (path: string) => string | null;
  isDir: (path: string) => boolean;
  doctor: DoctorHost;
}

/**
 * `cloudpin doctor --json` for `cwd`, without its one write: the terminal doctor finds out whether the cache folder
 * can be written by creating it and a probe file in it (probeWritable, src/paths.ts). Here the probe is a stub
 * that writes nothing, and if doctor asked it, the cache check says it was not checked (#15: no tool changes anything).
 */
async function readOnlyDoctor(deps: GuardDeps, ctx: ToolContext, cwd: string) {
  let asked = false;
  const d: DoctorDeps = { guard: deps, env: ctx.env, cwd, read: ctx.read, writable: () => ((asked = true), true), ...ctx.doctor };
  const notChecked: Check = {
    id: "cache",
    level: "info",
    title: `identity cache: not checked (${cacheDir(ctx.env)})`,
    detail: ["checking it means writing a file there, and this tool only reads; cloudpin doctor in a terminal checks it"],
  };
  const checks = (await runDoctor(d)).map((c) => (asked && c.id === "cache" ? notChecked : c));
  return doctorJson(checks, d);
}

function folder(ctx: ToolContext, value: unknown): string {
  if (value === undefined) return ctx.cwd;
  if (typeof value !== "string") throw new Error("cwd must be a string");
  const dir = resolve(ctx.cwd, value);
  if (!ctx.isDir(dir)) throw new Error(`folder not found: ${dir}`);
  return dir;
}

/**
 * What the server tells every agent at initialize (#111), the plugin skill's rules in a few lines for agents
 * without it. Codex reads this as server-wide guidance and asks that the first 512 characters stand alone
 * (learn.chatgpt.com/docs/extend/mcp, "Server instructions"); a test holds them to that.
 */
export const CLOUDPIN_INSTRUCTIONS = [
  "cloudpin keeps cloud CLIs (az, aws, gcloud, vercel, gh, kubectl, helm, supabase, wrangler) on the accounts .cloudpin.yml pins.",
  "Call cloudpin_status before cloud work.",
  "Before running any command that uses a cloud CLI, call cloudpin_check with the exact command line; run it only if the verdict is allow.",
  "On block or ask, stop and tell the user the reason and the fix.",
  "Never work around a block (another account, CLOUDPIN_SKIP, an environment variable, a script file).",
  "This server never runs or switches anything.",
].join(" ") +
  "\n\nSwitching accounts and editing .cloudpin.yml are the user's call. If this server may not be running in the project folder, pass it as cwd.";

/** The handler `cloudpin mcp` serves: its tools, and the instructions at initialize. */
export function cloudpinHandler(deps: GuardDeps, ctx: ToolContext, version: string): (line: string) => Promise<string | null> {
  return createHandler({ version, tools: cloudpinTools(deps, ctx), instructions: CLOUDPIN_INSTRUCTIONS });
}

/**
 * The MCP tools (#15, #112). All only read: they never run the command they are
 * asked about, log in, switch or write. Fresh answers, no identity cache.
 */
export function cloudpinTools(deps: GuardDeps, ctx: ToolContext): McpTool[] {
  return [
    {
      name: "cloudpin_status",
      description:
        "Which cloud accounts each CLI (az, aws, gcloud, vercel, gh, kubectl, helm, supabase, wrangler) is using here, what this project's .cloudpin.yml pins, which environment applies, and which agent hooks are installed. Call it before cloud work.",
      inputSchema: {
        type: "object",
        properties: { cwd: { type: "string", description: "Project folder; defaults to the current one." } },
      },
      call: async (args) => {
        const cwd = folder(ctx, args.cwd);
        return collectStatus(deps, cwd, ctx.env, () => installedHooks(ctx.read, cwd, ctx.env));
      },
    },
    {
      name: "cloudpin_check",
      description:
        "Would cloudpin allow this shell command, as an agent's? Returns each cloud CLI call in it, the account it would use and why, and the verdict (allow, block or ask) with the reason and the fix. Nothing is run.",
      inputSchema: {
        type: "object",
        properties: {
          command: { type: "string", description: "The full command line, e.g. \"cd web && vercel deploy --prod\"." },
          cwd: { type: "string", description: "Folder the command would run in; defaults to the current one." },
          shell: {
            type: "string",
            enum: ["bash", "powershell"],
            description: "The shell that would run it: powershell for a PowerShell tool's command; defaults to bash.",
          },
        },
        required: ["command"],
      },
      call: async (args) => {
        const { command, shell = "bash" } = args;
        if (typeof command !== "string" || command.trim() === "") throw new Error("command must be a non-empty string");
        if (shell !== "bash" && shell !== "powershell") throw new Error('shell must be "bash" or "powershell"');
        const cwd = folder(ctx, args.cwd);
        // Agent mode, as in the hook: CLOUDPIN_SKIP, CLOUDPIN_CONFIRM, CLOUDPIN_ENV and CLOUDPIN_BRANCH inside the command don't count.
        return { mode: "agent", calls: await explain(command, { mode: "agent", cwd, env: ctx.env, shell }, deps) };
      },
    },
    {
      name: "cloudpin_doctor",
      description:
        "Why cloudpin may not be guarding here: cloudpin on PATH, shell wrappers, agent hooks missing or out of date, on Windows the PowerShell execution policy and PATH, the pin file, each CLI's account, each with its fix. Account IDs shortened. Nothing is changed.",
      inputSchema: {
        type: "object",
        properties: { cwd: { type: "string", description: "Project folder; defaults to the current one." } },
      },
      call: async (args) => readOnlyDoctor(deps, ctx, folder(ctx, args.cwd)),
    },
  ];
}
