import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { bumpFormula, bumpInstallers, bumpManifest, parseArgs, renderWinget, shaFor } from "../scripts/bump-installers.mjs";
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

// Stand-in bytes for the 1.2.0 standalone exe zip (#96), and their sha256.
const EXE_ZIP = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x45, 0x58, 0x45]);
const EXE_SHA = createHash("sha256").update(EXE_ZIP).digest("hex");
const EXE_URL = "https://github.com/paureis/cloudpin/releases/download/v1.2.0/cloudpin-1.2.0-win-x64.zip";
const RELEASE_API = "https://api.github.com/repos/paureis/cloudpin/releases/tags/v1.2.0";
const RELEASE = { body: JSON.stringify({ tag_name: "v1.2.0", draft: false, published_at: "2026-12-03T17:04:05Z" }) };

const SUMS = (version: string, sha = NEW_SHA, zipSha = ZIP_SHA, exeSha = EXE_SHA) =>
  `${sha}  cloudpin-${version}.tgz\n${zipSha}  cloudpin-${version}-windows.zip\n${exeSha}  cloudpin-${version}-win-x64.zip\n`;

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
 * A fetch that serves `body` (null: offline) for the release's SHA256SUMS,
 * `tarball` for the registry tarball, `zip` for the Windows zip, and `more.exe`
 * and `more.release` for the exe zip and the GitHub Release's API record, and
 * records what was asked.
 */
