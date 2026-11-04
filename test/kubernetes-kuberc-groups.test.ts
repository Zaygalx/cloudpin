import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { FoundConfig } from "../src/config.js";
import { guard } from "../src/guard.js";
import { kubernetes } from "../src/providers/kubernetes.js";
import type { Exec, Resolution } from "../src/types.js";
import { tempDir } from "./tmp.js";

// #140. Two gaps left by #133's short flag groups:
// 1. A kuberc alias whose prependArgs/appendArgs hold a short flag group (`-itnprod`, `-iA`).
//    kubernetes.io/docs/reference/kubectl/kuberc/: prependArgs go right after the alias name,
//    appendArgs at the end; `command` is the built-in command (with subcommands) it runs.
// 2. A value that looks like a flag. spf13/pflag (flag.go, parseSingleShortArg): a value letter
//    that ends its word takes the next word whole, whatever it holds, so in `-c -n x` the
//    container is "-n" and x is a positional argument, not the namespace.

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

const PROD = "https://prod.example.com";
const ALL = "(all namespaces)";

function home(kuberc?: string): string {
  const dir = tempDir("cloudpin-kuberc-groups-");
  mkdirSync(join(dir, ".kube"));
  writeFileSync(join(dir, ".kube", "config"), CONFIG);
  if (kuberc !== undefined) writeFileSync(join(dir, ".kube", "kuberc"), kuberc);
  return dir;
}

/** A kuberc with one alias `al` running `command` with the given extra arguments. */
function alias(command: string, extra: { prependArgs?: string[]; appendArgs?: string[] }): string {
  const list = (key: string, words?: string[]) =>
    words ? `    ${key}:\n${words.map((w) => `      - ${JSON.stringify(w)}\n`).join("")}` : "";
  return `apiVersion: kubectl.config.k8s.io/v1beta1
kind: Preference
aliases:
  - name: al
    command: ${command}
${list("prependArgs", extra.prependArgs)}${list("appendArgs", extra.appendArgs)}`;
}

const resolve = (args: string[], kuberc?: string, bin = "kubectl"): Promise<Resolution> =>
  kubernetes.resolve({ args, env: { HOME: home(kuberc) }, cwd: "/repo", bin }, noExec);

async function target(args: string[], kuberc?: string, bin = "kubectl") {
  const res = await resolve(args, kuberc, bin);
  if (res.kind === "identity") return { server: res.identity.server, namespace: res.identity.namespace };
  return res;
}

async function stoppedByAlias(kuberc: string, args = ["al", "pods"]) {
  const res = await resolve(args, kuberc);
  expect(res.kind, kuberc).toBe("error");
  return res.kind === "error" ? res.message : "";
}

