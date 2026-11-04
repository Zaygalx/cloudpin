import { describe, expect, it } from "vitest";
import type { FoundConfig } from "../src/config.js";
import type { GuardDeps } from "../src/guard.js";
import { AGENTS, runHook } from "../src/hooks/agents.js";
import { azure } from "../src/providers/azure.js";
import { tokenize } from "../src/shell-tokens.js";
import { findInvocations, UNKNOWN_VALUE } from "../src/shellwords.js";
import type { Exec, ProviderDef } from "../src/types.js";
import { tempDir } from "./tmp.js";

// #161. Each expected reading below is what Git Bash 5.2 passed to an argv printer named like the CLI
// (script file and `bash -c`), not what bash's manual suggests.

const GUARDED = ["az", "aws", "gcloud", "vercel", "gh"];
const calls = (cmd: string) => findInvocations(cmd, GUARDED).map((i) => [i.bin, i.args]);
const NL = "\n";
const CR = "\r";
const AZ_OTHER = ["az", ["group", "delete", "-n", "x", "--subscription", "other"]];

/** Claude Code's own commit idiom: the message in a quoted heredoc inside "$( )". */
const commit = (message: string, after: string) => `git commit -m "$(cat <<'EOF'${NL}${message}${NL}EOF${NL})" && ${after}`;

describe("a heredoc inside $( ) is read as bash reads it (#161)", () => {
  it.each([
    ["an apostrophe", "Fix the user's bug"],
    ["an odd double quote", 'Say "hi to the team'],
    ["a closing parenthesis", "1) step one"],
    ["a backtick", "Use `x` here"],
    ["a comment sign and a parenthesis", "# it's (not) done"],
  ])("finds the call after Claude Code's commit idiom whose message has %s", (_name, message) => {
    expect(calls(commit(message, "az group delete -n x --subscription other"))).toEqual([AZ_OTHER]);
  });

  it("finds the call after gh pr create --body with the same idiom", () => {
    const line = `gh pr create --title t --body "$(cat <<'EOF'${NL}Don't merge yet${NL}EOF${NL})" && az group delete -n x --subscription other`;
    // The --body value is the substitution's output; #160 decides how it is read.
    const found = calls(line);
    expect(found.map(([bin]) => bin)).toEqual(["gh", "az"]);
    expect(found[1]).toEqual(AZ_OTHER);
  });

  it("still reads the heredoc body as data, and the commands after it inside $( ) as commands", () => {
    expect(calls(`echo "$(cat <<'EOF'${NL}az group delete -n y${NL}EOF${NL})"`)).toEqual([]);
    expect(calls(`x="$(cat <<'EOF'${NL}it's${NL}EOF${NL}az group list --subscription other${NL})"`)).toEqual([
      ["az", ["group", "list", "--subscription", "other"]],
    ]);
  });

  it("reads a comment inside $( ) to the end of its line", () => {
    expect(calls(`echo $(echo a # it's a ) comment${NL}) >/dev/null; az group list --subscription other`)).toEqual([
      ["az", ["group", "list", "--subscription", "other"]],
    ]);
  });

  it("counts the subshells inside $( ), so their ) does not close it", () => {
    expect(calls(`echo "$( (true) ; az group list --subscription other )"`)).toEqual([
      ["az", ["group", "list", "--subscription", "other"]],
    ]);
  });

  it("does not cut the last character of an unterminated $(", () => {
    expect(calls("echo $(az group list --subscription other")).toEqual([["az", ["group", "list", "--subscription", "other"]]]);
  });
});

