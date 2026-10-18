import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";
import { profilesForAccount, readAwsProfiles } from "./aws-config.js";
import type { CheckEntry } from "./check.js";
import type { Provider } from "./config.js";
import { home } from "./paths.js";
import { type Kubeconfig, loadKubeconfig, normaliseServer } from "./providers/kubernetes.js";
import { listTeams } from "./providers/vercel.js";
import type { Exec, ProviderDef, Resolution } from "./types.js";

/*
 * The per-CLI planners behind `cloudpin switch` (#14; design in
 * docs/superpowers/specs/2026-10-18-switch-design.md, which cites the source of
 * each CLI fact used here). A planner only reads: it may run a CLI's read-only
 * listing (az account list, gh auth status, vercel teams ls, gcloud auth list)
 * or read the kubeconfig or the AWS config file, and returns the commands
 * `cloudpin switch` would run, as argv, never as a shell string.
 */

/** Names cloudpin runs or hands to the shell (kube contexts may contain @ : /). */
const NAME = /^[A-Za-z0-9._@:/-]{1,128}$/;
/** What `AWS_PROFILE` may be set to, here and in the shell function. */
export const AWS_PROFILE_NAME = /^[A-Za-z0-9._-]{1,64}$/;

/**
 * A value cloudpin may put in a command it runs: the allowed characters, and
 * no leading "-", which the CLI would read as a flag.
 */
export const safeName = (value: string): boolean => NAME.test(value) && !value.startsWith("-");

/** A value shown to the user in a manual line, quoted so odd characters are visible. */
const quoted = (value: string): string => JSON.stringify(value);

export interface Candidate {
  name: string;
  commands: string[][];
  awsProfile?: string;
}

export type StepStatus = "ok" | "run" | "choose" | "manual" | "not-installed";

export interface Step {
  provider: Provider;
  status: StepStatus;
  /** Commands cloudpin will run, in order. */
  commands: string[][];
  /** Stop this provider's later commands when one fails (each depends on the previous). */
  chained?: boolean;
  /** AWS: the profile to put in AWS_PROFILE through CLOUDPIN_ENV_FILE. */
  awsProfile?: string;
  /** Several equally good targets: the user picks one, or the line is skipped. */
  candidates?: Candidate[];
  /** Names that go with a manual line (AWS profiles cloudpin can't apply in this shell). */
  listed?: string[];
  /** What the commands change, beyond the account (a file written, a context edited). */
  notes: string[];
  /** What cloudpin will not or cannot do, naming the exact command or variable. */
  manual: string[];
}

export interface PlanInput {
  provider: ProviderDef;
  pin: Record<string, string>;
  /** What `cloudpin check` found for this provider. */
  entry: CheckEntry;
  /** The resolution behind `entry`, when guard got that far. */
  resolution?: Resolution;
  /** The command's environment: passed to every CLI so its variables count. */
  env: NodeJS.ProcessEnv;
  cwd: string;
  exec: Exec;
  /** Finds a command on the env's PATH, when cloudpin can tell. */
  onPath?: (bin: string) => string | null;
  /** CLOUDPIN_ENV_FILE is set: the cloudpin shell function can apply AWS_PROFILE. */
  envFile: boolean;
}

interface Plan {
  commands?: string[][];
  chained?: boolean;
  awsProfile?: string;
  candidates?: Candidate[];
  /** Names shown with a manual line, which cloudpin can't apply itself. */
  listed?: string[];
  notes?: string[];
  manual?: string[];
}

/** The line for a provider whose account cloudpin could not determine. */
function unknownLine(entry: CheckEntry): string {
  const look = entry.fix ? `; look with: ${entry.fix}` : "";
  return `cloudpin could not tell which account is active (${entry.problems.join("; ")}), so it has nothing to switch from${look}`;
}

const identityOf = (resolution: Resolution | undefined): Record<string, string> =>
  resolution?.kind === "identity" ? resolution.identity : {};

function parseJson<T>(text: string): T | undefined {
  try {
    return JSON.parse(text) as T;
  } catch {
    return undefined;
  }
}

