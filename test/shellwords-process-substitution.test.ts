import { describe, expect, it } from "vitest";
import type { FoundConfig } from "../src/config.js";
import type { GuardDeps } from "../src/guard.js";
import { AGENTS, runHook } from "../src/hooks/agents.js";
import { azure } from "../src/providers/azure.js";
import { findInvocations } from "../src/shellwords.js";
import { DYNAMIC_WORD, type Exec, type ProviderDef } from "../src/types.js";
import { tempDir } from "./tmp.js";

// #156. bash(1), Process Substitution: an unquoted `<(list)` or `>(list)` runs the list and is replaced by
// one argument, a /dev/fd/N path, joined with any text next to it (`a<(true)b` passes `a/dev/fd/63b`), and
// the command keeps reading its words. Checked in bash: `p <(true) --x y` passes [/dev/fd/63] [--x] [y].
// So it is read like `$(...)`: part of a word whose value is only known when it runs, and the commands
// inside are still found. In double quotes it is plain text. Like `$(...)` it is one word, DYNAMIC_WORD (#160).

const GUARDED = ["az", "aws", "gcloud", "vercel", "gh"];
const calls = (cmd: string) => findInvocations(cmd, GUARDED).map((i) => [i.bin, i.args]);

describe("findInvocations: a process substitution is one argument and does not end the command (#156)", () => {
  it.each([
    // The issue's cases.
    ["az group list <(true) --subscription other", ["group", "list", DYNAMIC_WORD, "--subscription", "other"]],
    ["az group list >(cat) --subscription other", ["group", "list", DYNAMIC_WORD, "--subscription", "other"]],
    // Before, between and after the flags.
    ["az <(true) group list --subscription other", [DYNAMIC_WORD, "group", "list", "--subscription", "other"]],
    ["az group list --subscription <(true) other", ["group", "list", "--subscription", DYNAMIC_WORD, "other"]],
    ["az group list --subscription other <(true)", ["group", "list", "--subscription", "other", DYNAMIC_WORD]],
    ["az >(cat) group list --subscription other", [DYNAMIC_WORD, "group", "list", "--subscription", "other"]],
    ["az group list --subscription >(cat) other", ["group", "list", "--subscription", DYNAMIC_WORD, "other"]],
    ["az group list --subscription other >(cat)", ["group", "list", "--subscription", "other", DYNAMIC_WORD]],
    // Several, attached to each other.
    ["az group list <(true)>(cat) --subscription other", ["group", "list", DYNAMIC_WORD, "--subscription", "other"]],
    ["az group list <(true) >(cat) --subscription other", ["group", "list", DYNAMIC_WORD, DYNAMIC_WORD, "--subscription", "other"]],
  ])("%j", (cmd, args) => {
    expect(calls(cmd)).toEqual([["az", args]]);
  });

  it.each([
    // Joined with text it is one word, and the text around it stays in that word.
    ["az group list x<(true)y --subscription other", ["group", "list", DYNAMIC_WORD, "--subscription", "other"]],
    ["az group list --file=<(true) --subscription other", ["group", "list", `--file=${DYNAMIC_WORD}`, "--subscription", "other"]],
    ["az group list 2<(true) --subscription other", ["group", "list", DYNAMIC_WORD, "--subscription", "other"]],
    ["az group list a>(cat)b --subscription other", ["group", "list", DYNAMIC_WORD, "--subscription", "other"]],
    // Quoted, it is text: bash passes `<(true)` as it is.
    ['az group list "<(true)" --subscription other', ["group", "list", "<(true)", "--subscription", "other"]],
    ["az group list '>(cat)' --subscription other", ["group", "list", ">(cat)", "--subscription", "other"]],
  ])("joined or quoted: %j", (cmd, args) => {
    expect(calls(cmd)).toEqual([["az", args]]);
  });

  it.each([
    "az group list <(true) --subscription other",
    "az group list x<(true)y --subscription other",
    "az group list --subscription other >(cat)",
  ])("reads %j the same way as the line with $( ) in its place", (cmd) => {
    expect(calls(cmd)).toEqual(calls(cmd.replace(/[<>]\(/, "$(")));
  });

  it("finds the calls inside it, and the command around it keeps its flags", () => {
    expect(calls("az group list <(az account show) --subscription other")).toEqual([
      ["az", ["account", "show"]],
      ["az", ["group", "list", DYNAMIC_WORD, "--subscription", "other"]],
    ]);
    expect(calls("az group list >(gh api user) --subscription other")).toEqual([
      ["gh", ["api", "user"]],
      ["az", ["group", "list", DYNAMIC_WORD, "--subscription", "other"]],
    ]);
  });

  it("reads nested substitutions, and quotes inside them", () => {
    expect(calls("az group list <(cat <(gh api user)) --subscription other")).toEqual([
      ["gh", ["api", "user"]],
      ["az", ["group", "list", DYNAMIC_WORD, "--subscription", "other"]],
    ]);
    expect(calls("az group list <(echo $(gh api user)) --subscription other")).toEqual([
      ["gh", ["api", "user"]],
      ["az", ["group", "list", DYNAMIC_WORD, "--subscription", "other"]],
    ]);
    expect(calls("az group list $(cat >(gh api user)) --subscription other")).toEqual([
      ["gh", ["api", "user"]],
      ["az", ["group", "list", DYNAMIC_WORD, "--subscription", "other"]],
    ]);
    expect(calls('az group list <(echo ")"; gh api user) --subscription other')).toEqual([
      ["gh", ["api", "user"]],
      ["az", ["group", "list", DYNAMIC_WORD, "--subscription", "other"]],
    ]);
  });

  it("as a redirection's target it is dropped, its commands still run, and the flags after it stay", () => {
    expect(calls("az group list < <(gh api user) --subscription other")).toEqual([
      ["gh", ["api", "user"]],
      ["az", ["group", "list", "--subscription", "other"]],
    ]);
    expect(calls("az group list 2> >(cat) --subscription other")).toEqual([
      ["az", ["group", "list", "--subscription", "other"]],
    ]);
  });

  it("still splits commands after it", () => {
    expect(calls("az group list <(true) && gh pr list")).toEqual([
      ["az", ["group", "list", DYNAMIC_WORD]],
      ["gh", ["pr", "list"]],
    ]);
  });
});

// Through the agent hook, with the real azure provider resolving the subscription the command asks for.
const PINNED = "11111111-0000-0000-0000-000000000001";
const OTHER = "22222222-0000-0000-0000-000000000002";
const TENANT = "33333333-0000-0000-0000-000000000003";
const SUBSCRIPTIONS: Record<string, string> = { pinned: PINNED, [PINNED]: PINNED, other: OTHER, [OTHER]: OTHER };

const exec: Exec = async (bin, args) => {
  if (bin === "az" && args[0] === "account" && args[1] === "show") {
    const at = args.indexOf("--subscription");
    const id = at === -1 ? PINNED : SUBSCRIPTIONS[args[at + 1]!];
    if (!id) return { code: 1, stdout: "", stderr: "ERROR: Subscription not found." };
    return { code: 0, stdout: JSON.stringify({ id, tenantId: TENANT, name: id === PINNED ? "Pinned" : "Other" }), stderr: "" };
  }
  return { code: 1, stdout: "", stderr: "unexpected call" };
};

const config: FoundConfig = { path: "/repo/.cloudpin.yml", pins: { azure: { subscription: PINNED } } };
const deps: GuardDeps = { providers: [azure] as ProviderDef[], exec, findConfig: () => config };

async function decision(command: string): Promise<string> {
  const input = JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command }, cwd: tempDir("cloudpin-procsub-") });
  const out = await runHook(AGENTS.claude, input, deps, {});
  return out ? JSON.parse(out).hookSpecificOutput.permissionDecision : "allow";
}

describe("agent hook: a process substitution can't hide the account a command uses (#156)", () => {
  it.each([
    "az group list <(true) --subscription other",
    "az group list >(cat) --subscription other",
    "az <(true) group list --subscription other",
    "az group list --subscription <(true) other",
    "az group list x<(true)y --subscription other",
    "az group list <(cat <(true)) --subscription other",
    "az group list <(az account show) --subscription other",
    "az group list < <(true) --subscription other",
  ])("stops %j, which runs on another subscription", async (cmd) => {
    expect(await decision(cmd)).toBe("deny");
  });

  it.each([
    "az group list <(true) --subscription pinned",
    "az group list >(cat) --subscription pinned",
    "az group list <(az account show) --subscription pinned",
    "az group list <(true)",
  ])("control: allows %j, which runs on the pinned subscription", async (cmd) => {
    expect(await decision(cmd)).toBe("allow");
  });
});
