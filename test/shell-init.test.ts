import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { shellInit } from "../src/shell-init.js";
import { tempDir } from "./tmp.js";

const BINS = ["az", "aws", "gcloud", "vercel", "vc", "gh"];

describe("shellInit", () => {
  it.each([
    ["bash", "type -P cloudpin"],
    ["zsh", "whence -p cloudpin"],
  ])("wraps every guarded CLI for %s, falling back to it if cloudpin is gone", (shell, lookup) => {
    const script = shellInit(shell, BINS);
    for (const bin of BINS) {
      // `function name {`, not `name() {`: an existing alias would break the latter (#69).
      // The lookup finds only an executable: `command -v` would also find the cloudpin function (#14).
      expect(script).toContain(
        `function ${bin} { if ${lookup} >/dev/null 2>&1; then command cloudpin exec -- ${bin} "$@"; else command ${bin} "$@"; fi; }`,
      );
    }
    expect(script).not.toContain("command -v cloudpin");
  });

  it.each(["bash", "zsh"])("defines a cloudpin function for %s that applies only AWS_PROFILE from the switch side file, without eval", (shell) => {
    const script = shellInit(shell, BINS);
    const fn = script.slice(script.indexOf("function cloudpin {"));
    expect(fn).toContain('if [ "${1-}" != "switch" ]; then command cloudpin "$@"; return; fi');
    expect(fn).toContain("mktemp");
    expect(fn).toContain('CLOUDPIN_ENV_FILE="$__cloudpin_file" command cloudpin "$@"');
    expect(fn).toContain("AWS_PROFILE=*)");
    expect(fn).toContain("unset AWS_DEFAULT_PROFILE");
    expect(fn).toContain('rm -f "$__cloudpin_file"');
    expect(fn).not.toMatch(/\beval\b/);
    expect(fn).not.toContain("source");
  });

  it("defines a cloudpin function for PowerShell, without Invoke-Expression", () => {
    const script = shellInit("pwsh", BINS);
    const fn = script.slice(script.indexOf("function cloudpin {"));
    expect(fn).toContain("[IO.Path]::GetTempFileName()");
    expect(fn).toContain("Get-Command cloudpin -CommandType ExternalScript, Application");
    expect(fn).toContain("'^AWS_PROFILE=([A-Za-z0-9._-]{1,64})\\z'");
    expect(fn).toContain("Remove-Item Env:AWS_DEFAULT_PROFILE");
    expect(fn).toContain("$global:LASTEXITCODE = $__cloudpin_rc");
    expect(fn).not.toContain("Invoke-Expression");
    expect(fn).not.toContain("iex");
  });

  it("wraps every guarded CLI for PowerShell, passing pipeline input through", () => {
    const script = shellInit("pwsh", BINS);
    for (const bin of BINS) {
      expect(script).toContain(`function ${bin} {`);
      expect(script).toContain(`$input | cloudpin exec -- ${bin} @args`);
    }
  });

  it("falls back in PowerShell to the real executable (never the function itself) without cloudpin", () => {
    const script = shellInit("pwsh", ["gh"]);
    expect(script).toContain("Get-Command cloudpin -CommandType Application -ErrorAction SilentlyContinue");
    expect(script).toContain("(Get-Command gh -CommandType Application | Select-Object -First 1).Source");
  });

  it("accepts powershell as an alias for pwsh", () => {
    expect(shellInit("powershell", BINS)).toBe(shellInit("pwsh", BINS));
  });

  it("explains how to install and remove it", () => {
    expect(shellInit("bash", BINS)).toContain('eval "$(cloudpin shell-init bash)"');
    expect(shellInit("pwsh", BINS)).toContain("cloudpin shell-init pwsh | Out-String | Invoke-Expression");
  });

  it("rejects an unknown shell", () => {
    expect(() => shellInit("fish", BINS)).toThrow(/unsupported shell "fish"/);
  });
});

/** Is `shell` on PATH? Never on Windows, where `bash` may be WSL's rather than a real one for the test. */
function available(shell: string): boolean {
  if (process.platform === "win32") return false;
  return spawnSync(shell, ["-c", "exit 0"]).status === 0;
}

/** A folder with fake `cloudpin`, `kubectl` and `gh` that say who ran. */
function fakeBins(): string {
  const dir = tempDir("cloudpin-shell-");
  const write = (name: string, body: string) => {
    writeFileSync(join(dir, name), `#!/bin/sh\n${body}\n`);
    chmodSync(join(dir, name), 0o755);
  };
  write("cloudpin", 'echo "GUARDED $*"');
  write("kubectl", 'echo "REAL kubectl $*"');
  write("gh", 'echo "REAL gh $*"');
  return dir;
}

