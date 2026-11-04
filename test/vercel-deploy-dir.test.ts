import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { FoundConfig } from "../src/config.js";
import { guard } from "../src/guard.js";
import { vercel } from "../src/providers/vercel.js";
import type { Exec } from "../src/types.js";
import { tempDir } from "./tmp.js";

// #147. Some Vercel commands link the folder named by their path argument, not the folder
// they run in (vercel 50.35):
// - deploy (src/commands/deploy/index.ts handleDefaultDeploy, handleInitDeployment): the paths
//   are the positionals after "deploy", resolved against the folder after --cwd; validatePaths
//   stops unless paths[0] is a directory; then ensureLink("deploy", client, paths[0]).
//   `deploy continue` links the folder itself.
// - a first word that is no Vercel command (src/index.ts) runs an extension vercel-<word> in
//   the folder, if one exists, else deploys the word as a path.
// - pull (src/commands/pull/index.ts): `parsedArgs.args[1] || client.cwd`.
// - dev (src/commands/dev/index.ts, dev.ts): the first argument after "dev".
// The scope still comes only from the local config in the folder the command runs in
// (src/index.ts getConfig, read before --cwd).

const TEAMS = JSON.stringify({
  teams: [
    { id: "team_main", slug: "acme", current: true },
    { id: "team_side", slug: "side", current: false },
  ],
  pagination: {},
});

function fakeVercel() {
  const exec: Exec = async (_bin, args) => {
    if (args[0] === "teams") return { code: 0, stdout: TEAMS, stderr: "" };
    return { code: 1, stdout: "", stderr: "unexpected" };
  };
  return exec;
}

const loggedIn = { VERCEL_TOKEN: "example-env-token" };
const split = (cmd: string) => (cmd === "" ? [] : cmd.split(" "));

/** Links `dir` (created if missing) to a project of team `org`. */
function link(dir: string, org: string): string {
  mkdirSync(join(dir, ".vercel"), { recursive: true });
  writeFileSync(join(dir, ".vercel", "project.json"), JSON.stringify({ orgId: org, projectId: `prj_${org}` }));
  return dir;
}

/** A folder holding `sub`, linked to `subTeam`; the folder itself is linked to `rootTeam` when given. */
function tree(subTeam: string, rootTeam?: string): string {
  const root = tempDir("cloudpin-vercel-deploy-dir-");
  link(join(root, "sub"), subTeam);
  if (rootTeam) link(root, rootTeam);
  return root;
}

const resolve = (args: string[], cwd: string) => vercel.resolve({ args, env: loggedIn, cwd }, fakeVercel());

async function check(args: string[], cwd: string, team = "team_main") {
  const config: FoundConfig = { path: "/repo/.cloudpin.yml", pins: { vercel: { team } } };
  return guard(
    { bin: "vercel", args, env: loggedIn, cwd, mode: "agent" },
    { providers: [vercel], exec: fakeVercel(), findConfig: () => config },
  );
}

const ALLOW = { action: "allow", reason: "match" };

describe("guard: deploying a folder checks that folder's link (#147)", () => {
  it.each([
    "deploy sub",
    "sub",
    "./sub",
    "deploy ./sub --prod",
    "deploy --prod sub",
    "--prod sub",
    "-y sub",
    "-dy sub",
    "deploy --name app sub",
    "deploy -m k=v sub",
    "deploy -e A=1 -b B=2 --target preview sub",
    "deploy --archive=tgz sub",
    "deploy -- sub",
    "deploy sub other",
    "deploy init sub",
    "deploy init --prod -e A=1 sub",
    "-d deploy sub",
  ])("blocks %s when sub is linked to another team", async (cmd) => {
    expect(await check(split(cmd), tree("team_side"))).toMatchObject({ action: "block" });
  });

  it("blocks an absolute path to a folder linked to another team", async () => {
    const elsewhere = tree("team_side");
    expect(await check(["deploy", join(elsewhere, "sub")], tree("team_main"))).toMatchObject({ action: "block" });
  });

  it.each(["deploy sub", "sub", "-y sub", "deploy init sub"])(
    "control: allows %s when sub is linked to the pinned team, and a wrong pin blocks it",
    async (cmd) => {
      const root = tree("team_main");
      expect(await check(split(cmd), root)).toEqual(ALLOW);
      expect(await check(split(cmd), root, "team_side")).toMatchObject({ action: "block" });
    },
  );

  it("control: deploy with no path still reads the link of the folder it runs in", async () => {
    expect(await check(["deploy"], tree("team_side", "team_main"))).toEqual(ALLOW);
    expect(await check([], tree("team_side", "team_main"))).toEqual(ALLOW);
    expect(await check(["deploy", "--prod"], tree("team_main", "team_side"))).toMatchObject({ action: "block" });
  });

  it("an explicit deploy of sub reads only sub's link", async () => {
    expect(await check(["deploy", "sub"], tree("team_main", "team_side"))).toEqual(ALLOW);
  });

  it("a bare word also counts the folder's own link: Vercel runs vercel-<word> there if it exists", async () => {
    expect(await check(["sub"], tree("team_main", "team_side"))).toMatchObject({ action: "block" });
    expect(await check(["sub"], tree("team_main", "team_main"))).toEqual(ALLOW);
  });
});

