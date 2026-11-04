import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { findConfig, type FoundConfig } from "../src/config.js";
import type { GuardDeps } from "../src/guard.js";
import { AGENTS, runHook } from "../src/hooks/agents.js";
import { parseSwitchArgs } from "../src/switch.js";
import type { ProviderDef } from "../src/types.js";
import { tempDir } from "./tmp.js";

// #14 through main's parsing of an agent's line: every way of spelling `cloudpin switch` that the line's shell
// would run is asked about (denied where the agent can't ask), and `--yes` never changes that.

const gh = {
  name: "github",
  bins: ["gh"],
  isExempt: () => false,
  resolve: async () => ({ kind: "identity", identity: { user: "paureis" }, source: "t" }),
  compare: () => [],
  switchHint: () => "gh auth switch",
  statusCommand: "gh auth status",
  cacheInputs: () => ({ env: [], files: [], dirs: [] }),
} as unknown as ProviderDef;
const config: FoundConfig = { path: "/repo/.cloudpin.yml", pins: { github: { user: "paureis" } } };
const deps: GuardDeps = { providers: [gh], exec: async () => ({ code: 0, stdout: "", stderr: "" }), findConfig: () => config };

const encoded = (script: string) => Buffer.from(script, "utf16le").toString("base64");

const claudeInput = (command: string, tool = "Bash") => JSON.stringify({ tool_name: tool, tool_input: { command }, cwd: "/repo" });

/** Claude Code's answer (it can ask), or "none" when cloudpin has no objection. */
async function decision(command: string, tool = "Bash", d: GuardDeps = deps, env: NodeJS.ProcessEnv = {}): Promise<string> {
  const out = await runHook(AGENTS.claude, claudeInput(command, tool), d, env);
  return out ? (JSON.parse(out).hookSpecificOutput.permissionDecision as string) : "none";
}

/** Codex's answer (it can't ask). */
async function codexDecision(command: string, tool = "Bash"): Promise<string> {
  const out = await runHook(AGENTS.codex, claudeInput(command, tool), deps, {}, 45_000, "linux");
  return out ? (JSON.parse(out).hookSpecificOutput.permissionDecision as string) : "none";
}

const BASH_FORMS = [
  // Spellings of the name.
  "cloudpin switch",
  "CLOUDPIN switch",
  "CLOUDPIN.CMD switch",
  "cloudpin.exe switch",
  "cloudpin.ps1 switch",
  "./node_modules/.bin/cloudpin switch",
  "/usr/local/bin/cloudpin switch",
  String.raw`'C:\Program Files\nodejs\cloudpin.cmd' switch`,
  `"cloud"pin 'switch'`,
  // Package runners (#162).
  "npx cloudpin switch",
  "npx -y cloudpin@latest switch",
  "npx -p cloudpin cloudpin switch",
  "npm exec -- cloudpin switch",
  "npm exec cloudpin -- switch",
  "npm x -- cloudpin switch",
  "pnpm exec cloudpin switch",
  "pnpm dlx cloudpin switch",
  "pnpm cloudpin switch",
  "yarn cloudpin switch",
  "yarn dlx cloudpin switch",
  "bunx cloudpin switch",
  'npx -c "cloudpin switch"',
  // Wrappers (#162).
  "nice -n 5 cloudpin switch",
  "sudo cloudpin switch",
  "sudo -u root cloudpin switch",
  "env cloudpin switch",
  "env -i cloudpin switch",
  "env -u GH_TOKEN cloudpin switch",
  "env -S 'cloudpin switch'",
  "timeout 5 cloudpin switch",
  "nohup cloudpin switch",
  "time cloudpin switch",
  "stdbuf -oL cloudpin switch",
  "command cloudpin switch",
  "exec cloudpin switch",
  "builtin cloudpin switch",
  "echo x | xargs cloudpin switch",
  "find . -exec cloudpin switch ;",
  "watch cloudpin switch",
  // Shells and eval.
  'bash -c "cloudpin switch"',
  "sh -c 'cloudpin switch'",
  'eval "cloudpin switch"',
  // Lists, substitutions, heredocs and CRLF (#161).
  "true && cloudpin switch",
  "true; cloudpin switch",
  "(cloudpin switch)",
  "echo $(cloudpin switch)",
  "echo `cloudpin switch`",
  "bash <<EOF\ncloudpin switch\nEOF",
  "bash <<'EOF'\r\ncloudpin switch\r\nEOF\r\n",
  "true\r\ncloudpin switch\r\n",
  "cat <<EOF\nx\nEOF\ncloudpin switch",
  // Variables the line sets (#160).
  "c=cloudpin; $c switch",
  's=switch; cloudpin "$s"',
  "s=switch; cloudpin $s",
  // Environment on the line.
  "GH_TOKEN=x cloudpin switch",
  "export X=1; cloudpin switch",
  // cloudpin exec, also with something between it and the switch.
  "cloudpin exec -- cloudpin switch",
  "cloudpin exec cloudpin switch",
  "cloudpin exec -- cloudpin exec cloudpin switch",
  "CLOUDPIN.CMD exec -- CLOUDPIN.CMD switch",
  "cloudpin exec -- npx cloudpin switch",
  "cloudpin exec -- env cloudpin switch",
  "cloudpin exec -- nice cloudpin switch",
  "cloudpin exec -- bash -c 'cloudpin switch'",
  "cloudpin exec -- cmd /c cloudpin switch",
  "cloudpin exec -- pwsh -c 'cloudpin switch'",
  "cloudpin exec -- bash <<EOF\ncloudpin switch\nEOF",
  "c=cloudpin; $c exec -- npx cloudpin switch",
  // Reached from bash into the other shells.
  "cmd /c cloudpin switch",
  'cmd /c "cloudpin switch --yes"',
  "cmd.exe //c cloudpin.cmd switch",
  'cmd /s /c "cloudpin.cmd switch"',
  'powershell -Command "cloudpin switch"',
  "powershell -NoProfile -c 'cloudpin switch'",
  "pwsh -c 'cloudpin switch'",
  `powershell -EncodedCommand ${encoded("cloudpin switch")}`,
  `pwsh -NoProfile -e ${encoded("cloudpin switch --yes")}`,
];

