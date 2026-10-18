import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { bumpFormula, bumpInstallers, bumpManifest, parseArgs, shaFor } from "../scripts/bump-installers.mjs";
import { tempDir } from "./tmp.js";

const OLD_SHA = "4556f4ad13f9d2f9e8103cd8910edfd16cd8f19296e8cb9a3123583c7587a35a";
// Stand-in bytes for the 1.2.0 registry tarball, and their sha256 as SHA256SUMS lists it.
const TARBALL = new Uint8Array([0x1f, 0x8b, 0x08, 0x00, 1, 2, 3, 4, 250, 251]);
const NEW_SHA = createHash("sha256").update(TARBALL).digest("hex");
const REGISTRY = "https://registry.npmjs.org/cloudpin/-/cloudpin-1.2.0.tgz";
const RELEASE_SUMS = "https://github.com/paureis/cloudpin/releases/download/v1.2.0/SHA256SUMS";

const FORMULA = `class Cloudpin < Formula
  desc "Pin cloud CLI accounts to a repo and block commands on the wrong one"
  homepage "https://github.com/paureis/cloudpin"
  url "https://registry.npmjs.org/cloudpin/-/cloudpin-1.1.0.tgz"
  sha256 "${OLD_SHA}"
  license "MIT"

  depends_on "node"

  def install
    system "npm", "install", *std_npm_args
    bin.install_symlink libexec.glob("bin/*")
  end
end
`;

// Stand-in bytes for the 1.2.0 Windows zip, and their sha256.
const ZIP = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 9, 8, 7]);
const ZIP_SHA = createHash("sha256").update(ZIP).digest("hex");
const ZIP_URL = "https://github.com/paureis/cloudpin/releases/download/v1.2.0/cloudpin-1.2.0-windows.zip";
const ZEROS = "0".repeat(64);

/** The bucket's manifest at `version` (the bucket starts at the 0.0.0 placeholder with a zero hash). */
const MANIFEST = (version = "0.0.0", hash = ZEROS) => String.raw`{
    "version": "${version}",
    "description": "Pin cloud CLI accounts to a repo and block commands on the wrong one",
    "homepage": "https://github.com/paureis/cloudpin",
    "license": "MIT",
    "depends": "nodejs-lts",
    "url": "https://github.com/paureis/cloudpin/releases/download/v${version}/cloudpin-${version}-windows.zip",
    "hash": "${hash}",
    "bin": [
        [
            "..\\..\\nodejs-lts\\current\\node.exe",
            "cloudpin",
            "\"$dir\\dist\\cli.js\""
        ]
    ],
    "checkver": "github",
    "autoupdate": {
        "url": "https://github.com/paureis/cloudpin/releases/download/v$version/cloudpin-$version-windows.zip",
        "hash": {
            "url": "$baseurl/SHA256SUMS"
        }
    }
}
`;

const SUMS = (version: string, sha = NEW_SHA, zipSha = ZIP_SHA) =>
  `${sha}  cloudpin-${version}.tgz\n${zipSha}  cloudpin-${version}-windows.zip\n`;

function bucket(manifest = MANIFEST()): string {
  const dir = tempDir("cloudpin-bucket-");
  mkdirSync(join(dir, "bucket"));
  writeFileSync(join(dir, "bucket", "cloudpin.json"), manifest);
  return dir;
}

const readManifestFile = (dir: string) => readFileSync(join(dir, "bucket", "cloudpin.json"), "utf8");

/** `text` as a regular expression that matches only itself (every metacharacter escaped, backslash included). */
const escapeRegExp = (text: string) => text.replace(/[\\^$.*+?()[\]{}|\/-]/g, "\\$&");

function tap(formula = FORMULA): string {
  const dir = tempDir("cloudpin-tap-");
  mkdirSync(join(dir, "Formula"));
  writeFileSync(join(dir, "Formula", "cloudpin.rb"), formula);
  return dir;
}

/** What the fake serves for one URL: a body (and status), or null for a network error. */
type Reply = { body: string | Uint8Array; status?: number } | null;

/**
 * A fetch that serves `body` (null: offline) for the release's SHA256SUMS and
 * `tarball` for the registry tarball, and records what was asked.
 */
