import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { tempDir } from "./tmp.js";
import { ConfigError, findConfig, parseConfig, selectEnvironment } from "../src/config.js";
import { chooseEnvironment, currentBranch, findGitDir } from "../src/git.js";

const TWO_ENVS = `
environments:
  staging:
    vercel: { team: "team_staging" }
    aws: { account: "111111111111" }
  production:
    protected: true
    vercel: { team: "team_prod" }
    aws: { account: "222222222222" }
branches:
  main: production
  "release/*": production
  "*": staging
read_only:
  azure: ["webapp log tail"]
`;

describe("parseConfig with environments", () => {
  it("parses environments in file order, with protection and pins", () => {
    const project = parseConfig(TWO_ENVS);
    expect(project.environments).toEqual([
      { name: "staging", protected: false, pins: { vercel: { team: "team_staging" }, aws: { account: "111111111111" } } },
      { name: "production", protected: true, pins: { vercel: { team: "team_prod" }, aws: { account: "222222222222" } } },
    ]);
    expect(project.branches).toEqual([
      { pattern: "main", environment: "production" },
      { pattern: "release/*", environment: "production" },
      { pattern: "*", environment: "staging" },
    ]);
    expect(project.readOnly).toEqual({ azure: [["webapp", "log", "tail"]] });
  });

  it("treats the flat format as no environments", () => {
    const project = parseConfig("github:\n  user: paureis\n");
    expect(project.environments).toBeNull();
    expect(project.pins).toEqual({ github: { user: "paureis" } });
  });

  it("allows read_only in the flat format", () => {
    expect(parseConfig('github:\n  user: x\nread_only:\n  github: ["pr checks"]\n').readOnly).toEqual({
      github: [["pr", "checks"]],
    });
  });

  it("allows an environment with no pins", () => {
    expect(parseConfig("environments:\n  local: {}\n").environments).toEqual([
      { name: "local", protected: false, pins: {} },
    ]);
  });

  it.each([
    ["mixing provider sections with environments", "github:\n  user: x\nenvironments:\n  a: {}\n", /either provider sections or "environments"/],
    ["an empty environments section", "environments: {}\n", /at least one environment/],
    ["an environment that is not a mapping", "environments:\n  a: x\n", /environments\.a: expected a mapping/],
    ["an invalid environment name", 'environments:\n  "pro d": {}\n', /invalid environment name "pro d"/],
    ["protected that is not true or false", "environments:\n  a:\n    protected: yes\n", /a: "protected" must be true or false/],
    ["an unknown provider inside an environment", "environments:\n  a:\n    azur: {}\n", /environments\.a: unknown section "azur"/],
    ["a bad pin inside an environment", "environments:\n  a:\n    vercel: {}\n", /environments\.a: vercel: "team" is required/],
    ["branches without environments", "github:\n  user: x\nbranches:\n  main: prod\n", /"branches" needs "environments"/],
    ["a branch mapped to an unknown environment", "environments:\n  a: {}\nbranches:\n  main: b\n", /branches: "main" maps to unknown environment "b"/],
    ["read_only for an unknown provider", "read_only:\n  azur: [list]\n", /read_only: unknown provider "azur"/],
    ["read_only that is not a list", "read_only:\n  azure: list\n", /read_only\.azure: expected a list/],
    ["an empty read_only entry", 'read_only:\n  azure: [" "]\n', /read_only\.azure: entries must be non-empty/],
  ])("rejects %s", (_, text, message) => {
    expect(() => parseConfig(text)).toThrow(message);
  });
});

describe("selectEnvironment", () => {
  const project = parseConfig(TWO_ENVS);

  it("returns null for the flat format", () => {
    expect(selectEnvironment(parseConfig("github:\n  user: x\n"), { env: { CLOUDPIN_ENV: "x" } })).toBeNull();
  });

  it("prefers CLOUDPIN_ENV over everything", () => {
    expect(selectEnvironment(project, { env: { CLOUDPIN_ENV: "staging" }, chosen: "production", branch: "main" })).toMatchObject({
      name: "staging",
      protected: false,
      source: "CLOUDPIN_ENV",
    });
  });

  it("then the environment chosen with cloudpin use", () => {
    expect(selectEnvironment(project, { env: {}, chosen: "staging", branch: "main" })).toMatchObject({
      name: "staging",
      source: "cloudpin use",
    });
  });

  it("then an exact branch mapping, before patterns listed earlier", () => {
    const p = parseConfig('environments:\n  a: {}\n  b: {}\nbranches:\n  "*": a\n  main: b\n');
    expect(selectEnvironment(p, { env: {}, branch: "main" })).toMatchObject({ name: "b", source: 'branch "main"' });
  });

  it("then the first matching branch pattern", () => {
    expect(selectEnvironment(project, { env: {}, branch: "release/2.0" })).toMatchObject({ name: "production" });
    expect(selectEnvironment(project, { env: {}, branch: "feat/12-environments" })).toMatchObject({ name: "staging" });
  });

  it("falls back to the first environment listed", () => {
    const p = parseConfig("environments:\n  a: {}\n  b: {}\nbranches:\n  main: b\n");
    expect(selectEnvironment(p, { env: {}, branch: "dev" })).toMatchObject({ name: "a", source: "first listed" });
    expect(selectEnvironment(p, { env: {}, branch: null })).toMatchObject({ name: "a", source: "first listed" });
  });

  it("returns the selected environment's pins", () => {
    expect(selectEnvironment(project, { env: {}, branch: "main" })?.pins).toEqual({
      vercel: { team: "team_prod" },
      aws: { account: "222222222222" },
    });
  });

  it("refuses an unknown environment name instead of guessing", () => {
    expect(() => selectEnvironment(project, { env: { CLOUDPIN_ENV: "prod" } })).toThrow(
      /CLOUDPIN_ENV names unknown environment "prod" \(defined: staging, production\)/,
    );
    expect(() => selectEnvironment(project, { env: {}, chosen: "gone" })).toThrow(/cloudpin use/);
  });

  it("ignores an empty CLOUDPIN_ENV", () => {
    expect(selectEnvironment(project, { env: { CLOUDPIN_ENV: "" }, branch: "main" })).toMatchObject({ name: "production" });
  });

  it("uses CLOUDPIN_BRANCH on a detached HEAD", () => {
    expect(selectEnvironment(project, { env: { CLOUDPIN_BRANCH: "main" }, branch: null })).toMatchObject({
      name: "production",
      source: 'branch "main" (CLOUDPIN_BRANCH)',
    });
  });

  it("CLOUDPIN_BRANCH beats the checked-out branch", () => {
    expect(selectEnvironment(project, { env: { CLOUDPIN_BRANCH: "main" }, branch: "feature/x" })).toMatchObject({
      name: "production",
    });
  });

  it("CLOUDPIN_ENV and cloudpin use still win over CLOUDPIN_BRANCH", () => {
    expect(selectEnvironment(project, { env: { CLOUDPIN_ENV: "staging", CLOUDPIN_BRANCH: "main" } })).toMatchObject({
      name: "staging",
    });
    expect(selectEnvironment(project, { env: { CLOUDPIN_BRANCH: "main" }, chosen: "staging" })).toMatchObject({
      name: "staging",
    });
  });

  it("ignores an empty CLOUDPIN_BRANCH", () => {
    expect(selectEnvironment(project, { env: { CLOUDPIN_BRANCH: "" }, branch: "main" })).toMatchObject({
      name: "production",
      source: 'branch "main"',
    });
  });
});

