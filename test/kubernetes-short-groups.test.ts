import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { FoundConfig } from "../src/config.js";
import { guard } from "../src/guard.js";
import { kubernetes } from "../src/providers/kubernetes.js";
import type { Exec, Resolution } from "../src/types.js";
import { tempDir } from "./tmp.js";

// #133. kubectl and helm parse flags with spf13/pflag (flag.go, parseShortArg and
// parseSingleShortArg): a single-dash word is read one letter at a time; a letter that takes
// no value consumes one letter, and the first letter that takes a value takes the rest of
// the word (`-itnprod`), or `=value` (`-in=prod`), or the next word when it is the last
// letter (`-itn prod`).

const noExec: Exec = async () => {
  throw new Error("kubernetes must not spawn a process");
};

const CONFIG = `apiVersion: v1
kind: Config
current-context: prod
clusters:
- name: prod-cluster
  cluster:
    server: https://prod.example.com
contexts:
- name: prod
  context:
    cluster: prod-cluster
    namespace: payments
`;

function home(): string {
  const dir = tempDir("cloudpin-kube-groups-");
  mkdirSync(join(dir, ".kube"));
  writeFileSync(join(dir, ".kube", "config"), CONFIG);
  return dir;
}

const resolve = (args: string[], bin = "kubectl"): Promise<Resolution> =>
  kubernetes.resolve({ args, env: { HOME: home() }, cwd: "/repo", bin }, noExec);

/** The namespace and server the command would use, or the error. */
async function target(args: string[], bin = "kubectl") {
  const res = await resolve(args, bin);
  if (res.kind === "identity") return { server: res.identity.server, namespace: res.identity.namespace };
  return res;
}

const PROD = "https://prod.example.com";
const ALL = "(all namespaces)";

