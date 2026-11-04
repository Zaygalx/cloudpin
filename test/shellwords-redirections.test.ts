import { describe, expect, it } from "vitest";
import type { FoundConfig } from "../src/config.js";
import type { GuardDeps } from "../src/guard.js";
import { AGENTS, runHook } from "../src/hooks/agents.js";
import { azure } from "../src/providers/azure.js";
import { vercel } from "../src/providers/vercel.js";
import { findInvocations } from "../src/shellwords.js";
import type { Exec, ProviderDef } from "../src/types.js";
import { tempDir } from "./tmp.js";

// #154. Redirections are read the way bash reads them (bash(1), REDIRECTION): an optional stream
// number written right before the operator, the operator, and one target word, attached or after
// spaces. None of them is an argument, and the `&` in `>&` / `<&` / `&>` does not end the command.
// PowerShell (about_Redirection) uses the same shapes: `>`, `>>`, `2>`, `2>&1`, `*>`, `*>&1`.

const GUARDED = ["az", "aws", "gcloud", "vercel", "gh"];
const calls = (cmd: string) => findInvocations(cmd, GUARDED).map((i) => [i.bin, i.args]);

describe("findInvocations: redirections are not arguments and do not end the command (#154)", () => {
  it.each([
    // The issue's cases.
    ["az 2>&1 group list --subscription other", ["group", "list", "--subscription", "other"]],
    ["aws s3 rm s3://b/k > out.txt", ["s3", "rm", "s3://b/k"]],
    ["gh repo delete x 2>/dev/null --yes", ["repo", "delete", "x", "--yes"]],
    ["vercel 2>&1 deploy --scope x", ["deploy", "--scope", "x"]],
    // bash: every operator, with the target attached and separate.
    ["gh pr list >out --limit 5", ["pr", "list", "--limit", "5"]],
    ["gh pr list > out --limit 5", ["pr", "list", "--limit", "5"]],
    ["gh pr list >>out --limit 5", ["pr", "list", "--limit", "5"]],
    ["gh pr list 1>> out --limit 5", ["pr", "list", "--limit", "5"]],
    ["gh pr list <in --limit 5", ["pr", "list", "--limit", "5"]],
    ["gh pr list 0< in --limit 5", ["pr", "list", "--limit", "5"]],
    ["gh pr list >|out --limit 5", ["pr", "list", "--limit", "5"]],
    ["gh pr list 2>| out --limit 5", ["pr", "list", "--limit", "5"]],
    ["gh pr list <>rw --limit 5", ["pr", "list", "--limit", "5"]],
    ["gh pr list 1>&2 --limit 5", ["pr", "list", "--limit", "5"]],
    ["gh pr list 2>&- --limit 5", ["pr", "list", "--limit", "5"]],
    ["gh pr list 2>& 1 --limit 5", ["pr", "list", "--limit", "5"]],
    ["gh pr list <&0 --limit 5", ["pr", "list", "--limit", "5"]],
    ["gh pr list 0<&- --limit 5", ["pr", "list", "--limit", "5"]],
    ["gh pr list &>all --limit 5", ["pr", "list", "--limit", "5"]],
    ["gh pr list &> all --limit 5", ["pr", "list", "--limit", "5"]],
    ["gh pr list &>>all --limit 5", ["pr", "list", "--limit", "5"]],
    // `>&word` with a word that is not a number sends stdout and stderr to that file.
    ["gh pr list >&all.log --limit 5", ["pr", "list", "--limit", "5"]],
    ["gh pr list >& all.log --limit 5", ["pr", "list", "--limit", "5"]],
    // Quoted targets are one word, like any other.
    ['gh pr list > "my out.txt" --limit 5', ["pr", "list", "--limit", "5"]],
    ["gh pr list 2>'e r' --limit 5", ["pr", "list", "--limit", "5"]],
    // Several in a row, attached to each other.
    ["gh pr list 2>&1>out --limit 5", ["pr", "list", "--limit", "5"]],
    ["gh pr list >out 2>&1 --limit 5", ["pr", "list", "--limit", "5"]],
    // A here-string is standard input, not an argument.
    ["gh pr list <<<hello --limit 5", ["pr", "list", "--limit", "5"]],
    // PowerShell.
    ["gh pr list 2>$null --limit 5", ["pr", "list", "--limit", "5"]],
    ["gh pr list *>&1 --limit 5", ["pr", "list", "--limit", "5"]],
    ["gh pr list *> $null --limit 5", ["pr", "list", "--limit", "5"]],
    ["gh pr list 3>&1 --limit 5", ["pr", "list", "--limit", "5"]],
    ["gh pr list 2>>err.log --limit 5", ["pr", "list", "--limit", "5"]],
    ["gh pr list >> log.txt --limit 5", ["pr", "list", "--limit", "5"]],
  ])("%j", (cmd, args) => {
    expect(calls(cmd)).toEqual([[cmd.split(" ")[0], args]]);
  });

  it.each([
    "2>&1 az group list --subscription other",
    ">out az group list --subscription other",
    "> out az group list --subscription other",
    "2>/dev/null az group list --subscription other",
    "az 2>&1 group list --subscription other",
    "az group 2>&1 list --subscription other",
    "az group list 2>&1 --subscription other",
    "az group list --subscription 2>&1 other",
    "az group list --subscription other 2>&1",
    "az group list --subscription other > out.txt",
    "AZURE_X=1 2>&1 az group list --subscription other",
  ])("reads the same call wherever the redirection goes: %j", (cmd) => {
    expect(calls(cmd)).toEqual([["az", ["group", "list", "--subscription", "other"]]]);
  });

  it("drops the target but still runs a command substitution inside it", () => {
    expect(calls("az group list > $(gh api user)")).toEqual([
      ["gh", ["api", "user"]],
      ["az", ["group", "list"]],
    ]);
  });

  it.each([
    ["az group list 2>&1 && gh pr list", 2],
    ["az group list 2>&1 || gh pr list", 2],
    ["az group list 2>&1; gh pr list", 2],
    ["az group list 2>&1 | gh pr list", 2],
    ["az group list 2>&1 |& gh pr list", 2],
    ["az group list |& gh pr list", 2],
    ["az group list 2>&1 & gh pr list", 2],
    ["az group list 2>&1& gh pr list", 2],
    ["az group list & gh pr list", 2],
    ["az group list &>/dev/null && gh pr list", 2],
  ])("still splits commands on && || ; | |& and &: %j", (cmd) => {
    expect(calls(cmd)).toEqual([
      ["az", ["group", "list"]],
      ["gh", ["pr", "list"]],
    ]);
  });

  it("still reads a heredoc fed to a shell that also has a redirection", () => {
    expect(calls("bash 2>&1 <<EOF\naz group list --subscription other\nEOF")).toEqual([
      ["az", ["group", "list", "--subscription", "other"]],
    ]);
    expect(calls("bash <<EOF 2>/dev/null\naz group list --subscription other\nEOF")).toEqual([
      ["az", ["group", "list", "--subscription", "other"]],
    ]);
  });

  it("still reads the commands in a process substitution, <( ) or >( )", () => {
    expect(calls("diff <(az group list) <(gh pr list)")).toEqual([
      ["az", ["group", "list"]],
      ["gh", ["pr", "list"]],
    ]);
    // As a redirection target it runs where it appears, before the command it belongs to, like $( ) (#156).
    expect(calls("gh pr list > >(az group list)")).toEqual([
      ["az", ["group", "list"]],
      ["gh", ["pr", "list"]],
    ]);
  });

  // Where the line could mean either, keep the word: dropping a real argument could hide a flag.
  it.each([
    // Only an unquoted word that is just a stream number is one: `x2>out` passes x2 (bash does too).
    ["gh pr view x2>out --web", ["pr", "view", "x2", "--web"]],
    ['gh pr view "2">out --web', ["pr", "view", "2", "--web"]],
    ["gh pr view '2'>out --web", ["pr", "view", "2", "--web"]],
    ["gh pr view \\2>out --web", ["pr", "view", "2", "--web"]],
    // `&>` takes no stream number: bash passes the 2.
    ["gh pr view 2&>out --web", ["pr", "view", "2", "--web"]],
    // bash reads 12 as a stream; PowerShell passes `12>out` as one argument. Kept.
    ["gh pr view 12>out --web", ["pr", "view", "12", "--web"]],
    // A lone operator at the end is a syntax error in both shells: nothing to drop.
    ["gh pr view 5 --web >", ["pr", "view", "5", "--web"]],
  ])("%j", (cmd, args) => {
    expect(calls(cmd)).toEqual([["gh", args]]);
  });
});