function fakeFetch(
  body: string | null,
  status = 200,
  tarball: Reply = { body: TARBALL },
  zip: Reply = { body: ZIP },
  more: { exe?: Reply; release?: Reply } = {},
) {
  const { exe = { body: EXE_ZIP }, release = RELEASE } = more;
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
          : url.endsWith("-win-x64.zip")
            ? exe
            : url.startsWith("https://api.github.com/repos/paureis/cloudpin/releases/tags/")
              ? release
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

  it("takes --winget, with --date for the release date", () => {
    expect(parseArgs(["1.2.0", "--winget", "/w"])).toEqual({ version: "1.2.0", winget: "/w", force: false });
    expect(parseArgs(["--date", "2026-12-03", "--winget", "/w", "1.2.0", "--bucket", "/y"])).toEqual({
      version: "1.2.0",
      winget: "/w",
      date: "2026-12-03",
      bucket: "/y",
      force: false,
    });
  });

  it.each([
    [[], /usage/],
    [["1.2.0"], /--tap <path>, --bucket <path>, --winget <dir>/],
    [["1.2.0", "--tap"], /--tap needs a path/],
    [["1.2.0", "--bucket"], /--bucket needs a path/],
    [["1.2.0", "--bucket", "--tap", "/x"], /--bucket needs a path/],
    [["1.2.0", "--winget"], /--winget needs a path/],
    [["v1.2.0", "--tap", "/x"], /x\.y\.z/],
    [["1.2", "--tap", "/x"], /x\.y\.z/],
    [["1.2.0-beta.1", "--tap", "/x"], /x\.y\.z/],
    [["1.2.0", "--tap", "/x", "--chocolatey", "/y"], /unknown option --chocolatey/],
    [["1.2.0", "1.3.0", "--tap", "/x"], /one version/],
    [["1.2.0", "--winget", "/w", "--date"], /--date needs a YYYY-MM-DD date/],
    [["1.2.0", "--winget", "/w", "--date", "12/03/2026"], /--date must be YYYY-MM-DD/],
    [["1.2.0", "--winget", "/w", "--date", "2026-02-30"], /--date must be YYYY-MM-DD.*2026-02-30/],
    [["1.2.0", "--winget", "/w", "--date", "2026-13-01"], /--date must be YYYY-MM-DD/],
    [["1.2.0", "--bucket", "/y", "--date", "2026-12-03"], /--date only applies to --winget/],
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

// winget (#96): packaging/winget/ holds the three manifest templates.
const TEMPLATE_DIR = new URL("../packaging/winget/", import.meta.url);
const WINGET_FILES = ["paureis.cloudpin.yaml", "paureis.cloudpin.installer.yaml", "paureis.cloudpin.locale.en-US.yaml"];
const templates = () => Object.fromEntries(WINGET_FILES.map((f) => [f, readFileSync(new URL(f, TEMPLATE_DIR), "utf8")]));
const DESCRIPTION = (JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { description: string }).description;
const VALUES = { version: "1.2.0", sha256: EXE_SHA, releaseDate: "2026-12-03" };

type Installer = {
  Architecture: string;
  InstallerType: string;
  NestedInstallerType: string;
  NestedInstallerFiles: { RelativeFilePath: string; PortableCommandAlias: string }[];
  InstallerUrl: string;
  InstallerSha256: string;
};

describe("renderWinget", () => {
  it("has exactly the three templates winget-pkgs' multi-file layout needs", () => {
    expect(readdirSync(TEMPLATE_DIR).sort()).toEqual([...WINGET_FILES].sort());
  });

  it("fills in the version, the exe zip's url and uppercase sha256, and the release date", () => {
    const out = renderWinget(templates(), VALUES);
    expect(Object.keys(out).sort()).toEqual([...WINGET_FILES].sort());
    for (const text of Object.values(out)) expect(text).not.toMatch(/__[A-Z_]+__/);

    const version = parse(out["paureis.cloudpin.yaml"]!);
    expect(version).toEqual({
      PackageIdentifier: "paureis.cloudpin",
      PackageVersion: "1.2.0",
      DefaultLocale: "en-US",
      ManifestType: "version",
      ManifestVersion: "1.28.0",
    });

    const installer = parse(out["paureis.cloudpin.installer.yaml"]!);
    expect(installer).toMatchObject({
      PackageIdentifier: "paureis.cloudpin",
      PackageVersion: "1.2.0",
      ReleaseDate: "2026-12-03",
      ManifestType: "installer",
      ManifestVersion: "1.28.0",
    });
    expect(installer.Installers).toEqual([
      {
        Architecture: "x64",
        InstallerType: "zip",
        NestedInstallerType: "portable",
        NestedInstallerFiles: [{ RelativeFilePath: "cloudpin.exe", PortableCommandAlias: "cloudpin" }],
        InstallerUrl: EXE_URL,
        InstallerSha256: EXE_SHA.toUpperCase(),
      } satisfies Installer,
    ]);

    const locale = parse(out["paureis.cloudpin.locale.en-US.yaml"]!);
    expect(locale).toMatchObject({
      PackageIdentifier: "paureis.cloudpin",
      PackageVersion: "1.2.0",
      PackageLocale: "en-US",
      Publisher: "paureis",
      PackageName: "cloudpin",
      PackageUrl: "https://github.com/paureis/cloudpin",
      PublisherUrl: "https://github.com/paureis",
      License: "MIT",
      LicenseUrl: "https://github.com/paureis/cloudpin/blob/main/LICENSE",
      ShortDescription: DESCRIPTION,
      ReleaseNotesUrl: "https://github.com/paureis/cloudpin/releases/tag/v1.2.0",
      ManifestType: "defaultLocale",
      ManifestVersion: "1.28.0",
    });
    // winget-pkgs: at most 16 tags, lowercase with hyphens.
    expect(locale.Tags.length).toBeLessThanOrEqual(16);
    for (const tag of locale.Tags) expect(tag).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
  });

  it("starts each file with the schema header for its own type and version", () => {
    const out = renderWinget(templates(), VALUES);
    for (const [file, text] of Object.entries(out)) {
      const doc = parse(text) as { ManifestType: string; ManifestVersion: string };
      const schema = `# yaml-language-server: $schema=https://aka.ms/winget-manifest.${doc.ManifestType}.${doc.ManifestVersion}.schema.json`;
      expect(text.split("\n").slice(0, 2), file).toContain(schema);
    }
  });

  it("fails on a placeholder it doesn't know, a file that doesn't parse, or a file for another package or version", () => {
    const t = templates();
    const withExtra = { ...t, "paureis.cloudpin.yaml": t["paureis.cloudpin.yaml"] + "Moniker: __MONIKER__\n" };
    expect(() => renderWinget(withExtra, VALUES)).toThrow(/paureis\.cloudpin\.yaml: __MONIKER__ is not filled in/);
    const broken = { ...t, "paureis.cloudpin.yaml": t["paureis.cloudpin.yaml"] + "  : [\n" };
    expect(() => renderWinget(broken, VALUES)).toThrow(/paureis\.cloudpin\.yaml is not valid YAML/);
    const other = { ...t, "paureis.cloudpin.yaml": t["paureis.cloudpin.yaml"]!.replace("PackageIdentifier: paureis.cloudpin", "PackageIdentifier: other.pkg") };
    expect(() => renderWinget(other, VALUES)).toThrow(/paureis\.cloudpin\.yaml: PackageIdentifier is other\.pkg, not paureis\.cloudpin/);
    const pinned = { ...t, "paureis.cloudpin.installer.yaml": t["paureis.cloudpin.installer.yaml"]!.replace("PackageVersion: __VERSION__", "PackageVersion: 1.0.0") };
    expect(() => renderWinget(pinned, VALUES)).toThrow(/paureis\.cloudpin\.installer\.yaml: PackageVersion is 1\.0\.0, not 1\.2\.0/);
    const { ["paureis.cloudpin.locale.en-US.yaml"]: _gone, ...missing } = t;
    expect(() => renderWinget(missing, VALUES)).toThrow(/paureis\.cloudpin\.locale\.en-US\.yaml/);
  });
});

const wingetDir = (out: string, version = "1.2.0") => join(out, "manifests", "p", "paureis", "cloudpin", version);
const readWinget = (out: string) => Object.fromEntries(WINGET_FILES.map((f) => [f, readFileSync(join(wingetDir(out), f), "utf8")]));

describe("bumpInstallers --winget", () => {
  it("checks the exe zip against SHA256SUMS and writes the three manifests in winget-pkgs' layout, with --date", async () => {
    const out = tempDir("cloudpin-winget-");
    const f = fakeFetch(SUMS("1.2.0"));
    const lines = await bumpInstallers({ version: "1.2.0", winget: out, date: "2026-12-03", force: false }, f.impl);
    expect(f.asked).toEqual([RELEASE_SUMS, EXE_URL]);
    expect(readWinget(out)).toEqual(renderWinget(templates(), VALUES));
    expect(lines.join("\n")).toContain(wingetDir(out));
    expect(lines.join("\n")).toContain(EXE_SHA.toUpperCase());
    expect(lines.join("\n")).toContain("2026-12-03");
  });

  it("takes the release date from the GitHub Release's published date without --date", async () => {
    const out = tempDir("cloudpin-winget-");
    const f = fakeFetch(SUMS("1.2.0"), 200, { body: TARBALL }, { body: ZIP }, {
      release: { body: JSON.stringify({ draft: false, published_at: "2026-12-04T01:30:00Z" }) },
    });
    await bumpInstallers({ version: "1.2.0", winget: out, force: false }, f.impl);
    expect(f.asked).toEqual([RELEASE_SUMS, RELEASE_API, EXE_URL]);
    expect(parse(readWinget(out)["paureis.cloudpin.installer.yaml"]!).ReleaseDate).toBe("2026-12-04");
  });

  it.each([
    ["SHA256SUMS lacks the exe zip", fakeFetch(`${NEW_SHA}  cloudpin-1.2.0.tgz\n`), /no line for cloudpin-1\.2\.0-win-x64\.zip/],
    [
      "the exe zip differs from SHA256SUMS",
      fakeFetch(SUMS("1.2.0"), 200, { body: TARBALL }, { body: ZIP }, { exe: { body: new Uint8Array([...EXE_ZIP, 0]) } }),
      new RegExp(`${escapeRegExp(EXE_URL)} has sha256 [0-9a-f]{64}, but SHA256SUMS says ${EXE_SHA}; nothing was written`),
    ],
    [
      "the release has no exe zip",
      fakeFetch(SUMS("1.2.0"), 200, { body: TARBALL }, { body: ZIP }, { exe: { body: "Not Found", status: 404 } }),
      /win-x64\.zip: HTTP 404.*release's assets/s,
    ],
    ["the exe zip can't be downloaded", fakeFetch(SUMS("1.2.0"), 200, { body: TARBALL }, { body: ZIP }, { exe: null }), /could not download .*win-x64\.zip.*offline/],
    [
      "the GitHub Release isn't found",
      fakeFetch(SUMS("1.2.0"), 200, { body: TARBALL }, { body: ZIP }, { release: { body: "Not Found", status: 404 } }),
      /releases\/tags\/v1\.2\.0: HTTP 404.*--date YYYY-MM-DD/s,
    ],
    ["the GitHub API can't be reached", fakeFetch(SUMS("1.2.0"), 200, { body: TARBALL }, { body: ZIP }, { release: null }), /could not download .*releases\/tags\/v1\.2\.0.*offline/],
    [
      "the release is still a draft",
      fakeFetch(SUMS("1.2.0"), 200, { body: TARBALL }, { body: ZIP }, { release: { body: JSON.stringify({ draft: true, published_at: null }) } }),
      /v1\.2\.0 has no published date.*--date YYYY-MM-DD/s,
    ],
    [
      "the API's answer isn't JSON",
      fakeFetch(SUMS("1.2.0"), 200, { body: TARBALL }, { body: ZIP }, { release: { body: "<html>" } }),
      /v1\.2\.0 has no published date/,
    ],
  ])("writes nothing when %s", async (_what, f, message) => {
    const out = tempDir("cloudpin-winget-");
    await expect(bumpInstallers({ version: "1.2.0", winget: out, force: false }, f.impl)).rejects.toThrow(message);
    expect(readdirSync(out)).toEqual([]);
  });

  it("refuses a version folder that already has files, before downloading anything, unless --force", async () => {
    const out = tempDir("cloudpin-winget-");
    mkdirSync(wingetDir(out), { recursive: true });
    writeFileSync(join(wingetDir(out), "paureis.cloudpin.yaml"), "old\n");
    const f = fakeFetch(SUMS("1.2.0"));
    await expect(bumpInstallers({ version: "1.2.0", winget: out, date: "2026-12-03", force: false }, f.impl)).rejects.toThrow(
      /cloudpin[\\/]1\.2\.0 already has files.*--force/,
    );
    expect(f.asked).toEqual([]);
    expect(readFileSync(join(wingetDir(out), "paureis.cloudpin.yaml"), "utf8")).toBe("old\n");
    await bumpInstallers({ version: "1.2.0", winget: out, date: "2026-12-03", force: true }, f.impl);
    expect(readWinget(out)).toEqual(renderWinget(templates(), VALUES));
  });

  it("with --bucket, writes neither when the exe zip is wrong, though the Windows zip is right", async () => {
    const b = bucket();
    const out = tempDir("cloudpin-winget-");
    const f = fakeFetch(SUMS("1.2.0"), 200, { body: TARBALL }, { body: ZIP }, { exe: { body: new Uint8Array([1]) } });
    await expect(bumpInstallers({ version: "1.2.0", bucket: b, winget: out, date: "2026-12-03", force: false }, f.impl)).rejects.toThrow(
      /nothing was written/,
    );
    expect(f.asked).toEqual([RELEASE_SUMS, ZIP_URL, EXE_URL]);
    expect(readManifestFile(b)).toBe(MANIFEST());
    expect(existsSync(join(out, "manifests"))).toBe(false);
  });

  it("with --bucket, writes both after checking both downloads", async () => {
    const b = bucket();
    const out = tempDir("cloudpin-winget-");
    await bumpInstallers({ version: "1.2.0", bucket: b, winget: out, date: "2026-12-03", force: false }, fakeFetch(SUMS("1.2.0")).impl);
    expect(readManifestFile(b)).toBe(MANIFEST("1.2.0", ZIP_SHA));
    expect(readWinget(out)).toEqual(renderWinget(templates(), VALUES));
  });
});
