import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { commandWords as argWords, leadingWords } from "./args.js";
import type { Provider, ReadOnlyRules } from "./config.js";
import { home } from "./paths.js";
import { commandWords } from "./providers/kubernetes.js";
import { VALUE_FLAGS as SUPABASE_VALUE_FLAGS } from "./providers/supabase.js";
import { VALUE_FLAGS as WRANGLER_VALUE_FLAGS } from "./providers/cloudflare.js";
import { passesYes } from "./providers/vercel-args.js";

/*
 * Which commands only read, so they skip the confirmation on a protected
 * environment (issue #12). The lists are deliberately short: anything not on
 * them asks, so a mistake here can only make cloudpin too cautious. Only the
 * leading words before the first flag count, so global flags placed before
 * the command (`aws --region x ec2 ...`) also ask.
 */

const BUILT_IN: Record<
  Provider,
  (words: string[], args: string[], env: NodeJS.ProcessEnv, bin: string | undefined) => boolean
> = {
  // kubectl plugins cannot replace a built-in command (kubernetes.io, kubectl
  // plugins), nor can kuberc aliases. Global flags may come first, so the words
  // skip them (`kubectl -n web get pods`).
  kubernetes: (_words, args, _env, bin) => {
    const words = commandWords(args);
    if (bin === "helm") {
      return ["list", "ls", "status", "history"].includes(words[0] ?? "") || (words[0] === "get" && words.length >= 2);
    }
    const first = words[0] ?? "";
    if (["get", "describe", "logs", "top", "explain", "api-resources", "api-versions", "cluster-info"].includes(first)) {
      return true;
    }
    return first === "auth" && ["can-i", "whoami"].includes(words[1] ?? "");
  },

  // Azure CLI command guidelines: list and show are "backed server-side by a GET
  // request" (github.com/Azure/azure-cli/blob/dev/doc/command_guidelines.md).
  // az takes names as flags, so the verb is the last leading word; the alias
  // extension cannot redefine an existing command word.
  azure: (words) => words.length >= 2 && ["list", "show"].includes(words.at(-1)!),

  // `aws <service> <operation>`. AWS CLI aliases (~/.aws/cli/alias) can replace
  // a built-in command (awscli/alias.py), so with an alias file nothing is
  // trusted to be read-only.
  aws: (words, _args, env) => {
    if (awsAliasFiles(env).some((f) => existsSync(f))) return false;
    if (words.length < 2) return false;
    return /^(describe|list|get)-/.test(words[1]!) || (words[0] === "s3" && words[1] === "ls");
  },

  // gcloud puts a positional name after the verb ("compute instances describe
  // INSTANCE_NAME", cloud.google.com/sdk/gcloud/reference). So `describe` is
  // trusted only after a group, with at most one name after it, and with no
  // other verb before it (`instances delete describe` deletes an instance named
  // "describe").
  gcloud: (words) => {
    const i = words.findIndex((w) => w === "list" || w === "describe");
    if (i < 1 || words.length - i > 2) return false;
    // The top-level group (after alpha/beta) is never a verb, though some are
    // named like one (`gcloud run`, `gcloud deploy`).
    const groupAt = ["alpha", "beta", "preview"].includes(words[0]!) ? 1 : 0;
    return !words.slice(groupAt + 1, i).some((w) => GCLOUD_VERB.test(w));
  },

  // Vercel CLI: bare `vercel <path>` deploys, `vercel alias` with no subcommand
  // creates an alias, and `--yes` can set up a project (vercel.com/docs/cli). Of
  // this list only `project inspect` with no name uses --yes (ensureLink), read
  // also inside a short group (#148); the others never call ensureLink (50.35).
  vercel: (words, args) => {
    if (passesYes(args)) return false;
    const [first, second] = words;
    if (["ls", "list", "inspect", "logs"].includes(first ?? "")) return true;
    if (["env", "domains", "dns", "certs", "project", "projects", "teams", "alias"].includes(first ?? "")) {
      if (["ls", "list"].includes(second ?? "")) return true;
      return second === "inspect" && ["domains", "project", "projects"].includes(first!);
    }
    return false;
  },

  // gh refuses an alias named like a built-in command (cli/cli pkg/cmd/alias/set),
  // so `<core group> list|view|status` always means what it says.
  // Supabase: each command's SIDE_EFFECTS.md in github.com/supabase/cli
  // (apps/cli/src/commands). `inspect db` runs read-only SELECTs (its only
  // writes are a temporary login role and lifting a self-ban); `db pull` and
  // `db query` are left out: pull can record migration history, query runs any SQL.
  supabase: (_words, args) => {
    const w = argWords(args, SUPABASE_VALUE_FLAGS);
    const pair = w.slice(0, 2).join(" ");
    if (pair === "inspect db") return w.length === 3;
    if (SUPABASE_READ_WITH_NAME.has(pair)) return w.length <= 3;
    return SUPABASE_READ.has(pair) && w.length === 2;
  },

  // Wrangler (developers.cloudflare.com/workers/wrangler/commands). `tail` is
  // left out: it creates a tail on the Worker (src/tail/createTail.ts, a POST).
  cloudflare: (_words, args) => {
    const w = argWords(args, WRANGLER_VALUE_FLAGS);
    const head = w.slice(0, 3).join(" ");
    if (head === "d1 migrations list") return w.length <= 4;
    if (WRANGLER_READ3.has(head)) return w.length === 3;
    const pair = w.slice(0, 2).join(" ");
    if (WRANGLER_READ_WITH_NAME.has(pair)) return w.length <= 3;
    return WRANGLER_READ.has(pair) && w.length === 2;
  },

  github: (words) => {
    if (words.length === 1) return words[0] === "status";
    return GH_GROUPS.has(words[0] ?? "") && ["list", "view", "status"].includes(words[1] ?? "");
  },
};

