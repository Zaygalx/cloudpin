import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { bumpFormula, bumpInstallers, parseArgs, shaFor } from "../scripts/bump-installers.mjs";
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

const SUMS = (version: string, sha = NEW_SHA) => `${sha}  cloudpin-${version}.tgz\n`;

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
function fakeFetch(body: string | null, status = 200, tarball: Reply = { body: TARBALL }) {
  const asked: string[] = [];
  const impl = (async (url: string) => {
    asked.push(url);
    const reply: Reply = url.endsWith("/SHA256SUMS") ? (body === null ? null : { body, status }) : url.endsWith(".tgz") ? tarball : { body: "", status: 404 };
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
  it("takes a version, --tap and --force", () => {
    expect(parseArgs(["1.2.0", "--tap", "/x/tap"])).toEqual({ version: "1.2.0", tap: "/x/tap", force: false });
    expect(parseArgs(["--tap", "/x/tap", "1.2.0", "--force"])).toEqual({ version: "1.2.0", tap: "/x/tap", force: true });
  });

  it.each([
    [[], /usage/],
    [["1.2.0"], /--tap/],
    [["1.2.0", "--tap"], /--tap needs a path/],
    [["v1.2.0", "--tap", "/x"], /x\.y\.z/],
    [["1.2", "--tap", "/x"], /x\.y\.z/],
    [["1.2.0-beta.1", "--tap", "/x"], /x\.y\.z/],
    [["1.2.0", "--tap", "/x", "--bucket", "/y"], /unknown option --bucket/],
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
