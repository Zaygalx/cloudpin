import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  createDemoFolder,
  cursorMcp,
  FAKE_USER,
  parseArgs,
  pathWarnings,
  pinFile,
  readme,
} from "../scripts/demo-folder.mjs";
import { parseConfig, findConfig } from "../src/config.js";
import type { GuardDeps } from "../src/guard.js";
import { AGENTS, runHook } from "../src/hooks/agents.js";
import { hookFile, planInstall, windowsRoot } from "../src/install.js";
import { cloudpinTools } from "../src/mcp-tools.js";
import { providers } from "../src/providers/index.js";
import type { Exec } from "../src/types.js";
import { useCommand } from "../src/use.js";
import { tempDir } from "./tmp.js";

const DEV = "demo-dev";

/** Stands in for git (writes what `git init --initial-branch=main` leaves for cloudpin to read) and gh. */
function fakeExec(login = DEV) {
  const calls: { bin: string; args: string[] }[] = [];
  const exec: Exec = async (bin, args) => {
    calls.push({ bin, args });
    if (bin === "git") {
      const dir = args[args.indexOf("-C") + 1]!;
      mkdirSync(join(dir, ".git"), { recursive: true });
      writeFileSync(join(dir, ".git", "HEAD"), "ref: refs/heads/main\n");
      return { code: 0, stdout: "", stderr: "" };
    }
    if (bin === "gh") return { code: 0, stdout: `${login}\n`, stderr: "" };
    return { code: 127, stdout: "", stderr: `${bin}: not found`, notFound: true };
  };
  return { exec, calls };
}

/** A home folder of its own, so a write to ~/.cursor would show up. */
function sandbox() {
  const home = tempDir("cloudpin-demo-home-");
  const env = { HOME: home, USERPROFILE: home };
  return { home, env };
}

async function makeFolder(devUser = DEV) {
  const { home, env } = sandbox();
  const dir = join(tempDir("cloudpin-demo-"), "acme-api");
  const fake = fakeExec(devUser);
  const files = await createDemoFolder(
    { dir, devUser, env, platform: "linux" },
    { hookFile, planInstall, windowsRoot, exec: fake.exec },
  );
  return { dir, home, env, files, ...fake };
}

describe("parseArgs", () => {
  it("takes --dir and --dev-user", () => {
    expect(parseArgs([])).toEqual({});
    expect(parseArgs(["--dir", "/x/acme-api", "--dev-user", "me-1"])).toEqual({ dir: "/x/acme-api", devUser: "me-1" });
  });

  it.each([[["--dir"]], [["--dir", "--dev-user", "x"]], [["--force"]], [["extra"]], [["--dev-user", "a b"]]])(
    "refuses %j",
    (argv) => {
      expect(() => parseArgs(argv)).toThrow();
    },
  );

  it("refuses the made-up login as the dev account, in any case", () => {
    expect(() => parseArgs(["--dev-user", FAKE_USER.toUpperCase()])).toThrow(/made-up/);
  });
});

describe("pinFile", () => {
  it("pins production (protected, on main) to the made-up login and dev to the given one", () => {
    const project = parseConfig(pinFile(DEV));
    expect(project.environments).toEqual([
      { name: "production", protected: true, pins: { github: { user: FAKE_USER } } },
      { name: "dev", protected: false, pins: { github: { user: DEV } } },
    ]);
    expect(project.branches).toEqual([{ pattern: "main", environment: "production" }]);
  });

  it("names the host only when it isn't github.com", () => {
    expect(pinFile(DEV)).not.toContain("host:");
    const project = parseConfig(pinFile(DEV, "ghe.example.com"));
    expect(project.environments?.map((e) => e.pins.github)).toEqual([
      { user: FAKE_USER, host: "ghe.example.com" },
      { user: DEV, host: "ghe.example.com" },
    ]);
  });

  it.each(["", "a b", "x: y", "-lead", FAKE_USER])("refuses the dev login %j", (login) => {
    expect(() => pinFile(login)).toThrow();
  });
});