const POWERSHELL_FORMS = [
  "cloudpin switch",
  "CLOUDPIN.CMD switch",
  "& cloudpin switch",
  "& 'cloudpin' switch",
  `& "C:\\Program Files\\nodejs\\cloudpin.cmd" switch`,
  ". cloudpin switch",
  "cloudpin 'switch'",
  "`cloudpin switch",
  "cloud`pin switch",
  "$env:X = 1; cloudpin switch",
  "$x = cloudpin switch",
  "$c = 'cloudpin'; & $c switch",
  "$s = 'switch'; cloudpin $s",
  "true; cloudpin switch",
  "if ($true) { cloudpin switch }",
  "1..2 | ForEach-Object { cloudpin switch }",
  "iex 'cloudpin switch'",
  "Invoke-Expression 'cloudpin switch'",
  "'cloudpin switch' | iex",
  "Start-Process cloudpin -ArgumentList switch",
  "saps cloudpin switch",
  'cmd /c "cloudpin switch"',
  'powershell -Command "cloudpin switch"',
  `pwsh -EncodedCommand ${encoded("cloudpin switch")}`,
  "cloudpin exec -- npx cloudpin switch",
  "npx cloudpin switch",
];

describe("runHook: cloudpin switch in every form an agent's shell would run", () => {
  it.each(BASH_FORMS)("Bash asks: %s", async (form) => {
    expect(await decision(form)).toBe("ask");
    expect(await codexDecision(form)).toBe("deny");
  });

  it.each(POWERSHELL_FORMS)("PowerShell asks: %s", async (form) => {
    expect(await decision(form, "PowerShell")).toBe("ask");
    expect(await codexDecision(form, "PowerShell")).toBe("deny");
  });

  it("--yes changes nothing, in either shell, for an agent that can ask or one that can't", async () => {
    for (const tool of ["Bash", "PowerShell"]) {
      for (const form of ["cloudpin switch --yes", "npx cloudpin switch --yes", "cloudpin exec -- cloudpin switch --yes", "cloudpin switch --json --yes --only github"]) {
        expect(await decision(form, tool), form).toBe("ask");
        expect(await codexDecision(form, tool), form).toBe("deny");
      }
    }
  });

  it("a Codex line whose shell the payload doesn't name is read both ways on Windows", async () => {
    const out = await runHook(AGENTS.codex, claudeInput("& 'cloudpin.cmd' switch"), deps, {}, 45_000, "win32");
    expect(JSON.parse(out).hookSpecificOutput.permissionDecision).toBe("deny");
  });

  it("every agent's own answer: ask where it can, deny where it can't", async () => {
    const cmd = "CLOUDPIN.CMD switch --yes";
    const parsed = async (agent: keyof typeof AGENTS, input: string) => JSON.parse(await runHook(AGENTS[agent], input, deps, {}));
    expect((await parsed("copilot", JSON.stringify({ cwd: "/repo", toolName: "powershell", toolArgs: JSON.stringify({ command: cmd }) }))).permissionDecision).toBe("ask");
    expect((await parsed("cursor", JSON.stringify({ command: cmd, cwd: "/repo" }))).permission).toBe("ask");
    expect((await parsed("antigravity", JSON.stringify({ toolCall: { name: "run_command", args: { CommandLine: cmd, Cwd: "/repo" } } }))).decision).toBe("force_ask");
    expect((await parsed("gemini", JSON.stringify({ tool_name: "run_shell_command", tool_input: { command: cmd }, cwd: "/repo" }))).decision).toBe("deny");
    const codex = await parsed("codex", claudeInput(cmd));
    expect(codex.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(codex.hookSpecificOutput.permissionDecisionReason).toContain("ask the human to run `cloudpin switch`");
  });
});

describe("runHook: a cloudpin call whose subcommand isn't known in advance may be cloudpin switch", () => {
  it.each([
    "cloudpin $x",
    'cloudpin "$x"',
    "cloudpin $(echo switch)",
    "cloudpin `echo switch`",
    "cloudpin ${x}",
    "cloudpin exec -- cloudpin $x",
    "npx cloudpin $x",
    "echo switch | xargs cloudpin",
    'eval "cloudpin $x"',
    'bash -c "cloudpin $x"',
    "$x switch # cloudpin",
  ])("asks: %s", async (form) => {
    expect(await decision(form)).toBe("ask");
    expect(await codexDecision(form)).toBe("deny");
  });

  it("says it can't tell, and doesn't claim the call switches", async () => {
    const out = JSON.parse(await runHook(AGENTS.claude, claudeInput("cloudpin $x --yes"), deps, {}));
    const reason: string = out.hookSpecificOutput.permissionDecisionReason;
    expect(reason).toContain("can't read");
    expect(reason).toContain("cloudpin switch");
    expect(reason).not.toContain("switches the active accounts");
  });
});

describe("runHook: what isn't asked about", () => {
  it.each([
    "cloudpin switch --help",
    "cloudpin switch -h",
    "CLOUDPIN.CMD switch --help",
    "npx cloudpin switch --help",
    "cloudpin exec -- cloudpin switch --help",
    "cloudpin exec -- npx cloudpin switch -h",
    "cmd /c cloudpin switch --help",
    "cloudpin check",
    "cloudpin status --json",
    "cloudpin use",
    "cloudpin --help",
    "cloudpin explain -- cloudpin switch",
    "echo cloudpin switch",
    "grep 'cloudpin switch' README.md",
    "git commit -m 'cloudpin switch'",
    "man cloudpin",
    "cat <<EOF\ncloudpin switch\nEOF",
    "# cloudpin switch",
  ])("no objection: %s", async (form) => {
    expect(await decision(form)).toBe("none");
  });

  // #146: a --help cloudpin doesn't stop on must not make the call look harmless.
  it.each([
    "cloudpin switch --yes --help",
    "cloudpin switch --only github --help",
    "cloudpin switch --only=--help",
    "cloudpin switch $x --help",
    "cloudpin switch --yes -h",
    "cloudpin -h switch --yes && cloudpin switch",
    "cloudpin switch --help; cloudpin switch",
    "cloudpin exec -- cloudpin switch --yes --help",
  ])("a --help elsewhere on the line is still asked about: %s", async (form) => {
    expect(await decision(form)).toBe("ask");
  });

  it("cloudpin switch for a subcommand name in another case is not a switch: the CLI matches exactly", async () => {
    expect(await decision("cloudpin SWITCH")).toBe("none");
  });
});

describe("parseSwitchArgs: help is where the hook reads it (#146)", () => {
  it("only as the first word: the command then stops without switching", () => {
    expect(parseSwitchArgs(["--help"])).toEqual({ help: true });
    expect(parseSwitchArgs(["-h", "--yes"])).toEqual({ help: true });
  });

  it("anywhere else it is an unknown argument, so nothing runs", () => {
    expect(parseSwitchArgs(["--yes", "--help"])).toEqual({ error: 'unknown argument "--help"' });
    expect(parseSwitchArgs(["--json", "-h"])).toEqual({ error: 'unknown argument "-h"' });
  });
});

describe("runHook: cloudpin use through the same forms (match main's rule, and the new unwrapping)", () => {
  it.each([
    "cloudpin use prod",
    "CLOUDPIN.CMD use prod",
    "npx cloudpin use prod",
    "npm exec cloudpin -- use prod",
    "cloudpin exec -- cloudpin use prod",
    "cloudpin exec -- npx cloudpin use prod",
    "cmd /c cloudpin use prod",
  ])("asks: %s", async (form) => {
    expect(await decision(form)).toBe("ask");
  });
});

describe("runHook: cloudpin switch's question on Windows, where variable names ignore case (#136)", () => {
  const pinned = () => {
    const dir = tempDir("cloudpin-hook-switch-win-");
    writeFileSync(
      join(dir, ".cloudpin.yml"),
      "environments:\n  staging:\n    github: { user: stage-bot }\n  production:\n    protected: true\n    github: { user: prod-owner }\n",
    );
    return dir;
  };
  const ask = async (command: string, dir: string, platform: NodeJS.Platform, env: NodeJS.ProcessEnv = {}) => {
    const out = JSON.parse(await runHook(AGENTS.claude, JSON.stringify({ tool_name: "Bash", tool_input: { command }, cwd: dir }), { ...deps, findConfig, platform }, env));
    expect(out.hookSpecificOutput.permissionDecision).toBe("ask");
    return out.hookSpecificOutput.permissionDecisionReason as string;
  };

  it("a lowercase cloudpin_env on the line picks the environment it names, and is shown", async () => {
    const reason = await ask("cloudpin_env=production cloudpin switch", pinned(), "win32");
    expect(reason).toContain('environment "production"');
    expect(reason).toContain("github user prod-owner");
    expect(reason).toContain("CLOUDPIN_ENV=production cloudpin switch");
  });

  it("a lowercase cloudpin_env the agent started with counts too, and isn't shown as set by the line", async () => {
    const reason = await ask("cloudpin switch", pinned(), "win32", { cloudpin_env: "production" });
    expect(reason).toContain('environment "production"');
    expect(reason).not.toContain("CLOUDPIN_ENV=production");
  });

  it("control: on other platforms cloudpin_env is another variable", async () => {
    const reason = await ask("cloudpin_env=production cloudpin switch", pinned(), "linux");
    expect(reason).toContain('environment "staging"');
    expect(reason).not.toContain("prod-owner");
  });
});

describe("runHook: cloudpin switch's question never repeats a credential (#134)", () => {
  it("masks a token flag on the line", async () => {
    const out = JSON.parse(await runHook(AGENTS.claude, claudeInput("cloudpin switch --token s3cret-value --password=hunter2"), deps, {}));
    const reason: string = out.hookSpecificOutput.permissionDecisionReason;
    expect(reason).not.toContain("s3cret-value");
    expect(reason).not.toContain("hunter2");
    expect(reason).toContain("--token ***");
  });
});

describe("runHook: a guarded CLI behind cloudpin exec and a wrapper or shell (found by reading exec's words, #14)", () => {
  const wrong = {
    ...deps,
    providers: [{ ...gh, compare: () => ["user: expected paureis, active is someone"] } as unknown as ProviderDef],
  };
  it.each([
    "cloudpin exec -- gh pr list",
    "cloudpin exec -- bash -c 'gh pr list'",
    "cloudpin exec -- npx gh pr list",
    "cloudpin exec -- env GH_HOST=x gh pr list",
    "CLOUDPIN_SKIP=1 cloudpin exec -- cmd /c gh pr list",
  ])("is blocked: %s", async (form) => {
    expect(await decision(form, "Bash", wrong)).toBe("deny");
  });

  it("control: on the right account it has no objection", async () => {
    expect(await decision("cloudpin exec -- bash -c 'gh pr list'")).toBe("none");
  });
});
