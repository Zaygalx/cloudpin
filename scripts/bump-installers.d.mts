export interface BumpOptions {
  version: string;
  force: boolean;
  /** A checkout of paureis/homebrew-tap. */
  tap?: string;
  /** A checkout of paureis/scoop-bucket. */
  bucket?: string;
  /** A folder to render the winget manifests into, under manifests/p/paureis/cloudpin/<version>/. */
  winget?: string;
  /** winget's ReleaseDate, YYYY-MM-DD; without it, the GitHub Release's published date. */
  date?: string;
}

/**
 * `<version> [--tap <path>] [--bucket <path>] [--winget <dir> [--date YYYY-MM-DD]] [--force]`, at least one
 * installer; throws with the usage on anything else.
 */
export function parseArgs(argv: string[]): BumpOptions;

/**
 * The three winget manifests (file name -> text) rendered from packaging/winget/'s templates, the sha256 uppercase;
 * throws on a placeholder left over, a file that isn't YAML, or one for another package or version.
 */
export function renderWinget(
  templates: Record<string, string>,
  values: { version: string; sha256: string; releaseDate: string },
): Record<string, string>;

/** The sha256 of `asset` in a SHA256SUMS file; throws if missing or not 64 hex characters. */
export function shaFor(sums: string, asset: string): string;

/** The formula rewritten for `version`, and its version and sha256 before. */
export function bumpFormula(
  text: string,
  version: string,
  sha256: string,
  force: boolean,
): { text: string; from: { version: string; sha256: string } };

/** The Scoop manifest's version, url and hash lines rewritten for `version`, and its version and hash before. */
export function bumpManifest(
  text: string,
  version: string,
  sha256: string,
  force: boolean,
): { text: string; from: { version: string; sha256: string } };

/**
 * Rewrites each requested installer from the release's SHA256SUMS, and renders the winget manifests, after checking
 * that the file each installer downloads (the npm registry tarball, the release's Windows zip, the exe zip) has that
 * sha256; writes nothing otherwise. Returns one line per change.
 */
export function bumpInstallers(opts: BumpOptions, fetchImpl?: typeof fetch): Promise<string[]>;
