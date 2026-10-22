import { mkdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve as resolvePath } from "node:path";
import { describe, expect, it } from "vitest";
import type { Exec } from "../src/types.js";
import { A, B, folder, profileHome, resolve, whoami } from "./wrangler-fixtures.js";

// How Wrangler spells the folder whose binding picks the profile (#103), from workers-sdk wrangler@4.151.3:
// packages/wrangler/src/core/register-yargs-command.ts createHandler takes dirname(path.resolve(--config)),
// a plain string, else process.cwd() after --cwd, which the OS returns as the real path.

/**
 * A `wrangler whoami` that answers as Wrangler would: with the login of the profile its own --cwd and
 * --config pick, among `bindings` (the nearest bound folder), and `accounts` per profile.
 */
function wranglerLike(bindings: Record<string, string>, accounts: Record<string, string>): Exec {
  return async (_bin, args) => {
    const flag = (name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
    const cwd = realpathSync(flag("--cwd") ?? process.cwd());
    const config = flag("--config");
    const where = config === undefined ? cwd : dirname(resolvePath(cwd, config));
    let profile = "default";
    for (let d = where; ; d = dirname(d)) {
      if (bindings[d] !== undefined) {
        profile = bindings[d]!;
        break;
      }
      if (dirname(d) === d) break;
    }
    const id = accounts[profile]!;
    return { code: 0, stdout: whoami([{ id, name: "x" }]), stderr: "" };
  };
}

describe.skipIf(process.platform === "win32")("Wrangler profiles through a symlinked folder", () => {
  /** <root>/real holding wrangler.toml with no account_id, and <root>/link pointing at it. */
  function linked() {
    const root = realpathSync(folder({ "real/wrangler.toml": 'name = "w"\n' }));
    symlinkSync(join(root, "real"), join(root, "link"), "dir");
    return root;
  }
  const accounts = { default: A, work: B };

  it("asks whoami about the profile a symlinked --config picks: the real folder's binding doesn't apply", async () => {
    const root = linked();
    // `cd link && wrangler auth activate work` stores process.cwd(), the real path.
    const bindings = { [join(root, "real")]: "work" };
    const exec = wranglerLike(bindings, accounts);
    const res = await resolve(["deploy", "-c", join("link", "wrangler.toml")], root, profileHome(bindings), exec);
    expect(res).toMatchObject({ kind: "identity", identity: { account: A } });
  });

  it("and the reverse: a binding stored through the link applies to --config through it", async () => {
    const root = linked();
    // `wrangler auth activate work link` stores path.resolve("link"), not the real path.
    const bindings = { [join(root, "link")]: "work" };
    const exec = wranglerLike(bindings, accounts);
    const res = await resolve(["deploy", "-c", join("link", "wrangler.toml")], root, profileHome(bindings), exec);
    expect(res).toMatchObject({ kind: "identity", identity: { account: B }, source: expect.stringMatching(/profile "work"/) });
  });

  it("matches the real path of the command's folder, as process.cwd() reports it", async () => {
    const root = linked();
    mkdirSync(join(root, "real", "sub"));
    writeFileSync(join(root, "real", "sub", ".keep"), "");
    const bindings = { [join(root, "real")]: "work" };
    const exec = wranglerLike(bindings, accounts);
    expect(await resolve(["deploy"], join(root, "link", "sub"), profileHome(bindings), exec)).toMatchObject({
      identity: { account: B },
      source: expect.stringMatching(/profile "work"/),
    });
  });
});
