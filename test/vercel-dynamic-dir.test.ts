import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { FoundConfig } from "../src/config.js";
import { guard, type GuardDeps, type Verdict } from "../src/guard.js";
import { AGENTS, runHook } from "../src/hooks/agents.js";
import { vercel } from "../src/providers/vercel.js";
import { findInvocations } from "../src/shellwords.js";
import type { Exec } from "../src/types.js";
import { envFor } from "../src/user-env.js";
import { tempDir } from "./tmp.js";

// #147 and #160 together. Since #147 a positional word can name the folder whose link picks the
// team (linkDirs in vercel-args.ts), so a folder word known only when the command runs means
// cloudpin can't tell the account. Every line here goes through findInvocations and guard, as the
// hook does, with a fake Exec. The folder the command runs in is linked to the pinned team, which
// is also the active one, and `sub` is linked to another team, so only the folder word can be wrong.

const TEAMS = JSON.stringify({
  teams: [
    { id: "team_main", slug: "acme", current: true },
    { id: "team_side", slug: "side", current: false },
  ],
  pagination: {},
});

const sent: string[][] = [];
const exec: Exec = async (_bin, args) => {
  sent.push(args);
  if (args[0] === "teams") return { code: 0, stdout: TEAMS, stderr: "" };
  return { code: 1, stdout: "", stderr: "unexpected" };
};

const config: FoundConfig = { path: "/repo/.cloudpin.yml", pins: { vercel: { team: "team_main" } } };
const deps: GuardDeps = { providers: [vercel], exec, findConfig: () => config };
const loggedIn = { VERCEL_TOKEN: "example-env-token" };

function link(dir: string, org: string): string {
  mkdirSync(join(dir, ".vercel"), { recursive: true });
  writeFileSync(join(dir, ".vercel", "project.json"), JSON.stringify({ orgId: org, projectId: `prj_${org}` }));
  return dir;
}

/** A folder linked to `rootTeam`, holding `sub` linked to `subTeam`. */
function tree(subTeam = "team_side", rootTeam = "team_main"): string {
  const root = link(tempDir("cloudpin-vercel-dynamic-dir-"), rootTeam);
  link(join(root, "sub"), subTeam);
  return root;
}

/** The verdict for an agent's line, as the hook builds it (findInvocations, then envFor). */
async function line(command: string, cwd: string, base: NodeJS.ProcessEnv = loggedIn): Promise<Verdict> {
  const [inv] = findInvocations(command, vercel.bins, cwd);
  return guard({ bin: inv!.bin, args: inv!.args, env: envFor(base, inv!, { agent: true }), cwd: inv!.cwd ?? cwd, mode: "agent" }, deps);
}