describe("git helpers", () => {
  function repo(head: string) {
    const root = tempDir("cloudpin-git-");
    mkdirSync(join(root, ".git"));
    writeFileSync(join(root, ".git", "HEAD"), head);
    const nested = join(root, "apps", "web");
    mkdirSync(nested, { recursive: true });
    return { root, nested };
  }

  it("finds the git folder upward and reads the branch", () => {
    const { root, nested } = repo("ref: refs/heads/feat/12-environments\n");
    expect(findGitDir(nested)).toBe(join(root, ".git"));
    expect(currentBranch(join(root, ".git"))).toBe("feat/12-environments");
  });

  it("returns no branch on a detached HEAD", () => {
    const { root } = repo("3f2a000000000000000000000000000000000c91\n");
    expect(currentBranch(join(root, ".git"))).toBeNull();
  });

  it("follows a worktree's .git file", () => {
    const root = tempDir("cloudpin-wt-");
    const real = join(root, "main-repo", ".git", "worktrees", "wt");
    mkdirSync(real, { recursive: true });
    writeFileSync(join(real, "HEAD"), "ref: refs/heads/side\n");
    const wt = join(root, "wt");
    mkdirSync(wt);
    writeFileSync(join(wt, ".git"), `gitdir: ${real}\n`);
    expect(findGitDir(wt)).toBe(real);
    expect(currentBranch(real)).toBe("side");
  });

  it("returns null outside a repository", () => {
    expect(findGitDir(tempDir("cloudpin-nogit-"))).toBeNull();
  });

  it("remembers, reads and clears the chosen environment", () => {
    const { root } = repo("ref: refs/heads/main\n");
    const gitDir = join(root, ".git");
    expect(chooseEnvironment(gitDir)).toBeNull();
    chooseEnvironment(gitDir, "staging");
    expect(chooseEnvironment(gitDir)).toBe("staging");
    chooseEnvironment(gitDir, null);
    expect(chooseEnvironment(gitDir)).toBeNull();
  });
});

describe("findConfig with environments", () => {
  it("selects the environment from the repository's branch and choice", () => {
    const root = tempDir("cloudpin-envcfg-");
    mkdirSync(join(root, ".git"));
    writeFileSync(join(root, ".git", "HEAD"), "ref: refs/heads/main\n");
    writeFileSync(join(root, ".cloudpin.yml"), TWO_ENVS);

    const onMain = findConfig(root, {});
    expect(onMain?.environment).toEqual({ name: "production", protected: true, source: 'branch "main"' });
    expect(onMain?.pins).toEqual({ vercel: { team: "team_prod" }, aws: { account: "222222222222" } });
    expect(onMain?.readOnly).toEqual({ azure: [["webapp", "log", "tail"]] });

    chooseEnvironment(join(root, ".git"), "staging");
    expect(findConfig(root, {})?.environment).toMatchObject({ name: "staging", source: "cloudpin use" });
    expect(findConfig(root, { CLOUDPIN_ENV: "production" })?.environment?.name).toBe("production");
  });

  it("reports an unknown environment as a config error naming the file", () => {
    const root = tempDir("cloudpin-envcfg-");
    writeFileSync(join(root, ".cloudpin.yml"), TWO_ENVS);
    expect(() => findConfig(root, { CLOUDPIN_ENV: "nope" })).toThrow(ConfigError);
    expect(() => findConfig(root, { CLOUDPIN_ENV: "nope" })).toThrow(/\.cloudpin\.yml/);
  });

  it("leaves the flat format without an environment", () => {
    const root = tempDir("cloudpin-envcfg-");
    writeFileSync(join(root, ".cloudpin.yml"), "github:\n  user: x\n");
    const found = findConfig(root, { CLOUDPIN_ENV: "anything" });
    expect(found?.environment).toBeUndefined();
    expect(found?.pins).toEqual({ github: { user: "x" } });
  });
});
