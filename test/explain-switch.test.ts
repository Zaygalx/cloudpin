import { describe, expect, it } from "vitest";
import type { FoundConfig } from "../src/config.js";
import { explain, type ExplainOptions } from "../src/explain.js";
import type { GuardDeps } from "../src/guard.js";

// #14: explain, and the MCP check tool built on it, must say what an agent hook would do with cloudpin itself.

const config: FoundConfig = { path: "/repo/.cloudpin.yml", pins: { github: { user: "me" } } };
const deps: GuardDeps = { providers: [], exec: async () => ({ code: 0, stdout: "", stderr: "" }), findConfig: () => config };
const agent: ExplainOptions = { mode: "agent", cwd: "/repo", env: {} };

describe("explain: cloudpin's own commands", () => {
  it("for an agent, cloudpin switch asks, as the hook does, and names the pins", async () => {
    const [call] = await explain("cloudpin switch --yes", agent, deps);
    expect(call).toMatchObject({ verdict: "ask", cli: null, argv: ["cloudpin", "switch", "--yes"] });
    expect(call!.reason).toContain("github user me");
  });

  it("the same for the ways of spelling it, and for cloudpin use", async () => {
    for (const line of ["npx cloudpin switch", "cloudpin exec -- bash -c 'cloudpin switch'", "cloudpin $x", "cloudpin use prod"]) {
      const [call] = await explain(line, agent, deps);
      expect(call?.verdict, line).toBe("ask");
    }
    const [array] = await explain(["cloudpin", "switch"], agent, deps);
    expect(array?.verdict).toBe("ask");
  });

  it("masks a credential in the words it shows", async () => {
    const [call] = await explain("cloudpin switch --token s3cret-value", agent, deps);
    expect(JSON.stringify(call)).not.toContain("s3cret-value");
  });

  it("controls: help and read-only commands aren't calls it reports; in a terminal cloudpin switch asks by itself", async () => {
    for (const line of ["cloudpin switch --help", "cloudpin status", "cloudpin use"]) {
      expect(await explain(line, agent, deps), line).toEqual([]);
    }
    expect(await explain("cloudpin switch", { ...agent, mode: "shell" }, deps)).toEqual([]);
  });
});
