import { describe, expect, it } from "vitest";
import type { FoundConfig } from "../src/config.js";
import { guard } from "../src/guard.js";
import { vercel } from "../src/providers/vercel.js";
import type { Exec } from "../src/types.js";
import { tempDir } from "./tmp.js";

// #146. Vercel's main() (vercel 50.35, packages/cli/src/index.ts) parses the global flags
// (src/util/arg-common.ts) with arg 5.0.0 and { permissive: true }: a flag it doesn't know, or
// a letter of a short group it doesn't know, is kept as a positional, and the first positional
// is the command. A flag in that place is no command and no extension, so Vercel runs deploy.
// --version prints the version only when there is no command; every command accepts -v and
// ignores it. A command's own --help is honoured by most commands, not all: `promote <id>`
// and `rollback <id>` ignore it, and an extension (vercel-<word>) never receives it.

const split = (cmd: string) => (cmd === "" ? [] : cmd.split(" "));

describe("vercel.isExempt: the command is the one Vercel runs (#146)", () => {
  it.each([
    // A deploy flag before an exempt word is the command: Vercel deploys.
    "--prod --name whoami",
    "-yn whoami",
    "-m login",
    "-dy whoami",
    "-y whoami",
    "-yd whoami",
    "-dyQ x whoami",
    // -v / --version with a command does not stop the command.
    "deploy --prod -v",
    "--version deploy",
    "-v .",
    "-dv deploy --prod",
    "redirects list --version 3",
    // An unknown flag is a Vercel parse error; checking it is fine.
    "--unknown whoami",
    "-x whoami",
    "-dx whoami",
    // --help that the command never sees, or ignores.
    "promote dpl_123 --help",
    "rollback dpl_123 --yes -h",
    "rr start -dh",
    "my-extension --help",
    "deploy -- --help",
    "curl /api -- -X DELETE --help",
    "--prod --help",
  ])("checks vercel %s", (cmd) => {
    expect(vercel.isExempt(split(cmd))).toBe(false);
  });

  it("checks an empty command word, which Vercel reads as no command and deploys", () => {
    expect(vercel.isExempt(["", "whoami"])).toBe(false);
  });

  // arg throws when a value flag is not last in its group or has no value; nothing runs then.
  it.each(["-Tv x", "-Th x", "--scope -v", "-t"])("checks vercel %s, a parse error", (cmd) => {
    expect(vercel.isExempt(split(cmd))).toBe(false);
  });

  it.each([
    "-d whoami",
    "--debug whoami",
    "-Q x whoami",
    "-dT team whoami",
    "--scope=x whoami",
    "--version",
    "-v",
    "-dv",
    "--help",
    "-h",
    "-dh",
    "teams ls",
    "-t tok teams switch",
    "deploy --help",
    "deploy -dh",
    "env add X production --help",
    "login",
    "logout",
    "switch",
    "help deploy",
    // --api takes a value (arg-common.ts); the URL is not the command.
    "--api https://a.example whoami",
    // arg reads every word after "--" as a positional, so Vercel runs whoami.
    "-- whoami",
  ])("allows vercel %s", (cmd) => {
    expect(vercel.isExempt(split(cmd))).toBe(true);
  });
});

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

const FAKE_TOKEN = "exampleFakeToken146";

async function check(args: string[], team: string) {
  const config: FoundConfig = { path: "/repo/.cloudpin.yml", pins: { vercel: { team } } };
  return guard(
    { bin: "vercel", args, env: { VERCEL_TOKEN: FAKE_TOKEN }, cwd: tempDir("cloudpin-vercel-"), mode: "agent" },
    { providers: [vercel], exec: fakeVercel(), findConfig: () => config },
  );
}

describe("guard: vercel pinned to another team (#146)", () => {
  it("blocks vercel deploy --prod -v", async () => {
    expect(await check(split("deploy --prod -v"), "team_side")).toMatchObject({ action: "block" });
  });

  it("blocks vercel --prod --name whoami, a production deploy", async () => {
    expect(await check(split("--prod --name whoami"), "team_side")).toMatchObject({ action: "block" });
  });

  it("blocks vercel promote <id> --help, which promotes", async () => {
    expect(await check(split("promote dpl_123 --help"), "team_side")).toMatchObject({ action: "block" });
  });

  it("reads the team of a deploy whose command is a flag: -y -T side whoami", async () => {
    expect(await check(split("-y -T side whoami"), "team_main")).toMatchObject({ action: "block" });
    expect(await check(split("-y -T side whoami"), "team_side")).toEqual({ action: "allow", reason: "match" });
  });

  it("control: allows vercel whoami -d as exempt", async () => {
    expect(await check(split("whoami -d"), "team_side")).toEqual({ action: "allow", reason: "exempt" });
  });

  it("control: allows vercel deploy --prod -v on the pinned team", async () => {
    expect(await check(split("deploy --prod -v"), "team_main")).toEqual({ action: "allow", reason: "match" });
  });

  it("never names the token in a block message", async () => {
    const verdict = await check(["-t", FAKE_TOKEN, "-y", "whoami"], "team_side");
    expect(verdict).toMatchObject({ action: "block" });
    expect(JSON.stringify(verdict)).not.toContain(FAKE_TOKEN);
  });
});