describe("carriage returns are dropped, as Git Bash drops them (#161)", () => {
  it("continues a line ended by a backslash and CRLF", () => {
    expect(calls(`az group list \\${CR}${NL}  --subscription other`)).toEqual([["az", ["group", "list", "--subscription", "other"]]]);
  });

  it("does the same inside bash -c, a heredoc fed to bash, and eval", () => {
    const expected = [["az", ["group", "list", "--subscription", "other"]]];
    expect(calls(`bash -c 'az group list \\${CR}${NL}  --subscription other'`)).toEqual(expected);
    expect(calls(`bash <<EOF${CR}${NL}az group list \\${CR}${NL}  --subscription other${CR}${NL}EOF${CR}${NL}`)).toEqual(expected);
    expect(calls(`eval 'az group list \\${CR}${NL}  --subscription other'`)).toEqual(expected);
  });

  it("drops a CR inside a word or quotes instead of splitting the word on it", () => {
    expect(calls(`az group list --sub${CR}scription other`)).toEqual([["az", ["group", "list", "--subscription", "other"]]]);
    expect(calls(`a${CR}z group list`)).toEqual([["az", ["group", "list"]]]);
    expect(calls(`az x "a${CR}${NL}b" 'c${CR}${NL}d'`)).toEqual([["az", ["x", `a${NL}b`, `c${NL}d`]]]);
  });

  it("reads a CRLF script line by line, variables included", () => {
    const [inv] = findInvocations(`export AZURE_CONFIG_DIR=zzdir${CR}${NL}az group list${CR}${NL}`, GUARDED);
    expect(inv).toEqual({ bin: "az", args: ["group", "list"], env: { AZURE_CONFIG_DIR: "zzdir" } });
  });

  it("keeps a CR that $'\\r' writes", () => {
    expect(calls("az x $'a\\rb'")).toEqual([["az", ["x", `a${CR}b`]]]);
  });
});

describe("arithmetic (( )) and $(( )) is not a heredoc (#161)", () => {
  it.each([
    `(( n = 1 << 3 ))${NL}az group list --subscription other`,
    `if (( 1 << 3 )); then az group list --subscription other; fi`,
    `for ((i = 1 << 2; i < 5; i++)); do az group list --subscription other; done`,
    `echo $(( 1 << 3 ))${NL}az group list --subscription other`,
    `echo "$(( 1 << 3 ))"${NL}az group list --subscription other`,
    `(( x = "1" + 2 )); az group list --subscription other`,
    // A newline after << would start a heredoc body that swallows the call.
    `total=$(( a << 2${NL}  + b ))${NL}az group list --subscription other`,
    `(( n = a << 2${NL}  + 1 ))${NL}az group list --subscription other`,
  ])("finds the call in %j", (line) => {
    expect(calls(line)).toEqual([["az", ["group", "list", "--subscription", "other"]]]);
  });

  it.each([
    "echo $(( $(az group list --subscription other) + 1 ))",
    "(( n = $(az group list --subscription other) << 1 ))",
    "echo $(( `az group list --subscription other` + 1 ))",
  ])("still finds a command substitution inside the arithmetic: %j", (line) => {
    expect(calls(line)).toEqual([["az", ["group", "list", "--subscription", "other"]]]);
  });

  it.each([
    "((az group list --subscription other) )",
    "echo $((az group list --subscription other) )",
    "echo $( (az group list --subscription other) )",
  ])("reads (( or $(( that bash takes for nested subshells as subshells: %j", (line) => {
    expect(calls(line)).toEqual([["az", ["group", "list", "--subscription", "other"]]]);
  });

  it("reads nested $(( $( ) ) ), each tried as arithmetic and then as subshells, in time", { timeout: 2000 }, () => {
    // Read twice at every level, this took seconds at 20 levels and doubled with each one.
    let line = "az group list --subscription other";
    for (let k = 0; k < 22; k++) line = `echo $(( $( ${line} ) ) )`;
    expect(calls(line)).toEqual([["az", ["group", "list", "--subscription", "other"]]]);
  });

  it("marks $(( )) as known only when it runs", () => {
    expect(findInvocations("N=$(( 1 << 3 )) az group list", GUARDED)[0]?.env).toEqual({ N: UNKNOWN_VALUE });
  });
});

