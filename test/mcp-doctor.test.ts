import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import type { FoundConfig } from "../src/config.js";
import { doctorJson, runDoctor, type DoctorDeps } from "../src/doctor.js";
import type { GuardDeps } from "../src/guard.js";
import { hookFile } from "../src/install.js";
import { cloudpinHandler, cloudpinTools, type DoctorHost, type ToolContext } from "../src/mcp-tools.js";
import { probeWritable } from "../src/paths.js";
import type { Exec, ProviderDef } from "../src/types.js";
import { tempDir } from "./tmp.js";

const TEAM = "team_0123456789abcdef";

function vercel(): ProviderDef {
  return {
    name: "vercel",
    bins: ["vercel"],
    statusCommand: "vercel whoami",
    cacheInputs: () => ({ env: [], files: [], dirs: [] }),
    isExempt: () => false,
    resolve: async () => ({ kind: "identity", identity: { team: TEAM }, source: "the global current team" }),
    compare: (pin: Record<string, string>, id) => (pin.team === id.team ? [] : [`team: pinned "${pin.team}", active is "${id.team}"`]),
    switchHint: (pin: Record<string, string>) => `vercel switch ${pin.team}`,
  } as ProviderDef;
}

const readOrNull = (path: string): string | null => {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
};

/** A real project folder (home and cache inside it, so any write doctor makes lands there) and fake CLIs. */
function setup() {
  const project = tempDir("cloudpin-mcp-doctor-");
  const home = join(project, "home");
  const env: NodeJS.ProcessEnv = { HOME: home, USERPROFILE: home, CLOUDPIN_CACHE_DIR: join(project, "cache"), CLOUDPIN_NO_UPDATE_CHECK: "1" };
  const exec: Exec = async (bin, args) =>
    bin === "cloudpin" && args[0] === "--version" ? { code: 0, stdout: "9.9.9\n", stderr: "" } : { code: 0, stdout: "", stderr: "" };
  const config: FoundConfig = { path: join(project, ".cloudpin.yml"), pins: { vercel: { team: TEAM } } };
  const guard: GuardDeps = { providers: [vercel()], exec, findConfig: () => config };
  const host: DoctorHost = {
    platform: "linux",
    version: "9.9.9",
    self: join(project, "cli.js"),
    install: "npm",
    realpath: (p) => p,
    node: "22.17.0",
    onPath: (name) => (name === "cloudpin" ? join(project, "bin", "cloudpin") : null),
    latest: async () => null,
  };
  const ctx: ToolContext = {
    cwd: project,
    env,
    read: readOrNull,
    isDir: (p) => statSync(p, { throwIfNoEntry: false })?.isDirectory() ?? false,
    doctor: host,
  };
  const tool = cloudpinTools(guard, ctx).find((t) => t.name === "cloudpin_doctor");
  const cliDeps = (writable: DoctorDeps["writable"]): DoctorDeps => ({ guard, env, cwd: project, read: readOrNull, writable, ...host });
  return { project, env, guard, ctx, tool, cliDeps };
}

/** Every file and folder under `dir`, sorted. */
const listing = (dir: string) => readdirSync(dir, { recursive: true, encoding: "utf8" }).sort();

type Result = { cloudpin: string; checks: { id: string; level: string; title: string; detail?: string[] }[] };