const ALLOW = { action: "allow", reason: "match" };
const CANT_TELL = {
  action: "block",
  uncertain: true,
  problems: [expect.stringMatching(/^the folder this command acts on is only known when the command runs \(.*\), so cloudpin can't tell which account this command would use$/)],
  fix: "give the folder a literal value, or run the command yourself",
};

describe("a folder word known only when the command runs is can't tell (#147, #160)", () => {
  it.each([
    'vercel deploy "$D"',
    "vercel deploy $(cat d.txt)",
    'vercel deploy "$(cat d.txt)"',
    "vercel deploy `cat d.txt`",
    'vc deploy "$D"',
    'vercel "$D"',
    "vercel $(cat d.txt)",
    'vercel pull "$D"',
    "vercel pull $(cat d.txt)",
    'vercel dev "$D"',
    'vercel develop "$D"',
    'vercel dev dev "$D"',
    'vercel deploy init "$D"',
    // Part of the word is known, which doesn't say which folder.
    'vercel deploy "sub/$D"',
    // Flags before the word, the command's own and the global ones.
    'vercel deploy --prod "$D"',
    'vercel deploy --name app "$D"',
    'vercel pull --environment preview "$D"',
    'vercel dev -l 3000 "$D"',
    'vercel --prod "$D"',
    'vercel -y "$D"',
    'vercel -d deploy "$D"',
    'vercel --cwd other deploy "$D"',
    // The first path decides (validatePaths), also with a literal one after it.
    'vercel deploy "$D" sub',
    'vercel pull "$D" sub',
    'vercel dev "$D" sub',
    // Every word after "--" is a positional (mainParse), and dynamicTarget stops reading there.
    'vercel deploy -- "$D"',
    "vercel deploy -- $D",
    'vercel pull -- "$D"',
    "vercel pull -- $D",
    'vercel dev -- "$D"',
    'vercel -- "$D"',
    "vercel -- $D",
    // A first word known only when it runs may be pull or dev, which take flags deploy refuses.
    'vercel "$CMD" sub',
    'vercel "$CMD" --environment preview sub',
    'vercel "$CMD" --bogus',
  ])("stops %s", async (command) => {
    expect(await line(command, tree())).toMatchObject(CANT_TELL);
  });

  it("also when the folder it runs in is the one that is wrong", async () => {
    // pull and dev used to read a folder named after the marker, with no link at all.
    const root = tree("team_main", "team_side");
    for (const command of ['vercel pull "$D"', 'vercel dev "$D"', 'vercel deploy "$D"', 'vercel "$D"']) {
      const verdict = await line(command, root);
      expect(verdict.action, command).toBe("block");
    }
  });

  it("names no value, and sends none to a CLI", async () => {
    sent.length = 0;
    for (const command of ['vercel deploy "$HIDDEN_NAME"', "vercel pull $(cat hidden-name.txt)", 'vercel "hidden-name/$D"']) {
      const text = JSON.stringify(await line(command, tree()));
      expect(text).toContain("can't tell");
      expect(text).not.toContain("HIDDEN_NAME");
      expect(text).not.toContain("hidden-name");
      expect(text).not.toContain("<cloudpin");
    }
    expect(sent.length).toBeGreaterThan(0);
    expect(sent.filter((args) => args.some((a) => a.includes("<cloudpin")))).toEqual([]);
  });
});

describe("a word only known when it runs that isn't the folder still passes (#160)", () => {
  it.each([
    // Commands that link the folder they run in: the word is a name, a URL or a deployment.
    'vercel ls "$D"',
    "vercel ls $(cat d.txt)",
    'vercel env add "$NAME"',
    'vercel logs "$URL"',
    'vercel inspect "$URL"',
    'vercel rm "$DEPLOYMENT"',
    'vercel alias set "$A" "$B"',
    'vercel ls -- "$D"',
    // Values of flags that pick no folder.
    'vercel deploy --meta "k=$V"',
    'vercel deploy -m "$V"',
    'vercel deploy --meta="k=$V"',
    'vercel deploy --env "A=$V" --build-env "B=$V"',
    'vercel deploy --name "$N"',
    'vercel deploy --target "$T"',
    'vercel --name "$N"',
    'vercel -m "$V"',
    'vercel pull --environment "$E"',
    'vercel pull --git-branch "$B"',
    'vercel dev -l "$PORT"',
    'vercel dev --listen="$PORT"',
    // `deploy continue` links the folder it runs in.
    'vercel deploy continue --id "$I"',
    'vercel deploy continue "$X" --id dpl_1',
    // Words Vercel parse-fails on: nothing is deployed, so the folder's own link is read (as with a literal word).
    'vercel deploy --bogus "$D"',
    'vercel pull --bogus "$D"',
    'vercel dev --bogus "$D"',
    'vercel deploy --id "$I"',
  ])("allows %s", async (command) => {
    expect(await line(command, tree())).toEqual(ALLOW);
  });

  it.each([
    ['vercel deploy sub "$D"'],
    ['vercel sub "$D"'],
    ['vercel pull sub "$D"'],
    ['vercel dev sub "$D"'],
    ['vercel deploy init sub "$D"'],
    ['vercel deploy sub -- "$D"'],
    ['vercel deploy -m "$V" sub'],
  ])("reads the literal folder of %s: the word after it picks nothing", async (command) => {
    expect(await line(command, tree("team_main"))).toEqual(ALLOW);
    expect(await line(command, tree("team_side"))).toMatchObject({ action: "block", problems: [expect.stringContaining('linked project: belongs to team "team_side"')] });
  });

  it.each(['vercel deploy "$D" --help', 'vercel pull "$D" -h', 'vercel whoami "$D"', 'vercel switch "$D"', 'vercel login "$D"', 'vercel teams ls "$D"'])(
    "%s stays exempt",
    async (command) => {
      expect(await line(command, tree())).toEqual({ action: "allow", reason: "exempt" });
    },
  );

  it.each([
    ['vercel deploy --token "$T"', "--token"],
    ['vercel deploy "$D" --token "$T"', "--token"],
    ['vercel deploy --scope "$S" "$D"', "--scope"],
    ['vercel --cwd "$C" deploy', "--cwd"],
  ])("%s keeps the reason for %s", async (command, flag) => {
    expect(await line(command, tree())).toMatchObject({
      action: "block",
      uncertain: true,
      problems: [expect.stringContaining(`the value of ${flag} is only known`)],
      fix: `give ${flag} a literal value, or run the command yourself`,
    });
  });

  it("an unquoted variable before any -- keeps the reason about flags", async () => {
    expect(await line("vercel deploy $D", tree())).toMatchObject({ uncertain: true, problems: [expect.stringContaining("could be flags")] });
  });
});

describe("a variable set earlier in the line is the folder it names (#160)", () => {
  it.each(['D=sub; vercel deploy "$D"', "D=sub; vercel deploy $D", 'D=sub; vercel "$D"', 'D=sub; vercel pull "$D"', 'D=sub; vercel dev "$D"', 'D=sub; vercel deploy -- "$D"'])(
    "%s reads sub's link",
    async (command) => {
      expect(await line(command, tree("team_main"))).toEqual(ALLOW);
      const wrong = await line(command, tree("team_side"));
      expect(wrong).toMatchObject({ action: "block", problems: [expect.stringContaining('linked project: belongs to team "team_side"')] });
      expect(wrong).not.toHaveProperty("uncertain");
    },
  );

  it("a folder that doesn't exist falls back as a literal one does", async () => {
    expect(await line('D=missing; vercel deploy "$D"', tree())).toEqual(ALLOW);
  });

  it("a variable set from something unknown is still can't tell", async () => {
    expect(await line('D=$(cat d.txt); vercel deploy "$D"', tree())).toMatchObject(CANT_TELL);
  });
});

describe("VERCEL_ORG_ID still decides before any link is read", () => {
  const withOrg = (org: string) => ({ ...loggedIn, VERCEL_ORG_ID: org, VERCEL_PROJECT_ID: "prj_1" });

  it.each(['vercel deploy "$D"', 'vercel "$D"', 'vercel pull "$D"', 'vercel dev "$D"'])("%s follows it", async (command) => {
    expect(await line(command, tree(), withOrg("team_main"))).toEqual(ALLOW);
    expect(await line(command, tree(), withOrg("team_side"))).toMatchObject({
      action: "block",
      problems: [expect.stringContaining('linked project: belongs to team "team_side"')],
    });
  });

  it("set on the line, and set from something unknown", async () => {
    expect(await line('VERCEL_ORG_ID=team_main VERCEL_PROJECT_ID=prj_1 vercel deploy "$D"', tree())).toEqual(ALLOW);
    expect(await line('VERCEL_ORG_ID=$(cat o) VERCEL_PROJECT_ID=prj_1 vercel deploy "$D"', tree())).toMatchObject({
      action: "block",
      uncertain: true,
      problems: [expect.stringContaining("VERCEL_ORG_ID")],
    });
  });
});

describe("agent hook: a folder word known only when the command runs (#147, #160)", () => {
  async function decision(command: string, cwd: string, tool: "Bash" | "PowerShell" = "Bash") {
    const input = JSON.stringify({ hook_event_name: "PreToolUse", tool_name: tool, tool_input: { command }, cwd });
    const out = await runHook(AGENTS.claude, input, deps, loggedIn);
    const hook = out ? JSON.parse(out).hookSpecificOutput : undefined;
    return { decision: hook?.permissionDecision ?? "allow", reason: hook?.permissionDecisionReason ?? "" };
  }

  it.each(['vercel deploy "$D"', "vercel $(cat d.txt)", 'vercel pull "$D"', 'vercel dev "$D"'])("denies %s and says what to do", async (command) => {
    const { decision: d, reason } = await decision(command, tree());
    expect(d).toBe("deny");
    expect(reason).toContain("can't tell");
    expect(reason).toContain("give the folder a literal value, or run the command yourself");
  });

  it("control: the same folder written out is read, and a command that takes no folder passes", async () => {
    expect((await decision("vercel deploy sub", tree("team_main"))).decision).toBe("allow");
    expect((await decision("vercel deploy sub", tree("team_side"))).decision).toBe("deny");
    expect((await decision('vercel ls "$D"', tree())).decision).toBe("allow");
  });

  it("from Claude Code's PowerShell tool", async () => {
    expect((await decision("vercel deploy $D", tree(), "PowerShell")).reason).toContain("can't tell");
    expect((await decision("$D = 'sub'; vercel deploy $D", tree("team_main"), "PowerShell")).decision).toBe("allow");
    const wrong = await decision("$D = 'sub'; vercel deploy $D", tree("team_side"), "PowerShell");
    expect(wrong.decision).toBe("deny");
    expect(wrong.reason).not.toContain("can't tell");
  });
});
