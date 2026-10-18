import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { crc32, gzipSync, inflateRawSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { buildWindowsZip, readTarGz, writeZip, zipName } from "../scripts/windows-zip.mjs";
import { tempDir } from "./tmp.js";

const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array) => new TextDecoder().decode(b);

type TarEntry = { name: string; data?: string | Uint8Array; type?: string; prefix?: string };

/** One ustar header block for `name`, with its checksum. */
function header(name: string, size: number, type: string, prefix = ""): Buffer {
  const h = Buffer.alloc(512);
  h.write(name, 0, 100, "utf8");
  h.write("0000644\0", 100);
  h.write("0000000\0", 108);
  h.write("0000000\0", 116);
  h.write(size.toString(8).padStart(11, "0") + "\0", 124);
  h.write("00000000000\0", 136);
  h.write("        ", 148);
  h.write(type, 156);
  h.write("ustar\0", 257);
  h.write("00", 263);
  h.write(prefix, 345, 155, "utf8");
  let sum = 0;
  for (const b of h) sum += b;
  h.write(sum.toString(8).padStart(6, "0") + "\0 ", 148);
  return h;
}

/** A gzipped tarball of `entries`, as npm pack lays it out. */
function tgz(entries: TarEntry[]): Buffer {
  const blocks: Buffer[] = [];
  for (const e of entries) {
    const data = Buffer.from(typeof e.data === "string" ? enc(e.data) : (e.data ?? new Uint8Array()));
    blocks.push(header(e.name, data.length, e.type ?? "0", e.prefix));
    blocks.push(data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(blocks));
}

/** One pax record, "<len> key=value\n", where len counts the record's UTF-8 bytes. */
function paxRecord(key: string, value: string): string {
  const body = ` ${key}=${value}\n`;
  const bytes = enc(body).length;
  let len = bytes + 1;
  while (String(len).length + bytes !== len) len = String(len).length + bytes;
  return `${len}${body}`;
}

/** A pax extended header holding a `path` record, after any `before` records. */
function pax(path: string, before: [string, string][] = []): TarEntry {
  const records = [...before, ["path", path] as [string, string]].map(([k, v]) => paxRecord(k, v));
  return { name: "PaxHeader", type: "x", data: records.join("") };
}

/** The entries of a zip, read from its central directory, inflated and crc-checked. */
function readZip(zip: Buffer): { name: string; data: Buffer; flags: number; time: number; date: number }[] {
  const end = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const count = zip.readUInt16LE(end + 10);
  let p = zip.readUInt32LE(end + 16);
  const out = [];
  for (let i = 0; i < count; i++) {
    expect(zip.readUInt32LE(p)).toBe(0x02014b50);
    const flags = zip.readUInt16LE(p + 8);
    const time = zip.readUInt16LE(p + 12);
    const date = zip.readUInt16LE(p + 14);
    const crc = zip.readUInt32LE(p + 16);
    const size = zip.readUInt32LE(p + 24);
    const nameLen = zip.readUInt16LE(p + 28);
    const extra = zip.readUInt16LE(p + 30);
    const comment = zip.readUInt16LE(p + 32);
    const local = zip.readUInt32LE(p + 42);
    const name = zip.subarray(p + 46, p + 46 + nameLen).toString("utf8");
    expect(zip.readUInt32LE(local)).toBe(0x04034b50);
    const packedSize = zip.readUInt32LE(local + 18);
    const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
    const data = inflateRawSync(zip.subarray(start, start + packedSize));
    expect(data.length).toBe(size);
    expect(crc32(data)).toBe(crc);
    out.push({ name, data, flags, time, date });
    p += 46 + nameLen + extra + comment;
  }
  return out;
}

const PKG = JSON.stringify({ name: "cloudpin", version: "1.2.0", dependencies: { yaml: "2.9.1" } });

function tarballFile(entries: TarEntry[], name = "cloudpin-1.2.0.tgz"): string {
  const dir = tempDir("cloudpin-zip-in-");
  const path = join(dir, name);
  writeFileSync(path, tgz(entries));
  return path;
}

const PACKED: TarEntry[] = [
  { name: "package/LICENSE", data: "MIT" },
  { name: "package/dist/cli.js", data: "#!/usr/bin/env node\nconsole.log(1)\n" },
  { name: "package/package.json", data: PKG },
  { name: "package/README.md", data: "# cloudpin" },
];

/** A fake `npm ci`: checks what it was given and writes a small node_modules. */
function fakeInstall(seen: { pkg?: string; lock?: string }) {
  return (dir: string) => {
    seen.pkg = readFileSync(join(dir, "package.json"), "utf8");
    seen.lock = readFileSync(join(dir, "package-lock.json"), "utf8");
    mkdirSync(join(dir, "node_modules", "yaml", "dist"), { recursive: true });
    writeFileSync(join(dir, "node_modules", "yaml", "package.json"), "{}");
    writeFileSync(join(dir, "node_modules", "yaml", "dist", "index.js"), "module.exports = 1");
    writeFileSync(join(dir, "node_modules", ".package-lock.json"), "{}");
  };
}

function lockfile(): string {
  const path = join(tempDir("cloudpin-zip-lock-"), "package-lock.json");
  writeFileSync(path, '{"lockfileVersion":3}');
  return path;
}

describe("readTarGz", () => {
  it("returns regular files with their bytes, skipping folders", () => {
    const bytes = new Uint8Array([0, 1, 2, 255]);
    const files = readTarGz(tgz([{ name: "package/", type: "5" }, { name: "package/a.bin", data: bytes }, { name: "package/b.txt", data: "hi" }]));
    expect(files.map((f) => f.path)).toEqual(["package/a.bin", "package/b.txt"]);
    expect([...files[0]!.data]).toEqual([...bytes]);
    expect(dec(files[1]!.data)).toBe("hi");
  });

  it("reads long names from a pax header, a GNU long name or the ustar prefix", () => {
    const long = `package/${"d".repeat(120)}/file.js`;
    const files = readTarGz(
      tgz([
        pax(long),
        { name: "package/truncated", data: "1" },
        { name: "././@LongLink", type: "L", data: "package/gnu/long.js\0" },
        { name: "package/x", data: "2" },
        { name: "file.js", prefix: "package/deep", data: "3" },
      ]),
    );
    expect(files.map((f) => f.path)).toEqual([long, "package/gnu/long.js", "package/deep/file.js"]);
  });

  it("reads a pax path that is not ASCII, whose record length counts bytes", () => {
    const files = readTarGz(
      tgz([
        pax("package/dist/ü.js"),
        { name: "package/dist/u.js", data: "1" },
        // A non-ASCII record before the path: its byte length must not shift the next one.
        pax("package/dist/€.js", [["uname", "jürgen"]]),
        { name: "package/dist/e.js", data: "2" },
      ]),
    );
    expect(files.map((f) => f.path)).toEqual(["package/dist/ü.js", "package/dist/€.js"]);
  });

  it("refuses links and a corrupt header", () => {
    expect(() => readTarGz(tgz([{ name: "package/link", type: "2" }]))).toThrow(/not a regular file \(type 2\)/);
    // Control: the same tarball reads fine until one header byte changes.
    const raw = Buffer.concat([header("package/a", 0, "0"), Buffer.alloc(1024)]);
    expect(readTarGz(gzipSync(raw)).map((f) => f.path)).toEqual(["package/a"]);
    raw[0] = "q".charCodeAt(0);
    expect(() => readTarGz(gzipSync(raw))).toThrow(/bad header checksum/);
  });
});

describe("writeZip", () => {
  it("writes sorted, deflated entries with their exact bytes, one timestamp and the UTF-8 flag only where needed", () => {
    const big = enc("x".repeat(10000));
    const zip = writeZip([
      { name: "b/two.txt", data: enc("two") },
      { name: "a.bin", data: new Uint8Array([0, 255, 13, 10]) },
      { name: "big.txt", data: big },
      { name: "ünï.txt", data: enc("u") },
      { name: "empty", data: new Uint8Array() },
    ]);
    const entries = readZip(zip);
    expect(entries.map((e) => e.name)).toEqual(["a.bin", "b/two.txt", "big.txt", "empty", "ünï.txt"]);
    expect([...entries[0]!.data]).toEqual([0, 255, 13, 10]);
    expect(entries[2]!.data.equals(Buffer.from(big))).toBe(true);
    expect(zip.length).toBeLessThan(1000);
    expect(entries.map((e) => e.flags)).toEqual([0, 0, 0, 0, 0x0800]);
    expect(new Set(entries.map((e) => `${e.date}/${e.time}`)).size).toBe(1);
  });

  it("gives the same bytes for the same files in any order", () => {
    const a = writeZip([{ name: "x", data: enc("1") }, { name: "y", data: enc("2") }]);
    const b = writeZip([{ name: "y", data: enc("2") }, { name: "x", data: enc("1") }]);
    expect(a.equals(b)).toBe(true);
  });

  it.each(["../evil", "/abs", "a\\b", "a/../../b"])("refuses the unsafe name %s", (name) => {
    expect(() => writeZip([{ name, data: enc("") }])).toThrow(/unsafe entry name/);
  });

  it("refuses a name listed twice", () => {
    expect(() => writeZip([{ name: "a", data: enc("") }, { name: "a", data: enc("") }])).toThrow(/listed twice/);
  });
});

describe("buildWindowsZip", () => {
  it("puts the tarball's files at the zip root with the production node_modules, and no launcher", () => {
    const seen: { pkg?: string; lock?: string } = {};
    const out = join(tempDir("cloudpin-zip-out-"), "nested");
    const { zipPath, names } = buildWindowsZip({ tarball: tarballFile(PACKED), outDir: out, lockfile: lockfile(), install: fakeInstall(seen) });
    expect(zipPath).toBe(join(out, "cloudpin-1.2.0-windows.zip"));
    expect(seen).toEqual({ pkg: PKG, lock: '{"lockfileVersion":3}' });
    const expected = [
      "LICENSE",
      "README.md",
      "dist/cli.js",
      "node_modules/yaml/dist/index.js",
      "node_modules/yaml/package.json",
      "package.json",
    ];
    expect(names).toEqual(expected);
    const entries = readZip(readFileSync(zipPath));
    expect(entries.map((e) => e.name)).toEqual(expected);
    expect(names.some((n) => /\.(cmd|bat|ps1)$/i.test(n))).toBe(false);
    expect(dec(entries.find((e) => e.name === "dist/cli.js")!.data)).toBe("#!/usr/bin/env node\nconsole.log(1)\n");
  });

  it("gives the same zip twice", () => {
    const tarball = tarballFile(PACKED);
    const lock = lockfile();
    const a = buildWindowsZip({ tarball, outDir: tempDir("cloudpin-zip-a-"), lockfile: lock, install: fakeInstall({}) });
    const b = buildWindowsZip({ tarball, outDir: tempDir("cloudpin-zip-b-"), lockfile: lock, install: fakeInstall({}) });
    expect(readFileSync(a.zipPath).equals(readFileSync(b.zipPath))).toBe(true);
  });

  it.each([
    ["a file name that is not cloudpin-X.Y.Z.tgz", PACKED, "cloudpin-1.2.0-beta.tgz", /cloudpin-X\.Y\.Z\.tgz/],
    ["a version that differs from package.json", PACKED, "cloudpin-1.3.0.tgz", /package\.json says 1\.2\.0, the file name 1\.3\.0/],
    ["no dist/cli.js", PACKED.filter((e) => e.name !== "package/dist/cli.js"), "cloudpin-1.2.0.tgz", /no package\/dist\/cli\.js/],
    ["no package.json", PACKED.filter((e) => e.name !== "package/package.json"), "cloudpin-1.2.0.tgz", /no package\/package\.json/],
    ["a file outside package/", [...PACKED, { name: "other/x", data: "" }], "cloudpin-1.2.0.tgz", /outside package\//],
    ["its own node_modules", [...PACKED, { name: "package/node_modules/x/index.js", data: "" }], "cloudpin-1.2.0.tgz", /already has/],
  ])("refuses %s, writing nothing", (_what, entries, name, message) => {
    const out = tempDir("cloudpin-zip-out-");
    expect(() => buildWindowsZip({ tarball: tarballFile(entries, name), outDir: out, lockfile: lockfile(), install: fakeInstall({}) })).toThrow(message);
    expect(() => readFileSync(join(out, zipName("1.2.0")))).toThrow();
  });

  it("fails when the install makes no node_modules", () => {
    expect(() => buildWindowsZip({ tarball: tarballFile(PACKED), outDir: tempDir("cloudpin-zip-out-"), lockfile: lockfile(), install: () => {} })).toThrow(
      /no node_modules/,
    );
  });
});