async function planAzure({ pin, entry, env, exec }: PlanInput): Promise<Plan> {
  const login = pin.tenant ? `az login --tenant ${pin.tenant}` : "az login";
  if (entry.status === "not-logged-in") return { manual: [`log in: ${login}`] };
  if (entry.status === "unknown") return { manual: [unknownLine(entry)] };
  // `az account list` reads the local subscription cache (azure-cli _profile.py);
  // the projection keeps only the two IDs.
  const res = await exec("az", ["account", "list", "--output", "json", "--query", "[].{id:id,tenantId:tenantId}"], env);
  if (res.code !== 0) {
    if (/az login/.test(res.stderr)) return { manual: [`log in: ${login}`] };
    return { manual: [`az account list failed (exit ${res.code}); switch yourself: az account set --subscription ${pin.subscription}`] };
  }
  const subs = parseJson<{ id?: unknown; tenantId?: unknown }[]>(res.stdout);
  if (!Array.isArray(subs)) return { manual: ["could not read az account list output"] };
  const want = pin.subscription!.toLowerCase();
  const found = subs.find((s) => typeof s.id === "string" && s.id.toLowerCase() === want);
  if (!found) {
    return { manual: [`subscription ${pin.subscription} is not among the subscriptions this login knows; log in to its tenant: ${login}`] };
  }
  if (pin.tenant && typeof found.tenantId === "string" && found.tenantId.toLowerCase() !== pin.tenant.toLowerCase()) {
    return { manual: [`subscription ${pin.subscription} belongs to tenant ${found.tenantId}, not the pinned tenant ${pin.tenant}; check .cloudpin.yml`] };
  }
  if (!safeName(pin.subscription!)) return { manual: [`run it yourself: az account set --subscription ${quoted(pin.subscription!)}`] };
  // Always the ID, never a name (az account set --help: "Name or ID").
  return { commands: [["az", "account", "set", "--subscription", pin.subscription!]] };
}

const GITHUB_COM = "github.com";

async function planGithub({ pin, entry, env, exec, resolution }: PlanInput): Promise<Plan> {
  const host = pin.host ?? GITHUB_COM;
  // `gh help environment`: GH_TOKEN/GITHUB_TOKEN apply to github.com and *.ghe.com,
  // the enterprise pair to GitHub Enterprise Server hosts. With one set, gh uses it
  // instead of the stored login and `gh auth switch` refuses (cli/cli switch.go).
  const dotCom = host.toLowerCase() === GITHUB_COM || host.toLowerCase().endsWith(".ghe.com");
  const tokenVars = dotCom ? ["GH_TOKEN", "GITHUB_TOKEN"] : ["GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN"];
  const set = tokenVars.filter((name) => env[name]);
  if (set.length > 0) {
    return { manual: [`unset ${set.join(" and ")}: gh uses ${set.length > 1 ? "them" : "it"} instead of your gh logins, and won't switch while ${set.length > 1 ? "they are" : "it is"} set`] };
  }
  if (entry.status === "not-logged-in") return { manual: [`log in as ${pin.user}: gh auth login --hostname ${host}`] };
  if (entry.status === "unknown") return { manual: [unknownLine(entry)] };
  if (!safeName(host) || !safeName(pin.user!)) {
    return { manual: [`run it yourself: gh auth switch --hostname ${quoted(host)} --user ${quoted(pin.user!)}`] };
  }
  const manual: string[] = [];
  const activeHost = identityOf(resolution).host;
  if (activeHost && activeHost.toLowerCase() !== host.toLowerCase()) {
    manual.push(`gh commands here go to ${activeHost}: set GH_HOST=${host} (or pass --hostname ${host})`);
  }
  // `gh auth status --json hosts` drops the token field in JSON mode (cli/cli
  // status.go), and the jq projection keeps only these three fields anyway.
  const res = await exec(
    "gh",
    ["auth", "status", "--hostname", host, "--json", "hosts", "--jq", "[.hosts[][] | {host, login, active}]"],
    env,
  );
  const accounts = res.code === 0 ? parseJson<{ host?: unknown; login?: unknown; active?: unknown }[]>(res.stdout) : undefined;
  if (!Array.isArray(accounts)) {
    return { manual: [...manual, `could not list gh accounts (gh auth status exit ${res.code}); switch yourself: gh auth switch --hostname ${host} --user ${pin.user}`] };
  }
  const match = accounts.find(
    (a) =>
      typeof a.login === "string" &&
      typeof a.host === "string" &&
      a.host.toLowerCase() === host.toLowerCase() &&
      a.login.toLowerCase() === pin.user!.toLowerCase(),
  );
  if (!match) return { manual: [...manual, `log in as ${pin.user}: gh auth login --hostname ${host}`] };
  if (match.active === true) return { manual: manual.length > 0 ? manual : entry.problems };
  const login = match.login as string;
  if (!safeName(login)) return { manual: [...manual, `run it yourself: gh auth switch --hostname ${host} --user ${quoted(login)}`] };
  // Both flags always: without a terminal gh errors when it would have to prompt.
  return { commands: [["gh", "auth", "switch", "--hostname", host, "--user", login]], manual };
}

