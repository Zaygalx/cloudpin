import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { FoundConfig } from "../src/config.js";
import { guard, type Verdict } from "../src/guard.js";
import { cloudflare } from "../src/providers/cloudflare.js";
import { findInvocations } from "../src/shellwords.js";
import type { Exec } from "../src/types.js";
import { envFor } from "../src/user-env.js";
import { tempDir } from "./tmp.js";

// #119, part 1: a variable that decides Wrangler's account, set by an agent's
// line from something cloudpin can't read in advance ($(...), backticks,
// $OTHER), must block as "can't tell" (the #86 mechanism), not be dropped
// while Wrangler goes on to use it.

const A = "0123456789abcdef0123456789abcdef";
const B = "fedcba9876543210fedcba9876543210";
const pinnedToA: FoundConfig = { path: "/repo/.cloudpin.yml", pins: { cloudflare: { account: A } } };

function folder(files: Record<string, string> = {}) {
  const root = tempDir("cloudpin-cf-account-vars-");
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(join(root, name, ".."), { recursive: true });
    writeFileSync(join(root, name), content);
  }
  return root;
}

/** A fake `wrangler whoami` whose credentials see only account A, the pinned one. */
const onlyA: Exec = async () => ({ code: 0, stdout: JSON.stringify({ loggedIn: true, accounts: [{ id: A, name: "Acme" }] }), stderr: "" });

/** The verdict for an agent's command line, as the hook builds it (findInvocations, then envFor). */
async function agentLine(line: string, cwd: string, base: NodeJS.ProcessEnv = {}): Promise<Verdict> {
  const [inv] = findInvocations(line, cloudflare.bins, cwd);
  return guard(
    { bin: inv!.bin, args: inv!.args, env: envFor(base, inv!, { agent: true }), cwd, mode: "agent" },
    { providers: [cloudflare], exec: onlyA, findConfig: () => pinnedToA },
  );
}

describe("guard: Cloudflare account variables with unknown values (#119)", () => {
  it.each(["CLOUDFLARE_ACCOUNT_ID", "CF_ACCOUNT_ID"])("blocks %s=$(...) as can't tell", async (name) => {
    // Without the variable cloudpin would reach whoami, whose only account is the pinned one.
    for (const value of ["$(cat id)", "`cat id`", "$OTHER"]) {
      const v = await agentLine(`${name}=${value} wrangler deploy`, folder());
      expect(v).toMatchObject({ action: "block", uncertain: true, problems: [expect.stringContaining(`${name} is set by the command line`)] });
    }
  });

  it("blocks CLOUDFLARE_ENV=$(...) when the config file's sections name different accounts", async () => {
    const root = folder({ "wrangler.toml": `account_id = "${A}"\n[env.staging]\naccount_id = "${B}"\n` });
    expect(await agentLine("CLOUDFLARE_ENV=$(cat e) wrangler deploy", root)).toMatchObject({ action: "block", uncertain: true });
  });

  it("blocks WRANGLER_CACHE_DIR=$(...), which picks the account cache Wrangler reads", async () => {
    const root = folder({ ".wrangler/cache/wrangler-account.json": JSON.stringify({ account: { id: A } }) });
    expect(await agentLine("WRANGLER_CACHE_DIR=$(cat d) wrangler deploy", root)).toMatchObject({ action: "block", uncertain: true });
  });

  it("blocks DOTENV_KEY=$(...) when a .env.vault exists, since Wrangler would decrypt it instead of .env", async () => {
    const root = folder({ ".env": `CLOUDFLARE_ACCOUNT_ID=${A}\n`, ".env.vault": "DOTENV_VAULT_PRODUCTION=x\n" });
    expect(await agentLine("DOTENV_KEY=$(cat k) wrangler deploy", root)).toMatchObject({ action: "block", uncertain: true });
  });

  it("still resolves known values: the pinned account passes, another one blocks", async () => {
    expect(await agentLine(`CLOUDFLARE_ACCOUNT_ID=${A} wrangler deploy`, folder())).toEqual({ action: "allow", reason: "match" });
    const blocked = await agentLine(`CF_ACCOUNT_ID=${B} wrangler deploy`, folder());
    expect(blocked).toMatchObject({ action: "block", problems: [expect.stringContaining(B)] });
    expect(blocked).not.toHaveProperty("uncertain");
  });

  it("controls: an unknown value in a variable Wrangler doesn't read is still dropped", async () => {
    expect(await agentLine(`BUILD_ID=$(date) CLOUDFLARE_ACCOUNT_ID=${A} wrangler deploy`, folder())).toEqual({ action: "allow", reason: "match" });
    expect(await agentLine("BUILD_ID=$(date) wrangler deploy", folder())).toEqual({ action: "allow", reason: "match" });
  });

  it("every variable the provider follows from .env counts as an identity variable", () => {
    // DOTENV_VARS (wrangler-dotenv.ts) lists what decides the account or the credentials.
    const identity = cloudflare.cacheInputs({}).env;
    for (const name of ["CLOUDFLARE_ACCOUNT_ID", "CF_ACCOUNT_ID", "CLOUDFLARE_ENV", "WRANGLER_CACHE_DIR", "DOTENV_KEY"]) {
      expect(identity).toContain(name);
    }
  });
});
