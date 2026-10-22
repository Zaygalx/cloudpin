import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Owner rule: every release updates the docs. Bumping package.json without
// them makes this fail, so the release PR can't go green with stale docs.
const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const { version } = JSON.parse(read("package.json")) as { version: string };
const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

describe(`docs for release ${version}`, () => {
  it("README names it as the latest release", () => {
    expect(read("README.md")).toContain(`**Latest release: ${version}**`);
  });

  it("CHANGELOG has its entry", () => {
    expect(read("CHANGELOG.md")).toMatch(new RegExp(`^## \\[${escapeRegExp(version)}\\] - \\d{4}-\\d{2}-\\d{2}$`, "m"));
  });

  it("ROADMAP lists it as shipped", () => {
    expect(read("ROADMAP.md")).toContain(`- **${version}**`);
  });

  // The MCP Registry listing (#111): the server and its npm package carry the release's version.
  it("server.json has it, for the server and its npm package", () => {
    const server = JSON.parse(read("server.json")) as { version: string; packages: { version: string }[] };
    expect(server.version).toBe(version);
    expect(server.packages.map((p) => p.version)).toEqual([version]);
  });

  it("the bug report form suggests it as the example version", () => {
    expect(read(".github/ISSUE_TEMPLATE/bug_report.yml")).toContain(`cloudpin ${version},`);
  });
});
