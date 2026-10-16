import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { planInstall } from "../src/install.js";

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const json = (path: string) => JSON.parse(read(path)) as Record<string, any>;

describe("the Claude Code plugin", () => {
  it("is named cloudpin and has the package's version", () => {
    const plugin = json("plugin/.claude-plugin/plugin.json");
    expect(plugin.name).toBe("cloudpin");
    expect(plugin.version).toBe(json("package.json").version);
    expect(plugin.license).toBe("MIT");
  });

  it("runs exactly the hook `cloudpin install-hook claude` writes", () => {
    const fromInstall = JSON.parse(planInstall("claude", null).content).hooks.PreToolUse;
    expect(json("plugin/hooks/hooks.json").hooks.PreToolUse).toEqual(fromInstall);
  });

  it("starts the MCP server with `cloudpin mcp`", () => {
    expect(json("plugin/.mcp.json").mcpServers.cloudpin).toEqual({ command: "cloudpin", args: ["mcp"] });
  });

  it("is listed in this repository's marketplace, from its plugin folder", () => {
    const market = json(".claude-plugin/marketplace.json");
    expect(market.name).toBe("cloudpin");
    expect(market.owner.name).toBeTruthy();
    expect(market.plugins).toEqual([expect.objectContaining({ name: "cloudpin", source: "./plugin" })]);
  });

  it("ships a skill that names both tools and says to stop on a block", () => {
    const skill = read("plugin/skills/cloudpin/SKILL.md");
    expect(skill).toMatch(/^---\nname: cloudpin\ndescription: .+\n---\n/);
    expect(skill).toContain("cloudpin_status");
    expect(skill).toContain("cloudpin_check");
    expect(skill).toMatch(/never .*CLOUDPIN_SKIP/i);
  });
});
