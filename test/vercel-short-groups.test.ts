import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { FoundConfig } from "../src/config.js";
import { guard } from "../src/guard.js";
import { vercel } from "../src/providers/vercel.js";
import type { Exec } from "../src/types.js";
import { tempDir } from "./tmp.js";

// #125. Vercel parses its flags with arg 5.0.0 (vercel/vercel packages/cli/package.json;
// github.com/vercel/arg index.js at tag 5.0.0): a single-dash word longer than two
// characters is one flag per letter (`-dT` is `-d -T`), and when the last letter takes
// a value it reads the next word. Global flags: vercel/vercel packages/cli/src/util/arg-common.ts
// (booleans -d -h -v; values -A -Q -S -t -T).

const TEAMS = JSON.stringify({
  teams: [
    { id: "team_main", slug: "acme", current: true },
    { id: "team_side", slug: "side", current: false },
  ],
  pagination: {},
});
// With --token, vercel drops the config's current team (packages/cli/src/index.ts).
const TEAMS_NONE_CURRENT = JSON.stringify({ teams: [{ id: "team_side", slug: "side", current: false }] });
const USER = JSON.stringify({ user: { defaultTeamId: "team_hobby" } });

function fakeVercel() {
  const calls: string[][] = [];
  const exec: Exec = async (_bin, args) => {
    calls.push(args);
    if (args[0] === "teams") {
      return { code: 0, stdout: args.includes("--token") ? TEAMS_NONE_CURRENT : TEAMS, stderr: "" };
    }
    if (args[0] === "api") return { code: 0, stdout: USER, stderr: "" };
    return { code: 1, stdout: "", stderr: "unexpected" };
  };
  return { exec, calls };
}

/** An env with no Vercel login anywhere, so only a token or a --global-config login counts. */
function noLogin(): NodeJS.ProcessEnv {
  const empty = tempDir("cloudpin-vercel-home-");
  return { HOME: empty, USERPROFILE: empty, APPDATA: empty, XDG_DATA_HOME: empty };
}
const loggedIn = { VERCEL_TOKEN: "example-env-token" };
const ctx = (args: string[], env: NodeJS.ProcessEnv = loggedIn) => ({
  args,
  env,
  cwd: tempDir("cloudpin-vercel-"),
});

const FAKE_TOKEN = "exampleFakeToken123";

async function check(args: string[], team: string, env: NodeJS.ProcessEnv = loggedIn) {
  const { exec } = fakeVercel();
  const config: FoundConfig = { path: "/repo/.cloudpin.yml", pins: { vercel: { team } } };
  return guard(
    { bin: "vercel", args, env, cwd: tempDir("cloudpin-vercel-"), mode: "agent" },
    { providers: [vercel], exec, findConfig: () => config },
  );
}

describe("vercel.resolve: a short group ending in a value flag reads the next word (#125)", () => {
  it.each([
    [["-dT", "team_side", "deploy"]],
    [["-dT", "side", "deploy"]],
    [["-dS", "side", "deploy"]],
    [["deploy", "-dS", "side"]],
    [["-ddT", "side", "deploy"]],
  ])("uses the team given through %j", async (args) => {
    const { exec } = fakeVercel();
    expect(await vercel.resolve(ctx(args), exec)).toMatchObject({ identity: { team: "team_side", label: "side" } });
  });

  it("passes a token given through -dt to its own calls, and counts it as a login", async () => {
    const { exec, calls } = fakeVercel();
    const res = await vercel.resolve(ctx(["-dt", FAKE_TOKEN, "deploy"], noLogin()), exec);
    expect(res).toMatchObject({ kind: "identity", identity: { team: "team_hobby" } });
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) expect(call.join(" ")).toContain(`--token ${FAKE_TOKEN}`);
    expect(JSON.stringify(res)).not.toContain(FAKE_TOKEN);
  });

  it("uses a login found through -dQ <dir>", async () => {
    const { exec, calls } = fakeVercel();
    const cfg = tempDir("cloudpin-vercel-cfg-");
    writeFileSync(join(cfg, "auth.json"), "{}");
    const res = await vercel.resolve(ctx(["-dQ", cfg, "ls"], noLogin()), exec);
    expect(res).toMatchObject({ kind: "identity" });
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) expect(call.join(" ")).toContain(`--global-config ${cfg}`);
  });

  it("still reads --cwd after a group", async () => {
    const { exec } = fakeVercel();
    const linked = tempDir("cloudpin-vercel-linked-");
    mkdirSync(join(linked, ".vercel"));
    writeFileSync(join(linked, ".vercel", "project.json"), JSON.stringify({ orgId: "team_side", projectId: "prj_1" }));
    expect(await vercel.resolve(ctx(["-dT", "acme", "--cwd", linked, "deploy"]), exec)).toMatchObject({
      identity: { team: "team_main", projectTeam: "team_side" },
    });
  });

  it("does not split words after --", async () => {
    const { exec } = fakeVercel();
    expect(await vercel.resolve(ctx(["deploy", "--", "-dT", "side"]), exec)).toMatchObject({
      identity: { team: "team_main" },
    });
  });
});

describe("vercel.isExempt: a short group's value is not the command (#125)", () => {
  it.each([[["-dT", "whoami", "deploy"]], [["-dt", "login", "deploy"]], [["-dS", "switch", "deploy", "--prod"]]])(
    "guards %j",
    (args) => {
      expect(vercel.isExempt(args)).toBe(false);
    },
  );

  it.each([[["-dT", "side", "whoami"]], [["-d", "whoami"]], [["-dQ", "./cfg", "teams", "switch"]]])(
    "allows %j",
    (args) => {
      expect(vercel.isExempt(args)).toBe(true);
    },
  );
});

describe("guard: vercel with a short group, pinned to a team (#125)", () => {
  it("blocks a wrong team given through -dT, though the active team is the pinned one", async () => {
    expect(await check(["-dT", "side", "deploy"], "team_main")).toMatchObject({ action: "block" });
  });

  it("blocks -dT whoami deploy instead of treating it as whoami", async () => {
    expect(await check(["-dT", "whoami", "deploy"], "team_main")).toMatchObject({ action: "block" });
  });

  it("blocks a token given through -dt that resolves to another team, without naming the token", async () => {
    const verdict = await check(["-dt", FAKE_TOKEN, "deploy"], "team_main", noLogin());
    expect(verdict).toMatchObject({ action: "block" });
    expect(JSON.stringify(verdict)).toContain("team_hobby");
    expect(JSON.stringify(verdict)).not.toContain(FAKE_TOKEN);
  });

  it("allows the pinned team given through -dT", async () => {
    expect(await check(["-dT", "side", "deploy"], "team_side")).toEqual({ action: "allow", reason: "match" });
  });

  it("control: allows -dT naming the active, pinned team", async () => {
    expect(await check(["-dT", "acme", "deploy"], "team_main")).toEqual({ action: "allow", reason: "match" });
  });

  it("control: -T as a word of its own still works both ways", async () => {
    expect(await check(["-T", "side", "deploy"], "team_side")).toEqual({ action: "allow", reason: "match" });
    expect(await check(["-T", "side", "deploy"], "team_main")).toMatchObject({ action: "block" });
  });
});
