import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { commandName } from "../src/guard.js";
import { type Dialect, findInvocations } from "../src/shellwords.js";
import { DYNAMIC_WORDS as DWS } from "../src/types.js";

// #162: Windows runners that start a command from a string or a list: cmd /c, powershell and pwsh,
// Invoke-Expression, Start-Process and `& (Get-Command az).Source`. The shapes marked "real" were run in
// Windows PowerShell 5.1 and Git Bash with an argv printer named like the CLI; pwsh is from its docs
// (about_Pwsh) and PowerShell's CommandLineParameterParser.cs.
const GUARDED = ["az", "aws", "gcloud", "gh", "kubectl", "helm", "vercel", "supabase", "wrangler"];
const found = (line: string, dialect: Dialect) => findInvocations(line, GUARDED, resolve("/work"), undefined, dialect);
const calls = (line: string, dialect: Dialect = "powershell") => found(line, dialect).map((i) => ({ bin: commandName(i.bin), args: i.args }));
const AZ = ["group", "list", "--subscription", "other"];
const az = (args = AZ) => ({ bin: "az", args });
const encoded = (script: string) => Buffer.from(script, "utf16le").toString("base64");
const cantTell = [{ bin: "az", args: [DWS] }];

describe("cmd /c and /k read the rest as a cmd.exe line (#162)", () => {
  it.each([
    // real, from Windows PowerShell 5.1
    "cmd /c az group list --subscription other",
    'cmd /c "az group list --subscription other"',
    "cmd /C az group list --subscription other",
    "cmd /k 'az group list --subscription other & exit'",
    'cmd /s /c "az group list --subscription other"',
    "cmd /d /c az group list --subscription other",
    "cmd /r az group list --subscription other",
    "cmd /c 'echo x & az group list --subscription other'",
    "cmd /c '@az group list --subscription other'",
    "cmd /c 'call az group list --subscription other'",
    "cmd /c 'az group list --subscription other >nul 2>&1'",
    "cmd /c '\"az\" group list --subscription other'",
    "cmd.exe /c az group list --subscription other",
  ])("PowerShell: %j", (line) => {
    expect(calls(line)).toEqual([az()]);
  });

  it.each([
    // real, from Git Bash, which turns //c into /c (and a bare /c into C:/ unless MSYS_NO_PATHCONV is set)
    "cmd //c az group list --subscription other",
    'cmd //c "az group list --subscription other"',
    "cmd //c 'echo x & az group list --subscription other'",
    "cmd //caz group list --subscription other",
    "cmd /c az group list --subscription other",
  ])("bash: %j", (line) => {
    expect(calls(line, "bash")).toEqual([az()]);
  });

  it("splits on & && || | and ( ), and drops redirections (real)", () => {
    expect(calls("cmd /c az a1 '&' az group list --subscription other")).toEqual([az(["a1"]), az()]);
    expect(calls("cmd /c '(az a1) & (az group list --subscription other)'")).toEqual([az(["a1"]), az()]);
    expect(calls("cmd /c 'az a1 >nul 2>&1 && az a2 2>nul x || az a3 | az a4'")).toEqual([az(["a1"]), az(["a2", "x"]), az(["a3"]), az(["a4"])]);
  });

  it("keeps a quoted & in the argument (real)", () => {
    expect(calls("cmd /c 'az group list --query \"a&b\" --subscription other'")).toEqual([
      az(["group", "list", "--query", "a&b", "--subscription", "other"]),
    ]);
    // Git Bash escapes the quotes as \", which cmd passes on and the CLI reads as quotes.
    expect(calls("cmd //c 'az group list \"a&b\" --subscription other'", "bash")).toEqual([
      az(["group", "list", '"a&b"', "--subscription", "other"]),
    ]);
  });

  it.each([
    "cmd /c 'az group list --subscription %SUB%'",
    "cmd /c 'az group list ^& az x'",
    "cmd /c 'if exist x.txt az group list'",
    "cmd /c 'for %i in (a) do az group list'",
    "cmd /c 'start az group list'",
    "cmd /v:on /c 'az group list --subscription !SUB!'",
    "cmd /z /c az group list",
  ])("can't tell what cmd.exe makes of %j", (line) => {
    expect(calls(line)).toEqual(cantTell);
  });

  it("finds nothing in a cmd line without a guarded CLI", () => {
    expect(calls("cmd /c dir & ver")).toEqual([]);
  });
});

