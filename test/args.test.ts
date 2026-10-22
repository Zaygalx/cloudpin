import { describe, expect, it } from "vitest";
import { flagValue } from "../src/args.js";

describe("flagValue", () => {
  it("reads a short flag joined to its value with =", () => {
    expect(flagValue(["-e=production"], ["--env", "-e"])).toBe("production");
  });
});
