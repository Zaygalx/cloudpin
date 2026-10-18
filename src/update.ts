import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { upgradeCommand, type InstallMethod } from "./install-method.js";

/*
 * The update notice (issue #50, owner decision 2026-10-09). At most once a
 * day cloudpin asks the npm registry for its latest published version (public
 * data; the request carries nothing about the user) and, on a later run, says
 * so in one line on stderr. Only cloudpin's own interactive commands do this:
 * never the shell wrappers, `exec` or the agent hooks, which run on every
 * cloud command, and never `shell-init`, which a profile runs at every start.
 */

const REGISTRY_URL = "https://registry.npmjs.org/cloudpin/latest";
const DAY_MS = 24 * 60 * 60 * 1000;
const TIMEOUT_MS = 1500;

// The commands that may check: everything a person runs by hand.
const INTERACTIVE = new Set([
  "init", "check", "switch", "status", "use", "doctor", "explain", "install-hook", "uninstall-hook",
  "version", "--version", "-v", "help", "--help", "-h",
]);

export function checksForUpdates(command: string | undefined): boolean {
  return command === undefined || INTERACTIVE.has(command);
}

/** Off in CI, without a terminal, or with CLOUDPIN_NO_UPDATE_CHECK=1 or NO_UPDATE_NOTIFIER (update-notifier's switch). */
export function updateCheckAllowed(env: NodeJS.ProcessEnv, tty: boolean): boolean {
  if (!tty || env.CI || env.NO_UPDATE_NOTIFIER || env.CLOUDPIN_NO_UPDATE_CHECK === "1") return false;
  return true;
}

const VERSION = /^(\d+)\.(\d+)\.(\d+)$/;

/** True when `latest` is a release (no pre-release tag) newer than `current`. */
export function isNewer(latest: string, current: string): boolean {
  const a = VERSION.exec(latest);
  const b = VERSION.exec(current.replace(/-.*$/, ""));
  if (!a || !b) return false;
  for (let i = 1; i <= 3; i++) {
    const d = Number(a[i]) - Number(b[i]);
    if (d !== 0) return d > 0;
  }
  return false;
}

interface State {
  checkedAt: number;
  latest?: string;
}

function readState(file: string): State | undefined {
  try {
    const state = JSON.parse(readFileSync(file, "utf8")) as Partial<State>;
    return typeof state.checkedAt === "number" ? (state as State) : undefined;
  } catch {
    return undefined;
  }
}

/** The notice from the last check, or null, with the upgrade command for how cloudpin was installed. Reads a file only: no request. */
export function savedNotice(current: string, file: string, method: InstallMethod): string | null {
  const latest = readState(file)?.latest;
  if (!latest || !isNewer(latest, current)) return null;
  return `cloudpin ${latest} is available (you have ${current}): ${upgradeCommand(method)}`;
}

/** cloudpin's latest version on npm, or null if the registry can't be reached in time. */
export async function fetchLatest(fetchImpl: typeof fetch = fetch, timeoutMs = TIMEOUT_MS): Promise<string | null> {
  try {
    const res = await fetchImpl(REGISTRY_URL, { signal: AbortSignal.timeout(timeoutMs), headers: { accept: "application/json" } });
    if (!res.ok) return null;
    const version = ((await res.json()) as { version?: unknown }).version;
    return typeof version === "string" ? version : null;
  } catch {
    return null;
  }
}

export interface RefreshDeps {
  now: () => number;
  stateFile: string;
  fetchLatest: () => Promise<string | null>;
}

/**
 * Asks npm if the last check is a day old or more. The time is recorded even
 * when the check fails, so an offline machine is not asked again on every run.
 */
export async function refreshIfStale(d: RefreshDeps): Promise<void> {
  const state = readState(d.stateFile);
  if (state && d.now() - state.checkedAt < DAY_MS) return;
  const latest = (await d.fetchLatest()) ?? state?.latest;
  try {
    mkdirSync(dirname(d.stateFile), { recursive: true });
    writeFileSync(d.stateFile, JSON.stringify({ checkedAt: d.now(), ...(latest ? { latest } : {}) }));
  } catch {
    // An update notice is never worth a failure.
  }
}
