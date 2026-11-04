import { describe, expect, it } from "vitest";
import { findInvocations } from "../src/shellwords.js";
import { DYNAMIC_WORDS } from "../src/types.js";

// `cloudpin exec` starts its command without a shell, so that command is read as a list of words (#14).

const calls = (line: string, dialect: "bash" | "powershell" = "bash") =>
  findInvocations(line, ["gh", "cloudpin"], "/repo", {}, dialect).map((c) => [c.bin, ...c.args]);

describe("findInvocations: cloudpin exec", () => {
  it("reads the command it starts as the call, with or without --", () => {
    expect(calls("cloudpin exec -- gh pr list")).toEqual([["gh", "pr", "list"]]);
    expect(calls("cloudpin exec gh pr list")).toEqual([["gh", "pr", "list"]]);
    expect(calls("CLOUDPIN.CMD exec -- gh pr list")).toEqual([["gh", "pr", "list"]]);
    expect(calls("cloudpin exec -- cloudpin exec -- gh pr list")).toEqual([["gh", "pr", "list"]]);
  });

  it("finds a call behind a wrapper or a shell inside it, which reading only its first word would miss", () => {
    for (const line of [
      "cloudpin exec -- npx gh pr list",
      "cloudpin exec -- env gh pr list",
      "cloudpin exec -- nice -n 5 gh pr list",
      "cloudpin exec -- bash -c 'gh pr list'",
      "cloudpin exec -- cmd /c gh pr list",
      "cloudpin exec -- pwsh -c 'gh pr list'",
    ]) {
      expect(calls(line), line).toEqual([["gh", "pr", "list"]]);
    }
    expect(calls("cloudpin exec -- bash <<EOF\ngh pr list\nEOF")).toEqual([["gh", "pr", "list"]]);
  });

  it("works in a PowerShell line, whose variables are already substituted", () => {
    expect(calls("$c = 'gh'; cloudpin exec -- $c pr list", "powershell")).toEqual([["gh", "pr", "list"]]);
    expect(calls("& cloudpin exec -- npx gh pr list", "powershell")).toEqual([["gh", "pr", "list"]]);
  });

  it("keeps what the line gave the call: its variables, folder and cleared environment", () => {
    const [prefix] = findInvocations("GH_TOKEN=x cloudpin exec -- gh pr list", ["gh", "cloudpin"]);
    expect(prefix!.env).toEqual({ GH_TOKEN: "x" });
    const [exported] = findInvocations("export GH_TOKEN=x; cloudpin exec -- gh pr list", ["gh", "cloudpin"]);
    expect(exported!.env).toEqual({ GH_TOKEN: "x" });
    const [moved] = findInvocations("cd sub && cloudpin exec -- gh pr list", ["gh", "cloudpin"], "/repo");
    expect(moved!.cwd).toMatch(/repo.sub$/);
    const [cleared] = findInvocations("env -i cloudpin exec -- gh pr list", ["gh", "cloudpin"]);
    expect(cleared!.clearEnv).toBe(true);
  });

  it("its `cd` or assignment doesn't reach the rest of the line: it has no shell", () => {
    const [call] = findInvocations("cloudpin exec -- cd other; gh pr list", ["gh", "cloudpin"], "/repo");
    expect(call!.cwd).toBeUndefined();
    const [plain] = findInvocations("cloudpin exec -- GH_TOKEN=x; gh pr list", ["gh", "cloudpin"]);
    expect(plain!.env).toEqual({});
  });

  it("a command known only when it runs is checked against the guarded CLIs the line names", () => {
    expect(calls("cloudpin exec -- $x pr list")).toEqual([["cloudpin", "pr", "list"]]);
    expect(calls("cloudpin exec -- nice $x")).toEqual([["cloudpin", DYNAMIC_WORDS]]);
  });

  it("control: any other cloudpin command stays a call to cloudpin; another CLI's `exec` is its own", () => {
    expect(calls("cloudpin check")).toEqual([["cloudpin", "check"]]);
    expect(calls("cloudpin switch exec")).toEqual([["cloudpin", "switch", "exec"]]);
    expect(calls("gh exec -- cloudpin switch")).toEqual([["gh", "exec", "--", "cloudpin", "switch"]]);
    expect(calls("cloudpin exec")).toEqual([]);
    expect(calls("cloudpin exec --")).toEqual([]);
  });
});
