import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { findInvocations } from "../src/shellwords.js";
import { DYNAMIC_WORDS } from "../src/types.js";

const GUARDED = ["az", "aws", "gcloud", "vercel", "gh"];
const find = (cmd: string, cwd?: string) => findInvocations(cmd, GUARDED, cwd);
const bins = (cmd: string) => find(cmd).map((i) => [i.bin, ...i.args].join(" "));

describe("heredocs and here-strings (#7)", () => {
  it("reads a heredoc fed to a shell as commands", () => {
    expect(bins("bash <<EOF\ngh pr merge 12\nEOF")).toEqual(["gh pr merge 12"]);
    expect(bins("sh -s <<'EOF'\nvercel deploy --prod\nEOF")).toEqual(["vercel deploy --prod"]);
  });

  it("supports <<- with tab-indented bodies and quoted delimiters", () => {
    expect(bins('bash <<-"END"\n\tgh repo delete x\n\tEND\necho done')).toEqual(["gh repo delete x"]);
  });

  it("treats a heredoc fed to anything else as data", () => {
    expect(bins("cat > deploy.sh <<'EOF'\nvercel deploy --prod\nEOF")).toEqual([]);
  });

  it("does not let an apostrophe in heredoc data hide the commands after it", () => {
    expect(bins("cat <<EOF > notes.txt\ndon't forget\nEOF\nvercel deploy --prod")).toEqual(["vercel deploy --prod"]);
  });

  it("handles two heredocs on one line", () => {
    expect(bins("cat <<A; bash <<B\nit's data\nA\ngh pr merge 1\nB\naws s3 ls")).toEqual(["gh pr merge 1", "aws s3 ls"]);
  });

  it("reads a here-string fed to a shell", () => {
    expect(bins('bash <<< "gh pr merge 12"')).toEqual(["gh pr merge 12"]);
    expect(bins('cat <<< "gh pr merge 12"')).toEqual([]);
  });

  it("finds a guarded CLI reading a heredoc as its own input", () => {
    expect(bins("az rest --body @- <<EOF\n{}\nEOF")).toEqual(["az rest --body @-"]);
  });

  it("keeps the heredoc out of the arguments", () => {
    expect(find("gh api user --input - <<EOF\n{}\nEOF")[0]?.args).toEqual(["api", "user", "--input", "-"]);
  });
});

describe("commands held in variables (#7)", () => {
  it("resolves a variable set earlier on the same line", () => {
    expect(bins("CLI=vercel; $CLI deploy --prod")).toEqual(["vercel deploy --prod"]);
    expect(bins('CLI="gh"; ${CLI} pr merge 3')).toEqual(["gh pr merge 3"]);
  });

  it("checks a CLI named on the line when the command is an unknown variable", () => {
    expect(bins("$DEPLOY_TOOL deploy --prod # uses vercel")).toEqual(["vercel deploy --prod"]);
  });

  it("does not guess when no guarded CLI is named", () => {
    expect(bins("$EDITOR notes.md")).toEqual([]);
  });

  it("does not flag a CLI that is only mentioned in text", () => {
    expect(bins('git commit -m "fix gh pr list output" && echo vercel')).toEqual([]);
  });
});

describe("cd scoping (#7)", () => {
  const base = resolve("/repo");

  it("keeps a cd inside ( ) from leaking to later calls", () => {
    const calls = find("(cd ../other && vercel ls); vercel deploy", base);
    expect(calls.map((c) => c.cwd)).toEqual([resolve("/other"), undefined]);
  });

  it("keeps a cd inside $( ) or bash -c from leaking", () => {
    expect(find('x=$(cd /tmp && pwd); vercel deploy', base)[0]?.cwd).toBeUndefined();
    expect(find('bash -c "cd /tmp"; vercel deploy', base)[0]?.cwd).toBeUndefined();
  });

  it("still applies a cd in { } groups and plain lists", () => {
    expect(find("{ cd app; }; vercel deploy", base)[0]?.cwd).toBe(resolve("/repo/app"));
    expect(find("cd app && vercel deploy", base)[0]?.cwd).toBe(resolve("/repo/app"));
  });

  it("restores the folder after nested subshells", () => {
    const calls = find("cd a; (cd b; (cd c); gh pr list); gh pr list", base);
    expect(calls.map((c) => c.cwd)).toEqual([resolve("/repo/a/b"), resolve("/repo/a")]);
  });
});

describe("PowerShell forms agents use (#7)", () => {
  it("checks the command assigned to a variable", () => {
    expect(bins("$prs = gh pr list --json number")).toEqual(["gh pr list --json number"]);
    expect(bins("$out=vercel ls")).toEqual(["vercel ls"]);
    // Unquoted, a single word is a command too.
    expect(bins("$v = vercel")).toEqual(["vercel"]);
  });

  it("does not treat a bare variable as a command", () => {
    // `$_` is known only when it runs, so it is marked as such (#160).
    expect(bins("$files | ForEach-Object { gh pr view $_ }")).toEqual([`gh pr view ${DYNAMIC_WORDS}`]);
  });

  it("finds a CLI behind the call operator", () => {
    expect(bins('$cli = "vercel"; & $cli deploy')).toEqual(["vercel deploy"]);
  });
});
