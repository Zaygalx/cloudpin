import { describe, expect, it } from "vitest";
import { gcloud } from "../src/providers/gcloud.js";
import type { Exec } from "../src/types.js";

function fakeExec(result: { code: number; stdout?: string; stderr?: string }) {
  const calls: { bin: string; args: string[]; env: NodeJS.ProcessEnv }[] = [];
  const exec: Exec = async (bin, args, env) => {
    calls.push({ bin, args, env });
    return { stdout: "", stderr: "", ...result };
  };
  return { exec, calls };
}

const ctx = (args: string[], env: NodeJS.ProcessEnv = {}) => ({ args, env, cwd: "/repo" });
// Only these fields: the full list can hold credentials, and the output is cached.
const FORMAT =
  "--format=json(core.account,core.project,auth.impersonate_service_account,auth.access_token_file,auth.credential_file_override)";
// Shape observed from `gcloud config list --format=json` (SDK 588).
const listJson = (core: Record<string, string>) =>
  JSON.stringify({ core: { disable_usage_reporting: "True", ...core } });

describe("gcloud.isExempt", () => {
  it.each([
    [["auth", "login"]],
    [["auth", "list"]],
    [["config", "set", "project", "p"]],
    [["config", "configurations", "activate", "work"]],
    [["init"]],
    [["version"]],
    [["--version"]],
    [["info"]],
    [["help", "compute"]],
    [["compute", "instances", "list", "--help"]],
    [["components", "update"]],
  ])("allows %j", (args) => {
    expect(gcloud.isExempt(args)).toBe(true);
  });

  it.each([[["compute", "instances", "delete", "vm"]], [["run", "deploy"]], [["projects", "delete", "p"]], [[]]])(
    "guards %j",
    (args) => {
      expect(gcloud.isExempt(args)).toBe(false);
    },
  );
});

describe("gcloud.resolve", () => {
  it("reads account and project from gcloud config list", async () => {
    const { exec, calls } = fakeExec({ code: 0, stdout: listJson({ account: "me@x.com", project: "proj-1" }) });
    expect(await gcloud.resolve(ctx(["run", "deploy"]), exec)).toEqual({
      kind: "identity",
      identity: { account: "me@x.com", project: "proj-1" },
      source: "gcloud config list",
    });
    expect(calls[0]?.args).toEqual(["config", "list", FORMAT]);
  });

  it("passes the command's --account, --project and --configuration flags through", async () => {
    const { exec, calls } = fakeExec({ code: 0, stdout: listJson({ account: "a", project: "b" }) });
    await gcloud.resolve(
      ctx(["run", "deploy", "--project", "p2", "--account=a2@x.com", "--configuration", "work"]),
      exec,
    );
    expect(calls[0]?.args).toEqual([
      "config", "list", FORMAT,
      "--account", "a2@x.com", "--project", "p2", "--configuration", "work",
    ]);
  });

  it("passes the env through so CLOUDSDK_* variables count", async () => {
    const { exec, calls } = fakeExec({ code: 0, stdout: listJson({ account: "a" }) });
    await gcloud.resolve(ctx(["run", "deploy"], { CLOUDSDK_CORE_PROJECT: "p" }), exec);
    expect(calls[0]?.env.CLOUDSDK_CORE_PROJECT).toBe("p");
  });

  it("reports no account as logged-out", async () => {
    const { exec } = fakeExec({ code: 0, stdout: listJson({}) });
    expect(await gcloud.resolve(ctx(["run", "deploy"]), exec)).toEqual({
      kind: "logged-out",
      hint: "gcloud auth login",
    });
  });

  it("reports an unset project as empty, not as an error", async () => {
    const { exec } = fakeExec({ code: 0, stdout: listJson({ account: "me@x.com" }) });
    expect(await gcloud.resolve(ctx(["run", "deploy"]), exec)).toMatchObject({
      identity: { account: "me@x.com", project: "" },
    });
  });

  it("treats an unknown --configuration (empty output, exit 0, as observed) as logged-out", async () => {
    const { exec } = fakeExec({ code: 0, stdout: listJson({}) });
    const res = await gcloud.resolve(ctx(["run", "deploy", "--configuration", "nope"]), exec);
    expect(res.kind).toBe("logged-out");
  });

  it("passes gcloud's ERROR line on when the call fails", async () => {
    // gcloud's error format is "ERROR: (<command>) <message>".
    const { exec } = fakeExec({ code: 1, stderr: "ERROR: (gcloud.config.list) something broke\n" });
    expect(await gcloud.resolve(ctx(["run", "deploy"]), exec)).toEqual({
      kind: "error",
      message: "gcloud: (gcloud.config.list) something broke",
    });
  });
});

describe("gcloud.compare", () => {
  const identity = { account: "me@x.com", project: "proj-1" };

  it("matches account case-insensitively and project exactly", () => {
    expect(gcloud.compare({ account: "Me@X.com", project: "proj-1" }, identity)).toEqual([]);
  });

  it("checks only what is pinned", () => {
    expect(gcloud.compare({ project: "proj-1" }, { account: "other@x.com", project: "proj-1" })).toEqual([]);
  });

  it("reports each mismatch and an unset project", () => {
    expect(gcloud.compare({ account: "a@x.com", project: "p" }, { account: "me@x.com", project: "" })).toEqual([
      'account: expected "a@x.com", active is "me@x.com"',
      'project: expected "p", active is (not set)',
    ]);
  });

  it("suggests the config commands for what is pinned", () => {
    expect(gcloud.switchHint({ account: "a@x.com", project: "p" })).toBe(
      "gcloud config set account a@x.com && gcloud config set project p",
    );
  });
});
