// Builds the standalone Windows cloudpin.exe that winget installs (#96;
// docs/superpowers/specs/2026-10-18-winget-design.md):
//   npm run build
//   node scripts/build-exe.mjs <out-dir> [--node-cache <dir>]
// writes <out-dir>/cloudpin-X.Y.Z-win-x64.zip holding cloudpin.exe and LICENSE.
// cloudpin.exe is a Node single executable application (SEA): dist/cli.js,
// yaml and cross-spawn bundled into one ES module by rolldown, injected into
// the official win-x64 node.exe of the Node version pinned in
// scripts/exe-node-version.txt, by `node --build-sea` of that same version
// (nodejs.org/api/single-executable-applications.html: the blob's Node must be
// the one it is injected into; cross-platform builds need code cache and
// snapshot off). Every Node file comes from nodejs.org/dist and is used only
// when its sha256 matches both that release's SHASUMS256.txt and the value
// recorded in scripts/exe-node-sha256.txt when the pin was set, so a file
// swapped on nodejs.org later, SHASUMS256.txt and all, fails the build.
//
// It runs the same on ubuntu-latest (release.yml, where it fetches the
// linux-x64 node to run --build-sea) and on Windows (Nightly, where the
// win-x64 node.exe builds itself). Those are the two recorded files
// (exeNodeFiles); a build that needs any other Node file fails closed.
//
//   node scripts/build-exe.mjs --node-version      prints the pinned version
//   node scripts/build-exe.mjs --security-release  prints a newer security release of the pinned major, if any
//   node scripts/build-exe.mjs --print-hashes      prints exe-node-sha256.txt for the pinned version
// Those need no npm install (Nightly runs the second in a job without one),
// so the packages are imported only by the functions that build.
//
// Bumping the Node pin is one step: write the new X.Y.Z to exe-node-version.txt,
// then `node scripts/build-exe.mjs --print-hashes > scripts/exe-node-sha256.txt`,
// and before committing compare the two values with the release's GPG-signed
// SHASUMS256.txt.asc (github.com/nodejs/node#verifying-binaries).
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { builtinModules } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const DIST = "https://nodejs.org/dist";
const VERSION_FILE = fileURLToPath(new URL("./exe-node-version.txt", import.meta.url));
const SHA256_FILE = fileURLToPath(new URL("./exe-node-sha256.txt", import.meta.url));
const REPO = fileURLToPath(new URL("..", import.meta.url));

/** The zip's name for a cloudpin version. */
export const exeZipName = (version) => `cloudpin-${version}-win-x64.zip`;

const parse = (v) => v.split(".").map(Number);
/** Negative, zero or positive as `a` is older than, the same as or newer than `b` (X.Y.Z). */
const compare = (a, b) => {
  const [x, y] = [parse(a), parse(b)];
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
};

/**
 * The pinned Node version from exe-node-version.txt's text: one exact X.Y.Z,
 * at least 25.7 (--build-sea came in 25.5, an ESM main in 25.7).
 */
export function readExeNodeVersion(text) {
  const version = text.trim();
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`exe-node-version.txt: expected one exact X.Y.Z, got ${JSON.stringify(text)}`);
  if (compare(version, "25.7.0") < 0) throw new Error(`exe-node-version.txt: ${version} has no --build-sea with an ESM main (25.7 or later)`);
  return version;
}

/** The official Node file under nodejs.org/dist/v<version>/ that runs on `platform`-`arch`, and the binary inside a tarball. */
export function nodeAsset(platform, arch, version) {
  if (platform === "win32" && arch === "x64") return { file: "win-x64/node.exe" };
  const os = { linux: "linux", darwin: "darwin" }[platform];
  if (!os || !["x64", "arm64"].includes(arch)) throw new Error(`no official Node build is used for ${platform}-${arch}`);
  const base = `node-v${version}-${os}-${arch}`;
  return { file: `${base}.tar.gz`, member: `${base}/bin/node` };
}

/** SHASUMS256.txt's `<sha256>  <file>` lines, as file -> lowercase sha256. */
export function parseShasums(text) {
  const sums = new Map();
  for (const line of text.split(/\r?\n/)) {
    if (line.trim() === "") continue;
    const m = /^([0-9a-fA-F]{64}) {2}(\S+)$/.exec(line);
    if (!m) throw new Error(`SHASUMS256.txt: unexpected line ${JSON.stringify(line)}`);
    sums.set(m[2], m[1].toLowerCase());
  }
  return sums;
}

