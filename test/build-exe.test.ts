import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { inflateRawSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import {
  bundle,
  checkBundle,
  exeZipName,
  fetchVerified,
  newerSecurityRelease,
  nodeAsset,
  parseShasums,
  readExeNodeVersion,
  seaConfig,
  writeExeZip,
} from "../scripts/build-exe.mjs";
import { tempDir } from "./tmp.js";

const sha = (data: Uint8Array | string) => createHash("sha256").update(data).digest("hex");

describe("the pinned Node version", () => {
  it("is one exact 26.x version, in scripts/exe-node-version.txt", () => {
    const text = readFileSync(new URL("../scripts/exe-node-version.txt", import.meta.url), "utf8");
    expect(readExeNodeVersion(text)).toMatch(/^26\.\d+\.\d+$/);
  });

  it("refuses a range, a v prefix, extra lines or a Node without --build-sea and an ESM main (25.7)", () => {
    for (const bad of ["26", "^26.12.0", "v26.12.0", "26.12.0\n26.11.0\n", "", "24.21.0", "25.6.9"]) {
      expect(() => readExeNodeVersion(bad), JSON.stringify(bad)).toThrow();
    }
    expect(readExeNodeVersion("25.7.0\r\n")).toBe("25.7.0");
  });
});

describe("exeZipName", () => {
  it("is cloudpin-X.Y.Z-win-x64.zip", () => {
    expect(exeZipName("1.3.0")).toBe("cloudpin-1.3.0-win-x64.zip");
  });
});

describe("nodeAsset", () => {
  it("names the official files under nodejs.org/dist/vX.Y.Z/", () => {
    expect(nodeAsset("win32", "x64", "26.12.0")).toEqual({ file: "win-x64/node.exe" });
    expect(nodeAsset("linux", "x64", "26.12.0")).toEqual({
      file: "node-v26.12.0-linux-x64.tar.gz",
      member: "node-v26.12.0-linux-x64/bin/node",
    });
    expect(nodeAsset("darwin", "arm64", "26.12.0")).toEqual({
      file: "node-v26.12.0-darwin-arm64.tar.gz",
      member: "node-v26.12.0-darwin-arm64/bin/node",
    });
    expect(() => nodeAsset("aix", "ppc64", "26.12.0")).toThrow(/aix-ppc64/);
  });
});

describe("parseShasums", () => {
  it("reads <sha256>  <file> lines", () => {
    const a = "a".repeat(64);
    const b = "B".repeat(64);
    const sums = parseShasums(`${a}  node-v26.12.0-linux-x64.tar.gz\n${b}  win-x64/node.exe\r\n\n`);
    expect(sums.get("win-x64/node.exe")).toBe("b".repeat(64));
    expect(sums.get("node-v26.12.0-linux-x64.tar.gz")).toBe(a);
    expect(() => parseShasums("not a sum line\n")).toThrow();
  });
});

describe("fetchVerified", () => {
  const files: Record<string, Uint8Array> = { "win-x64/node.exe": new TextEncoder().encode("MZ fake node") };
  const sums = `${sha(files["win-x64/node.exe"]!)}  win-x64/node.exe\n${"0".repeat(64)}  win-x64/node.lib\n`;
  const fakeFetch = (served: Record<string, Uint8Array | string>, seen: string[] = []) =>
    (async (url: string) => {
      seen.push(url);
      const body = served[url];
      if (body === undefined) return new Response("missing", { status: 404 });
      return new Response(typeof body === "string" ? body : Buffer.from(body));
    }) as unknown as typeof fetch;
  const BASE = "https://nodejs.org/dist/v26.12.0";

  it("downloads from nodejs.org/dist only and keeps a file whose sha256 matches SHASUMS256.txt", async () => {
    const dir = tempDir("cloudpin-fetch-");
    const seen: string[] = [];
    const path = await fetchVerified("26.12.0", "win-x64/node.exe", dir, fakeFetch({ [`${BASE}/SHASUMS256.txt`]: sums, [`${BASE}/win-x64/node.exe`]: files["win-x64/node.exe"]! }, seen));
    expect(readFileSync(path, "utf8")).toBe("MZ fake node");
    expect(seen.every((u) => u.startsWith(`${BASE}/`))).toBe(true);
  });

  it("reuses a cached file only after checking it again, and replaces a bad one", async () => {
    const dir = tempDir("cloudpin-fetch-");
    const served = { [`${BASE}/SHASUMS256.txt`]: sums, [`${BASE}/win-x64/node.exe`]: files["win-x64/node.exe"]! };
    const first = await fetchVerified("26.12.0", "win-x64/node.exe", dir, fakeFetch(served));
    const seen: string[] = [];
    await fetchVerified("26.12.0", "win-x64/node.exe", dir, fakeFetch(served, seen));
    expect(seen).toEqual([`${BASE}/SHASUMS256.txt`]);
    writeFileSync(first, "tampered");
    const again: string[] = [];
    await fetchVerified("26.12.0", "win-x64/node.exe", dir, fakeFetch(served, again));
    expect(again).toContain(`${BASE}/win-x64/node.exe`);
    expect(readFileSync(first, "utf8")).toBe("MZ fake node");
  });

  it("refuses a download whose sha256 differs (the control), a file SHASUMS256.txt doesn't list, and an HTTP error", async () => {
    const dir = tempDir("cloudpin-fetch-");
    const evil = fakeFetch({ [`${BASE}/SHASUMS256.txt`]: sums, [`${BASE}/win-x64/node.exe`]: "MZ evil node" });
    await expect(fetchVerified("26.12.0", "win-x64/node.exe", dir, evil)).rejects.toThrow(/sha256/);
    await expect(fetchVerified("26.12.0", "win-x64/other.exe", dir, evil)).rejects.toThrow(/not in SHASUMS256/);
    await expect(fetchVerified("26.12.0", "win-x64/node.exe", dir, fakeFetch({}))).rejects.toThrow(/404/);
  });
});

describe("seaConfig", () => {
  it("builds an ESM main into the given node.exe, with code cache and snapshot off and no warning", () => {
    expect(seaConfig({ main: "/w/cloudpin.mjs", executable: "/w/node.exe", output: "/w/cloudpin.exe" })).toEqual({
      main: "/w/cloudpin.mjs",
      mainFormat: "module",
      executable: "/w/node.exe",
      output: "/w/cloudpin.exe",
      disableExperimentalSEAWarning: true,
      useSnapshot: false,
      useCodeCache: false,
    });
  });
});

describe("bundle and checkBundle", () => {
  function project(main: string): string {
    const dir = tempDir("cloudpin-bundle-");
    writeFileSync(join(dir, "dep.js"), "export const dep = (s) => s.toUpperCase();\n");
    writeFileSync(join(dir, "main.js"), main);
    return join(dir, "main.js");
  }

  it("inlines the version, keeps top-level await and leaves only built-in imports", async () => {
    const entry = project(
      [
        'import { createRequire } from "node:module";',
        'import { dep } from "./dep.js";',
        "const v = typeof CLOUDPIN_BUNDLED_VERSION === \"string\" ? CLOUDPIN_BUNDLED_VERSION : createRequire(import.meta.url)(\"../package.json\").version;",
        "await Promise.resolve();",
        "console.log(dep(v));",
        "",
      ].join("\n"),
    );
    const code = await bundle(entry, "1.3.0");
    expect(code).toContain('"1.3.0"');
    expect(code).not.toContain("CLOUDPIN_BUNDLED_VERSION");
    expect(code).toMatch(/\bawait\b/);
    expect(() => checkBundle(code, "1.3.0")).not.toThrow();
  });

  it("refuses a bundle that still reads package.json, lacks the version, or imports a package", () => {
    const good = 'import { a } from "node:fs";\nimport b from "path";\nconsole.log("1.3.0");\n';
    expect(() => checkBundle(good, "1.3.0")).not.toThrow();
    expect(() => checkBundle(`${good}require("../package.json")`, "1.3.0")).toThrow(/package\.json/);
    expect(() => checkBundle(good, "1.4.0")).toThrow(/1\.4\.0/);
    expect(() => checkBundle(`${good}import y from "yaml";`, "1.3.0")).toThrow(/yaml/);
    expect(() => checkBundle(`${good}export { y } from "yaml";`, "1.3.0")).toThrow(/yaml/);
    expect(() => checkBundle(`${good}import "yaml";`, "1.3.0")).toThrow(/yaml/);
    // An example in a doc comment, as yaml's own has, is not an import.
    expect(() => checkBundle(`${good}/**\n * import { Parser } from 'yaml'\n */\n`, "1.3.0")).not.toThrow();
    expect(() => checkBundle(`${good}const s = await import("cross-spawn");`, "1.3.0")).toThrow(/cross-spawn/);
    expect(() => checkBundle(`${good}const s = __require("which");`, "1.3.0")).toThrow(/which/);
    expect(() => checkBundle(`${good}const s = __require("child_process");`, "1.3.0")).not.toThrow();
  });
});

describe("writeExeZip", () => {
  it("writes cloudpin-X.Y.Z-win-x64.zip with cloudpin.exe and LICENSE at its root", async () => {
    const dir = tempDir("cloudpin-exezip-");
    writeFileSync(join(dir, "cloudpin.exe"), "MZ exe");
    writeFileSync(join(dir, "LICENSE"), "MIT");
    const zipPath = await writeExeZip({ exe: join(dir, "cloudpin.exe"), license: join(dir, "LICENSE"), version: "1.3.0", outDir: join(dir, "out") });
    expect(zipPath).toBe(join(dir, "out", "cloudpin-1.3.0-win-x64.zip"));
    const zip = readFileSync(zipPath);
    // Walk the local file headers (APPNOTE 4.3.7).
    const names: Record<string, string> = {};
    for (let off = 0; zip.readUInt32LE(off) === 0x04034b50; ) {
      const size = zip.readUInt32LE(off + 18);
      const nameLen = zip.readUInt16LE(off + 26);
      const name = zip.subarray(off + 30, off + 30 + nameLen).toString();
      names[name] = inflateRawSync(zip.subarray(off + 30 + nameLen, off + 30 + nameLen + size)).toString();
      off += 30 + nameLen + size;
    }
    expect(names).toEqual({ LICENSE: "MIT", "cloudpin.exe": "MZ exe" });
  });
});

describe("newerSecurityRelease", () => {
  const index = [
    { version: "v27.0.0", security: true },
    { version: "v26.13.1", security: false },
    { version: "v26.13.0", security: true },
    { version: "v26.12.1", security: true },
    { version: "v26.12.0", security: false },
    { version: "v26.11.0", security: true },
    { version: "v24.30.0", security: true },
  ];

  it("is the newest security release of the pinned major line newer than the pin", () => {
    expect(newerSecurityRelease(index, "26.12.0")).toBe("26.13.0");
    expect(newerSecurityRelease(index, "26.12.1")).toBe("26.13.0");
  });

  it("is null when every newer 26 release is a plain one, or only another major has a fix (the control)", () => {
    expect(newerSecurityRelease(index, "26.13.0")).toBeNull();
    expect(newerSecurityRelease([{ version: "v26.12.0", security: true }, { version: "v27.1.0", security: true }], "26.12.0")).toBeNull();
    // 26.9.0 is older than 26.12.0 even though "9" > "1" as text.
    expect(newerSecurityRelease([{ version: "v26.9.0", security: true }], "26.12.0")).toBeNull();
  });
});