describe("kubectl short flag groups (#133)", () => {
  it("reads -n at the end of a group, with the value as the next word", async () => {
    expect(await target(["exec", "-itn", "other-ns", "pod", "--", "sh"])).toEqual({ server: PROD, namespace: "other-ns" });
  });

  it("reads -n inside a group, with the value joined to it", async () => {
    expect(await target(["exec", "-itnother-ns", "pod", "--", "sh"])).toEqual({ server: PROD, namespace: "other-ns" });
  });

  it("reads -n= inside a group", async () => {
    expect(await target(["exec", "-in=other-ns", "pod", "--", "sh"])).toEqual({ server: PROD, namespace: "other-ns" });
  });

  it("reads -s at the end of a group as the server", async () => {
    expect(await target(["exec", "-is", "https://other.example.com", "pod"])).toEqual({
      server: "https://other.example.com",
      namespace: "payments",
    });
  });

  it("reads -A inside a group as all namespaces", async () => {
    expect(await target(["get", "pods", "-Aw"])).toEqual({ server: PROD, namespace: ALL });
    expect(await target(["get", "pods", "-wA"])).toEqual({ server: PROD, namespace: ALL });
    expect(await target(["get", "pods", "-Ao", "wide"])).toEqual({ server: PROD, namespace: ALL });
  });

  it("reads a boolean's =value as Go's strconv.ParseBool does", async () => {
    expect(await target(["get", "pods", "-wA=false"])).toEqual({ server: PROD, namespace: "payments" });
    expect(await target(["get", "pods", "-wA=true"])).toEqual({ server: PROD, namespace: ALL });
    expect(await target(["get", "pods", "--all-namespaces=1"])).toEqual({ server: PROD, namespace: ALL });
  });

  it("follows the letters that are booleans only in some commands", async () => {
    // `kubectl logs`: -f is --follow and -p is --previous; elsewhere they take a value.
    expect(await target(["logs", "-fn", "kube-system", "pod"])).toEqual({ server: PROD, namespace: "kube-system" });
    expect(await target(["logs", "-pn", "kube-system", "pod"])).toEqual({ server: PROD, namespace: "kube-system" });
    expect(await target(["apply", "-fns.yaml"])).toEqual({ server: PROD, namespace: "payments" });
    // `kubectl proxy`: -w is --www, which takes a value.
    expect(await target(["proxy", "-wnstatic"])).toEqual({ server: PROD, namespace: "payments" });
  });

  it("leaves a value that starts with a value letter alone, whatever letters it holds", async () => {
    expect(await target(["get", "pods", "-ojsonpath={..namespace}"])).toEqual({ server: PROD, namespace: "payments" });
    expect(await target(["get", "pods", "-lapp=nginx,tier=ns"])).toEqual({ server: PROD, namespace: "payments" });
    expect(await target(["exec", "-cmain-ns", "pod"])).toEqual({ server: PROD, namespace: "payments" });
  });

  it("can't tell when a letter it doesn't know comes before -n, -s or -A", async () => {
    for (const args of [["get", "pods", "-xn", "other"], ["get", "pods", "-ixs", "https://x"], ["get", "pods", "-zA"]]) {
      const res = await resolve(args);
      expect(res.kind, args.join(" ")).toBe("error");
      expect(res.kind === "error" && res.message).toMatch(/can't tell/);
    }
  });

  it("gives a value letter at the end of a group the next word, whatever it holds", async () => {
    // pflag: `-fc -xn` is --follow and --container "-xn", not the flags -x -n.
    expect(await target(["logs", "-fc", "-xn", "pod"])).toEqual({ server: PROD, namespace: "payments" });
  });

  it("ignores groups after --, which belong to the command run in the pod", async () => {
    expect(await target(["exec", "pod", "--", "sh", "-itn", "other"])).toEqual({ server: PROD, namespace: "payments" });
  });

  describe("controls: what worked before still does", () => {
    it("-it alone changes nothing", async () => {
      expect(await target(["exec", "-it", "pod", "--", "sh"])).toEqual({ server: PROD, namespace: "payments" });
    });

    it("an unknown group without -n, -s or -A changes nothing", async () => {
      expect(await target(["get", "pods", "-xy"])).toEqual({ server: PROD, namespace: "payments" });
    });

    it("-n ns and -nns", async () => {
      expect(await target(["exec", "-n", "other-ns", "-it", "pod"])).toEqual({ server: PROD, namespace: "other-ns" });
      expect(await target(["exec", "-nother-ns", "-it", "pod"])).toEqual({ server: PROD, namespace: "other-ns" });
    });

    it("the last namespace wins, groups included", async () => {
      expect(await target(["exec", "-n", "first", "-itn", "second", "pod"])).toEqual({ server: PROD, namespace: "second" });
      expect(await target(["exec", "-itn", "first", "-n", "second", "pod"])).toEqual({ server: PROD, namespace: "second" });
    });
  });
});

describe("helm short flag groups (#133)", () => {
  // helm v3.22.1 and v4.3.1 source (pkg/cmd/*.go, cmd/helm/*.go): -n is the global namespace.
  it("reads -n in a group", async () => {
    expect(await target(["upgrade", "-in", "other-ns", "rel", "chart"], "helm")).toEqual({ server: PROD, namespace: "other-ns" });
    expect(await target(["list", "-qnother-ns"], "helm")).toEqual({ server: PROD, namespace: "other-ns" });
    expect(await target(["list", "-qA"], "helm")).toEqual({ server: PROD, namespace: ALL });
  });

  it("leaves a value letter's value alone", async () => {
    expect(await target(["install", "-fvalues-ns.yaml", "rel", "chart"], "helm")).toEqual({ server: PROD, namespace: "payments" });
  });

  it("can't tell when a letter it doesn't know comes before -n or -A", async () => {
    expect((await resolve(["list", "-xn", "other"], "helm")).kind).toBe("error");
    expect((await resolve(["list", "-xA"], "helm")).kind).toBe("error");
  });
});

describe("guard with a group (#133)", () => {
  async function verdict(args: string[], namespace: string) {
    const config: FoundConfig = { path: "/repo/.cloudpin.yml", pins: { kubernetes: { server: PROD, namespace } } };
    return guard(
      { bin: "kubectl", args, env: { HOME: home() }, cwd: "/repo", mode: "agent" },
      { providers: [kubernetes], exec: noExec, findConfig: () => config },
    );
  }

  it("allows the pinned namespace given in a group", async () => {
    expect((await verdict(["exec", "-itn", "web", "pod", "--", "sh"], "web")).action).toBe("allow");
  });

  it("blocks another namespace given in a group", async () => {
    const v = await verdict(["exec", "-itn", "other-ns", "pod", "--", "sh"], "payments");
    expect(v.action).toBe("block");
    expect(v.action === "block" && v.problems.join(" ")).toContain('"other-ns"');
  });

  it("blocks a group it can't read, as uncertain", async () => {
    const v = await verdict(["get", "pods", "-xn", "other"], "payments");
    expect(v.action === "block" && v.uncertain).toBe(true);
  });
});
