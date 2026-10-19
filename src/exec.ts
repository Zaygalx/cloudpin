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
      env: { ...env, CLOUDPIN_ACTIVE: "1" },
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
 * realExec, and returns its exit code (127 when it can't be started).
 */
export function runInherited(bin: string, args: string[], env: NodeJS.ProcessEnv, stdio: StdioOptions = "inherit"): Promise<number> {
  return new Promise((resolve) => {
    const file = resolveBin(bin, env);
    if (file === null) {
      console.error(`cloudpin exec: ${notFoundMessage(bin)}`);
      resolve(127);
      return;
    }
    const child = spawn(file, args, { env, stdio });
    child.on("error", (err) => {
      console.error(`cloudpin exec: ${err.message}`);
      resolve(127);
    });
    child.on("close", (code) => resolve(code ?? 1));
  });
}