const sha256 = (data) => createHash("sha256").update(data).digest("hex");

/** `url`'s body; with `timeoutMs`, the request and the body together must finish in that time. */
async function download(fetchImpl, url, timeoutMs) {
  const init = timeoutMs ? { signal: AbortSignal.timeout(timeoutMs) } : undefined;
  try {
    const res = await fetchImpl(url, init);
    if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
    return new Uint8Array(await res.arrayBuffer());
  } catch (err) {
    if (init?.signal.aborted) throw new Error(`${url}: no response in ${timeoutMs / 1000} s`);
    throw err;
  }
}

/** The Node files of `version` cloudpin.exe is built from, whose sha256 exe-node-sha256.txt records. */
export function exeNodeFiles(version) {
  return [nodeAsset("win32", "x64", version).file, nodeAsset("linux", "x64", version).file];
}

/**
 * The sha256 recorded for `file` of Node `version` in exe-node-sha256.txt's
 * `text`: `<sha256>  v<version>/<file>` lines (`#` comments and blank lines
 * allowed). Throws when there is none, so a build fails closed.
 */
export function recordedSha256(text, version, file) {
  const want = `v${version}/${file}`;
  let found;
  for (const line of text.split(/\r?\n/)) {
    if (line.trim() === "" || line.startsWith("#")) continue;
    const m = /^([0-9a-fA-F]{64}) {2}(\S+)$/.exec(line);
    if (!m) throw new Error(`exe-node-sha256.txt: unexpected line ${JSON.stringify(line)}`);
    if (m[2] !== want) continue;
    if (found) throw new Error(`exe-node-sha256.txt: ${want} is there twice`);
    found = m[1].toLowerCase();
  }
  if (!found) throw new Error(`exe-node-sha256.txt has no sha256 for ${want}; run node scripts/build-exe.mjs --print-hashes`);
  return found;
}

/** exe-node-sha256.txt's text for Node `version`, from that release's SHASUMS256.txt (the pin's bump step). */
export async function printHashes(version, fetchImpl = fetch) {
  const sums = parseShasums(new TextDecoder().decode(await download(fetchImpl, `${DIST}/v${version}/SHASUMS256.txt`, 20000)));
  const lines = exeNodeFiles(version).map((file) => {
    const sum = sums.get(file);
    if (!sum) throw new Error(`${file} is not in SHASUMS256.txt of Node ${version}`);
    return `${sum}  v${version}/${file}`;
  });
  return [
    "# sha256 of the Node files cloudpin.exe is built from (scripts/build-exe.mjs), from nodejs.org/dist/v<version>/SHASUMS256.txt.",
    "# Regenerate with: node scripts/build-exe.mjs --print-hashes > scripts/exe-node-sha256.txt",
    "# after bumping exe-node-version.txt, and compare with the release's signed SHASUMS256.txt.asc before committing.",
    ...lines,
    "",
  ].join("\n");
}

/**
 * `file` of Node `version`, from nodejs.org/dist into `cacheDir`. Used only
 * when its sha256 is `recorded` (exe-node-sha256.txt) and that release's
 * SHASUMS256.txt says the same; any mismatch throws. A cached copy is used only
 * when its sha256 still matches; otherwise it is downloaded again. Returns its path.
 */
export async function fetchVerified(version, file, cacheDir, recorded, fetchImpl = fetch) {
  if (typeof recorded !== "string" || !/^[0-9a-fA-F]{64}$/.test(recorded)) {
    throw new Error(`${file}: the recorded sha256 ${JSON.stringify(recorded)} is not a sha256 (exe-node-sha256.txt)`);
  }
  const base = `${DIST}/v${version}`;
  const sums = parseShasums(new TextDecoder().decode(await download(fetchImpl, `${base}/SHASUMS256.txt`)));
  const expected = sums.get(file);
  if (!expected) throw new Error(`${file} is not in SHASUMS256.txt of Node ${version}`);
  if (expected !== recorded.toLowerCase()) {
    throw new Error(`${file}: SHASUMS256.txt of Node ${version} says ${expected}, but exe-node-sha256.txt recorded ${recorded.toLowerCase()}`);
  }
  const path = join(cacheDir, `v${version}`, ...file.split("/"));
  if (existsSync(path) && sha256(readFileSync(path)) === expected) return path;
  const data = await download(fetchImpl, `${base}/${file}`);
  const actual = sha256(data);
  if (actual !== expected) throw new Error(`${file}: sha256 ${actual} does not match SHASUMS256.txt (${expected})`);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, data);
  return path;
}

