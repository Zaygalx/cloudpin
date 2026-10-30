import { join } from "node:path";
import { commandWords, flagValue, hasBareFlag } from "../args.js";
import { appData, home } from "../paths.js";
import type { ProviderDef, Resolution } from "../types.js";

// Setup and housekeeping groups: logins, local config, SDK components, docs.
const EXEMPT_COMMANDS = new Set(["auth", "config", "init", "version", "info", "help", "topic", "components"]);
// Global flags that take a value (`gcloud --help`, GLOBAL FLAGS; SDK 588).
const GLOBAL_VALUE_FLAGS = new Set([
  "--account", "--billing-project", "--configuration", "--flags-file", "--flatten", "--format", "--project",
  "--verbosity", "--access-token-file", "--impersonate-service-account", "--trace-token",
]);
// Global flags that change which account/project a command uses
// (`gcloud topic configurations`). The env (CLOUDSDK_CORE_ACCOUNT,
// CLOUDSDK_CORE_PROJECT, CLOUDSDK_ACTIVE_CONFIG_NAME, CLOUDSDK_CONFIG)
// reaches gcloud unchanged.
const IDENTITY_FLAGS = ["--account", "--project", "--configuration"];
// Labels on an identity that isn't the active account (#165).
const IMPERSONATED = "impersonated";
const ACCESS_TOKEN = "access token";

type Auth = { impersonate_service_account?: string; access_token_file?: string; credential_file_override?: string };

/**
 * What replaces the active account's credentials, or undefined. store.py `_Load` (SDK 590.0.1) takes the
 * first of CLOUDSDK_AUTH_ACCESS_TOKEN, auth/access_token_file and auth/credential_file_override and
 * "ignore[s] the active account". The token's or key's account can't be read without using it.
 */
function accessToken(args: string[], env: NodeJS.ProcessEnv, auth: Auth): string | undefined {
  if (env.CLOUDSDK_AUTH_ACCESS_TOKEN) return "CLOUDSDK_AUTH_ACCESS_TOKEN";
  // An empty flag still overrides the property, and an empty value means no file.
  const file = flagValue(args, ["--access-token-file"]);
  if (file) return "--access-token-file";
  if (file === undefined && auth.access_token_file) {
    return "auth/access_token_file (from CLOUDSDK_AUTH_ACCESS_TOKEN_FILE or the configuration)";
  }
  if (auth.credential_file_override) return "auth/credential_file_override";
  return undefined;
}