function fakeFetch(body: string | null, status = 200, tarball: Reply = { body: TARBALL }, zip: Reply = { body: ZIP }) {
  const asked: string[] = [];
  const impl = (async (url: string) => {
    asked.push(url);
    const reply: Reply = url.endsWith("/SHA256SUMS")
      ? body === null
        ? null
        : { body, status }
      : url.endsWith(".tgz")
        ? tarball
        : url.endsWith("-windows.zip")
          ? zip
          : { body: "", status: 404 };
    if (reply === null) throw new Error("offline");
    const bytes = typeof reply.body === "string" ? new TextEncoder().encode(reply.body) : reply.body;
    const code = reply.status ?? 200;
    return {
      ok: code >= 200 && code < 300,
      status: code,
      text: async () => new TextDecoder().decode(bytes),
      arrayBuffer: async () => bytes.slice().buffer,
    };
  }) as unknown as typeof fetch;
  return { impl, asked };
}

describe("parseArgs", () => {
  it("takes a version, --tap, --bucket and --force", () => {
    expect(parseArgs(["1.2.0", "--tap", "/x/tap"])).toEqual({ version: "1.2.0", tap: "/x/tap", force: false });
    expect(parseArgs(["--tap", "/x/tap", "1.2.0", "--force"])).toEqual({ version: "1.2.0", tap: "/x/tap", force: true });
    expect(parseArgs(["1.2.0", "--bucket", "/y"])).toEqual({ version: "1.2.0", bucket: "/y", force: false });
    expect(parseArgs(["--bucket", "/y", "1.2.0", "--tap", "/x"])).toEqual({ version: "1.2.0", tap: "/x", bucket: "/y", force: false });
  });

  it.each([
    [[], /usage/],
    [["1.2.0"], /--tap <path>, --bucket <path>/],
    [["1.2.0", "--tap"], /--tap needs a path/],
    [["1.2.0", "--bucket"], /--bucket needs a path/],
    [["1.2.0", "--bucket", "--tap", "/x"], /--bucket needs a path/],
    [["v1.2.0", "--tap", "/x"], /x\.y\.z/],
    [["1.2", "--tap", "/x"], /x\.y\.z/],
    [["1.2.0-beta.1", "--tap", "/x"], /x\.y\.z/],
    [["1.2.0", "--tap", "/x", "--winget", "/y"], /unknown option --winget/],
    [["1.2.0", "1.3.0", "--tap", "/x"], /one version/],
  ])("refuses %j", (argv, message) => {
    expect(() => parseArgs(argv)).toThrow(message);
  });
});

describe("shaFor", () => {
  it("takes the tarball's line from SHA256SUMS, text or binary mode", () => {
    const sums = `${"a".repeat(64)}  cloudpin-1.2.0-windows.zip\n${NEW_SHA}  cloudpin-1.2.0.tgz\n`;
    expect(shaFor(sums, "cloudpin-1.2.0.tgz")).toBe(NEW_SHA);
    expect(shaFor(`${NEW_SHA} *cloudpin-1.2.0.tgz\r\n`, "cloudpin-1.2.0.tgz")).toBe(NEW_SHA);
    expect(shaFor(NEW_SHA.toUpperCase() + "  cloudpin-1.2.0.tgz", "cloudpin-1.2.0.tgz")).toBe(NEW_SHA);
  });

  it("fails without the tarball's line, never matching another file", () => {
    expect(() => shaFor(SUMS("1.2.1"), "cloudpin-1.2.0.tgz")).toThrow(/no line for cloudpin-1\.2\.0\.tgz/);
    expect(() => shaFor(`${NEW_SHA}  xcloudpin-1.2.0.tgz\n`, "cloudpin-1.2.0.tgz")).toThrow(/no line/);
  });

  it("fails when the sha256 is not 64 hex characters", () => {
    expect(() => shaFor(`${NEW_SHA.slice(1)}  cloudpin-1.2.0.tgz\n`, "cloudpin-1.2.0.tgz")).toThrow(/64 hex/);
    expect(() => shaFor(`${"g".repeat(64)}  cloudpin-1.2.0.tgz\n`, "cloudpin-1.2.0.tgz")).toThrow(/64 hex/);
  });
});