describe("guard: --cwd and the deploy path (#147)", () => {
  it("--cwd other deploy sub reads other/sub", async () => {
    const root = tree("team_main");
    link(join(root, "other", "sub"), "team_side");
    expect(await check(["--cwd", "other", "deploy", "sub"], root)).toMatchObject({ action: "block" });
    expect(await check(["deploy", "sub", "--cwd=other"], root)).toMatchObject({ action: "block" });
  });

  it("control: --cwd other deploy sub ignores ./sub", async () => {
    const root = tree("team_side");
    link(join(root, "other", "sub"), "team_main");
    expect(await check(["--cwd", "other", "deploy", "sub"], root)).toEqual(ALLOW);
  });
});

describe("guard: a known command word is not a path (#147)", () => {
  it.each(["env ls", "logs x", "ls", "inspect x", "teams ls x", "switch x"])(
    "%s reads the link of the folder it runs in",
    async (cmd) => {
      const root = tree("team_main", "team_main");
      for (const word of split(cmd)) link(join(root, word), "team_side");
      const res = await check(split(cmd), root);
      expect(res.action, JSON.stringify(res)).not.toBe("block");
    },
  );

  it("deploy continue links the folder it runs in, not a folder named continue", async () => {
    const root = tree("team_side", "team_main");
    link(join(root, "continue"), "team_side");
    expect(await check(["deploy", "continue", "--id", "dpl_1"], root)).toEqual(ALLOW);
  });
});

describe("guard: a path Vercel would refuse falls back to the folder it runs in (#147)", () => {
  it("a missing path, or a file, reads the folder's own link: Vercel stops before linking", async () => {
    const root = tree("team_side", "team_main");
    writeFileSync(join(root, "file.txt"), "x");
    expect(await check(["deploy", "missing"], root)).toEqual(ALLOW);
    expect(await check(["deploy", "file.txt"], root)).toEqual(ALLOW);
    expect(await check(["missing"], root)).toEqual(ALLOW);
    const wrong = tree("team_main", "team_side");
    expect(await check(["deploy", "missing"], wrong)).toMatchObject({ action: "block" });
  });

  it.each(["deploy --bogus sub", "deploy sub --bogus", "deploy init --name x sub"])(
    "%s is a Vercel parse error; the folder's own link is read",
    async (cmd) => {
      expect(await check(split(cmd), tree("team_side", "team_main"))).toEqual(ALLOW);
    },
  );
});

describe("guard: pull and dev read the folder they are given (#147)", () => {
  it.each([
    "pull sub",
    "pull --environment preview sub",
    "pull --git-branch main --yes sub",
    "dev sub",
    "develop sub",
    "dev dev sub",
    "dev -l 3000 sub",
    "dev --listen=3000 -L sub",
  ])("blocks %s when sub is linked to another team", async (cmd) => {
    expect(await check(split(cmd), tree("team_side", "team_main"))).toMatchObject({ action: "block" });
  });

  it.each(["pull sub", "dev sub"])("control: allows %s when sub is linked to the pinned team, and a wrong pin blocks it", async (cmd) => {
    const root = tree("team_main", "team_side");
    expect(await check(split(cmd), root)).toEqual(ALLOW);
    expect(await check(split(cmd), root, "team_side")).toMatchObject({ action: "block" });
  });

  it.each(["pull", "pull --prod", "dev", "dev dev"])("control: %s reads the folder it runs in", async (cmd) => {
    // A second "dev" is the command's own name (getSubcommand), not a folder called dev.
    const root = tree("team_side", "team_main");
    link(join(root, "dev"), "team_side");
    expect(await check(split(cmd), root)).toEqual(ALLOW);
  });
});

describe("vercel.resolve: the deploy path (#147)", () => {
  it("reports the path's linked team", async () => {
    expect(await resolve(["deploy", "sub"], tree("team_side", "team_main"))).toMatchObject({
      identity: { team: "team_main", projectTeam: "team_side" },
    });
  });

  it("uses a repository link's project for the path, not for the folder it runs in", async () => {
    const root = tempDir("cloudpin-vercel-deploy-dir-");
    mkdirSync(join(root, ".vercel"));
    mkdirSync(join(root, "sub"));
    writeFileSync(
      join(root, ".vercel", "repo.json"),
      JSON.stringify({
        orgId: "team_main",
        projects: [
          { id: "prj_root", name: "root", directory: "." },
          { id: "prj_sub", name: "sub", directory: "sub", orgId: "team_side" },
        ],
      }),
    );
    expect(await resolve(["deploy"], root)).toMatchObject({ identity: { projectTeam: "team_main" } });
    expect(await resolve(["deploy", "sub"], root)).toMatchObject({ identity: { projectTeam: "team_side" } });
  });

  it("keeps the scope from the folder it runs in: Vercel reads vercel.json before it knows the path", async () => {
    const root = tree("team_main");
    writeFileSync(join(root, "sub", "vercel.json"), JSON.stringify({ scope: "side" }));
    expect(await resolve(["deploy", "sub"], root)).toMatchObject({ identity: { team: "team_main" } });
  });

  it("VERCEL_ORG_ID still decides the project team", async () => {
    const res = await vercel.resolve(
      { args: ["deploy", "sub"], env: { ...loggedIn, VERCEL_ORG_ID: "team_main" }, cwd: tree("team_side") },
      fakeVercel(),
    );
    expect(res).toMatchObject({ identity: { projectTeam: "team_main" } });
  });
});
