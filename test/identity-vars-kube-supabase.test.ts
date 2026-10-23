import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { FoundConfig } from "../src/config.js";
import { guard, type Verdict } from "../src/guard.js";
import { kubernetes } from "../src/providers/kubernetes.js";
import { supabase } from "../src/providers/supabase.js";
import { type Exec, type ProviderDef, UNKNOWN_VALUE } from "../src/types.js";
import { tempDir } from "./tmp.js";

// #133 (owner's comment): the #86 "can't tell" check covers the variables a provider lists in
// cacheInputs().env. Every variable `resolve` reads to pick the target must be listed, so
// `KUBECONFIG=$(...) kubectl apply` is stopped instead of checked against another file.

const PROD = "https://prod.example.com";
const CONFIG = `apiVersion: v1
kind: Config
current-context: prod
clusters:
- name: prod-cluster
  cluster:
    server: ${PROD}
contexts:
- name: prod
  context:
    cluster: prod-cluster
    namespace: payments
`;

function kubeHome(): string {
  const dir = tempDir("cloudpin-kube-vars-");
  mkdirSync(join(dir, ".kube"));
  writeFileSync(join(dir, ".kube", "config"), CONFIG);
  return dir;
}

async function check(provider: ProviderDef, bin: string, args: string[], env: NodeJS.ProcessEnv, pins: FoundConfig["pins"], exec: Exec, cwd = "/repo"): Promise<Verdict> {
  const config: FoundConfig = { path: "/repo/.cloudpin.yml", pins };
  return guard({ bin, args, env, cwd, mode: "agent" }, { providers: [provider], exec, findConfig: () => config });
}

const noExec: Exec = async () => {
  throw new Error("kubernetes must not spawn a process");
};

describe("kubernetes: a target variable set from something unknown in advance (#133)", () => {
  const pins = { kubernetes: { server: PROD, namespace: "payments" } };
  const cases: [string, string][] = [
    ["KUBECONFIG", "kubectl"],
    ["KUBERC", "kubectl"],
    ["KUBECTL_KUBERC", "kubectl"],
    ["HOME", "kubectl"],
    ["USERPROFILE", "kubectl"],
    ["HELM_KUBECONTEXT", "helm"],
    ["HELM_KUBEAPISERVER", "helm"],
    ["HELM_NAMESPACE", "helm"],
  ];
  for (const [name, bin] of cases) {
    it(`blocks ${bin} as uncertain when ${name} is unknown`, async () => {
      const dir = kubeHome();
      const env = { HOME: dir, USERPROFILE: dir, [name]: UNKNOWN_VALUE };
      const v = await check(kubernetes, bin, ["delete", "pod", "x"], env, pins, noExec);
      expect(v.action).toBe("block");
      expect(v.action === "block" && v.uncertain).toBe(true);
      expect(v.action === "block" && v.problems.join(" ")).toContain(name);
    });
  }

  it("still resolves known values", async () => {
    const dir = kubeHome();
    const base = { HOME: dir, USERPROFILE: dir };
    const allowed = async (bin: string, env: NodeJS.ProcessEnv) =>
      (await check(kubernetes, bin, ["delete", "pod", "x"], { ...base, ...env }, pins, noExec)).action;
    expect(await allowed("kubectl", { KUBECONFIG: join(dir, ".kube", "config") })).toBe("allow");
    expect(await allowed("kubectl", { KUBERC: "off" })).toBe("allow");
    expect(await allowed("kubectl", { KUBECTL_KUBERC: "false" })).toBe("allow");
    expect(await allowed("helm", { HELM_KUBECONTEXT: "prod" })).toBe("allow");
    expect(await allowed("helm", { HELM_KUBEAPISERVER: PROD })).toBe("allow");
    expect(await allowed("helm", { HELM_NAMESPACE: "payments" })).toBe("allow");
    // Control: a known wrong value still blocks, and not as uncertain.
    const wrong = await check(kubernetes, "helm", ["delete", "x"], { ...base, HELM_NAMESPACE: "other" }, pins, noExec);
    expect(wrong.action === "block" && !wrong.uncertain).toBe(true);
  });
});

describe("supabase: a project variable set from something unknown in advance (#133)", () => {
  const REF = "abcdefghijklmnopqrst";
  const OTHER = "zyxwvutsrqponmlkjihg";
  const projects: Exec = async () => ({
    code: 0,
    stdout: JSON.stringify({ projects: [{ id: REF, organization_slug: "acme" }, { id: OTHER, organization_slug: "acme" }] }),
    stderr: "",
  });
  const pins = { supabase: { project: REF } };
  const token = { SUPABASE_ACCESS_TOKEN: "example-not-a-token" };

  function linked(ref: string): string {
    const root = tempDir("cloudpin-supabase-vars-");
    mkdirSync(join(root, "supabase", ".temp"), { recursive: true });
    writeFileSync(join(root, "supabase", "config.toml"), "");
    writeFileSync(join(root, "supabase", ".temp", "project-ref"), ref);
    return root;
  }

  for (const name of ["SUPABASE_PROJECT_ID", "SUPABASE_WORKDIR"]) {
    it(`blocks as uncertain when ${name} is unknown`, async () => {
      const v = await check(supabase, "supabase", ["db", "push"], { ...token, [name]: UNKNOWN_VALUE }, pins, projects, linked(REF));
      expect(v.action).toBe("block");
      expect(v.action === "block" && v.uncertain).toBe(true);
      expect(v.action === "block" && v.problems.join(" ")).toContain(name);
    });
  }

  it("still resolves known values", async () => {
    const here = linked(REF);
    const verdict = (env: NodeJS.ProcessEnv) => check(supabase, "supabase", ["db", "push"], { ...token, ...env }, pins, projects, here);
    expect((await verdict({ SUPABASE_PROJECT_ID: REF })).action).toBe("allow");
    expect((await verdict({ SUPABASE_WORKDIR: linked(REF) })).action).toBe("allow");
    // Controls: known values that pick another project block, and not as uncertain.
    const otherId = await verdict({ SUPABASE_PROJECT_ID: OTHER });
    expect(otherId.action === "block" && !otherId.uncertain).toBe(true);
    const otherDir = await verdict({ SUPABASE_WORKDIR: linked(OTHER) });
    expect(otherDir.action === "block" && !otherDir.uncertain).toBe(true);
  });
});
