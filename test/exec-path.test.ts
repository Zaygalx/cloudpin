import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { childEnv, realExec, runInherited } from "../src/exec.js";
import { findOnPath, resolveCommand } from "../src/paths.js";
import { tempDir } from "./tmp.js";

// GHSA-3cf7-5v5w-q5vr: a bare command name must resolve from PATH only, never
// from the current folder (CWE-427).

const files = (...paths: string[]) => {
  const set = new Set(paths);
  return (p: string) => set.has(p);
};

describe("findOnPath on Windows", () => {
  const win = (name: string, env: NodeJS.ProcessEnv, isFile: (p: string) => boolean) => findOnPath(name, env, "win32", isFile);

  it("skips relative and empty PATH entries", () => {
    const isFile = files(".\\az.cmd", "bin\\az.cmd", "tools\\az.cmd", "az.cmd", "C:\\real\\az.cmd");
    expect(win("az", { PATH: ".;bin;.\\tools;;C:\\real", PATHEXT: ".cmd" }, isFile)).toBe("C:\\real\\az.cmd");
    expect(win("az", { PATH: ".;bin;.\\tools;", PATHEXT: ".cmd" }, isFile)).toBeNull();
  });

  it("never looks in the current folder, even with PATH empty", () => {
    expect(win("az", { PATH: "", PATHEXT: ".CMD" }, () => true)).toBeNull();
    expect(win("az", {}, () => true)).toBeNull();
  });

  it("accepts a quoted entry", () => {
    const isFile = files("C:\\Program Files\\Azure\\az.cmd");
    expect(win("az", { PATH: '"C:\\Program Files\\Azure"', PATHEXT: ".cmd" }, isFile)).toBe("C:\\Program Files\\Azure\\az.cmd");
  });

  it("tries PATHEXT in order within each folder, folders in PATH order", () => {
    const isFile = files("C:\\a\\gh.CMD", "C:\\a\\gh.EXE", "C:\\b\\gh.COM");
    expect(win("gh", { PATH: "C:\\a;C:\\b", PATHEXT: ".COM;.EXE;.CMD" }, isFile)).toBe("C:\\a\\gh.EXE");
    expect(win("gh", { PATH: "C:\\b;C:\\a", PATHEXT: ".COM;.EXE;.CMD" }, isFile)).toBe("C:\\b\\gh.COM");
  });

  it("reads Path and PathExt in any casing", () => {
    const isFile = files("C:\\a\\az.CMD");
    expect(win("az", { Path: "C:\\a", PathExt: ".CMD" }, isFile)).toBe("C:\\a\\az.CMD");
  });

  it("tries a name that already has an extension as it is first", () => {
    const isFile = files("C:\\a\\az.cmd");
    expect(win("az.cmd", { PATH: "C:\\a", PATHEXT: ".EXE" }, isFile)).toBe("C:\\a\\az.cmd");
  });
});

describe("findOnPath on POSIX", () => {
  const nix = (name: string, env: NodeJS.ProcessEnv, isFile: (p: string) => boolean) => findOnPath(name, env, "linux", isFile);

  it("skips relative and empty PATH entries", () => {
    const isFile = files("az", "./az", "bin/az", "/usr/bin/az");
    expect(nix("az", { PATH: ":.:bin:/usr/bin" }, isFile)).toBe("/usr/bin/az");
    expect(nix("az", { PATH: "/usr/local/bin::" }, isFile)).toBeNull();
  });

  it("does not strip quotes, which POSIX shells keep as part of the folder", () => {
    expect(nix("az", { PATH: '"/usr/bin"' }, files("/usr/bin/az"))).toBeNull();
  });
});

describe("resolveCommand", () => {
  it("returns a name with a path separator unchanged", () => {
    expect(resolveCommand("./az", {}, "linux", () => false)).toBe("./az");
    expect(resolveCommand("/opt/az", {}, "linux", () => false)).toBe("/opt/az");
    expect(resolveCommand("tools\\az.cmd", {}, "win32", () => false)).toBe("tools\\az.cmd");
    expect(resolveCommand("tools/az.cmd", {}, "win32", () => false)).toBe("tools/az.cmd");
  });

  it("treats a backslash as part of the name on POSIX", () => {
    expect(resolveCommand("a\\az", { PATH: "/bin" }, "linux", files("/bin/a\\az"))).toBe("/bin/a\\az");
  });

  it("looks a bare name up on PATH, or returns null", () => {
    expect(resolveCommand("az", { PATH: "/usr/bin" }, "linux", files("/usr/bin/az"))).toBe("/usr/bin/az");
    expect(resolveCommand("az", { PATH: "/usr/bin" }, "linux", () => false)).toBeNull();
  });
});

// The real-process regression: a planted file in the current folder must not
// run in place of the one on PATH. Only tiny scripts this test writes run.
const PROBE = "zzcloudpinprobe";
const isWindows = process.platform === "win32";

/** The current process's environment with PATH replaced and the variable that disables the current-folder search removed. */
function probeEnv(path: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    const upper = k.toUpperCase();
    if (upper === "PATH" || upper === "NODEFAULTCURRENTDIRECTORYINEXEPATH") continue;
    env[k] = v;
  }
  env.PATH = path;
  return env;
}

