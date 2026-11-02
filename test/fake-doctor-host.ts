import type { DoctorHost } from "../src/mcp-tools.js";

/** A ToolContext's doctor facts for tests that don't call cloudpin_doctor: nothing on PATH, npm unreachable. */
export const fakeDoctorHost: DoctorHost = {
  platform: "linux",
  version: "9.9.9",
  self: "",
  install: "npm",
  realpath: (p) => p,
  node: "22.17.0",
  onPath: () => null,
  latest: async () => null,
};
