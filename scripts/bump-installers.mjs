// Points the installers at a new release (#16; #17 adds the Scoop manifest).
// Run by the release session after the vX.Y.Z tag's GitHub Release exists:
//   node scripts/bump-installers.mjs <version> --tap <path-to-homebrew-tap-checkout> [--force]
// It reads the sha256 from the release's SHA256SUMS (the same file the release
// workflow attests), checks that the npm registry tarball the formula's url
// points at has that sha256 (so run it after the staged npm version is
// approved), and rewrites the formula's url and sha256 lines. It never
// commits or pushes: review the diff in the tap checkout, then push it.
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const VERSION = /^(\d+)\.(\d+)\.(\d+)$/;
const SHA256 = /^[0-9a-f]{64}$/;

const sumsUrl = (version) => `https://github.com/paureis/cloudpin/releases/download/v${version}/SHA256SUMS`;
const registryUrl = (version) => `https://registry.npmjs.org/cloudpin/-/cloudpin-${version}.tgz`;

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

/*
 * One entry per installer. #17 adds the Scoop bucket here: its option
 * (--bucket), its file (bucket/cloudpin.json), the release asset it points at
 * (cloudpin-X.Y.Z-windows.zip) and its read and rewrite functions.
 */
const TARGETS = [
  {
    option: "--tap",
    key: "tap",
    file: join("Formula", "cloudpin.rb"),
    asset: (version) => `cloudpin-${version}.tgz`,
    // What the formula's url downloads, checked against the asset's sha256 before writing.
    source: registryUrl,
    current: (text) => readFormula(text).version,
    rewrite: bumpFormula,
  },
];

const USAGE = "usage: node scripts/bump-installers.mjs <version> --tap <path-to-homebrew-tap> [--force]";

/** `<version> --tap <path> [--force]`, in any order. */
export function parseArgs(argv) {
  const out = { force: false };
  const versions = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const target = TARGETS.find((t) => t.option === arg);
    if (target) {
      const value = argv[++i];
      if (value === undefined || value.startsWith("--")) throw new Error(`${arg} needs a path\n${USAGE}`);
      out[target.key] = value;
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
  if (!TARGETS.some((t) => out[t.key] !== undefined)) {
    throw new Error(`give at least one of ${TARGETS.map((t) => `${t.option} <path>`).join(", ")}\n${USAGE}`);
  }
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
 * until the owner approves the staged version on npmjs.com.
 */
async function checkSource(url, sha, fetchImpl) {
  const res = await download(url, fetchImpl, "; the npm version may still be awaiting approval on npmjs.com (Staged Packages)");
  const got = createHash("sha256").update(new Uint8Array(await res.arrayBuffer())).digest("hex");
  if (got !== sha) throw new Error(`${url} has sha256 ${got}, but SHA256SUMS says ${sha}; nothing was written`);
}

/**
 * Checks every requested installer file first, then downloads SHA256SUMS
 * once, checks each installer's download against it, then writes. Returns
 * one line per change.
 */
export async function bumpInstallers(opts, fetchImpl = fetch) {
  const chosen = TARGETS.filter((t) => opts[t.key] !== undefined).map((t) => {
    const path = join(opts[t.key], t.file);
    let text;
    try {
      text = readFileSync(path, "utf8");
    } catch {
      throw new Error(`can't read ${path}: is ${opts[t.key]} a checkout of the installer's repository?`);
    }
    checkNewer(t.file, t.current(text), opts.version, opts.force);
    return { t, path, text };
  });
  const sums = await (await download(sumsUrl(opts.version), fetchImpl)).text();
  const planned = chosen.map(({ t, path, text }) => {
    const sha = shaFor(sums, t.asset(opts.version));
    return { t, path, sha, ...t.rewrite(text, opts.version, sha, opts.force) };
  });
  for (const p of planned) await checkSource(p.t.source(opts.version), p.sha, fetchImpl);
  const lines = [];
  for (const p of planned) {
    writeFileSync(p.path, p.text);
    lines.push(
      `${p.path}:`,
      `  version ${p.from.version} -> ${opts.version}`,
      `  sha256  ${p.from.sha256} -> ${p.sha}`,
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
