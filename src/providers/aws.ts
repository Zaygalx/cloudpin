import { join } from "node:path";
import { commandWords, flagValue, hasBareFlag } from "../args.js";
import { home } from "../paths.js";
import type { ProviderDef } from "../types.js";

const EXEMPT_COMMANDS = new Set(["configure", "login", "logout", "help"]);
// Global options that take a value (`aws help`: each listed as "(string)").
const GLOBAL_VALUE_FLAGS = new Set([
  "--ca-bundle", "--cli-binary-format", "--cli-connect-timeout", "--cli-error-format", "--cli-read-timeout",
  "--color", "--endpoint-url", "--output", "--profile", "--query", "--region",
]);
// aws exits 253 when no credentials can be found (observed with empty
// config files: "NoCredentials: Unable to locate credentials").
const EXIT_NO_CREDENTIALS = 253;

export const aws: ProviderDef<"aws"> = {
  name: "aws",
  bins: ["aws"],
  statusCommand: "aws sts get-caller-identity",
  // The flags resolve reads (#160).
  targetFlags: ["--profile"],

  cacheInputs(env) {
    const dir = join(home(env), ".aws");
    return {
      // Every AWS_* variable: profiles, keys, role and web-identity settings.
      env: ["AWS_*"],
      files: [env.AWS_CONFIG_FILE ?? join(dir, "config"), env.AWS_SHARED_CREDENTIALS_FILE ?? join(dir, "credentials")],
      // SSO and assumed-role credential caches.
      dirs: [join(dir, "sso", "cache"), join(dir, "cli", "cache")],
    };
  },

  isExempt(args) {
    // The main parser's --version is an argparse "version" action, which prints and exits
    // wherever it comes before "--" (aws/aws-cli awscli/argparser.py MainArgParser).
    if (hasBareFlag(args, ["--version"])) return true;
    const words = commandWords(args, GLOBAL_VALUE_FLAGS);
    const [first, second] = words;
    if (first === undefined) return false;
    if (EXEMPT_COMMANDS.has(first) || words.at(-1) === "help") return true;
    if (first === "sso") return second === "login" || second === "logout";
    return first === "sts" && second === "get-caller-identity";
  },

  async resolve({ args, env }, exec) {
    // --profile is the only global flag that changes the account; the env
    // (AWS_PROFILE, AWS_ACCESS_KEY_ID, ...) reaches aws unchanged.
    const profile = flagValue(args, ["--profile"]);
    const query = ["sts", "get-caller-identity", "--output", "json"];
    if (profile !== undefined) query.push("--profile", profile);

    const res = await exec("aws", query, env);
    if (res.code !== 0) {
      const reason = /\[ERROR\]: (.+)$/m.exec(res.stderr)?.[1]?.trim().slice(0, 300);
      if (res.code === EXIT_NO_CREDENTIALS && /Unable to locate credentials/.test(res.stderr)) {
        return { kind: "logged-out", hint: "aws login (or aws configure)" };
      }
      if (/Token has expired|sso login/i.test(res.stderr)) {
        const name = profile ?? env.AWS_PROFILE;
        return { kind: "logged-out", hint: `aws sso login${name ? ` --profile ${name}` : ""}` };
      }
      return {
        kind: "error",
        message: reason ? `aws: ${reason}` : `aws sts get-caller-identity failed (exit ${res.code})`,
      };
    }
    try {
      const caller = JSON.parse(res.stdout) as { Account?: string; Arn?: string };
      if (!caller.Account) throw new Error("missing Account");
      return {
        kind: "identity",
        identity: { account: caller.Account, arn: caller.Arn ?? "" },
        source: "aws sts get-caller-identity",
      };
    } catch {
      return { kind: "error", message: "could not read aws sts get-caller-identity output" };
    }
  },

  compare(pin, identity) {
    if (identity.account === pin.account) return [];
    const arn = identity.arn ? ` (${identity.arn})` : "";
    return [`account: expected "${pin.account}", active is "${identity.account}"${arn}`];
  },

  switchHint(pin) {
    // AWS has no "switch account" command; the account follows the profile.
    return `set AWS_PROFILE (or pass --profile) to a profile for account ${pin.account}`;
  },
};
