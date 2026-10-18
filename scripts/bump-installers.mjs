// Points the installers at a new release (#16 the Homebrew formula, #17 the Scoop manifest, #96 winget).
// Run by the release session after the vX.Y.Z tag's GitHub Release exists:
//   node scripts/bump-installers.mjs <version> [--tap <homebrew-tap checkout>] [--bucket <scoop-bucket checkout>]
//     [--winget <out-dir> [--date YYYY-MM-DD]] [--force]
// It reads the sha256s from the release's SHA256SUMS (the same file the
// release workflow attests), checks that each file an installer downloads has
// its sha256 (the formula's npm registry tarball, so run it after the staged
// npm version is approved; the manifest's Windows zip and winget's exe zip
// from the release), and only then rewrites the formula's url and sha256
// lines and the manifest's version, url and hash lines, and renders the
// winget manifests from packaging/winget/ into
// <out-dir>/manifests/p/paureis/cloudpin/<version>/ (winget-pkgs' layout; the
// release date is the GitHub Release's published date unless --date gives
// one). It never commits, pushes or submits: review the diff in each
// checkout, then push it; docs/winget.md submits the winget folder.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

const VERSION = /^(\d+)\.(\d+)\.(\d+)$/;
const SHA256 = /^[0-9a-f]{64}$/;

const sumsUrl = (version) => `https://github.com/paureis/cloudpin/releases/download/v${version}/SHA256SUMS`;
const registryUrl = (version) => `https://registry.npmjs.org/cloudpin/-/cloudpin-${version}.tgz`;
const zipAsset = (version) => `cloudpin-${version}-windows.zip`;
const zipUrl = (version) => `https://github.com/paureis/cloudpin/releases/download/v${version}/${zipAsset(version)}`;
// The standalone exe's zip (#96; exeZipName in scripts/build-exe.mjs) and the release's API record, for its date.
const exeAsset = (version) => `cloudpin-${version}-win-x64.zip`;
const exeUrl = (version) => `https://github.com/paureis/cloudpin/releases/download/v${version}/${exeAsset(version)}`;
const releaseApi = (version) => `https://api.github.com/repos/paureis/cloudpin/releases/tags/v${version}`;

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** True for a real calendar date written YYYY-MM-DD (winget's ReleaseDate format). */
function isDate(text) {
  const m = DATE.exec(text);
  if (!m) return false;
  return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))).toISOString().slice(0, 10) === text;
}

/** -1, 0 or 1 for two x.y.z versions. */
function compare(a, b) {
  const x = VERSION.exec(a);
  const y = VERSION.exec(b);
  for (let i = 1; i <= 3; i++) {
    const d = Number(x[i]) - Number(y[i]);
    if (d !== 0) return Math.sign(d);
  }
  return 0;
}

/** Refuses a version that is not newer than the installer's; --force allows only the same one again. */
function checkNewer(file, current, version, force) {
  const c = compare(version, current);
  if (c > 0 || (c === 0 && force)) return;
  throw new Error(
    `${file}: ${version} is not newer than ${current}` + (c === 0 ? " (pass --force to write the same version again)" : ""),
  );
}

/** The sha256 of `asset` in a SHA256SUMS file (`sha256sum` text or binary mode lines). */
export function shaFor(sums, asset) {
  for (const line of sums.split(/\r?\n/)) {
    const m = /^(\S+) [ *](.+)$/.exec(line.trim());
    if (!m || m[2] !== asset) continue;
    const sha = m[1].toLowerCase();
    if (!SHA256.test(sha)) throw new Error(`SHA256SUMS: the sha256 for ${asset} is not 64 hex characters: ${m[1]}`);
    return sha;
  }
  throw new Error(`SHA256SUMS has no line for ${asset}`);
}

// The formula's own lines, two-space indented as `brew style` wants them.
const URL_LINE = /^ {2}url "([^"]*)"$/gm;
const SHA_LINE = /^ {2}sha256 "([^"]*)"$/gm;

function oneLine(text, pattern, what) {
  const found = [...text.matchAll(pattern)];
  if (found.length !== 1) throw new Error(`Formula/cloudpin.rb: expected exactly one ${what} line, found ${found.length}`);
  return found[0];
}

