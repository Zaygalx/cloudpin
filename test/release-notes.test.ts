import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { releaseNotes } from "../scripts/release-notes.mjs";

const CHANGELOG = `# Changelog

## [Unreleased]

## [0.4.0] - 2026-10-10

Signed releases.

### Added

- GitHub Releases with provenance (#53).

## [0.3.1] - 2026-10-09

### Added

- An update notice (#50).
`;

describe("releaseNotes", () => {
  it("takes the version's CHANGELOG section, without its heading, and adds how to verify the download", () => {
    const notes = releaseNotes(CHANGELOG, "0.4.0");
    expect(notes.startsWith("Signed releases.\n\n### Added\n\n- GitHub Releases with provenance (#53).")).toBe(true);
    expect(notes).not.toContain("0.3.1");
    expect(notes).not.toContain("## [0.4.0]");
    expect(notes).toContain("gh attestation verify cloudpin-0.4.0.tgz --repo paureis/cloudpin");
    expect(notes).toContain("gh attestation verify cloudpin-0.4.0-windows.zip --repo paureis/cloudpin");
    expect(notes).toContain("sha256sum -c --ignore-missing SHA256SUMS");
    expect(notes).toContain("npm view cloudpin@0.4.0 dist.integrity");
  });

  it.each(["0.4.0", "10.12.3-beta.1"])("lines up the comments in the verify block for %s", (version) => {
    const changelog = `## [${version}] - 2026-10-10\n\nNotes.\n`;
    const block = (releaseNotes(changelog, version).split("```sh\n")[1] ?? "").split("\n```")[0]!.split("\n");
    expect(block).toHaveLength(4);
    const columns = block.map((line) => line.indexOf("  # "));
    expect(columns.every((c) => c > 0 && c === columns[0])).toBe(true);
  });

  it("reads the last section to the end of the file", () => {
    expect(releaseNotes(CHANGELOG, "0.3.1")).toMatch(/^### Added\n\n- An update notice \(#50\)\./);
  });

  it("refuses a version the CHANGELOG has no entry for", () => {
    expect(() => releaseNotes(CHANGELOG, "9.9.9")).toThrow(/no CHANGELOG entry for 9\.9\.9/);
  });

  it("works on the real CHANGELOG for the current version", () => {
    const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
    expect(releaseNotes(readFileSync(new URL("../CHANGELOG.md", import.meta.url), "utf8"), version).length).toBeGreaterThan(100);
  });
});
