import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { FoundConfig } from "../src/config.js";
import { guard } from "../src/guard.js";
import { vercel } from "../src/providers/vercel.js";
import type { Exec } from "../src/types.js";
import { tempDir } from "./tmp.js";

// #127. Vercel picks the scope in vercel/vercel packages/cli/src/index.ts:
// `--scope || --team || localConfig?.scope`, where localConfig is read at startup, before
// `--cwd` changes folder, from `-A <file>` (relative to the folder the command runs in) or
// else vercel.json there (util/get-config.ts). now.json counted until the CLI deprecated it.
// arg 5.0.0 keeps the last occurrence of a repeated flag.

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

/** A temp folder holding the given files (name -> contents). */
function folder(files: Record<string, string> = {}): string {
  const dir = tempDir("cloudpin-vercel-scope-");
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body);
  return dir;
}
const scoped = (scope: unknown) => JSON.stringify({ scope });

const resolve = (args: string[], cwd = folder()) => vercel.resolve({ args, env: loggedIn, cwd }, fakeVercel());

async function check(args: string[], team: string, cwd = folder()) {
  const config: FoundConfig = { path: "/repo/.cloudpin.yml", pins: { vercel: { team } } };
  return guard(
    { bin: "vercel", args, env: loggedIn, cwd, mode: "agent" },
    { providers: [vercel], exec: fakeVercel(), findConfig: () => config },
  );
}

describe("vercel.resolve: --scope beats --team, whatever their order (#127)", () => {
  it.each([
    [["-S", "side", "-T", "acme", "deploy"]],
    [["-T", "acme", "-S", "side", "deploy"]],
    [["--team", "acme", "--scope", "side", "deploy"]],
    [["deploy", "--scope=side", "--team=acme"]],
    [["-dS", "side", "-dT", "acme", "deploy"]],
    [["-S", "acme", "--scope", "side", "-T", "acme"]],
  ])("uses the scope in %j", async (args) => {
    expect(await resolve(args)).toMatchObject({ identity: { team: "team_side", label: "side" } });
  });

  it.each([[["-T", "side", "--team", "acme", "deploy"]], [["--scope", "side", "-S", "acme", "deploy"]]])(
    "control: within one flag the last occurrence wins in %j",
    async (args) => {
      expect(await resolve(args)).toMatchObject({ identity: { team: "team_main" } });
    },
  );
});

describe("vercel.resolve: the local config's scope (#127)", () => {
  it("uses scope from vercel.json in the folder the command runs in, slug mapped to its ID", async () => {
    expect(await resolve(["deploy"], folder({ "vercel.json": scoped("side") }))).toMatchObject({
      identity: { team: "team_side", label: "side" },
    });
  });

  it("uses a scope given as a team ID", async () => {
    expect(await resolve(["deploy"], folder({ "vercel.json": scoped("team_side") }))).toMatchObject({
      identity: { team: "team_side" },
    });
  });

  it("reads vercel.json from the folder the command runs in, not from --cwd", async () => {
    const other = folder({ "vercel.json": scoped("acme") });
    expect(await resolve(["deploy", "--cwd", other], folder({ "vercel.json": scoped("side") }))).toMatchObject({
      identity: { team: "team_side" },
    });
    const elsewhere = folder({ "vercel.json": scoped("side") });
    expect(await resolve(["deploy", "--cwd", elsewhere])).toMatchObject({ identity: { team: "team_main" } });
  });

  it("uses scope from now.json when there is no vercel.json (older CLIs read it)", async () => {
    expect(await resolve(["deploy"], folder({ "now.json": scoped("side") }))).toMatchObject({
      identity: { team: "team_side" },
    });
  });

  it("prefers vercel.json over now.json", async () => {
    const cwd = folder({ "vercel.json": scoped("acme"), "now.json": scoped("side") });
    expect(await resolve(["deploy"], cwd)).toMatchObject({ identity: { team: "team_main" } });
  });

  it("reads the -A file instead of vercel.json, relative to the folder the command runs in", async () => {
    const cwd = folder({ "vercel.json": scoped("acme"), "custom.json": scoped("side") });
    const other = folder({ "custom.json": scoped("acme") });
    for (const args of [
      ["-A", "custom.json", "deploy"],
      ["--local-config", "custom.json", "deploy"],
      ["--local-config=custom.json", "deploy"],
      ["-dA", "custom.json", "deploy"],
      ["-A", "custom.json", "--cwd", other, "deploy"],
      ["-A", join(cwd, "custom.json"), "deploy"],
    ]) {
      expect(await resolve(args, cwd), JSON.stringify(args)).toMatchObject({ identity: { team: "team_side" } });
    }
  });

  it("ignores vercel.json's scope when the -A file has none", async () => {
    const cwd = folder({ "vercel.json": scoped("side"), "custom.json": "{}" });
    expect(await resolve(["-A", "custom.json", "deploy"], cwd)).toMatchObject({ identity: { team: "team_main" } });
  });

  it.each([[["deploy", "-T", "acme"]], [["deploy", "--scope", "acme"]]])("lets the flag in %j beat the file", async (args) => {
    expect(await resolve(args, folder({ "vercel.json": scoped("side") }))).toMatchObject({
      identity: { team: "team_main" },
    });
  });

  it.each([["{}"], [scoped("")], [scoped(42)], ["[]"], ["null"]])("uses no scope from %s", async (body) => {
    expect(await resolve(["deploy"], folder({ "vercel.json": body }))).toMatchObject({
      identity: { team: "team_main" },
    });
  });

  it("control: no local config means no scope", async () => {
    expect(await resolve(["deploy"])).toMatchObject({ identity: { team: "team_main" } });
  });
});