describe("createDemoFolder", () => {
  it("writes the pin file, the MCP entry, the project hook, git and the README, and nothing in the home folder", async () => {
    const { dir, home, files, calls } = await makeFolder();
    expect(files.sort()).toEqual([".cloudpin.yml", ".cursor/hooks.json", ".cursor/mcp.json", ".cursorignore", "README.md"]);
    expect(calls).toEqual([{ bin: "git", args: ["-C", dir, "init", "--quiet", "--initial-branch=main"] }]);
    expect(statSync(join(dir, ".git")).isDirectory()).toBe(true);
    expect(readFileSync(join(dir, ".cloudpin.yml"), "utf8")).toBe(pinFile(DEV));
    expect(readdirSync(home)).toEqual([]);
  });

  it("installs the hook exactly as `cloudpin install-hook cursor` does at project scope", async () => {
    const { dir, env } = await makeFolder();
    const path = hookFile("cursor", "project", dir, env);
    expect(path).toBe(join(dir, ".cursor", "hooks.json"));
    expect(readFileSync(path, "utf8")).toBe(planInstall("cursor", null, null).content);
    expect(planInstall("cursor", readFileSync(path, "utf8"), null).alreadyInstalled).toBe(true);
  });

  it("gives Cursor the MCP entry docs/mcp.md shows", async () => {
    const { dir } = await makeFolder();
    const doc = readFileSync(join(import.meta.dirname, "..", "docs", "mcp.md"), "utf8");
    const line = doc.split("\n").find((l) => l.startsWith('{"mcpServers"') && l.includes('"type": "stdio"'));
    expect(line).toBeDefined();
    expect(JSON.parse(readFileSync(join(dir, ".cursor", "mcp.json"), "utf8"))).toEqual(JSON.parse(line!));
    expect(cursorMcp()).toBe(readFileSync(join(dir, ".cursor", "mcp.json"), "utf8"));
  });

  it("refuses a folder that isn't empty, and writes nothing to it", async () => {
    const dir = tempDir("cloudpin-demo-");
    writeFileSync(join(dir, "keep.txt"), "x");
    const { exec, calls } = fakeExec();
    await expect(
      createDemoFolder({ dir, devUser: DEV, env: sandbox().env }, { hookFile, planInstall, windowsRoot, exec }),
    ).rejects.toThrow(/not empty/);
    expect(calls).toEqual([]);
    expect(readdirSync(dir)).toEqual(["keep.txt"]);
  });

  it("accepts an empty folder that already exists", async () => {
    const dir = tempDir("cloudpin-demo-");
    const { exec } = fakeExec();
    await createDemoFolder({ dir, devUser: DEV, env: sandbox().env }, { hookFile, planInstall, windowsRoot, exec });
    expect(existsSync(join(dir, ".cloudpin.yml"))).toBe(true);
  });

  it("stops when git init fails, before writing any file", async () => {
    const dir = join(tempDir("cloudpin-demo-"), "acme-api");
    const exec: Exec = async () => ({ code: 128, stdout: "", stderr: "fatal: something\n" });
    await expect(
      createDemoFolder({ dir, devUser: DEV, env: sandbox().env }, { hookFile, planInstall, windowsRoot, exec }),
    ).rejects.toThrow(/git init failed \(exit 128\): fatal: something/);
    expect(readdirSync(dir)).toEqual([]);
  });
});