async function planVercel({ pin, entry, env, exec, resolution }: PlanInput): Promise<Plan> {
  if (entry.status === "not-logged-in") return { manual: ["log in: vercel login"] };
  if (entry.status === "unknown") return { manual: [unknownLine(entry)] };
  const identity = identityOf(resolution);
  const commands: string[][] = [];
  const manual: string[] = [];
  if (identity.team !== pin.team) {
    const teams = await listTeams(exec, ["--non-interactive"], env);
    if (!Array.isArray(teams)) {
      manual.push(`could not list your teams (${teams.kind === "error" ? teams.message : "logged out"}); switch yourself: vercel teams switch`);
    } else {
      const team = teams.find((t) => t.id === pin.team);
      if (!team) manual.push(`log in as a member of team ${pin.team} (vercel login), then run cloudpin switch again`);
      else if (typeof team.slug !== "string" || !safeName(team.slug)) manual.push(`run it yourself: vercel teams switch ${quoted(String(team.slug))}`);
      // `teams switch` takes a slug, and unlike the top-level `switch` works with a token set.
      else commands.push(["vercel", "teams", "switch", team.slug]);
    }
  }
  // Project commands use the linked project's orgId (or VERCEL_ORG_ID), which a team switch doesn't change.
  if ((identity.projectTeam?.split(",") ?? []).some((t) => t !== pin.team)) {
    manual.push(
      env.VERCEL_ORG_ID
        ? "unset VERCEL_ORG_ID: project commands use it, and a team switch doesn't change it"
        : `the project linked here belongs to another team; link a project of team ${pin.team}: vercel link`,
    );
  }
  return { commands, manual };
}

async function planGcloud({ pin, entry, env, exec, resolution }: PlanInput): Promise<Plan> {
  if (entry.status === "unknown") return { manual: [unknownLine(entry)] };
  const identity = identityOf(resolution);
  // `gcloud topic configurations`: CLOUDSDK_ACTIVE_CONFIG_NAME picks the
  // configuration, so `config set` must write that one.
  const configuration = env.CLOUDSDK_ACTIVE_CONFIG_NAME;
  if (configuration && !safeName(configuration)) {
    return { manual: [`CLOUDSDK_ACTIVE_CONFIG_NAME is ${quoted(configuration)}; set the account and project in that configuration yourself`] };
  }
  // --quiet: `config set project` otherwise asks to confirm when it can't check access.
  const tail = ["--quiet", ...(configuration ? ["--configuration", configuration] : [])];
  const commands: string[][] = [];
  const manual: string[] = [];
  if (pin.account && identity.account?.toLowerCase() !== pin.account.toLowerCase()) {
    if (env.CLOUDSDK_CORE_ACCOUNT) {
      manual.push("unset CLOUDSDK_CORE_ACCOUNT: it beats the account in gcloud's configuration");
    } else {
      const res = await exec("gcloud", ["auth", "list", "--format=json"], env);
      const listed = res.code === 0 ? parseJson<{ account?: unknown }[]>(res.stdout) : undefined;
      const found = Array.isArray(listed)
        ? listed.find((a) => typeof a.account === "string" && a.account.toLowerCase() === pin.account!.toLowerCase())
        : undefined;
      const account = found?.account as string | undefined;
      if (!Array.isArray(listed)) manual.push(`could not list gcloud accounts (gcloud auth list exit ${res.code})`);
      else if (!account) manual.push(`log in: gcloud auth login ${pin.account}`);
      else if (!safeName(account)) manual.push(`run it yourself: gcloud config set account ${quoted(account)}`);
      else commands.push(["gcloud", "config", "set", "account", account, ...tail]);
    }
  }
  if (pin.project && identity.project !== pin.project) {
    if (env.CLOUDSDK_CORE_PROJECT) manual.push("unset CLOUDSDK_CORE_PROJECT: it beats the project in gcloud's configuration");
    else if (!safeName(pin.project)) manual.push(`run it yourself: gcloud config set project ${quoted(pin.project)}`);
    else commands.push(["gcloud", "config", "set", "project", pin.project, ...tail]);
  }
  return { commands, manual };
}

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

