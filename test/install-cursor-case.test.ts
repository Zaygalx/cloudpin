import { describe, expect, it } from "vitest";
import { planInstall } from "../src/install.js";
import { providers } from "../src/providers/index.js";

// Cursor runs the hook only for lines its matcher finds, and a Windows shell runs `CLOUDPIN.CMD` as `cloudpin`, so a
// name in another case must reach the hook (#14). Cursor's docs don't name a flag syntax, so no `(?i)`: plain classes.

const matcher = () => new RegExp(JSON.parse(planInstall("cursor", null).content).hooks.beforeShellExecution[0].matcher);

describe("Cursor's matcher", () => {
  it("finds cloudpin and every guarded CLI in any case, also with a Windows extension", () => {
    for (const bin of [...providers.flatMap((p) => p.bins), "cloudpin"]) {
      for (const spelled of [bin, bin.toUpperCase(), `${bin[0]!.toUpperCase()}${bin.slice(1)}`, `${bin.toUpperCase()}.CMD`, `${bin}.exe`]) {
        expect(matcher().test(`cd app && ${spelled} version`), spelled).toBe(true);
      }
    }
    expect(matcher().test("CLOUDPIN.CMD switch --yes")).toBe(true);
    expect(matcher().test("npx Cloudpin switch")).toBe(true);
  });

  it("controls: it still matches whole words only, and leaves other commands alone", () => {
    for (const line of ["npm test", "GHOST-CLI run", "ls -la", "cloudpinned", "AZURE list", "echo myGH"]) {
      expect(matcher().test(line), line).toBe(false);
    }
  });

  it("is plain regex syntax, with no inline flag another engine may reject", () => {
    expect(matcher().source).not.toContain("(?");
    expect(matcher().flags).toBe("");
  });
});