describe("bumpFormula", () => {
  it("rewrites only the url and sha256 lines and says what changed", () => {
    const r = bumpFormula(FORMULA, "1.2.0", NEW_SHA, false);
    expect(r.from).toEqual({ version: "1.1.0", sha256: OLD_SHA });
    expect(r.text).toBe(
      FORMULA.replace("cloudpin-1.1.0.tgz", "cloudpin-1.2.0.tgz").replace(OLD_SHA, NEW_SHA),
    );
  });

  it("fails unless there is exactly one url line and one sha256 line", () => {
    expect(() => bumpFormula(FORMULA.replace(/^ {2}url .*\n/m, ""), "1.2.0", NEW_SHA, false)).toThrow(/exactly one url line, found 0/);
    expect(() => bumpFormula(FORMULA.replace(/^ {2}sha256 .*\n/m, ""), "1.2.0", NEW_SHA, false)).toThrow(/exactly one sha256 line, found 0/);
    const twoUrls = FORMULA.replace("  license", '  url "https://registry.npmjs.org/cloudpin/-/cloudpin-1.0.0.tgz"\n  license');
    expect(() => bumpFormula(twoUrls, "1.2.0", NEW_SHA, false)).toThrow(/exactly one url line, found 2/);
    const twoShas = FORMULA.replace("  license", `  sha256 "${OLD_SHA}"\n  license`);
    expect(() => bumpFormula(twoShas, "1.2.0", NEW_SHA, false)).toThrow(/exactly one sha256 line, found 2/);
  });

  it("fails when the url is not cloudpin's registry tarball", () => {
    const other = FORMULA.replace("https://registry.npmjs.org/cloudpin/-/cloudpin-1.1.0.tgz", "https://example.com/cloudpin.tgz");
    expect(() => bumpFormula(other, "1.2.0", NEW_SHA, false)).toThrow(/registry tarball/);
  });

  it("fails unless the version is newer, and --force allows only a re-run of the same version", () => {
    expect(() => bumpFormula(FORMULA, "1.1.0", NEW_SHA, false)).toThrow(/not newer than 1\.1\.0.*--force/);
    expect(() => bumpFormula(FORMULA, "1.0.9", NEW_SHA, false)).toThrow(/not newer than 1\.1\.0/);
    expect(() => bumpFormula(FORMULA, "1.0.9", NEW_SHA, true)).toThrow(/not newer than 1\.1\.0/);
    expect(() => bumpFormula(FORMULA, "1.1.10", NEW_SHA, false)).not.toThrow();
    expect(bumpFormula(FORMULA, "1.1.0", NEW_SHA, true).text).toContain(NEW_SHA);
  });
});

describe("bumpInstallers", () => {
  it("downloads the release's SHA256SUMS, checks the registry tarball, rewrites the formula and prints the change", async () => {
    const dir = tap();
    const f = fakeFetch(SUMS("1.2.0"));
    const lines = await bumpInstallers({ version: "1.2.0", tap: dir, force: false }, f.impl);
    expect(f.asked).toEqual([RELEASE_SUMS, REGISTRY]);
    const formula = readFileSync(join(dir, "Formula", "cloudpin.rb"), "utf8");
    expect(formula).toContain('  url "https://registry.npmjs.org/cloudpin/-/cloudpin-1.2.0.tgz"\n');
    expect(formula).toContain(`  sha256 "${NEW_SHA}"\n`);
    expect(formula).not.toContain(OLD_SHA);
    expect(lines.join("\n")).toContain("1.1.0 -> 1.2.0");
    expect(lines.join("\n")).toContain(`${OLD_SHA} -> ${NEW_SHA}`);
  });

  it.each([
    ["the download fails", fakeFetch(null), /could not download .*SHA256SUMS.*offline/],
    ["the release has no SHA256SUMS", fakeFetch("Not Found", 404), /could not download .*SHA256SUMS.*HTTP 404/],
    ["SHA256SUMS lacks the tarball", fakeFetch(SUMS("1.2.1")), /no line for cloudpin-1\.2\.0\.tgz/],
    ["the sha256 is malformed", fakeFetch(SUMS("1.2.0", "abc")), /64 hex/],
    [
      "the registry tarball differs from SHA256SUMS",
      fakeFetch(SUMS("1.2.0"), 200, { body: new Uint8Array([...TARBALL, 0]) }),
      new RegExp(`${escapeRegExp(REGISTRY)} has sha256 [0-9a-f]{64}, but SHA256SUMS says ${NEW_SHA}`),
    ],
    [
      "npm does not have the version yet",
      fakeFetch(SUMS("1.2.0"), 200, { body: "Not Found", status: 404 }),
      /cloudpin-1\.2\.0\.tgz.*HTTP 404.*awaiting approval.*npmjs\.com/s,
    ],
    ["the registry can't be reached", fakeFetch(SUMS("1.2.0"), 200, null), /could not download .*cloudpin-1\.2\.0\.tgz.*offline/],
  ])("leaves the formula alone when %s", async (_what, f, message) => {
    const dir = tap();
    await expect(bumpInstallers({ version: "1.2.0", tap: dir, force: false }, f.impl)).rejects.toThrow(message);
    expect(readFileSync(join(dir, "Formula", "cloudpin.rb"), "utf8")).toBe(FORMULA);
  });

  it("fails clearly when the tap has no Formula/cloudpin.rb", async () => {
    const dir = tempDir("cloudpin-tap-");
    await expect(bumpInstallers({ version: "1.2.0", tap: dir, force: false }, fakeFetch(SUMS("1.2.0")).impl)).rejects.toThrow(
      /Formula[\\/]cloudpin\.rb/,
    );
  });

  it("checks the formula before downloading anything", async () => {
    const dir = tap();
    const f = fakeFetch(SUMS("1.1.0"));
    await expect(bumpInstallers({ version: "1.1.0", tap: dir, force: false }, f.impl)).rejects.toThrow(/not newer/);
    expect(f.asked).toEqual([]);
  });
});

