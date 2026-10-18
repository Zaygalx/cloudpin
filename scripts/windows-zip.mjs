// Builds the Windows zip that the Scoop bucket installs (#17;
// docs/superpowers/specs/2026-10-17-installers-design.md):
//   node scripts/windows-zip.mjs <cloudpin-X.Y.Z.tgz> <out-dir>
// writes <out-dir>/cloudpin-X.Y.Z-windows.zip holding, at the zip root, the
// files of the npm-packed tarball (dist, package.json, README, LICENSE...),
// and the production node_modules installed from this repository's
// package-lock.json. There is no launcher: the bucket's manifest makes Scoop's
// exe shim run nodejs-lts's node.exe with dist\cli.js (a .cmd launcher would
// let cmd.exe re-parse every argument; see the installers design).
//
// It runs the same on ubuntu-latest (release.yml) and on Windows, so it needs
// no tar or zip program: Node's zlib reads the tarball and writes the zip.
// Entries are sorted and carry one fixed timestamp, so two runs give the same
// file list (and, with the same zlib, the same bytes).
import spawn from "cross-spawn";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync, lstatSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { crc32, deflateRawSync, gunzipSync } from "node:zlib";

const TARBALL = /^cloudpin-(\d+\.\d+\.\d+)\.tgz$/;

/** The zip's name for a version. */
export const zipName = (version) => `cloudpin-${version}-windows.zip`;

/** A NUL-terminated field of a tar header. */
function field(block, start, length) {
  const bytes = block.subarray(start, start + length);
  const end = bytes.indexOf(0);
  return new TextDecoder().decode(end === -1 ? bytes : bytes.subarray(0, end));
}

/**
 * The `path` record of a pax extended header ("<len> path=<value>\n" records), if any.
 * Each <len> counts the record's bytes, so the records are split on the bytes and
 * only the value is decoded as UTF-8 (POSIX pax, "pax Extended Header").
 */
function paxPath(data) {
  const bytes = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  let i = 0;
  while (i < bytes.length) {
    const space = bytes.indexOf(0x20, i);
    if (space === -1) break;
    const len = Number(bytes.subarray(i, space).toString("latin1"));
    if (!Number.isInteger(len) || len <= 0) throw new Error("tarball: a pax header record has no valid length");
    const record = bytes.subarray(space + 1, i + len - 1);
    if (record.subarray(0, 5).toString("latin1") === "path=") return new TextDecoder().decode(record.subarray(5));
    i += len;
  }
  return undefined;
}

/**
 * The regular files of a gzipped tarball, as { path, data }. Directories are
 * skipped; links and any other entry type are refused (npm pack makes neither).
 * Reads ustar headers, pax `path` records and GNU long names, and checks each
 * header's checksum.
 */
export function readTarGz(gz) {
  const tar = gunzipSync(gz);
  const files = [];
  let longName;
  for (let off = 0; off + 512 <= tar.length; ) {
    const header = tar.subarray(off, off + 512);
    if (header.every((b) => b === 0)) break;
    const stored = parseInt(field(header, 148, 8).trim(), 8);
    let sum = 0;
    for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 32 : header[i];
    if (stored !== sum) throw new Error(`tarball: bad header checksum at byte ${off}`);
    const size = parseInt(field(header, 124, 12).trim() || "0", 8);
    const type = String.fromCharCode(header[156] || 48);
    const data = tar.subarray(off + 512, off + 512 + size);
    off += 512 + Math.ceil(size / 512) * 512;
    if (type === "x") {
      longName = paxPath(data) ?? longName;
      continue;
    }
    if (type === "L") {
      longName = field(data, 0, data.length);
      continue;
    }
    if (type === "g") continue;
    const prefix = field(header, 345, 155);
    const name = longName ?? (prefix ? `${prefix}/${field(header, 0, 100)}` : field(header, 0, 100));
    longName = undefined;
    if (type === "5") continue;
    if (type !== "0") throw new Error(`tarball: ${name} is not a regular file (type ${type})`);
    files.push({ path: name, data: Uint8Array.from(data) });
  }
  return files;
}

// 1985-10-26 08:15:00, the timestamp npm pack gives every entry, in MS-DOS form.
const DOS_TIME = (8 << 11) | (15 << 5);
const DOS_DATE = ((1985 - 1980) << 9) | (10 << 5) | 26;

/**
 * A zip of `entries` ({ name, data }, names with forward slashes), sorted by
 * name, deflated, all with one timestamp. No zip64: refuses 65535 entries or
 * 4 GiB. Names that are not ASCII get the UTF-8 flag (APPNOTE 4.4.4, bit 11).
 */