/** The formula's current version and sha256, after checking it has one url and one sha256 line. */
function readFormula(text) {
  const url = oneLine(text, URL_LINE, "url");
  const sha = oneLine(text, SHA_LINE, "sha256");
  const m = /^https:\/\/registry\.npmjs\.org\/cloudpin\/-\/cloudpin-(\d+\.\d+\.\d+)\.tgz$/.exec(url[1]);
  if (!m) throw new Error(`Formula/cloudpin.rb: the url is not cloudpin's npm registry tarball: ${url[1]}`);
  return { version: m[1], sha256: sha[1] };
}

/** The formula rewritten for `version`, and what it said before. */
export function bumpFormula(text, version, sha256, force) {
  const from = readFormula(text);
  checkNewer("Formula/cloudpin.rb", from.version, version, force);
  const out = text
    .replace(URL_LINE, () => `  url "${registryUrl(version)}"`)
    .replace(SHA_LINE, () => `  sha256 "${sha256}"`);
  return { text: out, from };
}

const MANIFEST_FILE = join("bucket", "cloudpin.json");

// The manifest's own top-level lines, four-space indented as Scoop formats its
// JSON; autoupdate's nested url and hash are indented deeper and never match.
const VERSION_FIELD = /^ {4}"version": "([^"]*)",$/gm;
const URL_FIELD = /^ {4}"url": "([^"]*)",$/gm;
const HASH_FIELD = /^ {4}"hash": "([^"]*)",$/gm;

function oneField(text, pattern, what) {
  const found = [...text.matchAll(pattern)];
  if (found.length !== 1) throw new Error(`${MANIFEST_FILE}: expected exactly one ${what} line, found ${found.length}`);
  return found[0];
}

/**
 * The manifest's current version and hash, after checking it has one version,
 * url and hash line, and that the url is cloudpin's Windows zip for that
 * version. The bucket starts at 0.0.0 with a hash of 64 zeros, which is valid.
 */
function readManifest(text) {
  const version = oneField(text, VERSION_FIELD, "version")[1];
  const url = oneField(text, URL_FIELD, "url")[1];
  const hash = oneField(text, HASH_FIELD, "hash")[1];
  const m = /^https:\/\/github\.com\/paureis\/cloudpin\/releases\/download\/v(\d+\.\d+\.\d+)\/cloudpin-(\d+\.\d+\.\d+)-windows\.zip$/.exec(url);
  if (!m || m[1] !== m[2]) throw new Error(`${MANIFEST_FILE}: the url is not cloudpin's Windows zip from a GitHub Release: ${url}`);
  if (m[1] !== version) throw new Error(`${MANIFEST_FILE}: the url is for ${m[1]} but the version is ${version}`);
  if (!SHA256.test(hash)) throw new Error(`${MANIFEST_FILE}: the hash is not 64 hex characters: ${hash}`);
  return { version, sha256: hash };
}

/** The manifest rewritten for `version`, every other byte kept, and what it said before. */
export function bumpManifest(text, version, sha256, force) {
  const from = readManifest(text);
  checkNewer(MANIFEST_FILE, from.version, version, force);
  const out = text
    .replace(VERSION_FIELD, () => `    "version": "${version}",`)
    .replace(URL_FIELD, () => `    "url": "${zipUrl(version)}",`)
    .replace(HASH_FIELD, () => `    "hash": "${sha256}",`);
  return { text: out, from };
}

// winget (#96): the identity and file names of the multi-file manifest in
// packaging/winget/, written where winget-pkgs keeps them
// (manifests/<first letter>/<publisher>/<package>/<version>/, doc/Authoring.md
// in github.com/microsoft/winget-pkgs), so `wingetcreate submit` takes the folder.
const WINGET_ID = "paureis.cloudpin";
const WINGET_TEMPLATES = new URL("../packaging/winget/", import.meta.url);
const WINGET_FILES = [`${WINGET_ID}.yaml`, `${WINGET_ID}.installer.yaml`, `${WINGET_ID}.locale.en-US.yaml`];
const wingetDir = (out, version) => join(out, "manifests", "p", "paureis", "cloudpin", version);

function readWingetTemplates() {
  return Object.fromEntries(
    WINGET_FILES.map((file) => {
      try {
        return [file, readFileSync(new URL(file, WINGET_TEMPLATES), "utf8")];
      } catch {
        throw new Error(`can't read packaging/winget/${file}: run this script from a cloudpin checkout`);
      }
    }),
  );
}

