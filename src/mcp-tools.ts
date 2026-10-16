import { resolve } from "node:path";
import { explain } from "./explain.js";
import type { GuardDeps } from "./guard.js";
import { installedHooks } from "./install.js";
import type { McpTool } from "./mcp.js";
import { collectStatus } from "./status.js";

export interface ToolContext {
  /** The server's folder; Claude Code starts it in the project. */
  cwd: string;
  env: NodeJS.ProcessEnv;
  read: (path: string) => string | null;
  isDir: (path: string) => boolean;
}

function folder(ctx: ToolContext, value: unknown): string {
  if (value === undefined) return ctx.cwd;
  if (typeof value !== "string") throw new Error("cwd must be a string");
  const dir = resolve(ctx.cwd, value);
  if (!ctx.isDir(dir)) throw new Error(`folder not found: ${dir}`);
  return dir;
}

/**
 * The two MCP tools (#15). Both only read: they never run the command they are
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
        },
        required: ["command"],
      },
      call: async (args) => {
        const { command } = args;
        if (typeof command !== "string" || command.trim() === "") throw new Error("command must be a non-empty string");
        const cwd = folder(ctx, args.cwd);
        // Agent mode, as in the hook: CLOUDPIN_SKIP, CLOUDPIN_CONFIRM and CLOUDPIN_ENV inside the command don't count.
        return { mode: "agent", calls: await explain(command, { mode: "agent", cwd, env: ctx.env }, deps) };
      },
    },
  ];
}