describe("kuberc alias arguments with a short flag group (#140)", () => {
  it("sees -n inside a group, with the value joined to it", async () => {
    expect(await stoppedByAlias(alias("get", { prependArgs: ["-itnprod"] }))).toMatch(/alias "al" sets "n"/);
  });

  it("sees -n at the end of a group, with the value as the next word", async () => {
    expect(await stoppedByAlias(alias("get", { prependArgs: ["-it", "-itn", "prod"] }))).toMatch(/alias "al" sets "n"/);
    expect(await stoppedByAlias(alias("get", { appendArgs: ["-itn", "prod"] }))).toMatch(/alias "al" sets "n"/);
  });

  it("sees -A and -s inside a group", async () => {
    expect(await stoppedByAlias(alias("get", { prependArgs: ["-iA"] }))).toMatch(/alias "al" sets "A"/);
    expect(await stoppedByAlias(alias("get", { appendArgs: ["-wA"] }))).toMatch(/alias "al" sets "A"/);
    expect(await stoppedByAlias(alias("get", { prependArgs: ["-is", "https://other.example.com"] }))).toMatch(/alias "al" sets "s"/);
  });

  it("reads the letters as the alias's command does: -f is a boolean in logs", async () => {
    // `kubectl logs`: -f is --follow, so in -fnkube-system the n is the namespace.
    expect(await stoppedByAlias(alias("logs", { prependArgs: ["-fnkube-system"] }))).toMatch(/alias "al" sets "n"/);
    expect(await stoppedByAlias(alias("logs", { prependArgs: ["-pn", "kube-system"] }))).toMatch(/sets "n"/);
  });

  it("can't tell, and stops, when a letter it doesn't know comes before a target letter", async () => {
    const message = await stoppedByAlias(alias("get", { prependArgs: ["-xnsecret-ns"] }));
    expect(message).toMatch(/alias "al"/);
    expect(message).toMatch(/can't tell/);
    // The word may hold a value, so only the letter is named.
    expect(message).toContain("-x,");
    expect(message).not.toContain("xnsecret");
    expect(message).not.toContain("secret-ns");
  });

  it("stops when an alias's value letter gets a namespace from appendArgs, whatever its prependArgs end with", async () => {
    // prependArgs and appendArgs are not next to each other: the user's words sit between them.
    expect(await stoppedByAlias(alias("logs", { prependArgs: ["-c"], appendArgs: ["-n", "prod"] }), ["al", "pod"])).toMatch(/sets "n"/);
  });

  describe("controls: aliases that don't pick the target still run", () => {
    it("harmless groups and values", async () => {
      for (const words of [["-it"], ["-ojson"], ["-ojsonpath={.metadata.namespace}"], ["-lapp=ns"], ["-cmain-ns"]]) {
        expect(await target(["al", "pods"], alias("get", { prependArgs: words })), words.join(" ")).toEqual({
          server: PROD,
          namespace: "payments",
        });
      }
    });

    it("-f takes a value outside logs, so -fns.yaml is a file name", async () => {
      expect(await target(["al"], alias("apply", { prependArgs: ["-fns.yaml"] }))).toEqual({ server: PROD, namespace: "payments" });
    });

    it("a value letter's next word is its value, even when it looks like -n", async () => {
      expect(await target(["al", "pod"], alias("logs", { prependArgs: ["-c", "-n"] }))).toEqual({ server: PROD, namespace: "payments" });
    });

    it("words after -- belong to the command run in the pod", async () => {
      expect(await target(["al", "pod"], alias("exec", { appendArgs: ["--", "sh", "-itn", "x"] }))).toEqual({
        server: PROD,
        namespace: "payments",
      });
    });
  });
});

describe("the user's flags after a kuberc alias use the letters of the alias's command (#140)", () => {
  it("reads -fn in an alias of logs as --follow and the namespace", async () => {
    expect(await target(["al", "-fn", "kube-system", "pod"], alias("logs", {}))).toEqual({ server: PROD, namespace: "kube-system" });
  });

  it("control: -fns.yaml in an alias of apply is still a file name", async () => {
    expect(await target(["al", "-fns.yaml"], alias("apply", {}))).toEqual({ server: PROD, namespace: "payments" });
  });
});

describe("a short flag's value that looks like a flag (#140)", () => {
  it("gives -c the word -n, so the namespace is not the next word", async () => {
    expect(await target(["logs", "-c", "-n", "x"])).toEqual({ server: PROD, namespace: "payments" });
    expect(await target(["exec", "-c", "-n", "x", "--", "sh"])).toEqual({ server: PROD, namespace: "payments" });
  });

  it("gives -c the word -A, so the command does not target all namespaces", async () => {
    expect(await target(["logs", "-c", "-A", "pod"])).toEqual({ server: PROD, namespace: "payments" });
  });

  it("gives -f the word - (stdin), and reads the -n after it", async () => {
    expect(await target(["apply", "-f", "-", "-n", "x"])).toEqual({ server: PROD, namespace: "x" });
    expect(await target(["apply", "-f", "-n", "x"])).toEqual({ server: PROD, namespace: "payments" });
  });

  it("gives -c the word --, so it doesn't end the flags", async () => {
    expect(await target(["logs", "-c", "--", "-n", "x", "pod"])).toEqual({ server: PROD, namespace: "x" });
  });

  it("keeps a value that starts with =", async () => {
    expect(await target(["get", "pods", "-n", "=x"])).toEqual({ server: PROD, namespace: "=x" });
  });

  it("a value letter with no word after it sets nothing", async () => {
    expect(await target(["get", "pods", "-n"])).toEqual({ server: PROD, namespace: "payments" });
    expect(await target(["logs", "pod", "-c"])).toEqual({ server: PROD, namespace: "payments" });
  });

  it("gives a global long flag the next word, whatever it holds", async () => {
    expect(await target(["get", "pods", "--namespace", "-n", "x"])).toEqual({ server: PROD, namespace: "-n" });
    expect(await target(["get", "pods", "--user", "-A"])).toEqual({ server: PROD, namespace: "payments" });
  });

  it("helm: gives -f the word -n", async () => {
    expect(await target(["install", "-f", "-n", "x", "chart"], undefined, "helm")).toEqual({ server: PROD, namespace: "payments" });
  });

  describe("controls: what worked before still does", () => {
    it("-n x, -c main -n x and -n after --", async () => {
      expect(await target(["logs", "-n", "x", "pod"])).toEqual({ server: PROD, namespace: "x" });
      expect(await target(["logs", "-c", "main", "-n", "x", "pod"])).toEqual({ server: PROD, namespace: "x" });
      expect(await target(["exec", "pod", "--", "sh", "-n", "x"])).toEqual({ server: PROD, namespace: "payments" });
      expect(await target(["get", "pods", "-A"])).toEqual({ server: PROD, namespace: ALL });
      expect(await target(["upgrade", "-n", "x", "rel", "chart"], undefined, "helm")).toEqual({ server: PROD, namespace: "x" });
    });
  });
});

describe("guard with kuberc groups and flag-like values (#140)", () => {
  async function verdict(args: string[], namespace: string, kuberc?: string) {
    const config: FoundConfig = { path: "/repo/.cloudpin.yml", pins: { kubernetes: { server: PROD, namespace } } };
    return guard(
      { bin: "kubectl", args, env: { HOME: home(kuberc) }, cwd: "/repo", mode: "agent" },
      { providers: [kubernetes], exec: noExec, findConfig: () => config },
    );
  }

  it("stops an alias that sets the namespace in a group, as uncertain", async () => {
    const v = await verdict(["al", "pods"], "prod", alias("get", { prependArgs: ["-itnprod"] }));
    expect(v.action === "block" && v.uncertain).toBe(true);
  });

  it("allows an alias with only harmless groups", async () => {
    expect((await verdict(["al", "pods"], "payments", alias("get", { prependArgs: ["-it", "-ojson"] }))).action).toBe("allow");
  });

  it("blocks -c -n x pinned to x: the command uses the context's namespace", async () => {
    const v = await verdict(["logs", "-c", "-n", "x"], "x");
    expect(v.action).toBe("block");
    expect(v.action === "block" && v.problems.join(" ")).toContain('"payments"');
  });

  it("allows -n x pinned to x", async () => {
    expect((await verdict(["logs", "-n", "x", "pod"], "x")).action).toBe("allow");
  });
});
