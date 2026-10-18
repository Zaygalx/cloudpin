// Release notes for a GitHub Release: the version's CHANGELOG section, plus how
// to check the download. Used by .github/workflows/release.yml:
//   node scripts/release-notes.mjs <version> > notes.md
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** The CHANGELOG section for `version` (without its heading) and verification steps. */
export function releaseNotes(changelog, version) {
  const lines = changelog.split(/\r?\n/);
  const start = lines.findIndex((l) => l.startsWith(`## [${version}]`));
  if (start === -1) throw new Error(`no CHANGELOG entry for ${version}`);
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => l.startsWith("## ["));
  const body = (end === -1 ? rest : rest.slice(0, end)).join("\n").trim();
  const tarball = `cloudpin-${version}.tgz`;
  const zip = `cloudpin-${version}-windows.zip`;
  const steps = [
    [`gh attestation verify ${tarball} --repo paureis/cloudpin`, "signed build provenance"],
    [`gh attestation verify ${zip} --repo paureis/cloudpin`, "the same, for the Scoop zip"],
    ["sha256sum -c --ignore-missing SHA256SUMS", "checksums of the files you downloaded"],
    [`npm view cloudpin@${version} dist.integrity`, "npm's sha512 for the same file"],
  ];
  // Pad to the longest command so the comments line up for any version length.
  const width = Math.max(...steps.map(([command]) => command.length));
  return [
    body,
    "",
    "### Verify this release",
    "",
    `\`${tarball}\` is the exact file npm serves (npm packs reproducibly), built and signed by this repository's`,
    "release workflow, as is " + "`" + zip + "`" + " (what the Scoop bucket installs: the same files plus their",
    "production node_modules). To check a download:",
    "",
    "```sh",
    ...steps.map(([command, comment]) => `${command.padEnd(width)}   # ${comment}`),
    "```",
    "",
  ].join("\n");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const version = process.argv[2];
  if (!version) {
    console.error("usage: node scripts/release-notes.mjs <version>");
    process.exit(1);
  }
  process.stdout.write(releaseNotes(readFileSync(new URL("../CHANGELOG.md", import.meta.url), "utf8"), version));
}