// Through the agent hook, with az and vercel resolving the identity the command asks for.
const PINNED = "11111111-0000-0000-0000-000000000001";
const OTHER = "22222222-0000-0000-0000-000000000002";
const TENANT = "33333333-0000-0000-0000-000000000003";
const SUBSCRIPTIONS: Record<string, string> = { pinned: PINNED, [PINNED]: PINNED, other: OTHER, [OTHER]: OTHER };
const TEAMS = JSON.stringify({
  teams: [
    { id: "team_main", slug: "acme", current: true },
    { id: "team_side", slug: "side", current: false },
  ],
  pagination: {},
});

const exec: Exec = async (bin, args) => {
  if (bin === "az" && args[0] === "account" && args[1] === "show") {
    const at = args.indexOf("--subscription");
    const id = at === -1 ? PINNED : SUBSCRIPTIONS[args[at + 1]!];
    if (!id) return { code: 1, stdout: "", stderr: "ERROR: Subscription not found." };
    return { code: 0, stdout: JSON.stringify({ id, tenantId: TENANT, name: id === PINNED ? "Pinned" : "Other" }), stderr: "" };
  }
  if (bin === "vercel" && args[0] === "teams") return { code: 0, stdout: TEAMS, stderr: "" };
  return { code: 1, stdout: "", stderr: "unexpected call" };
};

