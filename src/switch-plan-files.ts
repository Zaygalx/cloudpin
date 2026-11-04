import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";
import { profilesForAccount, readAwsProfiles } from "./aws-config.js";
import { home } from "./paths.js";
import { type Kubeconfig, loadKubeconfig, normaliseServer } from "./providers/kubernetes.js";
import type { PlanInput } from "./switch-plan.js";
import { AWS_PROFILE_NAME, type Plan, quoted, safeName, unknownLine } from "./switch-planners.js";

/*
 * The `cloudpin switch` planners that read a CLI's config file instead of asking the CLI (#14): the kubeconfig,
 * and the AWS config file (aws-config.ts).
 */

/**
 * The file `kubectl config use-context` writes current-context to, as client-go
 * picks it (tools/clientcmd/config.go, PathOptions.GetDefaultFilename): the only
 * KUBECONFIG entry, else the first that exists, else the last; without
 * KUBECONFIG, ~/.kube/config.
 */
export function defaultKubeconfigFile(env: NodeJS.ProcessEnv): string {
  const files = (env.KUBECONFIG ?? "").split(delimiter).filter(Boolean);
  if (files.length === 0) return join(home(env), ".kube", "config");
  if (files.length === 1) return files[0]!;
  return files.find((f) => existsSync(f)) ?? files[files.length - 1]!;
}

export async function planKubernetes({ pin, entry, env, onPath }: PlanInput): Promise<Plan> {
  if (entry.status === "unknown") return { manual: [unknownLine(entry)] };
  const loaded = loadKubeconfig(undefined, env);
  if ("error" in loaded) {
    return { manual: [loaded.error.kind === "error" ? loaded.error.message : "the kubeconfig can't be read"] };
  }
  const { config } = loaded;
  const server = normaliseServer(pin.server!);
  const serverOf = (ctx: { cluster?: string }) => (ctx.cluster ? config.clusters.get(ctx.cluster)?.server : undefined);
  const matching = [...config.contexts].filter(([, ctx]) => {
    const s = serverOf(ctx);
    return s !== undefined && normaliseServer(s) === server;
  });
  const manual = helmContextLine(config, env, server, pin.namespace);
  if (matching.length === 0) {
    return { manual: [`add a context for ${pin.server} to your kubeconfig (e.g. az aks get-credentials), then run cloudpin switch again`, ...manual] };
  }
  const ns = pin.namespace;
  const preferred = ns ? matching.filter(([, ctx]) => (ctx.namespace ?? "default") === ns) : matching;
  const pool = preferred.length > 0 ? preferred : matching;
  const setNamespace = ns !== undefined && preferred.length === 0;
  if (setNamespace && !safeName(ns)) return { manual: [`set the namespace yourself: kubectl config set-context --current --namespace=${quoted(ns)}`, ...manual] };

  const unsafe = pool.filter(([name]) => !safeName(name)).map(([name]) => name);
  const safe = pool.filter(([name]) => safeName(name)).map(([name]) => name);
  for (const name of unsafe) manual.push(`context ${quoted(name)} points at ${pin.server}; cloudpin won't pass that name on, so run it yourself: kubectl config use-context ${quoted(name)}`);
  if (safe.length === 0) return { manual };
  if (onPath && !onPath("kubectl")) {
    return { manual: [`kubectl is not installed, so cloudpin can't switch; set current-context to ${quoted(safe[0]!)} in ${defaultKubeconfigFile(env)}`, ...manual] };
  }

  const commandsFor = (name: string): string[][] => [
    ...(name === config.currentContext ? [] : [["kubectl", "config", "use-context", name]]),
    ...(setNamespace ? [["kubectl", "config", "set-context", "--current", `--namespace=${ns}`]] : []),
  ];
  const useNote = `kubectl config use-context writes current-context to ${defaultKubeconfigFile(env)}`;
  if (safe.length > 1) {
    const notes = [useNote, ...(setNamespace ? [`then sets namespace ${ns} on the context you pick, in your kubeconfig`] : [])];
    return { candidates: safe.map((name) => ({ name, commands: commandsFor(name) })), chained: true, notes, manual };
  }
  const name = safe[0]!;
  const notes = [
    ...(name === config.currentContext ? [] : [useNote]),
    ...(setNamespace ? [`kubectl config set-context --current sets namespace ${ns} on context ${quoted(name)} in your kubeconfig`] : []),
  ];
  return { commands: commandsFor(name), chained: true, notes, manual };
}