/**
 * The three winget manifests for `version`, from the templates: __VERSION__,
 * __SHA256__ (uppercase, as winget-pkgs' manifests and `winget hash` write it)
 * and __RELEASE_DATE__ filled in. Throws unless every placeholder is filled
 * and each file parses as YAML for this package and version.
 */
export function renderWinget(templates, { version, sha256, releaseDate }) {
  const fill = [
    ["__VERSION__", version],
    ["__SHA256__", sha256.toUpperCase()],
    ["__RELEASE_DATE__", releaseDate],
  ];
  const out = {};
  for (const file of WINGET_FILES) {
    const template = templates[file];
    if (typeof template !== "string") throw new Error(`packaging/winget/${file} is missing`);
    let text = template;
    for (const [placeholder, value] of fill) text = text.split(placeholder).join(value);
    const left = /__[A-Z0-9_]+__/.exec(text);
    if (left) throw new Error(`${file}: ${left[0]} is not filled in`);
    let doc;
    try {
      doc = parse(text);
    } catch (err) {
      throw new Error(`${file} is not valid YAML: ${err instanceof Error ? err.message : String(err)}`);
    }
    const id = doc?.PackageIdentifier;
    if (id !== WINGET_ID) throw new Error(`${file}: PackageIdentifier is ${id}, not ${WINGET_ID}`);
    if (doc.PackageVersion !== version) throw new Error(`${file}: PackageVersion is ${doc.PackageVersion}, not ${version}`);
    out[file] = text;
  }
  return out;
}

/** The GitHub Release's published date (UTC), YYYY-MM-DD, from the public API. */
async function releaseDateOf(version, fetchImpl) {
  const url = releaseApi(version);
  const res = await download(url, fetchImpl, `; is the v${version} GitHub Release published? Otherwise pass --date YYYY-MM-DD`);
  let published;
  try {
    published = JSON.parse(await res.text())?.published_at;
  } catch {
    published = undefined;
  }
  const date = typeof published === "string" ? published.slice(0, 10) : "";
  if (!isDate(date)) {
    throw new Error(`the GitHub Release v${version} has no published date (${url}); publish it, or pass --date YYYY-MM-DD`);
  }
  return date;
}

/* One entry per installer. */
const TARGETS = [
  {
    option: "--tap",
    key: "tap",
    file: join("Formula", "cloudpin.rb"),
    asset: (version) => `cloudpin-${version}.tgz`,
    // What the formula's url downloads, checked against the asset's sha256 before writing.
    source: registryUrl,
    notFound: "; the npm version may still be awaiting approval on npmjs.com (Staged Packages)",
    current: (text) => readFormula(text).version,
    rewrite: bumpFormula,
  },
  {
    option: "--bucket",
    key: "bucket",
    file: MANIFEST_FILE,
    asset: zipAsset,
    // The manifest's url is the release asset itself.
    source: zipUrl,
    notFound: "; check the release's assets (release.yml uploads the zip with the tarball from 1.2.0 on)",
    current: (text) => readManifest(text).version,
    rewrite: bumpManifest,
  },
];

const USAGE =
  "usage: node scripts/bump-installers.mjs <version> [--tap <path-to-homebrew-tap>] [--bucket <path-to-scoop-bucket>]" +
  " [--winget <out-dir> [--date YYYY-MM-DD]] [--force]";

/** `<version> --tap <path> [--force]`, in any order. */
export function parseArgs(argv) {
  const out = { force: false };
  const versions = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const target = TARGETS.find((t) => t.option === arg);
    if (target || arg === "--winget") {
      const value = argv[++i];
      if (value === undefined || value.startsWith("--")) throw new Error(`${arg} needs a path\n${USAGE}`);
      out[target ? target.key : "winget"] = value;
    } else if (arg === "--date") {
      const value = argv[++i];
      if (value === undefined || value.startsWith("--")) throw new Error(`--date needs a YYYY-MM-DD date\n${USAGE}`);
      if (!isDate(value)) throw new Error(`--date must be YYYY-MM-DD, a real date: ${value}`);
      out.date = value;
    } else if (arg === "--force") {
      out.force = true;
    } else if (arg.startsWith("--")) {
      throw new Error(`unknown option ${arg}\n${USAGE}`);
    } else {
      versions.push(arg);
    }
  }
  if (versions.length === 0) throw new Error(USAGE);
  if (versions.length > 1) throw new Error(`give one version, not ${versions.join(" ")}\n${USAGE}`);
  if (!VERSION.test(versions[0])) throw new Error(`the version must be x.y.z (no "v", no pre-release): ${versions[0]}`);
  if (!TARGETS.some((t) => out[t.key] !== undefined) && out.winget === undefined) {
    throw new Error(`give at least one of ${TARGETS.map((t) => `${t.option} <path>`).join(", ")}, --winget <dir>\n${USAGE}`);
  }
  if (out.date !== undefined && out.winget === undefined) throw new Error(`--date only applies to --winget\n${USAGE}`);
  return { version: versions[0], ...out };
}