/** The --build-sea configuration (the docs' "Generating single executable applications with --build-sea"). */
export function seaConfig({ main, executable, output }) {
  return {
    main,
    mainFormat: "module",
    executable,
    output,
    disableExperimentalSEAWarning: true,
    useSnapshot: false,
    useCodeCache: false,
  };
}

/**
 * `entry` and everything it imports, packages included, as one ES module for
 * Node 26, with CLOUDPIN_BUNDLED_VERSION replaced by `version` (src/version.ts).
 * Top-level await stays: the SEA's main is an ES module.
 */
export async function bundle(entry, version) {
  const { rolldown } = await import("rolldown");
  const build = await rolldown({
    input: entry,
    platform: "node",
    logLevel: "warn",
    transform: { target: "node26", define: { CLOUDPIN_BUNDLED_VERSION: JSON.stringify(version) } },
  });
  try {
    const { output } = await build.generate({ format: "esm", codeSplitting: false });
    if (output.length !== 1 || output[0].type !== "chunk") throw new Error(`bundle: expected one chunk, got ${output.length} files`);
    return output[0].code;
  } finally {
    await build.close();
  }
}

const BUILTIN = new Set(builtinModules);

/**
 * Throws unless `code` can run as a SEA main: inside one, import and require
 * load only built-in modules and import.meta.url is the exe, so the bundle must
 * name `version` and must not read package.json or load any package.
 */
export function checkBundle(code, version) {
  if (code.includes("package.json")) throw new Error("bundle: still reads package.json (src/version.ts not inlined?)");
  if (!code.includes(JSON.stringify(version))) throw new Error(`bundle: version ${version} is not inlined`);
  // Static imports and re-exports start a line in rolldown's output (an example in a JSDoc comment, as yaml's
  // has, starts with `*`); calls are matched anywhere.
  const specifiers = /^(?:import|export)\b[^\n]*?\bfrom\s*["']([^"']+)["']|\bimport\s*\(\s*["']([^"']+)["']\s*\)|\b(?:__)?require\s*\(\s*["']([^"']+)["']\s*\)|^import\s*["']([^"']+)["']/gm;
  for (const m of code.matchAll(specifiers)) {
    const spec = m[1] ?? m[2] ?? m[3] ?? m[4];
    if (!spec.startsWith("node:") && !BUILTIN.has(spec)) throw new Error(`bundle: still loads "${spec}", which a SEA can't`);
  }
}

/** Writes <outDir>/cloudpin-<version>-win-x64.zip with cloudpin.exe and LICENSE; returns its path. */
export async function writeExeZip({ exe, license, version, outDir }) {
  const { writeZip } = await import("./windows-zip.mjs");
  mkdirSync(outDir, { recursive: true });
  const zipPath = join(outDir, exeZipName(version));
  writeFileSync(zipPath, writeZip([
    { name: "cloudpin.exe", data: readFileSync(exe) },
    { name: "LICENSE", data: readFileSync(license) },
  ]));
  return zipPath;
}

/** The newest `security: true` release in nodejs.org/dist/index.json of `pinned`'s major line that is newer than it, or null. */
export function newerSecurityRelease(index, pinned) {
  const major = parse(pinned)[0];
  const found = index
    .map((r) => ({ version: String(r.version).replace(/^v/, ""), security: r.security === true }))
    .filter((r) => /^\d+\.\d+\.\d+$/.test(r.version) && parse(r.version)[0] === major && r.security && compare(r.version, pinned) > 0)
    .sort((a, b) => compare(b.version, a.version));
  return found[0]?.version ?? null;
}

/**
 * The newest security release of `pinned`'s major line newer than it, from
 * nodejs.org/dist/index.json, or null. Nightly runs this in a job with a short
 * timeout, so a stalled nodejs.org fails here in `timeoutMs` instead.
 */