export function writeZip(entries) {
  const sorted = [...entries].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].name === sorted[i - 1].name) throw new Error(`zip: ${sorted[i].name} is listed twice`);
  }
  if (sorted.length >= 0xffff) throw new Error("zip: too many entries for a zip without zip64");
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const { name, data } of sorted) {
    if (name.includes("\\") || name.startsWith("/") || name.split("/").includes("..")) {
      throw new Error(`zip: unsafe entry name ${name}`);
    }
    const nameBytes = new TextEncoder().encode(name);
    const flags = /^[\x20-\x7e]*$/.test(name) ? 0 : 0x0800;
    const packed = deflateRawSync(data, { level: 9 });
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed: 2.0 (deflate)
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4); // made by: MS-DOS (0), spec 2.0
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(DOS_TIME, 12);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(packed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    // extra, comment, disk, internal and external attributes: 0
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBytes, packed);
    centrals.push(central, nameBytes);
    offset += local.length + nameBytes.length + packed.length;
  }
  const cdSize = centrals.reduce((n, b) => n + b.length, 0);
  if (offset + cdSize >= 0xffffffff) throw new Error("zip: too large for a zip without zip64");
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(sorted.length, 8);
  end.writeUInt16LE(sorted.length, 10);
  end.writeUInt32LE(cdSize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, ...centrals, end]);
}

/** Every regular file under `dir`, as { name, data } with names relative to `under` and forward slashes. */
function filesUnder(dir, under) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    const stat = lstatSync(path);
    if (stat.isDirectory()) out.push(...filesUnder(path, under));
    else if (stat.isFile()) out.push({ name: relative(under, path).split(sep).join("/"), data: readFileSync(path) });
    else throw new Error(`${path} is neither a file nor a folder (a link?); refusing to zip it`);
  }
  return out;
}

/**
 * `npm ci --omit=dev --ignore-scripts --no-bin-links` in `dir`, which holds
 * package.json and package-lock.json. No install scripts run, and no
 * node_modules/.bin is made (its links and shims are per platform and
 * cloudpin never uses them).
 */
export function npmCi(dir) {
  const args = ["ci", "--omit=dev", "--ignore-scripts", "--no-bin-links", "--no-audit", "--no-fund"];
  const res = spawn.sync("npm", args, { cwd: dir, stdio: ["ignore", "inherit", "inherit"] });
  if (res.error) throw new Error(`could not run npm: ${res.error.message}`);
  if (res.status !== 0) throw new Error(`npm ${args.join(" ")} failed with exit code ${res.status}`);
}

/**
 * Builds the zip for `tarball` into `outDir` and returns its path and entry
 * names. `install(dir)` installs the production dependencies into
 * `dir/node_modules` from the package.json and package-lock.json there.
 */
export function buildWindowsZip({ tarball, outDir, lockfile, install = npmCi }) {
  const m = TARBALL.exec(basename(tarball));
  if (!m) throw new Error(`expected an npm-packed cloudpin-X.Y.Z.tgz, got ${basename(tarball)}`);
  const version = m[1];
  const files = readTarGz(readFileSync(tarball)).map(({ path, data }) => {
    if (!path.startsWith("package/")) throw new Error(`tarball: ${path} is outside package/`);
    return { name: path.slice("package/".length), data };
  });
  const pkgFile = files.find((f) => f.name === "package.json");
  if (!pkgFile) throw new Error("tarball: no package/package.json");
  const pkg = JSON.parse(new TextDecoder().decode(pkgFile.data));
  if (pkg.version !== version) throw new Error(`tarball: package.json says ${pkg.version}, the file name ${version}`);
  if (!files.some((f) => f.name === "dist/cli.js")) throw new Error("tarball: no package/dist/cli.js");
  if (files.some((f) => f.name.startsWith("node_modules/"))) {
    throw new Error("tarball: already has node_modules");
  }

  const staging = mkdtempSync(join(tmpdir(), "cloudpin-windows-zip-"));
  try {
    writeFileSync(join(staging, "package.json"), pkgFile.data);
    writeFileSync(join(staging, "package-lock.json"), readFileSync(lockfile));
    install(staging);
    const modules = join(staging, "node_modules");
    if (!statSync(modules, { throwIfNoEntry: false })?.isDirectory()) throw new Error("the install made no node_modules");
    // npm's own record of the tree, which only speeds up later npm runs.
    const deps = filesUnder(modules, staging).filter((f) => f.name !== "node_modules/.package-lock.json");
    const entries = [...files, ...deps];
    mkdirSync(outDir, { recursive: true });
    const zipPath = join(outDir, zipName(version));
    writeFileSync(zipPath, writeZip(entries));
    return { zipPath, names: entries.map((e) => e.name).sort() };
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [tarball, outDir, ...rest] = process.argv.slice(2);
  if (!tarball || !outDir || rest.length > 0) {
    console.error("usage: node scripts/windows-zip.mjs <cloudpin-X.Y.Z.tgz> <out-dir>");
    process.exit(1);
  }
  try {
    const lockfile = fileURLToPath(new URL("../package-lock.json", import.meta.url));
    const { zipPath, names } = buildWindowsZip({ tarball, outDir, lockfile });
    console.log(`${zipPath}: ${names.length} files`);
  } catch (err) {
    console.error(`windows-zip: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}
