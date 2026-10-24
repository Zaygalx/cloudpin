import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

// readFileSync fails with EACCES for files named .env.denied; everything else is untouched.
vi.mock("node:fs", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs")>();
  const readFileSync = ((path: unknown, ...rest: unknown[]) => {
    if (String(path).endsWith(".env.denied")) throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
    return (fs.readFileSync as (...a: unknown[]) => unknown)(path, ...rest);
  }) as typeof fs.readFileSync;
  return { ...fs, default: { ...fs, readFileSync }, readFileSync };
});
import { cloudflare } from "../src/providers/cloudflare.js";
import { DOTENV_VARS, parseDotenv, wranglerDotenv } from "../src/providers/wrangler-dotenv.js";
import { tempDir } from "./tmp.js";

const A = "0123456789abcdef0123456789abcdef";
const B = "fedcba9876543210fedcba9876543210";
const C = "00000000111111112222222233333333";

const parse = (text: string) => Object.fromEntries(parseDotenv(text));

function folder(files: Record<string, string> = {}) {
  const root = tempDir("cloudpin-dotenv-");
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(join(root, name, ".."), { recursive: true });
    writeFileSync(join(root, name), content);
  }
  return root;
}

// What Wrangler would see, on Linux unless a platform is given.
const load = (start: string, env: NodeJS.ProcessEnv = {}, args: string[] = ["deploy"], platform: NodeJS.Platform = "linux") =>
  wranglerDotenv(args, env, start, platform);

describe("parseDotenv: the dotenv 16.3.1 format Wrangler reads", () => {
  it("reads KEY=value lines, export, spaces, comments, blank lines, CRLF and a BOM", () => {
    const text = "\uFEFF# a comment\r\nA=1\r\n\r\nexport B = two words  \r\n  C=3 # inline comment\r\nD=\r\nE=#all comment\r\nexport=6\r\nF.G-h=7\r\n";
    expect(parse(text)).toEqual({ A: "1", B: "two words", C: "3", D: "", E: "", export: "6", "F.G-h": "7" });
  });

  it("strips quotes, keeps # inside them, and expands \\n and \\r only in double quotes", () => {
    const text = [
      'D="a # not a comment" # comment',
      "S='its'",
      "Q='{\"json\": true}'",
      "T=" + "`back tick`",
      'N="line1\\nline2\\r"',
      "L='line1\\nline2'",
      'P="C:\\path\\to"',
      'E=""',
      "U=unquoted \"inner\" quotes",
    ].join("\n");
    expect(parse(text)).toEqual({
      D: "a # not a comment",
      S: "its",
      Q: '{"json": true}',
      T: "back tick",
      N: "line1\nline2\r",
      L: "line1\\nline2",
      P: "C:\\path\\to",
      E: "",
      U: 'unquoted "inner" quotes',
    });
  });

  it("reads a quoted value over several lines, and the lines inside it set nothing", () => {
    const text = ['KEY="-----BEGIN', `CLOUDFLARE_ACCOUNT_ID=${B}`, '-----END"', "AFTER=1"].join("\n");
    expect(parse(text)).toEqual({ KEY: `-----BEGIN\nCLOUDFLARE_ACCOUNT_ID=${B}\n-----END`, AFTER: "1" });
  });

  it("lets a later line win over an earlier one", () => {
    expect(parse(`X=${A}\nX=${B}\n`)).toEqual({ X: B });
  });

  // Expected values are what dotenv 16.3.1's own parse() returns for each text.
  it.each([
    ["an unclosed quote", 'A=1\nB="never closed\nC=2', { A: "1", B: '"never closed', C: "2" }],
    ["text after the closing quote", 'B="x" y', { B: '"x" y' }],
    ["an escaped quote", 'B="a\\"b"', { B: 'a\\"b' }],
    ["a backslash before the closing quote", "B='a\\'", { B: "a\\" }],
    ["the KEY: value form", "B: value", { B: "value" }],
    ["a line without =", "A=1\nJUST_A_WORD", { A: "1" }],
    ["a value on the line after KEY=", 'A=\n"value"', { A: "value" }],
    ["export on its own line", "export\nA=1", { A: "1" }],
    ["JSON with escaped quotes, a colon line and a stray line", 'G="{\\"type\\":\\"sa\\"}"\nDEBUG: true\nstray line\nX=1', { G: '{\\"type\\":\\"sa\\"}', DEBUG: "true", X: "1" }],
  ])("reads %s as dotenv does", (_what, text, expected) => {
    expect(parse(text)).toEqual(expected);
  });
});

