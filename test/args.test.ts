import { describe, expect, it } from "vitest";
import { flagValue } from "../src/args.js";

describe("flagValue", () => {
  it("reads a short flag joined to its value with = when the CLI accepts it", () => {
    expect(flagValue(["-e=production"], ["--env", "-e"], { shortEquals: true })).toBe("production");
  });

  it("leaves a short flag joined with = alone by default", () => {
    expect(flagValue(["-T=acme"], ["--team", "-T"])).toBeUndefined();
  });

  it("still reads a long flag joined with = by default", () => {
    expect(flagValue(["--env=production"], ["--env", "-e"])).toBe("production");
  });

  it("still reads a short flag and its separate value by default", () => {
    expect(flagValue(["-e", "production"], ["--env", "-e"])).toBe("production");
  });
});
