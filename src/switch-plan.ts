import type { CheckEntry } from "./check.js";
import type { Provider } from "./config.js";
import { planAws, planKubernetes } from "./switch-plan-files.js";
import { planAzure, planCloudflare, planGcloud, planGithub, type Plan, planSupabase, planVercel } from "./switch-planners.js";
import type { Exec, ProviderDef, Resolution } from "./types.js";

export { defaultKubeconfigFile } from "./switch-plan-files.js";

/*
 * What `cloudpin switch` plans for a pinned provider (#14): the plan's shape, and the status of each line. The
 * per-CLI planners are in switch-planners.ts and switch-plan-files.ts. Planning only reads; it runs no switch command.
 */

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