export const gcloud: ProviderDef<"gcloud"> = {
  name: "gcloud",
  bins: ["gcloud"],
  statusCommand: "gcloud config list",
  // The flags resolve reads (#160).
  targetFlags: [...IDENTITY_FLAGS, "--impersonate-service-account", "--access-token-file"],

  cacheInputs(env) {
    const dir =
      env.CLOUDSDK_CONFIG ??
      (appData(env) ? join(appData(env)!, "gcloud") : join(home(env), ".config", "gcloud"));
    return {
      env: ["CLOUDSDK_*"],
      files: [join(dir, "active_config")],
      dirs: [join(dir, "configurations")],
    };
  },

  isExempt(args) {
    if (hasBareFlag(args, ["--help", "-h"])) return true;
    const [first] = commandWords(args, GLOBAL_VALUE_FLAGS);
    // "--version, -v ... only available at the global level" (gcloud reference); a command may
    // have its own, as `app deploy --version v2` names the version it deploys (#146).
    if (first === undefined) return hasBareFlag(args, ["--version", "-v"]);
    return EXEMPT_COMMANDS.has(first);
  },

  async resolve({ args, env }, exec): Promise<Resolution> {
    // `gcloud config list` given the same flags and env reports the account
    // and project the command would use (verified for flags, CLOUDSDK_CORE_*
    // and named configurations on SDK 588). The projection keeps only the fields
    // read here: the full list can hold credentials such as proxy/password, and the
    // output is cached (checked on SDK 588 with a throwaway config). The auth fields hold an account or
    // file paths, never a token (#165). config list reports a property from the flag, then
    // CLOUDSDK_<SECTION>_<NAME>, then the configuration (properties/parsers.py
    // `_GetPropertyWithoutCallback`, SDK 590.0.1), as `gcloud topic configurations` documents.
    const query = [
      "config", "list",
      "--format=json(core.account,core.project,auth.impersonate_service_account,auth.access_token_file,auth.credential_file_override)",
    ];
    for (const flag of IDENTITY_FLAGS) {
      const value = flagValue(args, [flag]);
      if (value !== undefined) query.push(flag, value);
    }
    const res = await exec("gcloud", query, env);
    if (res.code !== 0) {
      const reason = /^ERROR: (.+)$/m.exec(res.stderr)?.[1]?.trim().slice(0, 300);
      return {
        kind: "error",
        message: reason ? `gcloud: ${reason}` : `gcloud config list failed (exit ${res.code})`,
      };
    }
    let core: { account?: string; project?: string };
    let auth: Auth;
    try {
      const parsed = JSON.parse(res.stdout) as { core?: typeof core; auth?: Auth };
      [core, auth] = [parsed.core ?? {}, parsed.auth ?? {}];
    } catch {
      return { kind: "error", message: "could not read gcloud config list output" };
    }
    const project = core.project ?? "";
    // "all API requests will be made as the given service account or target service account in an
    // impersonation delegation chain" (gcloud reference, --impersonate-service-account, which stores the
    // auth/impersonate_service_account property for the invocation: lib/surface/__init__.py). store.py
    // `Load` checks it first: an access token then only supplies the credentials that impersonate.
    const flag = flagValue(args, ["--impersonate-service-account"]);
    const chain = flag ?? auth.impersonate_service_account;
    if (chain) {
      const name = flag !== undefined ? "--impersonate-service-account" : "auth/impersonate_service_account";
      // store.py `ParseImpersonationAccounts`: split on commas and trimmed; the last is the target.
      const target = chain.split(",").map((id) => id.trim()).at(-1);
      if (!target) return { kind: "error", message: `${name} ends with no service account to impersonate` };
      return { kind: "identity", identity: { account: target, project, label: IMPERSONATED }, source: name };
    }
    const token = accessToken(args, env, auth);
    if (token) {
      return {
        kind: "identity",
        identity: { account: "", project, label: ACCESS_TOKEN },
        source: token,
        unknown: {
          account: `the command authenticates with the access token or key from ${token}, not the active account, so cloudpin can't tell which account it uses`,
        },
      };
    }
    // No account also covers an unknown --configuration, which gcloud reports
    // as an empty config with exit 0 rather than as an error.
    if (!core.account) return { kind: "logged-out", hint: "gcloud auth login" };
    return {
      kind: "identity",
      identity: { account: core.account, project },
      source: "gcloud config list",
    };
  },

  compare(pin, identity) {
    const out: string[] = [];
    // Google account emails compare case-insensitively; project IDs are lowercase by rule.
    if (pin.account && identity.account?.toLowerCase() !== pin.account.toLowerCase()) {
      const actual =
        identity.label === IMPERSONATED
          ? `impersonating "${identity.account}"`
          : identity.label === ACCESS_TOKEN
            ? "the command uses an access token, whose account cloudpin can't tell"
            : `active is "${identity.account}"`;
      out.push(`account: expected "${pin.account}", ${actual}`);
    }
    if (pin.project && identity.project !== pin.project) {
      const active = identity.project ? `"${identity.project}"` : "(not set)";
      out.push(`project: expected "${pin.project}", active is ${active}`);
    }
    return out;
  },

  switchHint(pin) {
    const steps: string[] = [];
    if (pin.account) steps.push(`gcloud config set account ${pin.account}`);
    if (pin.project) steps.push(`gcloud config set project ${pin.project}`);
    return steps.join(" && ");
  },
};