describe("ANSI-C $'...' and locale $\"...\" quotes (#161)", () => {
  it.each([
    ["az group list $'--subscription' other", ["group", "list", "--subscription", "other"]],
    ["az group list --subscription=$'other'", ["group", "list", "--subscription=other"]],
    ["az group list $'\\x2d-subscription' other", ["group", "list", "--subscription", "other"]],
    ["az group list $'\\055-subscription' other", ["group", "list", "--subscription", "other"]],
    ['az group list $"--subscription" other', ["group", "list", "--subscription", "other"]],
    ['az x a$"b"c', ["x", "abc"]],
    // Inside double quotes, $' is two characters.
    ["az x \"$'zz'\"", ["x", "$'zz'"]],
  ])("%j", (line, args) => {
    expect(calls(line)).toEqual([["az", args]]);
  });

  it("decodes the escapes bash decodes, and keeps a backslash it does not know", () => {
    const line = "az x $'a\\tb' $'a\\nb' $'it\\'s' $'q\\\"q' $'b\\\\s' $'\\q' $'\\x' $'\\e' $'\\?' $'\\0101' $'\\x4142' $'\\x41g'";
    expect(calls(line)).toEqual([
      ["az", ["x", "a\tb", "a\nb", "it's", 'q"q', "b\\s", "\\q", "\\x", "\u001b", "?", "\b1", "A42", "Ag"]],
    ]);
  });

  it("finds a CLI named in ANSI-C quotes", () => {
    expect(calls("$'az' group list --subscription other")).toEqual([["az", ["group", "list", "--subscription", "other"]]]);
  });

  it("marks a word with a rarer escape or a NUL as known only when it runs", () => {
    for (const quote of ["$'\\u0041'", "$'\\U00000041'", "$'\\cA'", "$'a\\0b'", "$'a\\x00b'"]) {
      const word = tokenize(`az ${quote}`)[1];
      expect(word, quote).toMatchObject({ kind: "word", quoted: true, dynamic: true });
    }
    expect(tokenize("az $'a\\tb'")[1]).toEqual({ kind: "word", value: "a\tb", quoted: true, dynamic: false });
    expect(findInvocations("X=$'zz\\tdir' Y=$'\\u0041' az group list", GUARDED)[0]?.env).toEqual({ X: "zz\tdir", Y: UNKNOWN_VALUE });
  });

  it("reads an unterminated $' to the end of the line", () => {
    expect(calls("az x $'abc")).toEqual([["az", ["x", "abc"]]]);
  });
});

// Through the agent hook, with the real azure provider and a fake Exec.
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
  const input = JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command }, cwd: tempDir("cloudpin-161-") });
  const out = await runHook(AGENTS.claude, input, deps, {});
  return out ? JSON.parse(out).hookSpecificOutput.permissionDecision : "allow";
}

describe("agent hook: heredocs in $( ), CRLF, arithmetic and $'...' can't hide the account (#161)", () => {
  const shapes: [string, (sub: string) => string][] = [
    ["commit idiom, apostrophe", (s) => commit("Fix the user's bug", `az group delete -n x --subscription ${s}`)],
    ["commit idiom, odd double quote", (s) => commit('Say "hi', `az group delete -n x --subscription ${s}`)],
    ["gh pr create idiom", (s) => `gh pr create --body "$(cat <<'EOF'${NL}Don't merge${NL}EOF${NL})" && az group list --subscription ${s}`],
    ["CRLF continuation", (s) => `az group list \\${CR}${NL}  --subscription ${s}`],
    ["arithmetic shift", (s) => `(( n = 1 << 3 ))${NL}az group list --subscription ${s}`],
    ["ANSI-C flag", (s) => `az group list $'--subscription' ${s}`],
    ["ANSI-C hex flag", (s) => `az group list $'\\x2d-subscription' ${s}`],
    ["locale flag", (s) => `az group list $"--subscription" ${s}`],
  ];

  it.each(shapes)("stops %s with --subscription other", async (_name, line) => {
    expect(await decision(line("other"))).toBe("deny");
  });

  it.each(shapes)("control: allows %s with the pinned subscription", async (_name, line) => {
    expect(await decision(line("pinned"))).toBe("allow");
  });
});
