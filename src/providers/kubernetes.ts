import { existsSync, readFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { parse, YAMLParseError } from "yaml";
import { commandWords as wordsAfterFlags, hasAnyFlag } from "../args.js";
import { home } from "../paths.js";
import type { ProviderDef, Resolution } from "../types.js";

/*
 * kubectl and helm target the cluster and namespace their kubeconfig and flags
 * select. cloudpin reads the kubeconfig itself (never printing it: it holds
 * credentials) instead of asking kubectl, so helm is guarded even where
 * kubectl is not installed, and no process is spawned.
 * Loading and merging: kubernetes.io/docs/concepts/configuration/organize-cluster-access-kubeconfig/
 */

const ALL_NAMESPACES = "(all namespaces)";

// Commands that never contact a cluster (kubectl --help; helm.sh/docs/helm),
// plus `version`, which cloudpin always lets through. `explain` and
// `api-resources` ask the server, so they are guarded (and read-only).
const KUBECTL_EXEMPT = new Set(["config", "version", "help", "completion", "kustomize", "plugin", "options", "kuberc"]);
const HELM_EXEMPT = new Set([
  "create", "dependency", "dep", "env", "lint", "package", "plugin", "pull", "fetch", "push", "registry",
  "repo", "search", "show", "inspect", "template", "verify", "version", "help", "completion",
]);

/**
 * A flag's last value. Long flags as `--name value` / `--name=value`; one-letter
 * flags also as pflag accepts them, `-n value`, `-n=value` and `-nvalue`, so
 * `kubectl -nkube-system delete ...` is not mistaken for the default namespace.
 */
function flag(args: string[], long: string[], short?: string): string | undefined {
  let found: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--") break;
    for (const name of long) {
      if (arg === name && i + 1 < args.length) found = args[i + 1];
      else if (arg.startsWith(`${name}=`)) found = arg.slice(name.length + 1);
    }
    if (short && arg.startsWith(short) && !arg.startsWith("--")) {
      if (arg === short && i + 1 < args.length) found = args[i + 1];
      else if (arg.length > short.length) found = arg.slice(short.length).replace(/^=/, "");
    }
  }
  return found || undefined;
}

export interface Kubeconfig {
  currentContext?: string;
  contexts: Map<string, { cluster?: string; namespace?: string }>;
  clusters: Map<string, { server?: string }>;
}

export type Loaded = { config: Kubeconfig; files: string[] } | { error: Resolution };

const str = (v: unknown): string | undefined => (typeof v === "string" && v !== "" ? v : undefined);
const map = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

/** Reads and merges the kubeconfig files: the first file to set a value or a named entry wins. */
export function loadKubeconfig(explicit: string | undefined, env: NodeJS.ProcessEnv): Loaded {
  let paths: string[];
  if (explicit) {
    // --kubeconfig: only that file, which must exist.
    if (!existsSync(explicit)) return { error: { kind: "error", message: `kubeconfig ${explicit} was not found` } };
    paths = [explicit];
  } else if (env.KUBECONFIG) {
    paths = env.KUBECONFIG.split(delimiter).filter(Boolean);
  } else {
    paths = [join(home(env), ".kube", "config")];
  }
  const config: Kubeconfig = { contexts: new Map(), clusters: new Map() };
  const files: string[] = [];
  for (const path of paths) {
    if (!existsSync(path)) continue;
    let doc: unknown;
    try {
      doc = parse(readFileSync(path, "utf8"), { schema: "failsafe" });
    } catch (err) {
      // Never echo the parser's message: it quotes the file, which holds credentials.
      const line = err instanceof YAMLParseError ? ` (line ${err.linePos?.[0].line ?? "?"})` : "";
      return { error: { kind: "error", message: `kubeconfig ${path} is not valid YAML${line}` } };
    }
    files.push(path);
    const top = map(doc);
    config.currentContext ??= str(top["current-context"]);
    for (const entry of Array.isArray(top.contexts) ? top.contexts : []) {
      const name = str(map(entry).name);
      const body = map(map(entry).context);
      if (name && !config.contexts.has(name)) {
        config.contexts.set(name, { cluster: str(body.cluster), namespace: str(body.namespace) });
      }
    }
    for (const entry of Array.isArray(top.clusters) ? top.clusters : []) {
      const name = str(map(entry).name);
      if (name && !config.clusters.has(name)) config.clusters.set(name, { server: str(map(map(entry).cluster).server) });
    }
  }
  return { config, files };
}