describe("the demo, run against the folder (gh faked)", () => {
  const deps = (exec: Exec): GuardDeps => ({ providers, exec, findConfig });
  const cursorInput = (dir: string) => JSON.stringify({ command: "gh repo list --visibility public --limit 5", cwd: dir });

  it("shot 3: cloudpin_check blocks on production, naming both logins and the fix", async () => {
    const { dir, env, exec } = await makeFolder();
    const [, check] = cloudpinTools(deps(exec), { cwd: dir, env, read: () => null, isDir: () => true });
    const res = (await check!.call({ command: "gh repo list --visibility public --limit 5" })) as {
      calls: { verdict: string; reason?: string }[];
    };
    expect(res.calls).toHaveLength(1);
    expect(res.calls[0]!.verdict).toBe("block");
    expect(JSON.stringify(res)).toContain(`user: expected \\"${FAKE_USER}\\", active is \\"${DEV}\\"`);
    expect(JSON.stringify(res)).toContain(`gh auth switch --user ${FAKE_USER}`);
  });

  it("shot 4: Cursor's hook denies the command with the same reason", async () => {
    const { dir, env, exec } = await makeFolder();
    const out = JSON.parse(await runHook(AGENTS.cursor, cursorInput(dir), deps(exec), env));
    expect(out.permission).toBe("deny");
    expect(out.agent_message).toContain(`user: expected "${FAKE_USER}", active is "${DEV}"`);
    expect(out.agent_message).toContain('environment: production (protected), chosen by branch "main"');
    expect(out.user_message).toBe(out.agent_message);
  });

  it("shot 5: after `cloudpin use dev` the same command is allowed, and --clear brings the block back", async () => {
    const { dir, env, exec } = await makeFolder();
    expect(useCommand(["dev"], dir, env)).toMatchObject({ code: 0, lines: ["cloudpin: using dev here (remembered for this clone, not committed)"] });
    expect(JSON.parse(await runHook(AGENTS.cursor, cursorInput(dir), deps(exec), env))).toEqual({ permission: "allow" });

    expect(useCommand(["--clear"], dir, env).code).toBe(0);
    expect(JSON.parse(await runHook(AGENTS.cursor, cursorInput(dir), deps(exec), env)).permission).toBe("deny");
  });

  it("control: logged in as the made-up account, production would allow (so the block comes from the pin)", async () => {
    const { dir, env } = await makeFolder();
    const { exec } = fakeExec(FAKE_USER);
    expect(JSON.parse(await runHook(AGENTS.cursor, cursorInput(dir), deps(exec), env))).toEqual({ permission: "allow" });
  });

  it("the agent switching environment itself needs the user's OK", async () => {
    const { dir, env, exec } = await makeFolder();
    const out = JSON.parse(await runHook(AGENTS.cursor, JSON.stringify({ command: "cloudpin use dev", cwd: dir }), deps(exec), env));
    expect(out.permission).toBe("ask");
  });
});

describe("pathWarnings", () => {
  const who = { username: "jdoe", home: "/home/jdoe" };

  it("warns about a path holding the username or inside the home folder", () => {
    expect(pathWarnings("/home/jdoe/x/acme-api", who)[0]).toMatch(/inside your home folder and the folder path contains your username/);
    expect(pathWarnings("C:\\Users\\JDoe\\AppData\\Local\\Temp\\cloudpin-demo-1\\acme-api", { username: "jdoe", home: "C:\\Users\\jdoe" })).toHaveLength(2);
    expect(pathWarnings("/srv/jdoe-demo/acme-api", who)[0]).toMatch(/contains your username/);
  });

  it("is silent for a neutral folder", () => {
    expect(pathWarnings("/tmp/demo/acme-api", who)).toEqual([]);
    expect(pathWarnings("C:\\demo\\acme-api", { username: "", home: "" })).toEqual([]);
  });
});

describe("readme", () => {
  const text = readme();

  it("has the three prompts, the timings and a numbered setup list", () => {
    expect(text).toContain("Run gh repo list --visibility public --limit 5 and tell me what's there.");
    expect(text).toContain("Run it anyway.");
    expect(text).toContain("I've switched this project to dev. Try again.");
    expect(text).toMatch(/0:00-0:08[\s\S]*1:15-1:30/);
    for (let n = 1; n <= 10; n++) expect(text).toMatch(new RegExp(`^ ?${n}\\. `, "m"));
  });

  it("names no path, login or account of the person making it", () => {
    expect(text).not.toMatch(/[A-Za-z]:\\|\/Users\/|\/home\//);
    expect(text).not.toContain(DEV);
  });
});
