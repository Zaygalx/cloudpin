import type { CheckEntry } from "./check.js";
import { IMPERSONATED } from "./providers/gcloud.js";
import { listTeams, localScope } from "./providers/vercel.js";
import type { Candidate, PlanInput } from "./switch-plan.js";
import type { ProviderDef, Resolution } from "./types.js";

/*
 * The per-CLI planners behind `cloudpin switch` (#14; design in
 * docs/superpowers/specs/2026-10-18-switch-design.md, which cites the source of
 * each CLI fact used here). A planner only reads: it may run a CLI's read-only
 * listing (az account list, gh auth status, vercel teams ls, gcloud auth list)
 * or read a file (switch-plan-files.ts), and returns the commands
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
export const quoted = (value: string): string => JSON.stringify(value);

export interface Plan {
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
export function unknownLine(entry: CheckEntry): string {
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

export async function planAzure({ pin, entry, env, exec }: PlanInput): Promise<Plan> {
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

export async function planGithub({ pin, entry, env, exec, resolution }: PlanInput): Promise<Plan> {
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

export async function planVercel({ pin, entry, env, cwd, exec, resolution }: PlanInput): Promise<Plan> {
  if (entry.status === "not-logged-in") return { manual: ["log in: vercel login"] };
  if (entry.status === "unknown") return { manual: [unknownLine(entry)] };
  const identity = identityOf(resolution);
  const commands: string[][] = [];
  const manual: string[] = [];
  // The local config's scope beats the active team (#127), so a team switch would change nothing here.
  const scope = identity.team !== pin.team ? localScope(cwd, undefined) : undefined;
  if (typeof scope === "string") {
    manual.push(`the Vercel config here (vercel.json) sets scope ${quoted(scope)}, which beats the active team; change it to the pinned team ${pin.team}`);
  } else if (identity.team !== pin.team) {
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

export async function planGcloud({ pin, entry, env, exec, resolution }: PlanInput): Promise<Plan> {
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
    if (identity.label === IMPERSONATED) {
      // "all API requests will be made as the given service account" (gcloud reference), whichever account is
      // active (#165), so `config set account` would change nothing. The property follows the variable, then the
      // configuration (`gcloud topic configurations`).
      const clear = env.CLOUDSDK_AUTH_IMPERSONATE_SERVICE_ACCOUNT ? "unset CLOUDSDK_AUTH_IMPERSONATE_SERVICE_ACCOUNT" : "gcloud config unset auth/impersonate_service_account";
      manual.push(`${clear}: gcloud acts as that service account, whichever account is active`);
    } else if (env.CLOUDSDK_CORE_ACCOUNT) {
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

export async function planSupabase({ pin, entry, env, provider }: PlanInput): Promise<Plan> {
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

export async function planCloudflare({ pin, entry, provider }: PlanInput): Promise<Plan> {
  const manual: string[] = [];
  if (entry.status === "not-logged-in" && entry.fix) manual.push(`log in: ${entry.fix}`);
  if (entry.status === "unknown") manual.push(unknownLine(entry));
  manual.push((provider as ProviderDef<"cloudflare">).switchHint(pin as never));
  return { manual };
}
