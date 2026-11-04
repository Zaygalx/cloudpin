import { describe, expect, it } from "vitest";
import { checkBundle } from "../scripts/build-exe.mjs";

const good = 'const v = "1.3.0";\n';

describe("checkBundle looks for a read of package.json, not the word", () => {
  it("lets a comment mention package.json", () => {
    expect(() => checkBundle(`${good}// package.json "engines".\n`, "1.3.0")).not.toThrow();
    expect(() => checkBundle(`${good}/** * vercel/vercel packages/cli/package.json; arg 5.0.0 */\n`, "1.3.0")).not.toThrow();
  });

  it("refuses package.json as a string, in any quotes and through a path", () => {
    expect(() => checkBundle(`${good}createRequire(import.meta.url)("../package.json")`, "1.3.0")).toThrow(/package\.json/);
    expect(() => checkBundle(`${good}readFileSync('package.json')`, "1.3.0")).toThrow(/package\.json/);
    expect(() => checkBundle(`${good}readFileSync(\`\${root}/package.json\`)`, "1.3.0")).toThrow(/package\.json/);
  });
});
