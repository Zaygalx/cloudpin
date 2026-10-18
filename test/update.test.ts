import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { checksForUpdates, fetchLatest, isNewer, refreshIfStale, savedNotice, updateCheckAllowed } from "../src/update.js";
import { tempDir } from "./tmp.js";

const DAY = 24 * 60 * 60 * 1000;
const stateFile = () => join(tempDir("cloudpin-update-"), "update-check.json");

describe("updateCheckAllowed", () => {
  it("is on in a terminal, and off in CI, without a terminal, or when turned off", () => {
    expect(updateCheckAllowed({}, true)).toBe(true);
    expect(updateCheckAllowed({}, false)).toBe(false);
    expect(updateCheckAllowed({ CI: "true" }, true)).toBe(false);
    expect(updateCheckAllowed({ NO_UPDATE_NOTIFIER: "1" }, true)).toBe(false);
    expect(updateCheckAllowed({ CLOUDPIN_NO_UPDATE_CHECK: "1" }, true)).toBe(false);
  });
});

describe("checksForUpdates", () => {
  it("runs for cloudpin's own commands, never on the guarded path or in shell start-up", () => {
    for (const cmd of ["init", "check", "status", "use", "doctor", "explain", "install-hook", "uninstall-hook", "version", "--version", "-v", "help", undefined]) {
      expect(checksForUpdates(cmd), String(cmd)).toBe(true);
    }
    for (const cmd of ["exec", "hook", "shell-init", "nonsense"]) expect(checksForUpdates(cmd), cmd).toBe(false);
  });
});

describe("isNewer", () => {
  it.each([
    ["0.3.1", "0.3.0", true],
    ["0.10.0", "0.9.9", true],
    ["1.0.0", "0.99.0", true],
    ["0.3.0", "0.3.0", false],
    ["0.2.9", "0.3.0", false],
    ["1.0.0-beta.1", "0.3.0", false],
    ["not a version", "0.3.0", false],
  ])("%s newer than %s: %s", (latest, current, expected) => {
    expect(isNewer(latest, current)).toBe(expected);
  });
});

describe("savedNotice", () => {
  it("is one line when the saved latest version is newer, and nothing otherwise", () => {
    const file = stateFile();
    expect(savedNotice("0.3.0", file, "npm")).toBeNull();
    writeFileSync(file, JSON.stringify({ checkedAt: 1, latest: "0.3.1" }));
    expect(savedNotice("0.3.0", file, "npm")).toBe("cloudpin 0.3.1 is available (you have 0.3.0): npm install --global cloudpin");
    expect(savedNotice("0.3.1", file, "npm")).toBeNull();
    writeFileSync(file, "{ broken");
    expect(savedNotice("0.3.0", file, "npm")).toBeNull();
  });

  it.each([
    ["brew", "brew upgrade cloudpin"],
    ["scoop", "scoop update cloudpin"],
    ["pnpm", "pnpm add --global cloudpin"],
    ["volta", "volta install cloudpin"],
    ["yarn", "yarn global add cloudpin"],
    ["bun", "bun add --global cloudpin@latest"],
  ] as const)("names the upgrade command for a %s install", (method, command) => {
    const file = stateFile();
    writeFileSync(file, JSON.stringify({ checkedAt: 1, latest: "0.3.1" }));
    expect(savedNotice("0.3.0", file, method)).toBe(`cloudpin 0.3.1 is available (you have 0.3.0): ${command}`);
  });
});

describe("refreshIfStale", () => {
  it("asks npm at most once a day and keeps the last answer when a check fails", async () => {
    const file = stateFile();
    let calls = 0;
    let answer: string | null = "0.3.1";
    const deps = (now: number) => ({ now: () => now, stateFile: file, fetchLatest: async () => (calls++, answer) });
    await refreshIfStale(deps(1000));
    expect(calls).toBe(1);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ checkedAt: 1000, latest: "0.3.1" });
    await refreshIfStale(deps(1000 + DAY - 1));
    expect(calls).toBe(1);
    answer = null;
    await refreshIfStale(deps(1000 + DAY));
    expect(calls).toBe(2);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ checkedAt: 1000 + DAY, latest: "0.3.1" });
  });

  it("never throws, even when the state folder can't be written", async () => {
    await expect(
      refreshIfStale({ now: () => 1, stateFile: join(stateFile(), "not-a-dir", "x.json"), fetchLatest: async () => "0.3.1" }),
    ).resolves.toBeUndefined();
  });
});

describe("fetchLatest", () => {
  it("asks the registry for cloudpin's latest version, with a timeout, and gives null on any failure", async () => {
    const seen: { url: string; signal: unknown }[] = [];
    const ok = (async (url: string, init?: { signal?: unknown }) => {
      seen.push({ url, signal: init?.signal });
      return { ok: true, json: async () => ({ name: "cloudpin", version: "0.3.1" }) };
    }) as unknown as typeof fetch;
    expect(await fetchLatest(ok)).toBe("0.3.1");
    expect(seen[0]!.url).toBe("https://registry.npmjs.org/cloudpin/latest");
    expect(seen[0]!.signal).toBeDefined();
    const notOk = (async () => ({ ok: false, json: async () => ({}) })) as unknown as typeof fetch;
    expect(await fetchLatest(notOk)).toBeNull();
    const throws = (async () => {
      throw new Error("offline");
    }) as unknown as typeof fetch;
    expect(await fetchLatest(throws)).toBeNull();
    const noVersion = (async () => ({ ok: true, json: async () => ({}) })) as unknown as typeof fetch;
    expect(await fetchLatest(noVersion)).toBeNull();
  });
});