/** The flags and variables that pick the target, per CLI. */
function selectors(bin: string | undefined, args: string[], env: NodeJS.ProcessEnv) {
  if (bin === "helm") {
    // helm.sh/docs/helm/helm: flags beat their HELM_* variables.
    return {
      kubeconfig: flag(args, ["--kubeconfig"]),
      context: flag(args, ["--kube-context"]) ?? str(env.HELM_KUBECONTEXT),
      cluster: undefined,
      server: flag(args, ["--kube-apiserver"]) ?? str(env.HELM_KUBEAPISERVER),
      namespace: flag(args, ["--namespace"], "-n") ?? str(env.HELM_NAMESPACE),
    };
  }
  return {
    kubeconfig: flag(args, ["--kubeconfig"]),
    context: flag(args, ["--context"]),
    cluster: flag(args, ["--cluster"]),
    server: flag(args, ["--server"], "-s"),
    namespace: flag(args, ["--namespace"], "-n"),
  };
}

// Options that pick the cluster or namespace, as kuberc names them (flag names without dashes).
const TARGET_OPTIONS = new Set(["namespace", "n", "context", "cluster", "server", "s", "kubeconfig", "user", "all-namespaces", "A"]);

function setsTarget(options: unknown, extraArgs: unknown[]): string | undefined {
  for (const option of Array.isArray(options) ? options : []) {
    const name = str(map(option).name);
    if (name && TARGET_OPTIONS.has(name)) return name;
  }
  for (const arg of extraArgs) {
    if (typeof arg !== "string" || !arg.startsWith("-")) continue;
    // "--context=prod" -> "context"; "-nweb" or "-n" -> "n".
    const name = arg.startsWith("--") ? arg.slice(2).split("=")[0]! : arg.slice(1, 2);
    if (TARGET_OPTIONS.has(name)) return name;
  }
  return undefined;
}

/**
 * kubectl 1.33+ applies ~/.kube/kuberc: per-command option defaults and
 * aliases (kubernetes.io/docs/reference/kubectl/kuberc/). If the ones this
 * command uses set the context, namespace or server, cloudpin cannot be sure
 * of the target, so it says so (and the command is stopped). Aliases cannot
 * reuse a built-in command name. Returns the problem, or undefined.
 */
function kubercProblem(args: string[], env: NodeJS.ProcessEnv): string | undefined {
  if (env.KUBERC === "off" || env.KUBECTL_KUBERC === "false") return undefined;
  const path = flag(args, ["--kuberc"]) ?? str(env.KUBERC) ?? join(home(env), ".kube", "kuberc");
  if (!existsSync(path)) return undefined;
  let doc: unknown;
  try {
    doc = parse(readFileSync(path, "utf8"), { schema: "failsafe" });
  } catch {
    return `kuberc ${path} is not valid YAML`;
  }
  const [command] = commandWords(args);
  if (!command) return undefined;
  const top = map(doc);
  for (const entry of Array.isArray(top.defaults) ? top.defaults : []) {
    const forCommand = (str(map(entry).command) ?? str(map(entry).name))?.split(/\s+/)[0];
    const option = forCommand === command ? setsTarget(map(entry).options, []) : undefined;
    if (option) return `kuberc ${path} sets "${option}" for "${command}"; cloudpin can't tell which cluster or namespace that picks (set KUBERC=off to check without it)`;
  }
  for (const entry of Array.isArray(top.aliases) ? top.aliases : []) {
    const e = map(entry);
    if (str(e.name) !== command) continue;
    const extra = [...(Array.isArray(e.prependArgs) ? e.prependArgs : []), ...(Array.isArray(e.appendArgs) ? e.appendArgs : [])];
    const option = setsTarget(e.options, extra);
    if (option) return `kuberc ${path} alias "${command}" sets "${option}"; cloudpin can't tell which cluster or namespace that picks`;
  }
  return undefined;
}

function allNamespaces(args: string[]): boolean {
  const end = args.indexOf("--");
  const own = end === -1 ? args : args.slice(0, end);
  return own.some((a) => a === "-A" || a === "--all-namespaces" || a === "--all-namespaces=true");
}

/** Drops `user:password@` from a server URL, so it never reaches a message or `status`. */
function withoutUserinfo(server: string): string {
  return server.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/@]*@/i, "$1");
}

export function normaliseServer(server: string): string {
  try {
    const url = new URL(server);
    // URL lowercases the scheme and host; paths stay case-sensitive.
    return `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, "")}`;
  } catch {
    return server.replace(/\/+$/, "");
  }
}

