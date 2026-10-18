import { readFileSync } from "node:fs";
import { join } from "node:path";
import { home } from "./paths.js";

/**
 * Reads the AWS config file offline for `cloudpin switch` (#14): which profiles
 * exist and which account each one names. Only section names and two keys are
 * looked at, `sso_account_id` and the account field of `role_arn`; every other
 * line is skipped without being kept, because the file may hold secrets
 * (`aws_secret_access_key`, a `credential_process` command line). The
 * credentials file is never read.
 *
 * Format (docs.aws.amazon.com/cli/latest/userguide/cli-configure-files.html, and
 * botocore configloader.py, which reads it with Python's RawConfigParser):
 * `[default]` and `[profile name]` sections; botocore splits a "profile ..."
 * header with shlex and keeps it only when that gives exactly two words, so
 * `[profile "a b"]` names "a b" and `[profile a b]` is ignored; option names
 * are case-insensitive; indented lines continue the previous value (nested
 * settings such as `s3 =`), so they are never read as keys.
 */

export interface AwsProfile {
  name: string;
  /** The 12-digit account the profile names, when it names one offline. */
  account?: string;
}

const ACCOUNT = /^\d{12}$/;

/** shlex.split for a section header: whitespace, quotes and backslashes. Null when a quote is unbalanced. */
function shellSplit(text: string): string[] | null {
  const words: string[] = [];
  let word: string | null = null;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (/\s/.test(c)) {
      if (word !== null) words.push(word);
      word = null;
    } else if (c === "'" || c === '"') {
      const end = text.indexOf(c, i + 1);
      if (end === -1) return null;
      const inner = text.slice(i + 1, end);
      word = (word ?? "") + (c === '"' ? inner.replace(/\\(["\\])/g, (_m, ch: string) => ch) : inner);
      i = end;
    } else if (c === "\\" && i + 1 < text.length) {
      word = (word ?? "") + text[++i];
    } else {
      word = (word ?? "") + c;
    }
  }
  if (word !== null) words.push(word);
  return words;
}

/** The profile a section header names, or null for any other section. */
function profileName(header: string): string | null {
  if (header === "default") return "default";
  if (!header.startsWith("profile")) return null;
  const parts = shellSplit(header);
  return parts?.length === 2 && parts[0] === "profile" ? parts[1]! : null;
}

/** The account in an IAM role ARN (arn:partition:iam::account:role/name), or undefined. */
function accountOfRoleArn(value: string): string | undefined {
  const fields = value.split(":");
  return fields.length >= 6 && fields[0] === "arn" && fields[2] === "iam" && ACCOUNT.test(fields[4]!)
    ? fields[4]
    : undefined;
}

/** Every profile in the file, in order, with the account it names when it names one. */
export function awsProfilesFromConfig(text: string): AwsProfile[] {
  const profiles = new Map<string, AwsProfile>();
  let current: AwsProfile | null = null;
  for (const raw of text.replace(/^\uFEFF/, "").split(/\r?\n/)) {
    // Indented: a continuation or nested setting, never a key of the profile.
    if (/^\s/.test(raw)) continue;
    const line = raw.trimEnd();
    if (line === "" || line.startsWith("#") || line.startsWith(";")) continue;
    const header = /^\[(.+)\]/.exec(line);
    if (header) {
      const name = profileName(header[1]!.trim());
      if (name === null) {
        current = null;
      } else {
        current = profiles.get(name) ?? { name };
        profiles.set(name, current);
      }
      continue;
    }
    if (!current) continue;
    const option = /^([^=:]+?)\s*[=:]\s*(.*)$/.exec(line);
    if (!option) continue;
    const key = option[1]!.toLowerCase();
    // Only these two keys are ever looked at; any other value is dropped here.
    if (key === "sso_account_id") {
      const value = option[2]!.trim();
      if (ACCOUNT.test(value)) current.account = value;
    } else if (key === "role_arn") {
      const account = accountOfRoleArn(option[2]!.trim());
      if (account) current.account = account;
    }
  }
  return [...profiles.values()];
}

/** The names of the profiles that name `account`, in file order. */
export function profilesForAccount(profiles: AwsProfile[], account: string): string[] {
  return profiles.filter((p) => p.account === account).map((p) => p.name);
}

/** The AWS config file the command's environment uses: AWS_CONFIG_FILE, else ~/.aws/config. */
export function awsConfigPath(env: NodeJS.ProcessEnv): string {
  return env.AWS_CONFIG_FILE || join(home(env), ".aws", "config");
}

/** The profiles in the AWS config file, or [] when there is none. The error names the file, never its content. */
export function readAwsProfiles(env: NodeJS.ProcessEnv): { path: string; profiles: AwsProfile[] } | { path: string; error: string } {
  const path = awsConfigPath(env);
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { path, profiles: [] };
    return { path, error: `could not read ${path}` };
  }
  return { path, profiles: awsProfilesFromConfig(text) };
}