describe("vercel.resolve: a local config it cannot read fails closed (#127)", () => {
  it.each([
    ["invalid vercel.json", ["deploy"], { "vercel.json": "{ scope: side" }],
    ["invalid now.json beside a valid vercel.json", ["deploy"], { "vercel.json": scoped("acme"), "now.json": "{" }],
    ["invalid vercel.json, with a flag", ["deploy", "--scope", "acme"], { "vercel.json": "{" }],
    ["invalid -A file", ["-A", "custom.json", "deploy"], { "custom.json": "not json" }],
    ["missing -A file", ["-A", "missing.json", "deploy"], {}],
  ])("%s", async (_name, args, files) => {
    const res = await resolve(args, folder(files));
    expect(res).toMatchObject({ kind: "error" });
    expect(JSON.stringify(res)).toMatch(/vercel\.json|now\.json|custom\.json|missing\.json/);
  });

  it("an unreadable vercel.json (a folder by that name)", async () => {
    const cwd = folder();
    mkdirSync(join(cwd, "vercel.json"));
    expect(await resolve(["deploy"], cwd)).toMatchObject({ kind: "error" });
  });
});

describe("guard: vercel scope, pinned to a team (#127)", () => {
  it("blocks -S other -T pinned, and allows -S pinned -T other", async () => {
    expect(await check(["-S", "side", "-T", "acme", "deploy"], "team_main")).toMatchObject({ action: "block" });
    expect(await check(["-S", "side", "-T", "acme", "deploy"], "team_side")).toEqual({ action: "allow", reason: "match" });
  });

  it("blocks a vercel.json scope naming another team, though the active team is the pinned one", async () => {
    const cwd = folder({ "vercel.json": scoped("side") });
    expect(await check(["deploy"], "team_main", cwd)).toMatchObject({ action: "block" });
    expect(await check(["deploy"], "team_side", cwd)).toEqual({ action: "allow", reason: "match" });
  });

  it("control: without a scope anywhere, the active pinned team passes and a wrong pin blocks", async () => {
    expect(await check(["deploy"], "team_main")).toEqual({ action: "allow", reason: "match" });
    expect(await check(["deploy"], "team_side")).toMatchObject({ action: "block" });
  });

  it("blocks as uncertain when vercel.json is not valid JSON", async () => {
    expect(await check(["deploy"], "team_main", folder({ "vercel.json": "{" }))).toMatchObject({
      action: "block",
      uncertain: true,
    });
  });
});