const config: FoundConfig = {
  path: "/repo/.cloudpin.yml",
  pins: { azure: { subscription: PINNED }, vercel: { team: "team_main" } },
};
const deps: GuardDeps = { providers: [azure, vercel] as ProviderDef[], exec, findConfig: () => config };
const env = { VERCEL_TOKEN: "example-env-token" };

async function decision(command: string, tool: "Bash" | "PowerShell" = "Bash"): Promise<string> {
  const input = JSON.stringify({ hook_event_name: "PreToolUse", tool_name: tool, tool_input: { command }, cwd: tempDir("cloudpin-redir-") });
  const out = await runHook(AGENTS.claude, input, deps, env);
  return out ? JSON.parse(out).hookSpecificOutput.permissionDecision : "allow";
}

describe("agent hook: a redirection can't hide the account a command uses (#154)", () => {
  it.each([
    "az 2>&1 group list --subscription other",
    "2>&1 az group list --subscription other",
    "az group list 2>&1 --subscription other",
    "az group list --subscription other 2>&1",
    "az group list &>/dev/null --subscription other",
    "az group list >| out.txt --subscription other",
    "az group list --subscription other > out.txt",
  ])("stops %j, which runs on another subscription", async (cmd) => {
    expect(await decision(cmd)).toBe("deny");
  });

  it.each(["az 2>&1 group list --subscription other", "az group list 2>$null --subscription other", "az group list *>&1 --subscription other"])(
    "stops %j from Claude Code's PowerShell tool",
    async (cmd) => {
      expect(await decision(cmd, "PowerShell")).toBe("deny");
    },
  );

  it.each([
    "az 2>&1 group list --subscription pinned",
    "2>&1 az group list",
    "az group list --subscription pinned > out.txt 2>&1",
  ])("control: allows %j, which runs on the pinned subscription", async (cmd) => {
    expect(await decision(cmd)).toBe("allow");
  });

  it("stops vercel 2>&1 deploy --scope side and allows the pinned scope", async () => {
    expect(await decision("vercel 2>&1 deploy --scope side")).toBe("deny");
    expect(await decision("vercel 2>&1 deploy --scope acme")).toBe("allow");
  });
});