/** Writes a probe that prints `word` and exits with `code`. */
function writeProbe(dir: string, word: string, code: number): void {
  mkdirSync(dir, { recursive: true });
  if (isWindows) {
    writeFileSync(join(dir, PROBE + ".cmd"), "@echo " + word + "\r\n@exit /b " + code + "\r\n");
  } else {
    const file = join(dir, PROBE);
    writeFileSync(file, "#!/bin/sh\necho " + word + "\nexit " + code + "\n");
    chmodSync(file, 0o755);
  }
}

function plant() {
  const root = tempDir("cloudpin-cwd-");
  const planted = join(root, "repo");
  const real = join(root, "bin");
  writeProbe(planted, "PLANTED", 41);
  writeProbe(real, "REAL", 42);
  // On POSIX an empty PATH entry means the current folder; it must be skipped.
  const path = isWindows ? real : [real, ""].join(":");
  return { planted, env: probeEnv(path) };
}

async function inFolder<T>(dir: string, fn: () => Promise<T>): Promise<T> {
  const before = process.cwd();
  process.chdir(dir);
  try {
    return await fn();
  } finally {
    process.chdir(before);
  }
}

describe("spawning a bare name ignores the current folder", () => {
  it("realExec runs the copy on PATH", async () => {
    const { planted, env } = plant();
    const res = await inFolder(planted, () => realExec(PROBE, [], env));
    expect(res.stdout.trim()).toBe("REAL");
    expect(res.code).toBe(42);
  });

  it("realExec reports not found when only the current folder has it", async () => {
    const { planted } = plant();
    const empty = tempDir("cloudpin-empty-");
    const res = await inFolder(planted, () => realExec(PROBE, [], probeEnv(empty)));
    expect(res).toMatchObject({ code: 127, stdout: "", notFound: true });
    expect(res.stderr).toContain(PROBE);
  });

  it("cloudpin exec (runInherited) runs the copy on PATH", async () => {
    const { planted, env } = plant();
    const code = await inFolder(planted, () => runInherited(PROBE, [], env, "ignore"));
    expect(code).toBe(42);
  });

  it("cloudpin exec (runInherited) exits 127 when only the current folder has it", async () => {
    const { planted } = plant();
    const empty = tempDir("cloudpin-empty-");
    const code = await inFolder(planted, () => runInherited(PROBE, [], probeEnv(empty), "ignore"));
    expect(code).toBe(127);
  });
});

// npm's Windows .cmd shims run a bare "node" when no node.exe sits beside the
// shim, and cmd.exe looks a bare name up in the current folder before PATH
// unless NoDefaultCurrentDirectoryInExePath is set. probeEnv deletes that
// variable, so these tests fail if cloudpin does not set it for the child.
const SHIM = "zzshimprobe";
const HELPER = "zznodeprobe";

function writeCmd(dir: string, name: string, body: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name + ".cmd"), body);
}

function plantShim() {
  const root = tempDir("cloudpin-shim-");
  const planted = join(root, "repo");
  const real = join(root, "bin");
  writeCmd(real, SHIM, "@call " + HELPER + " %*\r\n@exit /b %errorlevel%\r\n");
  writeCmd(real, HELPER, "@echo REAL\r\n@exit /b 42\r\n");
  writeCmd(planted, HELPER, "@echo PLANTED\r\n@exit /b 41\r\n");
  return { planted, env: probeEnv(real) };
}

describe.runIf(isWindows)("a shim on PATH that runs a bare name ignores the current folder", () => {
  it("realExec: the shim's helper comes from PATH", async () => {
    const { planted, env } = plantShim();
    const res = await inFolder(planted, () => realExec(SHIM, [], env));
    expect(res.stdout.trim()).toBe("REAL");
    expect(res.code).toBe(42);
  });

  it("cloudpin exec (runInherited): the shim's helper comes from PATH", async () => {
    const { planted, env } = plantShim();
    const code = await inFolder(planted, () => runInherited(SHIM, [], env, "ignore"));
    expect(code).toBe(42);
  });
});

describe("childEnv", () => {
  const NAME = "NoDefaultCurrentDirectoryInExePath";

  it("tells Windows not to search the current folder", () => {
    const out = childEnv({ PATH: "C:\bin", A: "1" }, "win32");
    expect(out).toEqual({ PATH: "C:\bin", A: "1", [NAME]: "1" });
  });

  it("replaces any casing of the variable with a single key", () => {
    const input = { nodefaultcurrentdirectoryinexepath: "", NODEFAULTCURRENTDIRECTORYINEXEPATH: "x", B: "2" };
    const out = childEnv(input, "win32");
    const keys = Object.keys(out).filter((k) => k.toUpperCase() === NAME.toUpperCase());
    expect(keys).toEqual([NAME]);
    expect(out[NAME]).toBe("1");
    expect(out.B).toBe("2");
    expect(input).toEqual({ nodefaultcurrentdirectoryinexepath: "", NODEFAULTCURRENTDIRECTORYINEXEPATH: "x", B: "2" });
  });

  it("leaves the environment alone on other platforms", () => {
    for (const platform of ["linux", "darwin"] as const) {
      const out = childEnv({ PATH: "/usr/bin" }, platform);
      expect(out).toEqual({ PATH: "/usr/bin" });
      expect(Object.keys(out).some((k) => k.toUpperCase() === NAME.toUpperCase())).toBe(false);
    }
  });
});
