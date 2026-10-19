import type { StdioOptions } from "node:child_process";
import spawn from "cross-spawn";
import { isExecutableFile, resolveCommand } from "./paths.js";
import type { Exec } from "./types.js";

const TIMEOUT_MS = 20_000;

/**
 * The absolute file to spawn for `bin`, from the PATH in `env` (the command's
 * own environment), never from the current folder: given a bare name, the
 * `which` lookup inside cross-spawn, cmd.exe and libuv all search the current
 * folder first on Windows (GHSA-3cf7-5v5w-q5vr, CWE-427). Spawning the full
 * path leaves nothing for them to search.
 */
function resolveBin(bin: string, env: NodeJS.ProcessEnv): string | null {
  return resolveCommand(bin, env, process.platform, isExecutableFile);
}

const notFoundMessage = (bin: string) => `${bin}: not found on PATH`;

const NO_CWD_SEARCH = "NoDefaultCurrentDirectoryInExePath";

/**
 * The environment a child process gets. On Windows it also sets
 * NoDefaultCurrentDirectoryInExePath, which makes cmd.exe and libuv skip the
 * current folder when they look up a bare command name (Microsoft docs for
 * NeedCurrentDirectoryForExePathW; libuv src/win/process.c). Spawning the full
 * path only covers the first step: npm's .cmd shims (vercel, wrangler) then run
 * a bare `node` when no node.exe sits beside the shim, and that lookup happens
 * inside the child (GHSA-3cf7-5v5w-q5vr). Windows variable names are
 * case-insensitive and Node keeps only one key per name, chosen by sort order,
 * so any other casing is dropped before the canonical key is set.
 */
export function childEnv(env: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform): NodeJS.ProcessEnv {
  if (platform !== "win32") return env;
  const upper = NO_CWD_SEARCH.toUpperCase();
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(env)) {
    if (k.toUpperCase() !== upper) out[k] = v;
  }
  out[NO_CWD_SEARCH] = "1";
  return out;
}

/**
 * Runs a CLI without a shell. cross-spawn handles Windows .cmd shims (az,
 * vercel) by escaping each argument, so values taken from the user's command
 * line (a --hostname, a --scope) can never be interpreted by cmd.exe.
 */
export const realExec: Exec = (bin, args, env) =>
  new Promise((resolve) => {
    const file = resolveBin(bin, env);
    if (file === null) {
      resolve({ code: 127, stdout: "", stderr: notFoundMessage(bin), notFound: true });
      return;
    }
    const child = spawn(file, args, {
      env: childEnv({ ...env, CLOUDPIN_ACTIVE: "1" }),
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill(), TIMEOUT_MS);
    child.stdout?.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr?.on("data", (d: Buffer) => (stderr += d.toString()));
    child.on("error", (err: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      const notFound = err.code === "ENOENT";
      resolve({ code: notFound ? 127 : 1, stdout, stderr: err.message, notFound });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });

/**
 * Runs the user's command for `cloudpin exec`, resolved the same way as
 * realExec, and returns its exit code (127 when it can't be started). It gets
 * the same childEnv, so on Windows the command's own lookups skip the current
 * folder too, as PowerShell and Git Bash already do.
 */
export function runInherited(bin: string, args: string[], env: NodeJS.ProcessEnv, stdio: StdioOptions = "inherit"): Promise<number> {
  return new Promise((resolve) => {
    const file = resolveBin(bin, env);
    if (file === null) {
      console.error(`cloudpin exec: ${notFoundMessage(bin)}`);
      resolve(127);
      return;
    }
    const child = spawn(file, args, { env: childEnv(env), stdio });
    child.on("error", (err) => {
      console.error(`cloudpin exec: ${err.message}`);
      resolve(127);
    });
    child.on("close", (code) => resolve(code ?? 1));
  });
}
