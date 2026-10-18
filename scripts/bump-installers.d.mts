export interface BumpOptions {
  version: string;
  force: boolean;
  /** A checkout of paureis/homebrew-tap. */
  tap?: string;
}

/** `<version> --tap <path> [--force]`; throws with the usage on anything else. */
export function parseArgs(argv: string[]): BumpOptions;

/** The sha256 of `asset` in a SHA256SUMS file; throws if missing or not 64 hex characters. */
export function shaFor(sums: string, asset: string): string;

/** The formula rewritten for `version`, and its version and sha256 before. */
export function bumpFormula(
  text: string,
  version: string,
  sha256: string,
  force: boolean,
): { text: string; from: { version: string; sha256: string } };

/**
 * Rewrites each requested installer from the release's SHA256SUMS, after checking that the file the installer
 * downloads (the npm registry tarball) has that sha256; writes nothing otherwise. Returns one line per change.
 */
export function bumpInstallers(opts: BumpOptions, fetchImpl?: typeof fetch): Promise<string[]>;