export const kubernetes: ProviderDef<"kubernetes"> = {
  name: "kubernetes",
  bins: ["kubectl", "helm"],
  statusCommand: "kubectl config view --minify",

  cacheInputs() {
    // Identity is read from the kubeconfig on every command; nothing is spawned or cached.
    return { env: [], files: [], dirs: [] };
  },

  isExempt(args, bin) {
    if (hasAnyFlag(args, ["--help", "-h"])) return true;
    const [first] = commandWords(args);
    if (first === undefined) return hasAnyFlag(args, ["--version"]);
    return (bin === "helm" ? HELM_EXEMPT : KUBECTL_EXEMPT).has(first);
  },

  async resolve({ args, env, bin }) {
    if (bin !== "helm") {
      const problem = kubercProblem(args, env);
      if (problem) return { kind: "error", message: problem };
    }
    const sel = selectors(bin, args, env);
    const loaded = loadKubeconfig(sel.kubeconfig, env);
    if ("error" in loaded) return loaded.error;
    const { config, files } = loaded;
    if (files.length === 0 && !sel.server) {
      return { kind: "logged-out", hint: "no kubeconfig found; get one from your cluster (e.g. az aks get-credentials) or set KUBECONFIG" };
    }
    const contextName = sel.context ?? config.currentContext;
    if (!contextName && !sel.server) {
      return { kind: "logged-out", hint: "no current context; kubectl config use-context <name>" };
    }
    const context = contextName ? config.contexts.get(contextName) : undefined;
    if (contextName && !context) {
      return { kind: "error", message: `context "${contextName}" is not defined in the kubeconfig` };
    }
    let server = sel.server;
    if (!server) {
      const clusterName = sel.cluster ?? context?.cluster;
      const cluster = clusterName ? config.clusters.get(clusterName) : undefined;
      if (!clusterName || !cluster) {
        return { kind: "error", message: `cluster "${clusterName ?? ""}" is not defined in the kubeconfig` };
      }
      if (!cluster.server) return { kind: "error", message: `cluster "${clusterName}" has no server in the kubeconfig` };
      server = cluster.server;
    }
    const namespace = allNamespaces(args) ? ALL_NAMESPACES : (sel.namespace ?? context?.namespace ?? "default");
    return {
      kind: "identity",
      identity: { server: withoutUserinfo(server), namespace, context: contextName ?? "" },
      source: "kubeconfig",
    };
  },

  compare(pin, identity) {
    const out: string[] = [];
    if (normaliseServer(identity.server ?? "") !== normaliseServer(pin.server)) {
      const ctx = identity.context ? ` (context "${identity.context}")` : "";
      out.push(`server: expected "${pin.server}", active is "${identity.server}"${ctx}`);
    }
    if (pin.namespace && identity.namespace !== pin.namespace) {
      out.push(
        identity.namespace === ALL_NAMESPACES
          ? `namespace: expected "${pin.namespace}", the command targets all namespaces`
          : `namespace: expected "${pin.namespace}", the command uses "${identity.namespace}"`,
      );
    }
    return out;
  },

  switchHint(pin) {
    const ns = pin.namespace ? `, and pass -n ${pin.namespace}` : "";
    return `kubectl config get-contexts, then kubectl config use-context <the context for ${pin.server}>${ns}`;
  },
};

// Global flags that take a value (`kubectl options`, helm.sh/docs/helm/helm), so
// in `kubectl --context prod delete ...` the word "prod" is not the command.
const VALUE_FLAGS = new Set([
  "--as", "--as-group", "--as-uid", "--as-user-extra", "--cache-dir", "--certificate-authority",
  "--client-certificate", "--client-key", "--cluster", "--context", "--kubeconfig", "--kuberc",
  "--log-flush-frequency", "-n", "--namespace", "--password", "--profile", "--profile-output",
  "--request-timeout", "-s", "--server", "--tls-server-name", "--token", "--user", "--username", "-v", "--v",
  "--vmodule",
  "--burst-limit", "--kube-apiserver", "--kube-as-group", "--kube-as-user", "--kube-ca-file", "--kube-context",
  "--kube-tls-server-name", "--kube-token", "--qps", "--registry-config", "--repository-cache", "--repository-config",
]);

/**
 * The command's words with flags and global flag values left out, e.g.
 * ["delete", "pod", "x"] for `kubectl -n web --context prod delete pod x`.
 * Only global flags come before the command word, and kubectl and helm reject
 * unknown ones, so the first word is the command.
 */
export function commandWords(args: string[]): string[] {
  return wordsAfterFlags(args, VALUE_FLAGS);
}