// Verbs that change something, or that suggest the word after them is a name.
const GCLOUD_VERB =
  /^(create|delete|update|deploy|set|unset|add|remove|start|stop|reset|resize|restart|suspend|resume|import|export|move|rename|enable|disable|apply|run|ssh|scp|attach|detach|patch|submit|cancel|rollback|promote|undelete|execute|call|get|describe|list)(-|$)/;

const SUPABASE_READ = new Set([
  "projects list", "orgs list", "functions list", "secrets list", "branches list", "backups list", "migration list",
  "snippets list", "sso list", "gen types", "postgres-config get", "ssl-enforcement get", "network-restrictions get",
]);
const SUPABASE_READ_WITH_NAME = new Set(["branches get", "sso show"]);

const WRANGLER_READ = new Set(["deployments list", "deployments status", "versions list", "secret list", "d1 list", "whoami"]);
const WRANGLER_READ_WITH_NAME = new Set(["versions view", "d1 info"]);
const WRANGLER_READ3 = new Set(["kv namespace list", "r2 bucket list"]);

const GH_GROUPS = new Set([
  "pr", "issue", "repo", "release", "run", "workflow", "gist", "label", "secret", "variable",
  "cache", "codespace", "project", "ruleset", "org", "ssh-key", "gpg-key", "extension", "alias",
]);

function awsAliasFiles(env: NodeJS.ProcessEnv): string[] {
  const files = [join(home(env), ".aws", "cli", "alias")];
  if (env.AWS_CONFIG_FILE) files.push(join(dirname(env.AWS_CONFIG_FILE), "cli", "alias"));
  return files;
}

/** True when the command only reads, by the built-in list or the project's `read_only` rules. */
export function isReadOnly(
  provider: Provider,
  args: string[],
  env: NodeJS.ProcessEnv,
  rules: ReadOnlyRules,
  /** The command name, for providers that guard several CLIs (kubectl, helm). */
  bin?: string,
): boolean {
  const words = leadingWords(args);
  const extra = rules[provider] ?? [];
  if (extra.some((rule) => rule.length <= words.length && rule.every((w, i) => words[i] === w))) return true;
  return BUILT_IN[provider](words, args, env, bin);
}
