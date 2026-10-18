/** `cloudpin-<version>-windows.zip`. */
export function zipName(version: string): string;

/** The regular files of a gzipped tarball; throws on links, other entry types or a bad header checksum. */
export function readTarGz(gz: Uint8Array): { path: string; data: Uint8Array }[];

/** A deterministic zip of `entries` (sorted, deflated, one timestamp); throws on duplicate or unsafe names. */
export function writeZip(entries: { name: string; data: Uint8Array }[]): Buffer;

/** `npm ci --omit=dev --ignore-scripts --no-bin-links` in `dir`. */
export function npmCi(dir: string): void;

/** Builds `<outDir>/cloudpin-X.Y.Z-windows.zip` from an npm-packed tarball; returns its path and sorted entry names. */
export function buildWindowsZip(opts: {
  tarball: string;
  outDir: string;
  lockfile: string;
  install?: (dir: string) => void;
}): { zipPath: string; names: string[] };