async function planKubernetes({ pin, entry, env, onPath }: PlanInput): Promise<Plan> {
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

/** helm uses HELM_KUBECONTEXT instead of the current context (helm.sh/docs/helm/helm). */
function helmContextLine(config: Kubeconfig, env: NodeJS.ProcessEnv, server: string, namespace: string | undefined): string[] {
  const name = env.HELM_KUBECONTEXT;
  if (!name) return [];
  const ctx = config.contexts.get(name);
  const s = ctx?.cluster ? config.clusters.get(ctx.cluster)?.server : undefined;
  const right = s !== undefined && normaliseServer(s) === server && (!namespace || (ctx?.namespace ?? "default") === namespace);
  return right ? [] : ["unset HELM_KUBECONTEXT: helm uses it instead of the current context"];
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

async function planAws({ pin, entry, env, envFile }: PlanInput): Promise<Plan> {
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
  // aws-cli v2 reads AWS_PROFILE before AWS_DEFAULT_PROFILE (configprovider.py).
  const current = env.AWS_PROFILE || env.AWS_DEFAULT_PROFILE;
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

async function planSupabase({ pin, entry, env, provider }: PlanInput): Promise<Plan> {
  const manual: string[] = [];
  if (entry.status === "not-logged-in") manual.push("log in: supabase login");
  if (entry.status === "unknown") manual.push(unknownLine(entry));
  if (env.SUPABASE_PROJECT_ID && env.SUPABASE_PROJECT_ID !== pin.project) {
    manual.push("unset SUPABASE_PROJECT_ID: it beats the project supabase link chose");
  }
  // `supabase link` writes supabase/.temp/ and fetches the project's API keys
  // (supabase CLI commands/link/SIDE_EFFECTS.md), so cloudpin leaves it to the user.
  manual.push(
    `link the pinned project: ${(provider as ProviderDef<"supabase">).switchHint(pin as never)} ` +
      "(it writes supabase/.temp/ and fetches the project's API keys, so cloudpin leaves it to you)",
  );
  return { manual };
}

async function planCloudflare({ pin, entry, provider }: PlanInput): Promise<Plan> {
  const manual: string[] = [];
  if (entry.status === "not-logged-in" && entry.fix) manual.push(`log in: ${entry.fix}`);
  if (entry.status === "unknown") manual.push(unknownLine(entry));
  manual.push((provider as ProviderDef<"cloudflare">).switchHint(pin as never));
  return { manual };
}

const PLANNERS: Record<Provider, (input: PlanInput) => Promise<Plan>> = {
  azure: planAzure,
  aws: planAws,
  gcloud: planGcloud,
  vercel: planVercel,
  github: planGithub,
  kubernetes: planKubernetes,
  supabase: planSupabase,
  cloudflare: planCloudflare,
};

/** What `cloudpin switch` would do for one pinned provider. */
export async function planProvider(input: PlanInput): Promise<Step> {
  const provider = input.entry.provider as Provider;
  const base = { provider, commands: [] as string[][], notes: [] as string[] };
  switch (input.entry.status) {
    case "match":
      return { ...base, status: "ok", manual: [] };
    case "not-installed":
      return { ...base, status: "not-installed", manual: input.entry.problems };
    case "unsupported":
      return { ...base, status: "manual", manual: input.entry.problems };
  }
  const plan = await PLANNERS[provider](input);
  const commands = plan.commands ?? [];
  const candidates = plan.candidates ?? [];
  const status: StepStatus =
    commands.length > 0 || plan.awsProfile !== undefined ? "run" : candidates.length > 1 ? "choose" : "manual";
  return {
    ...base,
    status,
    commands,
    ...(plan.chained && (commands.length > 1 || candidates.length > 0) ? { chained: true } : {}),
    ...(plan.awsProfile !== undefined ? { awsProfile: plan.awsProfile } : {}),
    ...(candidates.length > 1 ? { candidates } : {}),
    ...(plan.listed && plan.listed.length > 0 ? { listed: plan.listed } : {}),
    notes: plan.notes ?? [],
    manual: plan.manual ?? [],
  };
}