export async function securityRelease(pinned, fetchImpl = fetch, timeoutMs = 20000) {
  const index = JSON.parse(new TextDecoder().decode(await download(fetchImpl, `${DIST}/index.json`, timeoutMs)));
  return newerSecurityRelease(index, pinned);
}

async function run(bin, args, what) {
  const { default: spawn } = await import("cross-spawn");
  const res = spawn.sync(bin, args, { stdio: ["ignore", "inherit", "inherit"] });
  if (res.error) throw new Error(`${what}: ${res.error.message}`);
  if (res.status !== 0) throw new Error(`${what} failed with exit code ${res.status}`);
}

/** A node of the pinned version that runs here: this one, or the official build for this platform. */
async function builderNode(version, cacheDir, work, recorded) {
  if (process.version === `v${version}`) return process.execPath;
  const asset = nodeAsset(process.platform, process.arch, version);
  const path = await fetchVerified(version, asset.file, cacheDir, recordedSha256(recorded, version, asset.file));
  if (!asset.member) return path;
  // The tarball holds links (bin/npm and others), so only bin/node is taken, by tar (GNU tar on Linux, bsdtar on macOS).
  await run("tar", ["-xzf", path, "-C", work, asset.member], "tar");
  const node = join(work, ...asset.member.split("/"));
  chmodSync(node, 0o755);
  return node;
}

/** Builds the zip into `outDir`; returns its path, the exe's size and the pinned Node version. */
export async function buildExe({ outDir, cacheDir }) {
  const nodeVersion = readExeNodeVersion(readFileSync(VERSION_FILE, "utf8"));
  const recorded = readFileSync(SHA256_FILE, "utf8");
  const { version } = JSON.parse(readFileSync(join(REPO, "package.json"), "utf8"));
  const entry = join(REPO, "dist", "cli.js");
  if (!existsSync(entry)) throw new Error("no dist/cli.js; run npm run build first");
  const work = mkdtempSync(join(tmpdir(), "cloudpin-exe-"));
  try {
    const cache = cacheDir ?? join(work, "node");
    const code = await bundle(entry, version);
    checkBundle(code, version);
    const main = join(work, "cloudpin.mjs");
    writeFileSync(main, code);
    const executable = await fetchVerified(nodeVersion, "win-x64/node.exe", cache, recordedSha256(recorded, nodeVersion, "win-x64/node.exe"));
    const builder = await builderNode(nodeVersion, cache, work, recorded);
    const exe = join(work, "cloudpin.exe");
    const config = join(work, "sea-config.json");
    writeFileSync(config, `${JSON.stringify(seaConfig({ main, executable, output: exe }), null, 2)}\n`);
    await run(builder, ["--build-sea", config], "node --build-sea");
    const size = statSync(exe, { throwIfNoEntry: false })?.size ?? 0;
    if (size <= statSync(executable).size) throw new Error("node --build-sea wrote no larger exe than node.exe");
    const zipPath = await writeExeZip({ exe, license: join(REPO, "LICENSE"), version, outDir });
    return { zipPath, exeSize: size, nodeVersion };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

const USAGE = "usage: node scripts/build-exe.mjs <out-dir> [--node-cache <dir>] | --node-version | --security-release | --print-hashes";

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  try {
    if (args.length === 1 && args[0] === "--node-version") {
      console.log(readExeNodeVersion(readFileSync(VERSION_FILE, "utf8")));
    } else if (args.length === 1 && args[0] === "--security-release") {
      const pinned = readExeNodeVersion(readFileSync(VERSION_FILE, "utf8"));
      const newer = await securityRelease(pinned);
      if (newer) console.log(newer);
    } else if (args.length === 1 && args[0] === "--print-hashes") {
      process.stdout.write(await printHashes(readExeNodeVersion(readFileSync(VERSION_FILE, "utf8"))));
    } else {
      const [outDir, ...rest] = args;
      let cacheDir;
      if (rest.length === 2 && rest[0] === "--node-cache") cacheDir = resolve(rest[1]);
      else if (rest.length !== 0) throw new Error(USAGE);
      if (!outDir || outDir.startsWith("--")) throw new Error(USAGE);
      const { zipPath, exeSize, nodeVersion } = await buildExe({ outDir: resolve(outDir), cacheDir });
      console.log(`${zipPath}: cloudpin.exe ${exeSize} bytes, Node ${nodeVersion}`);
    }
  } catch (err) {
    console.error(`build-exe: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}