describe("powershell and pwsh (#162)", () => {
  it.each([
    // real, Windows PowerShell 5.1: a positional argument is the command, and the rest is joined to it
    'powershell -NoProfile "az group list --subscription other"',
    "powershell -NoProfile az group list --subscription other",
    'powershell -NoProfile -c "az group list --subscription other"',
    'powershell -NoProfile -Comm "az group list --subscription other"',
    "powershell -NoProfile -Command az group list --subscription other",
    "powershell -NoProfile -c 'az group list' --subscription other",
    "powershell -NoProfile /c 'az group list --subscription other'",
    "powershell -NoProfile -Command { az group list --subscription other }",
    `powershell -NoProfile -EncodedCommand ${encoded("az group list --subscription other")}`,
    `powershell -NoProfile -enc ${encoded("az group list --subscription other")}`,
    `powershell -NoProfile -e ${encoded("az group list --subscription other")}`,
    `powershell -NoProfile -ec ${encoded("az group list --subscription other")}`,
    "powershell -NoProfile -ex Bypass -c 'az group list --subscription other'",
    "powershell -NoProfile -ep Bypass -c 'az group list --subscription other'",
    "powershell -nop -noni -w hidden -sta -c 'az group list --subscription other'",
    "powershell -NoProfile -InputFormat text -c 'az group list --subscription other'",
    "'az group list --subscription other' | powershell -NoProfile -Command -",
    "'az group list --subscription other' | powershell -NoProfile -File -",
    "pwsh -NoProfile -c 'az group list --subscription other'",
    `pwsh -enc ${encoded("az group list --subscription other")}`,
    "powershell.exe -NoProfile -c 'az group list --subscription other'",
  ])("PowerShell: %j", (line) => {
    expect(calls(line)).toEqual([az()]);
  });

  it.each([
    'powershell -NoProfile -c "az group list --subscription other"',
    `powershell.exe -NoProfile -EncodedCommand ${encoded("az group list --subscription other")}`,
    'pwsh -Command "az group list --subscription other"',
  ])("bash: %j", (line) => {
    expect(calls(line, "bash")).toEqual([az()]);
  });

  it("reads -CommandWithArgs, whose $args are only known when it runs", () => {
    expect(calls("pwsh -cwa 'az group list --subscription $args' other")).toEqual([az(["group", "list", "--subscription", DWS])]);
  });

  it.each([
    // pwsh's positional argument is a script file (about_Pwsh), which fails here
    'pwsh -NoProfile "az group list --subscription other"',
    // a script file is not read, as `bash deploy.sh` is not (README, agent hooks)
    "powershell -NoProfile -File deploy.ps1 -Subscription other",
    "powershell -NoProfile -enc not-base64!",
  ])("finds no call in %j", (line) => {
    expect(calls(line)).toEqual([]);
  });
});

describe("Invoke-Expression (#162)", () => {
  it.each([
    // real
    "iex 'az group list --subscription other'",
    "Invoke-Expression 'az group list --subscription other'",
    "Invoke-Expression -Command 'az group list --subscription other'",
    "iex -C 'az group list --subscription other'",
    "'az group list --subscription other' | iex",
    "$c = 'az group list --subscription other'; iex $c",
    '$s = "other"; iex "az group list --subscription $s"',
    "$c = 'az group list --subscription other'; $c | Invoke-Expression",
  ])("reads the literal string: %j", (line) => {
    expect(calls(line)).toEqual([az()]);
  });

  it("runs each string piped to it (real)", () => {
    expect(calls("'az a1', 'az group list --subscription other' | iex")).toEqual([az(["a1"]), az()]);
  });

  it.each(["iex ('az ' + 'group list --subscription other')", "Get-Content cmd.txt | iex; az version", "iex $env:CMD; az version"])(
    "can't tell with a string it can't read, when the line names the CLI: %j",
    (line) => {
      expect(calls(line)[0]).toEqual({ bin: "az", args: [DWS] });
    },
  );

  it("finds nothing when the line names no guarded CLI", () => {
    expect(calls("iex (Get-Content run.txt)")).toEqual([]);
  });
});

describe("Start-Process (#162)", () => {
  it.each([
    // real
    "Start-Process az -ArgumentList 'group','list','--subscription','other' -NoNewWindow -Wait",
    "Start-Process az -ArgumentList 'group', 'list', '--subscription', 'other' -Wait",
    "Start-Process az -ArgumentList 'group list --subscription other' -Wait",
    "Start-Process az 'group','list','--subscription','other'",
    "saps az 'group list --subscription other' -Wait",
    "start az 'group list --subscription other' -Wait",
    "Start-Process -FilePath az -ArgumentList 'group list --subscription other'",
    "Start-Process az -Args 'group list --subscription other'",
    "Start-Process az -A 'group list --subscription other'",
    "Start-Process az -ArgumentList:'group list --subscription other'",
  ])("%j", (line) => {
    expect(calls(line)).toEqual([az()]);
  });

  it("splits the joined list as the CLI does (real)", () => {
    expect(calls("Start-Process az -ArgumentList 'group','list','--query','\"a b\"','--subscription','other'")).toEqual([
      az(["group", "list", "--query", "a b", "--subscription", "other"]),
    ]);
    // 5.1 joins the list with spaces, unquoted, so powershell gets -c and then the words of the script.
    expect(calls("Start-Process powershell -ArgumentList '-NoProfile','-c','az group list --subscription other'")).toEqual([az()]);
  });

  it("checks the call in its -WorkingDirectory", () => {
    expect(found("Start-Process az -ArgumentList 'group list' -WorkingDirectory sub", "powershell")[0]?.cwd).toBe(resolve("/work/sub"));
  });

  it.each([
    "Start-Process az -ArgumentList $a",
    "Start-Process az -ArgumentList @('group','list')",
    "Start-Process az -Credential $c -ArgumentList 'group','list'",
    "Start-Process az -Verb RunAs -ArgumentList 'group','list'",
    "Start-Process az -UseNewEnvironment -ArgumentList 'group','list'",
    "Start-Process az -Frob x -ArgumentList 'group','list'",
    "Start-Process az -W -ArgumentList 'group','list'",
  ])("can't tell: %j", (line) => {
    expect(calls(line)).toEqual(cantTell);
  });

  it("finds nothing in a process that is not guarded", () => {
    expect(calls("Start-Process notepad -ArgumentList 'a.txt'")).toEqual([]);
  });
});

describe("& (Get-Command az).Source (#162)", () => {
  it.each([
    "& (Get-Command az).Source group list --subscription other",
    "& (Get-Command az).Path group list --subscription other",
  ])("reads the member as part of the command, not an argument (real): %j", (line) => {
    expect(calls(line)).toEqual([az()]);
  });
});
