import { describe, expect, it } from "vitest";
import { findInvocations } from "../src/shellwords.js";
import { DYNAMIC_WORD, DYNAMIC_WORDS } from "../src/types.js";

// #160. A word whose value is known only when the command runs ($( ), backticks, a variable not set
// earlier on the line, "$@") must reach the provider as something guard can recognise, never as "" or
// as the literal `$VAR`. A variable set earlier on the line is substituted, as bash does: an unquoted
// one is split on spaces, a quoted one stays one word.

const GUARDED = ["az", "aws", "gcloud", "vercel", "gh", "kubectl"];
const calls = (cmd: string, env?: NodeJS.ProcessEnv) =>
  findInvocations(cmd, GUARDED, undefined, env).map((i) => [i.bin, i.args]);

describe("findInvocations: words known only when the command runs (#160)", () => {
  it.each([
    // An unquoted $( ) or backticks is read as one word that is not a flag (owner decision); the flag
    // before it still reads it.
    ["az group list --subscription $(cat sub.txt)", ["group", "list", "--subscription", DYNAMIC_WORD]],
    ["az group list --subscription `cat sub.txt`", ["group", "list", "--subscription", DYNAMIC_WORD]],
    ["az group list x$(cat a)y", ["group", "list", DYNAMIC_WORD]],
    ["az group list -x$(cat a)", ["group", "list", `-x${DYNAMIC_WORD}`]],
    // An unquoted variable bash may split into several words, flags included.
    ["az group list --subscription $SUB", ["group", "list", "--subscription", DYNAMIC_WORDS]],
    ["az group list $1", ["group", "list", DYNAMIC_WORDS]],
    // Quoted, it is one word.
    ['az group list --subscription "$(cat sub.txt)"', ["group", "list", "--subscription", DYNAMIC_WORD]],
    ['az group list --subscription "$SUB"', ["group", "list", "--subscription", DYNAMIC_WORD]],
    ['az group list --subscription "${SUB}"', ["group", "list", "--subscription", DYNAMIC_WORD]],
    // A known flag name before `=` is kept.
    ['kubectl --context="$(cat ctx)" get pods', [`--context=${DYNAMIC_WORD}`, "get", "pods"]],
    ["kubectl --context=$(cat ctx) get pods", [`--context=${DYNAMIC_WORD}`, "get", "pods"]],
    // "$@" and "${a[@]}" are any number of words, even quoted.
    ['az group list "$@"', ["group", "list", DYNAMIC_WORDS]],
    ['az group list "${args[@]}"', ["group", "list", DYNAMIC_WORDS]],
    ["az group list $@", ["group", "list", DYNAMIC_WORDS]],
    ["az group list $*", ["group", "list", DYNAMIC_WORDS]],
    // "$*" and "${a[*]}" are one word when quoted.
    ['az group list "$*"', ["group", "list", DYNAMIC_WORD]],
    // A process substitution is one path, and $(( )) one number.
    ["az group list <(cat x)", ["group", "list", DYNAMIC_WORD]],
    ["az group list --top $(( 2 + 3 ))", ["group", "list", "--top", DYNAMIC_WORD]],
  ])("%j", (cmd, args) => {
    expect(calls(cmd)).toEqual([[cmd.split(" ")[0], args]]);
  });

  it("keeps the text before a value it can't read only when it starts like a flag", () => {
    expect(calls('az x "--sub$(echo scription)" other')).toEqual([["az", ["x", `--sub${DYNAMIC_WORD}`, "other"]]]);
    expect(calls('az x "rg-$(date +%s)"')).toEqual([["az", ["x", DYNAMIC_WORD]]]);
  });

  it.each([
    ["s=pinned; az group list --subscription $s", ["group", "list", "--subscription", "pinned"]],
    ['s=pinned; az group list --subscription "$s"', ["group", "list", "--subscription", "pinned"]],
    ["s=pinned; az group list --subscription ${s}", ["group", "list", "--subscription", "pinned"]],
    ["s=pinned; az group list --subscription=$s", ["group", "list", "--subscription=pinned"]],
    ["export S=pinned; az group list --subscription $S", ["group", "list", "--subscription", "pinned"]],
    ['FLAGS="--subscription other"; az group list $FLAGS', ["group", "list", "--subscription", "other"]],
    ['FLAGS="--subscription other"; az group list "$FLAGS"', ["group", "list", "--subscription other"]],
    ['F="  -o   json "; az group list $F', ["group", "list", "-o", "json"]],
    ['E=""; az group list $E --subscription x', ["group", "list", "--subscription", "x"]],
    ['E=""; az group list "$E"', ["group", "list", ""]],
    ["unset E; az group list $E", ["group", "list"]],
    // A variable assigned from something unknown stays unknown.
    ["s=$(cat sub.txt); az group list --subscription $s", ["group", "list", "--subscription", DYNAMIC_WORDS]],
    // The prefix assignment applies to the command, not to its own words (bash expands them first).
    ["s=a; s=b az group list $s", ["group", "list", "a"]],
    // PowerShell variables set on the line.
    ["$s = 'pinned'; az group list --subscription $s", ["group", "list", "--subscription", "pinned"]],
  ])("substitutes a variable set earlier on the line: %j", (cmd, args) => {
    expect(calls(cmd)).toEqual([["az", args]]);
  });

  it("does not let a variable set inside a subshell or $( ) reach the outer line", () => {
    expect(calls("(s=other); az group list --subscription $s")).toEqual([["az", ["group", "list", "--subscription", DYNAMIC_WORDS]]]);
  });

  it("still finds a CLI held in a variable, known or not", () => {
    expect(calls("CLI=az; $CLI group list")).toEqual([["az", ["group", "list"]]]);
    expect(calls('CLI="az group"; $CLI list')).toEqual([["az", ["group", "list"]]]);
    expect(calls("$TOOL group list # az")).toEqual([["az", ["group", "list"]]]);
  });

  it("reads a variable from the environment it was given only to know it is one word, never its value", () => {
    const env = { REPO: "acme/app", FLAGS: "--hostname x", DASH: "-x" };
    expect(calls("gh api repos/$REPO/pulls", env)).toEqual([["gh", ["api", DYNAMIC_WORD]]]);
    expect(calls("gh api $FLAGS", env)).toEqual([["gh", ["api", DYNAMIC_WORDS]]]);
    expect(calls("gh api $DASH", env)).toEqual([["gh", ["api", DYNAMIC_WORDS]]]);
    expect(calls("gh api repos/$REPO/pulls")).toEqual([["gh", ["api", DYNAMIC_WORDS]]]);
  });

  it("keeps the variables of an assignment or export unsplit, and unknown when they are", () => {
    const [a] = findInvocations('A="x y"; B=$A az group list', GUARDED);
    expect(a?.env).toEqual({ B: "x y" });
    const [b] = findInvocations("export AZURE_CONFIG_DIR=$(cat d); az group list", GUARDED);
    expect(b?.env.AZURE_CONFIG_DIR).toMatch(/^<cloudpin: /);
  });
});
