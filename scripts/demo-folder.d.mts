import type { AgentName } from "../src/hooks/agents.js";
import type { Scope } from "../src/install.js";
import type { Exec } from "../src/types.js";

/** The made-up production login the demo pins. */
export const FAKE_USER: string;
/** The demo folder's name. */
export const PROJECT_NAME: string;

/** `[--dir <path>] [--dev-user <login>]`; throws with the usage on anything else. */
export function parseArgs(argv: string[]): { dir?: string; devUser?: string };

/** The pin file: production pinned to FAKE_USER, dev to `devUser` (on `host` when it isn't github.com). */
export function pinFile(devUser: string, host?: string): string;

/** .cursor/mcp.json, the entry docs/mcp.md gives for Cursor. */
export function cursorMcp(): string;

/** Warnings for a folder path that would put the username or home folder on screen. */
export function pathWarnings(dir: string, who: { username: string; home: string }): string[];

/** The current user's name and home folder. */
export function currentUser(): { username: string; home: string };

/** The demo folder's README. */
export function readme(): string;

export interface DemoDeps {
  hookFile: (agent: AgentName, scope: Scope, root: string, env: NodeJS.ProcessEnv) => string;
  planInstall: (agent: AgentName, existing: string | null, root?: string | null) => { content: string; alreadyInstalled: boolean };
  windowsRoot: (env: NodeJS.ProcessEnv, platform: NodeJS.Platform) => string | null;
  exec: Exec;
}

/** Creates the demo folder; returns the files written, relative to `dir`. */
export function createDemoFolder(
  opts: { dir: string; devUser: string; host?: string; env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform },
  deps: DemoDeps,
): Promise<string[]>;

/** A new folder under the OS temp folder, ending in PROJECT_NAME. */
export function defaultDir(): string;