/** The response for `url`; `notFound` is added to the error for an HTTP 404. */
async function download(url, fetchImpl, notFound = "") {
  let res;
  try {
    res = await fetchImpl(url);
  } catch (err) {
    throw new Error(`could not download ${url}: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!res.ok) throw new Error(`could not download ${url}: HTTP ${res.status}${res.status === 404 ? notFound : ""}`);
  return res;
}

/**
 * Refuses unless the file the installer will download has the sha256 that
 * SHA256SUMS lists: the formula's url is the npm registry tarball, which 404s
 * until the owner approves the staged version on npmjs.com; the manifest's is
 * the release's Windows zip. `notFound` explains a 404.
 */
async function checkSource(url, sha, fetchImpl, notFound) {
  const res = await download(url, fetchImpl, notFound);
  const got = createHash("sha256").update(new Uint8Array(await res.arrayBuffer())).digest("hex");
  if (got !== sha) throw new Error(`${url} has sha256 ${got}, but SHA256SUMS says ${sha}; nothing was written`);
}

/**
 * Checks every requested installer file (and that winget's version folder is
 * empty) first, then downloads SHA256SUMS once, checks each installer's
 * download against it, then writes. Returns one line per change.
 */
export async function bumpInstallers(opts, fetchImpl = fetch) {
  const { version } = opts;
  const chosen = TARGETS.filter((t) => opts[t.key] !== undefined).map((t) => {
    const path = join(opts[t.key], t.file);
    let text;
    try {
      text = readFileSync(path, "utf8");
    } catch {
      throw new Error(`can't read ${path}: is ${opts[t.key]} a checkout of the installer's repository?`);
    }
    checkNewer(t.file, t.current(text), version, opts.force);
    return { t, path, text };
  });
  let winget;
  if (opts.winget !== undefined) {
    const dir = wingetDir(opts.winget, version);
    const templates = readWingetTemplates();
    if (!opts.force && existsSync(dir) && readdirSync(dir).length > 0) {
      throw new Error(`${dir} already has files (pass --force to write the same version again)`);
    }
    winget = { dir, templates };
  }
  const sums = await (await download(sumsUrl(version), fetchImpl)).text();
  const planned = chosen.map(({ t, path, text }) => {
    const sha = shaFor(sums, t.asset(version));
    return { t, path, sha, ...t.rewrite(text, version, sha, opts.force) };
  });
  if (winget) {
    winget.sha = shaFor(sums, exeAsset(version));
    winget.releaseDate = opts.date ?? (await releaseDateOf(version, fetchImpl));
    winget.files = renderWinget(winget.templates, { version, sha256: winget.sha, releaseDate: winget.releaseDate });
  }
  for (const p of planned) await checkSource(p.t.source(version), p.sha, fetchImpl, p.t.notFound);
  if (winget) {
    await checkSource(exeUrl(version), winget.sha, fetchImpl, "; check the release's assets (release.yml uploads the exe zip from 1.3.0 on)");
  }
  const lines = [];
  for (const p of planned) {
    writeFileSync(p.path, p.text);
    lines.push(
      `${p.path}:`,
      `  version ${p.from.version} -> ${version}`,
      `  sha256  ${p.from.sha256} -> ${p.sha}`,
    );
  }
  if (winget) {
    mkdirSync(winget.dir, { recursive: true });
    for (const [file, text] of Object.entries(winget.files)) writeFileSync(join(winget.dir, file), text);
    lines.push(
      `${winget.dir}:`,
      `  ${Object.keys(winget.files).join(", ")}`,
      `  version ${version}, sha256 ${winget.sha.toUpperCase()}, release date ${winget.releaseDate}`,
    );
  }
  return lines;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const opts = parseArgs(process.argv.slice(2));
    for (const line of await bumpInstallers(opts)) console.log(line);
  } catch (err) {
    console.error(`bump-installers: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}
