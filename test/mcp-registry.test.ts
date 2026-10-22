import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

// The official MCP Registry listing (#111). Sources, read 2026-10-21:
// - server.json fields and limits: static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json, the
//   schema mcp-publisher v1.8.1 calls current (pkg/model/constants.go, CurrentSchemaURL).
// - npm ownership: the registry reads `mcpName` from registry.npmjs.org/<identifier>/<version> and requires it to
//   equal the server name (internal/validators/registries/npm.go in github.com/modelcontextprotocol/registry).
// - GitHub OIDC grants the namespace io.github.<repository owner>/* (internal/api/handlers/v0/auth/github_oidc.go).
const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const json = (path: string) => JSON.parse(read(path)) as Record<string, any>;
const pkg = json("package.json");
const server = json("server.json");
const NAME = "io.github.paureis/cloudpin";

describe("server.json for the MCP Registry", () => {
  it("uses the current schema and the GitHub namespace that OIDC login grants", () => {
    expect(server.$schema).toBe("https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json");
    expect(server.name).toBe(NAME);
    expect(server.repository).toEqual({ url: "https://github.com/paureis/cloudpin", source: "github" });
  });

  it("has a description within the schema's 100 characters", () => {
    expect(server.description.length).toBeGreaterThan(0);
    expect(server.description.length).toBeLessThanOrEqual(100);
  });

  it("runs the npm package's binary over stdio with the argument mcp", () => {
    expect(server.packages).toEqual([
      {
        registryType: "npm",
        registryBaseUrl: "https://registry.npmjs.org",
        identifier: pkg.name,
        version: pkg.version,
        transport: { type: "stdio" },
        packageArguments: [{ type: "positional", value: "mcp" }],
      },
    ]);
  });

  it("is claimed by package.json's mcpName, which the registry checks on npm", () => {
    expect(pkg.mcpName).toBe(NAME);
  });
});

describe("the MCP Registry workflow", () => {
  const workflow = parse(read(".github/workflows/mcp-registry.yml")) as Record<string, any>;
  const steps: Record<string, any>[] = Object.values(workflow.jobs as Record<string, any>).flatMap((job) => job.steps ?? []);

  it("only runs by hand, never on pull requests, pushes or tags (CI budget)", () => {
    expect(Object.keys(workflow.on)).toEqual(["workflow_dispatch"]);
    expect(workflow.on.workflow_dispatch.inputs.tag.required).toBe(true);
  });

  it("is one Linux job that may only read the repo and request an OIDC token", () => {
    const jobs = Object.values(workflow.jobs as Record<string, any>);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]["runs-on"]).toBe("ubuntu-latest");
    expect(workflow.permissions).toEqual({ contents: "read" });
    expect(jobs[0].permissions).toEqual({ contents: "read", "id-token": "write" });
  });

  it("pins every action by full commit SHA", () => {
    const uses = steps.map((s) => s.uses).filter(Boolean);
    expect(uses.length).toBeGreaterThan(0);
    for (const u of uses) expect(u).toMatch(/^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/);
  });

  it("installs a pinned mcp-publisher release, checked against its SHA-256", () => {
    const text = read(".github/workflows/mcp-registry.yml");
    expect(text).toMatch(/MCP_PUBLISHER_VERSION: \d+\.\d+\.\d+\n/);
    expect(text).toMatch(/MCP_PUBLISHER_SHA256: [0-9a-f]{64}\n/);
    expect(text).toContain("releases/download/v${MCP_PUBLISHER_VERSION}/mcp-publisher_linux_amd64.tar.gz");
    expect(text).not.toContain("releases/latest");
    expect(text).toContain("sha256sum --check --strict");
  });

  // /v0/validate runs schema and semantic checks only; the npm mcpName check runs on publish (registry v1.8.1,
  // internal/api/handlers/v0/validate.go). So a dry run validates before the npm version is approved.
  it("validates first, and checks the live npm version, logs in and publishes only outside a dry run", () => {
    const at = (re: RegExp) => steps.findIndex((s) => re.test(String(s.run ?? "")));
    const [agree, install, validate, npm, login, publish] = [
      at(/jq -r \.version server\.json/),
      at(/sha256sum --check/),
      at(/mcp-publisher" validate /),
      at(/npm view /),
      at(/mcp-publisher" login github-oidc/),
      at(/mcp-publisher" publish /),
    ];
    expect([agree, install, validate, npm, login, publish].every((i) => i >= 0)).toBe(true);
    expect(agree < install && install < validate && validate < npm && npm < login && login < publish).toBe(true);
    for (const i of [agree, install, validate]) expect(steps[i]!.if).toBeUndefined();
    for (const i of [npm, login, publish]) expect(steps[i]!.if).toBe("${{ !inputs.dry_run }}");
    expect(workflow.on.workflow_dispatch.inputs.dry_run.description).toMatch(/validate.*before the npm version is approved/i);
  });
});
