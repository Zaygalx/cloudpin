import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { tempDir } from "./tmp.js";
import { ConfigError, findConfig, parseConfig } from "../src/config.js";
import type { InstallMethod } from "../src/install-method.js";

// How the running cloudpin was installed, as config.ts sees it; npm unless a test says otherwise.
const running = vi.hoisted(() => ({ method: "npm" as InstallMethod }));
vi.mock("../src/install-method.js", async (original) => ({
  ...(await original<typeof import("../src/install-method.js")>()),
  runningInstallMethod: () => running.method,
}));
afterEach(() => {
  running.method = "npm";
});

describe("parseConfig", () => {
  it("parses every provider section", () => {
    const pins = parseConfig(`
azure:
  subscription: 3f2a0000-0000-0000-0000-000000000c91 # "Prod"
  tenant: 8b1d0000-0000-0000-0000-00000000044e
aws:
  account: "123456789012"
gcloud:
  account: me@example.com
  project: my-project
vercel:
  team: team_x9K
github:
  user: paureis
`).pins;
    expect(pins).toEqual({
      azure: {
        subscription: "3f2a0000-0000-0000-0000-000000000c91",
        tenant: "8b1d0000-0000-0000-0000-00000000044e",
      },
      aws: { account: "123456789012" },
      gcloud: { account: "me@example.com", project: "my-project" },
      vercel: { team: "team_x9K" },
      github: { user: "paureis" },
    });
  });

  it("keeps an unquoted numeric AWS account ID intact as a string", () => {
    expect(parseConfig("aws:\n  account: 012345678901\n").pins).toEqual({
      aws: { account: "012345678901" },
    });
  });

  it("returns an empty pin set for an empty file", () => {
    expect(parseConfig("")).toEqual({ environments: null, pins: {}, branches: [], readOnly: {} });
  });

  it("rejects an unknown provider, naming it", () => {
    expect(() => parseConfig("azur:\n  subscription: x\n")).toThrow(
      /unknown section "azur"/,
    );
  });

  it("rejects an unknown key inside a provider", () => {
    expect(() => parseConfig("vercel:\n  teem: x\n")).toThrow(
      /vercel: unknown key "teem"/,
    );
  });

  describe("a name this version doesn't know (#67)", () => {
    const version = (JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string }).version;
    const message = (text: string) => {
      try {
        parseConfig(text);
      } catch (err) {
        return (err as Error).message;
      }
      throw new Error("expected a ConfigError");
    };

    it.each([
      ["a top-level section", "terraform:\n  workspace: prod\n"],
      ["a key inside a provider", "azure:\n  subscription: x\n  management_group: y\n"],
      ["a section inside an environment", "environments:\n  prod:\n    terraform: {}\n"],
      ["a read_only provider", "read_only:\n  terraform: [plan]\n"],
    ])("says %s may need a newer cloudpin, with this version and the update command", (_, text) => {
      const got = message(text);
      expect(got).toContain(`written for a newer cloudpin than this one (${version})`);
      expect(got).toContain("npm install --global cloudpin@latest");
    });

    it.each<[InstallMethod, string]>([
      ["npm", "update it: npm install --global cloudpin@latest"],
      ["brew", "update it: brew upgrade cloudpin"],
      ["scoop", "update it: scoop update cloudpin"],
      ["pnpm", "update it: pnpm add --global cloudpin"],
      ["volta", "update it: volta install cloudpin"],
      ["yarn", "update it: yarn global add cloudpin"],
      ["bun", "update it: bun add --global cloudpin@latest"],
      ["winget", "update it: winget upgrade paureis.cloudpin"],
      ["exe", "update it: download the latest cloudpin-X.Y.Z-win-x64.zip from https://github.com/paureis/cloudpin/releases"],
    ])("names the update command for a %s install", (method, command) => {
      running.method = method;
      const got = message("terraform:\n  workspace: prod\n");
      expect(got).toContain('unknown section "terraform"');
      expect(got).toContain(`written for a newer cloudpin than this one (${version}), ${command}`);
      expect(got.endsWith(command)).toBe(true);
      if (method !== "npm") expect(got).not.toMatch(/\bnpm\b/);
    });

    it("doesn't say so for a mistake no version would accept", () => {
      expect(message("azure:\n  tenant: x\n")).not.toContain("newer cloudpin");
      expect(message("environments:\n  a: {}\nbranches:\n  main: b\n")).not.toContain("newer cloudpin");
    });
  });

  it("rejects a provider section missing its required key", () => {
    expect(() => parseConfig("azure:\n  tenant: x\n")).toThrow(
      /azure: "subscription" is required/,
    );
  });

  it("requires at least one of account or project for gcloud", () => {
    expect(() => parseConfig("gcloud: {}\n")).toThrow(
      /gcloud: set "account", "project" or both/,
    );
  });

  it("rejects malformed YAML with a ConfigError", () => {
    expect(() => parseConfig("azure: [unclosed\n")).toThrow(ConfigError);
  });
});

describe("findConfig", () => {
  function tree() {
    const root = tempDir("cloudpin-");
    const nested = join(root, "apps", "web");
    mkdirSync(nested, { recursive: true });
    return { root, nested };
  }

  it("finds the nearest .cloudpin.yml walking upward", () => {
    const { root, nested } = tree();
    writeFileSync(join(root, ".cloudpin.yml"), "github:\n  user: outer\n");
    writeFileSync(join(root, "apps", ".cloudpin.yml"), "github:\n  user: inner\n");
    const found = findConfig(nested);
    expect(found?.path).toBe(join(root, "apps", ".cloudpin.yml"));
    expect(found?.pins).toEqual({ github: { user: "inner" } });
  });

  it("returns null when no file exists up to the filesystem root", () => {
    const { nested } = tree();
    expect(findConfig(nested)).toBeNull();
  });

  it("reports the file path when the file is invalid", () => {
    const { root } = tree();
    writeFileSync(join(root, ".cloudpin.yml"), "nope:\n  x: 1\n");
    expect(() => findConfig(root)).toThrow(/\.cloudpin\.yml/);
  });
});