describe("cloudpin_doctor", () => {
  it("is listed with a schema that takes an optional cwd", async () => {
    const { guard, ctx } = setup();
    const handle = cloudpinHandler(guard, ctx, "9.9.9");
    const list = JSON.parse((await handle(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" })))!);
    const doctor = list.result.tools.find((t: { name: string }) => t.name === "cloudpin_doctor");
    expect(doctor).toBeDefined();
    expect(doctor.annotations).toEqual({ readOnlyHint: true });
    expect(doctor.inputSchema).toMatchObject({ type: "object", properties: { cwd: { type: "string" } } });
    expect(doctor.inputSchema.required).toBeUndefined();
    expect(doctor.description).toMatch(/hook/i);
  });

  it("returns what `cloudpin doctor --json` returns, the cache check aside", async () => {
    const { tool, cliDeps } = setup();
    const d = cliDeps(() => true);
    const expected = doctorJson(await runDoctor(d), d);
    const got = (await tool!.call({})) as Result;
    const notCache = (r: Result) => ({ ...r, checks: r.checks.filter((c) => c.id !== "cache") });
    expect(notCache(got)).toEqual(notCache(expected as Result));
    expect(got.checks.map((c) => c.id)).toEqual(expect.arrayContaining(["cloudpin", "path", "shell", "hooks", "pins", "cli:vercel", "cache"]));
  });

  it("keeps the cache check as is when the cache is off, since it then needs no write", async () => {
    const { tool, env } = setup();
    env.CLOUDPIN_NO_CACHE = "1";
    const got = (await tool!.call({})) as Result;
    expect(got.checks.find((c) => c.id === "cache")?.title).toMatch(/off \(CLOUDPIN_NO_CACHE=1\)/);
  });

  it("answers over tools/call with the JSON as text and as structured content", async () => {
    const { guard, ctx } = setup();
    const handle = cloudpinHandler(guard, ctx, "9.9.9");
    const call = { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "cloudpin_doctor", arguments: {} } };
    const res = JSON.parse((await handle(JSON.stringify(call)))!).result;
    expect(res.isError).toBeUndefined();
    expect(JSON.parse(res.content[0].text)).toEqual(res.structuredContent);
    expect(res.structuredContent.cloudpin).toBe("9.9.9");
  });

  it("shortens account IDs, as --json does", async () => {
    const { tool } = setup();
    const text = JSON.stringify(await tool!.call({}));
    expect(text).not.toContain(TEAM);
    expect(text).toContain("…cdef");
  });

  it("says when no agent hook guards the project", async () => {
    const { tool } = setup();
    const hooks = ((await tool!.call({})) as Result).checks.find((c) => c.id === "hooks");
    expect(hooks).toMatchObject({ level: "info", title: expect.stringMatching(/agent hooks: none installed/) });
  });

  it("says when a hook is out of date", async () => {
    const { tool, project, env } = setup();
    // A Cursor hook from before the matcher grew (as in test/doctor.test.ts).
    const file = hookFile("cursor", "project", project, env);
    const old = { version: 1, hooks: { beforeShellExecution: [{ command: "cloudpin hook cursor", matcher: "\\b(gh)\\b", timeout: 60 }] } };
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(old));
    const hook = ((await tool!.call({})) as Result).checks.find((c) => c.id === "hook");
    expect(hook).toMatchObject({ level: "warn", title: expect.stringMatching(/out of date/) });
  });

  it("refuses a folder that doesn't exist, and a cwd that isn't a string", async () => {
    const { tool, guard, ctx, project } = setup();
    await expect(tool!.call({ cwd: join(project, "nope") })).rejects.toThrow(/folder not found/);
    await expect(tool!.call({ cwd: 7 })).rejects.toThrow(/cwd must be a string/);
    const handle = cloudpinHandler(guard, ctx, "9.9.9");
    const call = { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "cloudpin_doctor", arguments: { cwd: "nope" } } };
    const res = JSON.parse((await handle(JSON.stringify(call)))!).result;
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/folder not found/);
  });
});

describe("cloudpin_doctor never writes (#15: no MCP tool changes anything)", () => {
  // Control: the terminal doctor's cache probe does write here, so the listing below can see a write.
  it("control: `cloudpin doctor`'s cache probe creates the cache folder in this setup", async () => {
    const { project, cliDeps } = setup();
    const before = listing(project);
    await runDoctor(cliDeps(probeWritable));
    expect(listing(project)).not.toEqual(before);
  });

  it("leaves the folder exactly as it was, and says the cache check was skipped", async () => {
    const { project, tool } = setup();
    const before = listing(project);
    const got = (await tool!.call({})) as Result;
    expect(listing(project)).toEqual(before);
    expect(got.checks.find((c) => c.id === "cache")).toMatchObject({ level: "info", title: expect.stringMatching(/not checked/) });
  });
});