// Run in real shells (#69): only a real parser shows what an alias does to a function definition.
describe.each(["bash", "zsh"])("the %s wrappers in a real shell", (shell) => {
  const run = (prelude: string, path: (bins: string) => string = (bins) => `${bins}:/usr/bin:/bin`) => {
    const bins = fakeBins();
    const file = join(bins, "test.sh");
    writeFileSync(
      file,
      // bash expands aliases only in interactive shells unless told to; zsh always does.
      ['[ -n "$BASH_VERSION" ] && shopt -s expand_aliases', prelude, 'eval "$CLOUDPIN_INIT"', 'echo "eval rc=$?"', "kubectl get pods", "gh pr list", ""].join("\n"),
    );
    const res = spawnSync(shell, [file], {
      env: { PATH: path(bins), HOME: bins, CLOUDPIN_INIT: shellInit(shell, ["kubectl", "gh"]) },
      encoding: "utf8",
    });
    return { stdout: res.stdout, stderr: res.stderr };
  };

  it.skipIf(!available(shell))("guards every CLI, and warns about nothing, without aliases", () => {
    const { stdout, stderr } = run("");
    expect(stdout).toBe("eval rc=0\nGUARDED exec -- kubectl get pods\nGUARDED exec -- gh pr list\n");
    expect(stderr).toBe("");
  });

  it.skipIf(!available(shell))("still guards a CLI whose alias calls the CLI itself", () => {
    const { stdout, stderr } = run("alias kubectl='kubectl --context c'\nalias gh='\\gh'");
    expect(stdout).toBe("eval rc=0\nGUARDED exec -- kubectl --context c get pods\nGUARDED exec -- gh pr list\n");
    expect(stderr).toBe("");
  });

  it.skipIf(!available(shell))("warns at start-up about an alias that runs another program, and guards the rest", () => {
    const { stdout, stderr } = run("alias kubectl='kubecolor'\nalias gh='command gh'");
    expect(stdout).toContain("eval rc=0\n");
    for (const [bin, alias] of [["kubectl", "kubecolor"], ["gh", "command gh"]]) {
      expect(stderr).toContain(`cloudpin: alias ${bin}='${alias}' runs another program, so ${bin} is not guarded in this shell`);
    }
  });

  it.skipIf(!available(shell))("runs the real CLI when cloudpin is gone", () => {
    const { stdout } = run("", (bins) => {
      const only = tempDir("cloudpin-nocp-");
      for (const name of ["kubectl", "gh"]) symlinkSync(join(bins, name), join(only, name));
      return `${only}:/usr/bin:/bin`;
    });
    expect(stdout).toBe("eval rc=0\nREAL kubectl get pods\nREAL gh pr list\n");
  });
});

describe("the PowerShell wrappers in Windows PowerShell", () => {
  it.skipIf(process.platform !== "win32")("warn at start-up about an alias, which PowerShell runs before a function", () => {
    const init = shellInit("pwsh", ["kubectl", "gh"]);
    const res = spawnSync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", "Set-Alias gh hub; $env:CLOUDPIN_INIT | Out-String | Invoke-Expression; 'done'"],
      { env: { ...process.env, CLOUDPIN_INIT: init }, encoding: "utf8" },
    );
    const out = res.stdout + res.stderr;
    expect(out).toContain("done");
    expect(out).toContain("cloudpin: alias gh -> hub runs instead of the cloudpin wrapper, so gh is not guarded in this shell");
    expect(out).not.toContain("alias kubectl");
  }, 60_000); // powershell.exe took about 6 s to start on a GitHub Windows runner, past vitest's 5 s default
});

// #14: the cloudpin function applies AWS_PROFILE from `cloudpin switch` in the user's own shell.
// The fake cloudpin writes a valid line, then lines that must never be applied or run.
const FAKE_SWITCH = [
  'echo "REAL $*"',
  'if [ -n "${CLOUDPIN_ENV_FILE-}" ]; then',
  '  echo "FILE $CLOUDPIN_ENV_FILE"',
  "  printf '%s\n' 'OTHER=1' 'AWS_PROFILE=dev' 'AWS_PROFILE=bad;touch pwned' 'AWS_PROFILE=$(touch pwned2)' 'AWS_PROFILE=' >> \"$CLOUDPIN_ENV_FILE\"",
  "fi",
  "exit 3",
].join("\n");

