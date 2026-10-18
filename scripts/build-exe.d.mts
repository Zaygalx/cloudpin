/** `cloudpin-<version>-win-x64.zip`. */
export function exeZipName(version: string): string;

/** The pinned Node version from exe-node-version.txt's text; throws unless it is one exact X.Y.Z, 25.7 or later. */
export function readExeNodeVersion(text: string): string;

/** The official Node file under nodejs.org/dist/v<version>/ for a platform and arch, and the binary inside a tarball. */
export function nodeAsset(platform: string, arch: string, version: string): { file: string; member?: string };

/** SHASUMS256.txt as file -> lowercase sha256; throws on a line that isn't `<sha256>  <file>`. */
export function parseShasums(text: string): Map<string, string>;

/** Downloads `file` of Node `version` from nodejs.org/dist into `cacheDir`, checked against SHASUMS256.txt; returns its path. */
export function fetchVerified(version: string, file: string, cacheDir: string, fetchImpl?: typeof fetch): Promise<string>;

/** The --build-sea configuration: an ESM main, code cache and snapshot off, no experimental warning. */
export function seaConfig(opts: { main: string; executable: string; output: string }): Record<string, unknown>;

/** `entry` and all it imports as one ES module, with CLOUDPIN_BUNDLED_VERSION replaced by `version`. */
export function bundle(entry: string, version: string): Promise<string>;

/** Throws unless the bundle names `version`, doesn't read package.json and loads only built-in modules. */
export function checkBundle(code: string, version: string): void;

/** Writes `<outDir>/cloudpin-<version>-win-x64.zip` with cloudpin.exe and LICENSE; returns its path. */
export function writeExeZip(opts: { exe: string; license: string; version: string; outDir: string }): Promise<string>;

/** The newest security release of `pinned`'s major line newer than it, from nodejs.org/dist/index.json, or null. */
export function newerSecurityRelease(index: { version: string; security?: boolean }[], pinned: string): string | null;

/** Bundles dist/cli.js, builds cloudpin.exe with the pinned Node and zips it into `outDir`. */
export function buildExe(opts: { outDir: string; cacheDir?: string }): Promise<{ zipPath: string; exeSize: number; nodeVersion: string }>;
