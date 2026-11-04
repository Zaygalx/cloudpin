import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { FoundConfig } from "../src/config.js";
import { guard } from "../src/guard.js";
import { vercel } from "../src/providers/vercel.js";
import { isReadOnly } from "../src/readonly.js";
import type { Exec } from "../src/types.js";
import { tempDir } from "./tmp.js";

// #148. `vercel project inspect` with no name links the folder through ensureLink, which with
// --yes can create a project, link the folder and connect Git (vercel 50.35:
// src/commands/project/inspect.ts, util/projects/get-project-by-cwd-or-link.ts). The project
// command parses permissively (src/commands/project/index.ts main), so a group's unknown -y is
// kept as a word, and "--" is dropped; inspect then parses those words with --yes/-y
// (inspectSubcommand options: yesOption). So `-dy`, `-yd` and `-- -dy` all pass --yes.

const split = (cmd: string) => (cmd === "" ? [] : cmd.split(" "));
const env = { HOME: tempDir("cloudpin-yes-home-"), USERPROFILE: "" };
const ro = (cmd: string) => isReadOnly("vercel", split(cmd), env, {});

describe("isReadOnly: vercel --yes in a short group (#148)", () => {
  it.each([
    "project inspect -dy",
    "projects inspect -yd",
    "project inspect -dyQ x",
    "project inspect -- -y",
    "project inspect -- -dy",
    "project inspect --yes=false",
    "ls -dy",
  ])("vercel %s needs confirmation", (cmd) => {
    expect(ro(cmd)).toBe(false);
  });

  it.each(["project inspect", "project inspect -dQ dir", "projects inspect -d", "ls -d", "env ls -d"])(
    "control: vercel %s stays read-only",
    (cmd) => {
      expect(ro(cmd)).toBe(true);
    },
  );
});

// src/commands/teams/index.ts COMMAND_CONFIG: list = ls|list, switch = switch|change,
// add = create|add, invite. teamsCommand's aliases are "switch" and "team"
// (src/commands/teams/command.ts), and the subcommand is the word after the one typed.
describe("vercel.isExempt: teams subcommand aliases (#148)", () => {
  it.each(["teams change", "teams change acme", "team ls", "team list", "team switch", "team change acme", "-d team ls"])(
    "allows vercel %s",
    (cmd) => {
      expect(vercel.isExempt(split(cmd))).toBe(true);
    },
  );

  it.each(["teams add", "teams create", "team add", "team create", "team invite a@example.com", "teams -x ls", "team"])(
    "checks vercel %s",
    (cmd) => {
      expect(vercel.isExempt(split(cmd))).toBe(false);
    },
  );
});

const TEAMS = JSON.stringify({
  teams: [
    { id: "team_main", slug: "acme", current: true },
    { id: "team_side", slug: "side", current: false },
  ],
  pagination: {},
});

const fakeVercel: Exec = async (_bin, args) => {
  if (args[0] === "teams") return { code: 0, stdout: TEAMS, stderr: "" };
  return { code: 1, stdout: "", stderr: "unexpected" };
};

const loggedIn = { VERCEL_TOKEN: "example-env-token" };
const production = { name: "production", protected: true, source: 'branch "main"' };

async function check(cmd: string, team = "team_main", cwd = tempDir("cloudpin-vercel-yes-")) {
  const config: FoundConfig = { path: "/repo/.cloudpin.yml", pins: { vercel: { team } }, environment: production };
  return guard(
    { bin: "vercel", args: split(cmd), env: loggedIn, cwd, mode: "agent" },
    { providers: [vercel], exec: fakeVercel, findConfig: () => config },
  );
}

const CONFIRM = { action: "confirm", provider: "vercel", configPath: "/repo/.cloudpin.yml", environment: production };

describe("guard: vercel on a protected environment (#148)", () => {
  it.each(["project inspect -dy", "projects inspect -yd", "project inspect -dyQ x"])(
    "asks before vercel %s, which may link the folder",
    async (cmd) => {
      expect(await check(cmd)).toEqual(CONFIRM);
    },
  );

  it("still asks before vercel deploy --prod -dy", async () => {
    expect(await check("deploy --prod -dy")).toEqual(CONFIRM);
  });

  it.each(["project inspect", "project inspect -dQ dir"])("control: lets vercel %s through", async (cmd) => {
    expect(await check(cmd)).toEqual({ action: "allow", reason: "match" });
  });

  // #146 fixed these false blocks; a wrong team proves the command is exempt, not matched.
  it.each(["-dv", "-dh", "--api https://api.example.com whoami", "teams change", "team switch"])(
    "allows vercel %s as exempt",
    async (cmd) => {
      expect(await check(cmd, "team_side")).toEqual({ action: "allow", reason: "exempt" });
    },
  );
});

/** Links `dir` (created if missing) to a project of team `org`. */
function link(dir: string, org: string): string {
  mkdirSync(join(dir, ".vercel"), { recursive: true });
  writeFileSync(join(dir, ".vercel", "project.json"), JSON.stringify({ orgId: org, projectId: `prj_${org}` }));
  return dir;
}

describe("vercel.resolve: --api takes a value (#146, #148)", () => {
  // Read as the command, the value `sub` would be a deploy path and add sub's link.
  it("reads the folder's link, not the --api value's", async () => {
    const root = link(tempDir("cloudpin-vercel-api-"), "team_main");
    link(join(root, "sub"), "team_side");
    const resolution = await vercel.resolve({ args: split("--api sub ls"), env: loggedIn, cwd: root }, fakeVercel);
    expect(resolution).toMatchObject({ kind: "identity", identity: { team: "team_main", projectTeam: "team_main" } });
  });

  it("control: a deploy of sub reads sub's link", async () => {
    const root = link(tempDir("cloudpin-vercel-api-"), "team_main");
    link(join(root, "sub"), "team_side");
    const resolution = await vercel.resolve({ args: split("deploy sub"), env: loggedIn, cwd: root }, fakeVercel);
    expect(resolution).toMatchObject({ kind: "identity", identity: { projectTeam: "team_side" } });
  });
});