describe.each(["bash", "zsh"])("the %s cloudpin function in a real shell", (shell) => {
  const run = (lines: string[], opts: { installed?: boolean } = {}) => {
    const dir = tempDir("cloudpin-fn-");
    if (opts.installed !== false) {
      writeFileSync(join(dir, "cloudpin"), `#!/bin/sh\n${FAKE_SWITCH}\n`);
      chmodSync(join(dir, "cloudpin"), 0o755);
    }
    writeFileSync(join(dir, "gh"), '#!/bin/sh\necho "REAL gh $*"\n');
    chmodSync(join(dir, "gh"), 0o755);
    const file = join(dir, "test.sh");
    writeFileSync(file, ['eval "$CLOUDPIN_INIT"', ...lines, ""].join("\n"));
    const res = spawnSync(shell, [file], {
      cwd: dir,
      env: { PATH: `${dir}:/usr/bin:/bin`, HOME: dir, TMPDIR: dir, AWS_DEFAULT_PROFILE: "old", CLOUDPIN_INIT: shellInit(shell, ["gh"]) },
      encoding: "utf8",
    });
    return { dir, stdout: res.stdout, stderr: res.stderr };
  };
  const show = 'echo "rc=$rc profile=${AWS_PROFILE-unset} default=${AWS_DEFAULT_PROFILE-unset} other=${OTHER-unset} envfile=${CLOUDPIN_ENV_FILE-unset}"';

  it.skipIf(!available(shell))("applies only a valid AWS_PROFILE from cloudpin switch, keeps the exit code and deletes the side file", () => {
    const { dir, stdout } = run(["cloudpin switch --yes", "rc=$?", show]);
    expect(stdout).toContain("REAL switch --yes");
    expect(stdout).toContain("rc=3 profile=dev default=unset other=unset envfile=unset");
    const sideFile = /FILE (.+)/.exec(stdout)?.[1];
    expect(sideFile).toBeDefined();
    expect(existsSync(sideFile!)).toBe(false);
    expect(existsSync(join(dir, "pwned"))).toBe(false);
    expect(existsSync(join(dir, "pwned2"))).toBe(false);
  });

  it.skipIf(!available(shell))("passes every other subcommand straight through, with no side file", () => {
    const { stdout } = run(["cloudpin check --json", "rc=$?", show]);
    expect(stdout).toBe("REAL check --json\nrc=3 profile=unset default=old other=unset envfile=unset\n");
  });

  it.skipIf(!available(shell))("still sends guarded CLIs to the real cloudpin, not to the function", () => {
    const { stdout } = run(["gh pr list"]);
    expect(stdout).toBe("REAL exec -- gh pr list\n");
  });

  it.skipIf(!available(shell))("without cloudpin installed, fails like a missing command and leaves guarded CLIs working", () => {
    const { stdout } = run(["cloudpin switch", "rc=$?", show, "gh pr list"], { installed: false });
    expect(stdout).toContain("rc=127 profile=unset default=old");
    expect(stdout).toContain("REAL gh pr list");
  });
});

describe("the PowerShell cloudpin function in Windows PowerShell", () => {
  it.skipIf(process.platform !== "win32")("applies only a valid AWS_PROFILE from cloudpin switch, keeps the exit code, deletes the side file, and passes the rest through", () => {
    const dir = tempDir("cloudpin-psfn-");
    writeFileSync(
      join(dir, "cloudpin.cmd"),
      [
        "@echo off",
        "echo REAL %*",
        "if defined CLOUDPIN_ENV_FILE (",
        "  echo FILE %CLOUDPIN_ENV_FILE%",
        '  >>"%CLOUDPIN_ENV_FILE%" echo OTHER=1',
        '  >>"%CLOUDPIN_ENV_FILE%" echo AWS_PROFILE=dev',
        '  >>"%CLOUDPIN_ENV_FILE%" echo AWS_PROFILE=bad;x',
        '  >>"%CLOUDPIN_ENV_FILE%" echo AWS_PROFILE=dev2 extra',
        ")",
        "exit /b 3",
        "",
      ].join("\r\n"),
    );
    const script = [
      "$env:PATH = $env:FAKE_DIR + ';' + $env:PATH",
      "$env:CLOUDPIN_INIT | Out-String | Invoke-Expression",
      "$env:AWS_DEFAULT_PROFILE = 'old'",
      "cloudpin switch --yes",
      "'rc=' + $LASTEXITCODE + ' profile=' + $env:AWS_PROFILE + ' default=[' + $env:AWS_DEFAULT_PROFILE + '] other=[' + $env:OTHER + '] envfile=[' + $env:CLOUDPIN_ENV_FILE + ']'",
      "cloudpin check --json",
      "'rc2=' + $LASTEXITCODE",
    ].join("; ");
    const res = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
      env: { ...process.env, FAKE_DIR: dir, CLOUDPIN_INIT: shellInit("pwsh", ["gh"]), AWS_PROFILE: "", CLOUDPIN_ENV_FILE: "" },
      encoding: "utf8",
    });
    const out = res.stdout;
    expect(out).toContain("REAL switch --yes");
    expect(out).toContain("rc=3 profile=dev default=[] other=[] envfile=[]");
    expect(out).toContain("REAL check --json");
    expect(out).toContain("rc2=3");
    const sideFile = /FILE (.+)/.exec(out)?.[1]?.trim();
    expect(sideFile).toBeDefined();
    expect(existsSync(sideFile!)).toBe(false);
  }, 60_000);
});