describe("bumpManifest", () => {
  it("rewrites only the version, url and hash lines of the placeholder, and says what changed", () => {
    const r = bumpManifest(MANIFEST(), "1.2.0", ZIP_SHA, false);
    expect(r.from).toEqual({ version: "0.0.0", sha256: ZEROS });
    expect(r.text).toBe(MANIFEST("1.2.0", ZIP_SHA));
    // Everything else, autoupdate's own url and hash included, is byte for byte the same.
    expect(r.text.split("\n").filter((l, i) => l !== MANIFEST().split("\n")[i])).toEqual([
      '    "version": "1.2.0",',
      '    "url": "https://github.com/paureis/cloudpin/releases/download/v1.2.0/cloudpin-1.2.0-windows.zip",',
      `    "hash": "${ZIP_SHA}",`,
    ]);
  });

  it.each([
    ["version", /^ {4}"version": .*\n/m],
    ["url", /^ {4}"url": .*\n/m],
    ["hash", /^ {4}"hash": .*\n/m],
  ])("fails unless there is exactly one top-level %s line", (what, line) => {
    const text = MANIFEST("1.1.0", NEW_SHA);
    expect(() => bumpManifest(text.replace(line, ""), "1.2.0", ZIP_SHA, false)).toThrow(new RegExp(`exactly one ${what} line, found 0`));
    const twice = text.replace(line, (l) => l + l);
    expect(() => bumpManifest(twice, "1.2.0", ZIP_SHA, false)).toThrow(new RegExp(`exactly one ${what} line, found 2`));
  });

  it("fails when the url is not cloudpin's Windows zip for the manifest's version", () => {
    const other = MANIFEST("1.1.0", NEW_SHA).replace(/^( {4}"url": ")[^"]*/m, (_m, start: string) => start + "https://example.com/cloudpin.zip");
    expect(() => bumpManifest(other, "1.2.0", ZIP_SHA, false)).toThrow(/not cloudpin's Windows zip/);
    const mismatch = MANIFEST("1.1.0", NEW_SHA).replace('"version": "1.1.0"', '"version": "1.0.0"');
    expect(() => bumpManifest(mismatch, "1.2.0", ZIP_SHA, false)).toThrow(/url is for 1\.1\.0 but the version is 1\.0\.0/);
  });

  it("fails when the current hash is not 64 hex characters", () => {
    expect(() => bumpManifest(MANIFEST("1.1.0", "abc"), "1.2.0", ZIP_SHA, false)).toThrow(/hash is not 64 hex/);
  });

  it("fails unless the version is newer, and --force allows only a re-run of the same version", () => {
    const current = MANIFEST("1.1.0", NEW_SHA);
    expect(() => bumpManifest(current, "1.1.0", ZIP_SHA, false)).toThrow(/bucket[\\/]cloudpin\.json: 1\.1\.0 is not newer than 1\.1\.0.*--force/);
    expect(() => bumpManifest(current, "1.0.9", ZIP_SHA, true)).toThrow(/not newer than 1\.1\.0/);
    expect(bumpManifest(current, "1.1.0", ZIP_SHA, true).text).toContain(ZIP_SHA);
  });
});

describe("bumpInstallers --bucket", () => {
  it("checks the release's zip against SHA256SUMS, rewrites the manifest and prints the change", async () => {
    const dir = bucket();
    const f = fakeFetch(SUMS("1.2.0"));
    const lines = await bumpInstallers({ version: "1.2.0", bucket: dir, force: false }, f.impl);
    expect(f.asked).toEqual([RELEASE_SUMS, ZIP_URL]);
    expect(readManifestFile(dir)).toBe(MANIFEST("1.2.0", ZIP_SHA));
    expect(lines.join("\n")).toContain("0.0.0 -> 1.2.0");
    expect(lines.join("\n")).toContain(`${ZEROS} -> ${ZIP_SHA}`);
  });

  it.each([
    ["SHA256SUMS lacks the zip", fakeFetch(`${NEW_SHA}  cloudpin-1.2.0.tgz\n`), /no line for cloudpin-1\.2\.0-windows\.zip/],
    [
      "the zip differs from SHA256SUMS",
      fakeFetch(SUMS("1.2.0"), 200, { body: TARBALL }, { body: new Uint8Array([...ZIP, 0]) }),
      new RegExp(`${escapeRegExp(ZIP_URL)} has sha256 [0-9a-f]{64}, but SHA256SUMS says ${ZIP_SHA}`),
    ],
    ["the release has no zip", fakeFetch(SUMS("1.2.0"), 200, { body: TARBALL }, { body: "Not Found", status: 404 }), /windows\.zip: HTTP 404.*release's assets/s],
    ["the zip can't be downloaded", fakeFetch(SUMS("1.2.0"), 200, { body: TARBALL }, null), /could not download .*windows\.zip.*offline/],
  ])("leaves the manifest alone when %s", async (_what, f, message) => {
    const dir = bucket();
    await expect(bumpInstallers({ version: "1.2.0", bucket: dir, force: false }, f.impl)).rejects.toThrow(message);
    expect(readManifestFile(dir)).toBe(MANIFEST());
  });

  it("fails clearly when the folder has no bucket/cloudpin.json", async () => {
    await expect(bumpInstallers({ version: "1.2.0", bucket: tempDir("cloudpin-bucket-"), force: false }, fakeFetch(SUMS("1.2.0")).impl)).rejects.toThrow(
      /bucket[\\/]cloudpin\.json/,
    );
  });
});

describe("bumpInstallers --tap --bucket", () => {
  it("rewrites both after checking both downloads", async () => {
    const t = tap();
    const b = bucket();
    const f = fakeFetch(SUMS("1.2.0"));
    await bumpInstallers({ version: "1.2.0", tap: t, bucket: b, force: false }, f.impl);
    expect(f.asked).toEqual([RELEASE_SUMS, REGISTRY, ZIP_URL]);
    expect(readFileSync(join(t, "Formula", "cloudpin.rb"), "utf8")).toContain(NEW_SHA);
    expect(readManifestFile(b)).toBe(MANIFEST("1.2.0", ZIP_SHA));
  });

  it("writes neither when the zip is wrong, though the tarball is right", async () => {
    const t = tap();
    const b = bucket();
    const f = fakeFetch(SUMS("1.2.0"), 200, { body: TARBALL }, { body: new Uint8Array([1]) });
    await expect(bumpInstallers({ version: "1.2.0", tap: t, bucket: b, force: false }, f.impl)).rejects.toThrow(/nothing was written/);
    expect(readFileSync(join(t, "Formula", "cloudpin.rb"), "utf8")).toBe(FORMULA);
    expect(readManifestFile(b)).toBe(MANIFEST());
  });

  it("downloads nothing when either file is not older than the version", async () => {
    const f = fakeFetch(SUMS("1.2.0"));
    await expect(
      bumpInstallers({ version: "1.2.0", tap: tap(), bucket: bucket(MANIFEST("1.2.0", ZIP_SHA)), force: false }, f.impl),
    ).rejects.toThrow(/bucket[\\/]cloudpin\.json: 1\.2\.0 is not newer than 1\.2\.0/);
    expect(f.asked).toEqual([]);
  });
});