/** helm uses its own variables instead of the current context's values (helm.sh/docs/helm/helm), which `use-context` doesn't change. */
function helmContextLine(config: Kubeconfig, env: NodeJS.ProcessEnv, server: string, namespace: string | undefined): string[] {
  const lines: string[] = [];
  const name = env.HELM_KUBECONTEXT;
  if (name) {
    const ctx = config.contexts.get(name);
    const s = ctx?.cluster ? config.clusters.get(ctx.cluster)?.server : undefined;
    const right = s !== undefined && normaliseServer(s) === server && (!namespace || (ctx?.namespace ?? "default") === namespace);
    if (!right) lines.push("unset HELM_KUBECONTEXT: helm uses it instead of the current context");
  }
  if (env.HELM_KUBEAPISERVER && normaliseServer(env.HELM_KUBEAPISERVER) !== server) {
    lines.push("unset HELM_KUBEAPISERVER: helm uses it instead of the current context's server");
  }
  if (namespace && env.HELM_NAMESPACE && env.HELM_NAMESPACE !== namespace) {
    lines.push("unset HELM_NAMESPACE: helm uses it instead of the current context's namespace");
  }
  return lines;
}

const AWS_KEY_VARS = "AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_SESSION_TOKEN";

/** How to set AWS_PROFILE by hand, when cloudpin can't set it in the user's shell. */
function exportLine(name: string): string {
  return (
    `in your shell: export AWS_PROFILE=${name} (PowerShell: $env:AWS_PROFILE = '${name}'). cloudpin can't set it in this ` +
    `shell (it can through the cloudpin function from cloudpin shell-init). An agent's shell doesn't keep it either: ` +
    `pass --profile ${name} to each aws command instead`
  );
}

export async function planAws({ pin, entry, env, envFile }: PlanInput): Promise<Plan> {
  // Keys in the environment beat any profile (cli-configure-files.html, precedence).
  if (env.AWS_ACCESS_KEY_ID) return { manual: [`unset ${AWS_KEY_VARS}: keys in the environment beat any profile`] };
  const read = readAwsProfiles(env);
  if ("error" in read) return { manual: [read.error] };
  const names = profilesForAccount(read.profiles, pin.account!);
  if (names.length === 0) {
    return {
      manual: [
        `add a profile for account ${pin.account} to ${read.path} (aws configure sso); profiles that use only ` +
          "credential_process or static keys name no account cloudpin can read without asking AWS, so they can't be matched",
      ],
    };
  }
  // aws-cli v2 reads AWS_PROFILE before AWS_DEFAULT_PROFILE (configprovider.py),
  // and with neither set uses [default], so planning AWS_PROFILE=default would change nothing.
  const current = env.AWS_PROFILE || env.AWS_DEFAULT_PROFILE || "default";
  if (current && names.includes(current)) {
    return {
      manual: [
        entry.status === "not-logged-in" && entry.fix
          ? `log in: ${entry.fix}`
          : `profile ${current}, already in use, names account ${pin.account} but acts as another; look with: aws sts get-caller-identity --profile ${current}`,
      ],
    };
  }
  const safe = names.filter((n) => AWS_PROFILE_NAME.test(n));
  const manual = names
    .filter((n) => !AWS_PROFILE_NAME.test(n))
    .map((n) => `profile ${quoted(n)} names account ${pin.account}, but cloudpin only sets AWS_PROFILE to [A-Za-z0-9._-] names; set it yourself`);
  if (safe.length === 0) return { manual };
  if (!envFile) {
    if (safe.length === 1) return { manual: [exportLine(safe[0]!), ...manual] };
    return {
      listed: safe,
      manual: [`profiles for account ${pin.account}: ${safe.join(", ")}; ${exportLine("<one of them>")}`, ...manual],
    };
  }
  if (safe.length === 1) return { awsProfile: safe[0]!, manual };
  return { candidates: safe.map((name) => ({ name, commands: [], awsProfile: name })), manual };
}
