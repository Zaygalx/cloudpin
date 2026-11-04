import { describe, expect, it } from "vitest";
import { providers } from "../src/providers/index.js";
import { runSwitch, type SwitchIO } from "../src/switch.js";
import type { Exec } from "../src/types.js";

describe("cloudpin switch's text never repeats a credential a CLI echoes (#134)", () => {
  it("a failed command's error line has its secret flags masked", async () => {
    const lines: string[] = [];
    const io: SwitchIO = { isTTY: false, ask: async () => "", out: (l) => lines.push(l), err: (l) => lines.push(l) };
    let switched = false;
    const exec: Exec = async (bin, args) => {
      const line = [bin, ...args].join(" ");
      const ok = (stdout: string) => ({ code: 0, stdout, stderr: "" });
      if (line.startsWith("gh api user")) return ok(switched ? "me\n" : "someone\n");
      if (line.startsWith("gh auth status")) return ok(JSON.stringify([{ host: "github.com", login: "me", active: false }]));
      if (line.startsWith("gh auth switch")) {
        switched = true;
        return { code: 1, stdout: "", stderr: "error: gh said --token s3cret-value and --password=hunter2 were wrong\n" };
      }
      throw new Error(`unscripted: ${line}`);
    };
    await runSwitch("/repo", {}, { providers, exec, findConfig: () => ({ path: "/repo/.cloudpin.yml", pins: { github: { user: "me" } } }) }, { yes: true, json: false }, io);
    const text = lines.join("\n");
    expect(text).toContain("failed (exit 1)");
    expect(text).toContain("--token ***");
    expect(text).not.toContain("s3cret-value");
    expect(text).not.toContain("hunter2");
  });
});