describe("wranglerDotenv: the environment Wrangler gives itself", () => {
  it("returns the command's own environment untouched when there is no .env file", () => {
    const env = { CLOUDFLARE_API_TOKEN: "t", PATH: "/bin" };
    const res = load(folder({ "wrangler.toml": "" }), env);
    expect(res).toEqual({ env, from: {} });
    expect("env" in res && res.env).toBe(env);
  });

  it("fills CLOUDFLARE_ACCOUNT_ID from .env when the environment lacks it", () => {
    const res = load(folder({ ".env": `CLOUDFLARE_ACCOUNT_ID=${B}\n` }), { PATH: "/bin" });
    expect(res).toEqual({ env: { PATH: "/bin", CLOUDFLARE_ACCOUNT_ID: B }, from: { CLOUDFLARE_ACCOUNT_ID: ".env" } });
  });

  it("keeps a non-empty value from the environment over .env, but lets .env fill an empty one", () => {
    const root = folder({ ".env": `CLOUDFLARE_ACCOUNT_ID=${B}\nCLOUDFLARE_API_TOKEN=from-file\n` });
    expect(load(root, { CLOUDFLARE_ACCOUNT_ID: A })).toEqual({
      env: { CLOUDFLARE_ACCOUNT_ID: A, CLOUDFLARE_API_TOKEN: "from-file" },
      from: { CLOUDFLARE_API_TOKEN: ".env" },
    });
    expect(load(root, { CLOUDFLARE_ACCOUNT_ID: "" })).toMatchObject({ env: { CLOUDFLARE_ACCOUNT_ID: B } });
  });

  it("reads .env, .env.local, .env.<env> and .env.<env>.local, each overriding the one before", () => {
    const root = folder({
      ".env": `CLOUDFLARE_ACCOUNT_ID=${A}\nCF_ACCOUNT_ID=${A}\nCLOUDFLARE_EMAIL=a@example.com\n`,
      ".env.local": `CF_ACCOUNT_ID=${B}\n`,
      ".env.production": `CLOUDFLARE_ACCOUNT_ID=${B}\nCLOUDFLARE_EMAIL=b@example.com\n`,
      ".env.production.local": `CLOUDFLARE_ACCOUNT_ID=${C}\n`,
    });
    expect(load(root, {}, ["deploy"])).toMatchObject({ env: { CLOUDFLARE_ACCOUNT_ID: A, CF_ACCOUNT_ID: B }, from: { CF_ACCOUNT_ID: ".env.local" } });
    expect(load(root, {}, ["deploy", "--env", "production"])).toMatchObject({
      env: { CLOUDFLARE_ACCOUNT_ID: C, CF_ACCOUNT_ID: B, CLOUDFLARE_EMAIL: "b@example.com" },
      from: { CLOUDFLARE_ACCOUNT_ID: ".env.production.local", CLOUDFLARE_EMAIL: ".env.production" },
    });
    expect(load(root, {}, ["deploy", "-e", "production"])).toMatchObject({ env: { CLOUDFLARE_ACCOUNT_ID: C } });
    expect(load(root, {}, ["deploy", "--env=production"])).toMatchObject({ env: { CLOUDFLARE_ACCOUNT_ID: C } });
    // CLOUDFLARE_ENV picks the config section, not the .env files (only --env does).
    expect(load(root, { CLOUDFLARE_ENV: "production" })).toMatchObject({ env: { CLOUDFLARE_ACCOUNT_ID: A } });
  });

  it("reads only the --env-file files when given (relative to the folder, repeated or several after one flag)", () => {
    const root = folder({
      ".env": `CLOUDFLARE_ACCOUNT_ID=${A}\n`,
      "secrets/one.env": `CLOUDFLARE_ACCOUNT_ID=${B}\nCLOUDFLARE_EMAIL=one@example.com\n`,
      "secrets/two.env": `CLOUDFLARE_ACCOUNT_ID=${C}\n`,
    });
    expect(load(root, {}, ["deploy", "--env-file", "secrets/one.env"])).toMatchObject({
      env: { CLOUDFLARE_ACCOUNT_ID: B },
      from: { CLOUDFLARE_ACCOUNT_ID: join("secrets", "one.env") },
    });
    expect(load(root, {}, ["deploy", "--env-file=secrets/one.env", "--env-file", join(root, "secrets", "two.env")])).toMatchObject({
      env: { CLOUDFLARE_ACCOUNT_ID: C, CLOUDFLARE_EMAIL: "one@example.com" },
    });
    // yargs arrays are greedy: every word after --env-file up to the next flag is a file.
    expect(load(root, {}, ["deploy", "--env-file", "secrets/one.env", "secrets/two.env", "--dry-run"])).toMatchObject({ env: { CLOUDFLARE_ACCOUNT_ID: C } });
    expect(load(root, {}, ["deploy", "--env-file", "missing.env"])).toEqual({ env: {}, from: {} });
  });

  it("takes --envFile, the camel-case alias yargs gives --env-file", () => {
    const root = folder({ ".env": `CLOUDFLARE_ACCOUNT_ID=${A}\n`, "other.env": `CLOUDFLARE_ACCOUNT_ID=${B}\n` });
    expect(load(root, {}, ["deploy", "--envFile", "other.env"])).toMatchObject({ env: { CLOUDFLARE_ACCOUNT_ID: B } });
    expect(load(root, {}, ["deploy", "--envFile=other.env"])).toMatchObject({ env: { CLOUDFLARE_ACCOUNT_ID: B } });
  });

  it("only adds the variables that decide the account or credentials", () => {
    const root = folder({ ".env": `DATABASE_URL=postgres://\${HOST}/db\nCLOUDFLARE_ENV=staging\nWRANGLER_CACHE_DIR=.cache\n` });
    expect(load(root)).toEqual({ env: { CLOUDFLARE_ENV: "staging", WRANGLER_CACHE_DIR: ".cache" }, from: { CLOUDFLARE_ENV: ".env", WRANGLER_CACHE_DIR: ".env" } });
  });

  it("stops on a value it would have to expand, naming the variable and file but not the value", () => {
    const root = folder({ ".env": "CLOUDFLARE_API_TOKEN=${SECRET_TOKEN_VALUE}\n" });
    const res = load(root);
    expect(res).toMatchObject({ error: expect.stringMatching(/CLOUDFLARE_API_TOKEN.*\.env/) });
    expect(JSON.stringify(res)).not.toContain("SECRET_TOKEN_VALUE");
    // ...unless the environment already sets it, which wins without expanding.
    expect(load(root, { CLOUDFLARE_API_TOKEN: "t" })).toEqual({ env: { CLOUDFLARE_API_TOKEN: "t" }, from: {} });
  });

  it("reads every line as dotenv does, so lines for other tools never stop a command", () => {
    const text = 'GOOGLE_CREDS="{\\"type\\":\\"service_account\\"}"\nDEBUG: true\nstray line\nCLOUDFLARE_API_TOKEN="abc\\"def"\nCF_ACCOUNT_ID=' + B + "\n";
    expect(load(folder({ ".env.local": text }))).toEqual({
      env: { CLOUDFLARE_API_TOKEN: 'abc\\"def', CF_ACCOUNT_ID: B },
      from: { CLOUDFLARE_API_TOKEN: ".env.local", CF_ACCOUNT_ID: ".env.local" },
    });
  });

  it("skips a file it can't read for any reason, as Wrangler does (dotenv returns the error, Wrangler only logs it)", () => {
    // The mocked readFileSync above fails with EACCES for this name.
    const root = folder({ ".env.denied": `CLOUDFLARE_ACCOUNT_ID=${B}\n`, ".env.extra": `CLOUDFLARE_ACCOUNT_ID=${A}\n` });
    expect(load(root, {}, ["deploy", "--env-file", ".env.extra", ".env.denied"])).toEqual({
      env: { CLOUDFLARE_ACCOUNT_ID: A },
      from: { CLOUDFLARE_ACCOUNT_ID: ".env.extra" },
    });
  });

  it("skips a folder named like a .env file", () => {
    const root = folder({ ".env/inside": "x", ".env.local": `CLOUDFLARE_ACCOUNT_ID=${A}\n` });
    expect(load(root)).toEqual({ env: { CLOUDFLARE_ACCOUNT_ID: A }, from: { CLOUDFLARE_ACCOUNT_ID: ".env.local" } });
  });

  it("stops when DOTENV_KEY makes dotenv decrypt a .vault file instead of the plain one", () => {
    const root = folder({ ".env": `CLOUDFLARE_ACCOUNT_ID=${A}\n`, ".env.local.vault": "DOTENV_VAULT_PRODUCTION=encrypted\n" });
    const res = load(root, { DOTENV_KEY: "dotenv://:key_secretpart@dotenv.org/vault/.env.vault?environment=production" });
    expect(res).toMatchObject({ error: expect.stringMatching(/\.env\.local\.vault.*DOTENV_KEY/) });
    expect(JSON.stringify(res)).not.toContain("secretpart");
    // No key, or an empty one: dotenv reads the plain files and ignores the vault.
    expect(load(root)).toMatchObject({ env: { CLOUDFLARE_ACCOUNT_ID: A } });
    expect(load(root, { DOTENV_KEY: "" })).toMatchObject({ env: { CLOUDFLARE_ACCOUNT_ID: A } });
    // A key but no vault file: the plain files again.
    expect(load(folder({ ".env": `CLOUDFLARE_ACCOUNT_ID=${A}\n` }), { DOTENV_KEY: "k" })).toMatchObject({ env: { CLOUDFLARE_ACCOUNT_ID: A } });
  });

  it("treats variable names case-insensitively on Windows only, as Wrangler does there", () => {
    const root = folder({ ".env": `cloudflare_account_id=${B}\n` });
    expect(load(root, {}, ["deploy"], "win32")).toMatchObject({ env: { CLOUDFLARE_ACCOUNT_ID: B } });
    expect(load(root, { Cloudflare_Account_Id: A }, ["deploy"], "win32")).toEqual({ env: { Cloudflare_Account_Id: A }, from: {} });
    expect(load(root, {}, ["deploy"], "linux")).toEqual({ env: {}, from: {} });
  });

  it("covers every variable the identity cache keys on", () => {
    for (const name of cloudflare.cacheInputs({}).env) expect(DOTENV_VARS).toContain(name);
    for (const name of ["CLOUDFLARE_ACCOUNT_ID", "CF_ACCOUNT_ID", "CLOUDFLARE_ENV", "WRANGLER_CACHE_DIR"]) expect(DOTENV_VARS).toContain(name);
  });
});
