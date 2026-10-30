import { resolve } from "node:path";
import type { Words } from "./ps-words.js";
import { DYNAMIC_WORD, DYNAMIC_WORDS } from "./types.js";

/**
 * Commands that run the command after their own flags (#162): Unix wrappers (env, sudo, nice, timeout...)
 * and package runners (npx, pnpm, yarn, bunx). Each reads its flags from a table taken from the tool's
 * docs, so the wrapped call is found after flags that take a value; a flag the table doesn't know, or one
 * only known when the line runs, means cloudpin can't tell which command runs.
 *
 * A table lists each option as its names, short and long: `-u= --unset=` takes a value (`-u NAME`,
 * `-uNAME`, `--unset NAME`, `--unset=NAME`), `--block-signal[=]` and `-l[=]` an optional one, attached only
 * (`-l5`, `--block-signal=PIPE`), and `-i --ignore-environment` none. Long names may be shortened to any
 * unambiguous prefix, as getopt_long allows; short ones may be grouped (`-iu NAME`).
 */

type Arity = "none" | "value" | "optional";
export interface Table {
  short: Map<string, [string, Arity]>;
  long: Map<string, [string, Arity]>;
  /** nice's obsolete `-NUM` adjustment. */
  numeric?: boolean;
}

export function table(...specs: string[]): Table {
  const out: Table = { short: new Map(), long: new Map() };
  for (const spec of specs) {
    const names = spec.split(" ");
    const bareName = (name: string) => name.split(/[[=\]]/)[0]!;
    const key = bareName(names[0]!);
    for (const name of names) {
      const arity: Arity = name.endsWith("[=]") ? "optional" : name.endsWith("=") ? "value" : "none";
      const bare = bareName(name);
      if (bare.startsWith("--")) out.long.set(bare.slice(2), [key, arity]);
      else out.short.set(bare.slice(1), [key, arity]);
    }
  }
  return out;
}

export interface Options {
  /** Each option read, by its first name in the table, with its value. */
  options: [string, string | undefined][];
  /** Index of the first word after the options. */
  next: number;
  /** A flag the table doesn't know, or a word only known when the line runs, where a flag may be. */
  unknown: boolean;
  /** Options whose value is only known when the line runs. */
  dynamic: Set<string>;
}

/** Reads options from `words[from]` on, up to the first operand or `--` (getopt with "+"). */
export function readOptions(words: readonly string[], from: number, t: Table, dynamic: readonly boolean[] = []): Options {
  const options: [string, string | undefined][] = [];
  const values = new Set<string>();
  const done = (next: number, unknown = false): Options => ({ options, next, unknown, dynamic: values });
  const add = (key: string, value: string | undefined, at: number) => {
    options.push([key, value]);
    if (dynamic[at]) values.add(key);
  };
  let k = from;
  for (; k < words.length; k++) {
    const word = words[k]!;
    if (dynamic[k]) return done(k, true);
    if (word === "--") return done(k + 1);
    if (!word.startsWith("-") || word === "-") return done(k);
    if (t.numeric && /^-\d+$/.test(word)) {
      add("-n", word.slice(1), k);
      continue;
    }
    if (word.startsWith("--")) {
      const eq = word.indexOf("=");
      const name = word.slice(2, eq === -1 ? undefined : eq);
      const matches = t.long.has(name) ? [name] : [...t.long.keys()].filter((l) => l.startsWith(name));
      if (new Set(matches.map((m) => t.long.get(m)![0])).size !== 1) return done(k, true);
      const [key, arity] = t.long.get(matches[0]!)!;
      if (arity === "none" && eq !== -1) return done(k, true);
      if (arity === "value" && eq === -1) add(key, words[k + 1], ++k);
      else add(key, eq === -1 ? undefined : word.slice(eq + 1), k);
      continue;
    }
    for (let j = 1; j < word.length; j++) {
      const spec = t.short.get(word[j]!);
      if (!spec) return done(k, true);
      const [key, arity] = spec;
      const rest = word.slice(j + 1);
      if (arity === "none") add(key, undefined, k);
      else if (rest !== "" || arity === "optional") add(key, rest || undefined, k);
      else add(key, words[k + 1], ++k);
      if (arity !== "none") break;
    }
  }
  return done(k);
}

/** What a wrapper does to the call it runs. */
export interface Unwrapped {
  /** Index of the wrapped command. */
  next: number;
  /** Variables it removes from the call's environment (`env -u`). */
  unset?: string[];
  /** The call starts with an empty environment (`env -i`, `env -`, `exec -c`). */
  clearEnv?: boolean;
  /** Folder it runs the call in, as written (`env -C`, `sudo -D`, `pnpm -C`). */
  cwd?: string;
  /** xargs: the string it replaces with each input line, or else it appends the input. */
  xargs?: { replace?: string; spread: boolean };
  /** env -S: a string it splits into the words that come next. */
  split?: string;
  /** The command as the runner finds it: `wrangler@latest` runs `wrangler`. */
  bin?: string;
  /** A command line it runs through a shell (`npx -c`, `pnpm exec -c`). */
  script?: string;
  /** Something it can't read decides what runs. */
  unknown?: boolean;
  /** It runs no command (`command -v`). */
  none?: boolean;
}

// GNU coreutils 8.32 `env --help` (coreutils 9 adds -a/--argv0); BSD env(1) adds -P altpath.
const ENV = table(
  "-i --ignore-environment", "-0 --null", "-u= --unset=", "-C= --chdir=", "-S= --split-string=", "-v --debug",
  "-a= --argv0=", "-P=", "--block-signal[=]", "--default-signal[=]", "--ignore-signal[=]", "--list-signal-handling",
);
// sudo's parse_args.c: short "+Aa:BbC:c:D:Eeg:Hh::iKklNnPp:R:r:SsT:t:U:u:Vv" and its long options; Sudo for
// Windows (learn.microsoft.com/windows/sudo) adds --inline, --disable-input and -N/--new-window.
const SUDO = table(
  "-A --askpass", "-a= --auth-type=", "-b --background", "-B --bell", "-C= --close-from=", "-c= --login-class=",
  "-D= --chdir=", "-E --preserve-env[=]", "-e --edit", "-g= --group=", "-H --set-home", "-h[=] --help", "--host=",
  "-i --login", "-K --remove-timestamp", "-k --reset-timestamp", "-l --list", "-N --no-update --new-window",
  "-n --non-interactive", "-P --preserve-groups", "-p= --prompt=", "-R= --chroot=", "-r= --role=", "-S --stdin",
  "-s --shell", "-T= --command-timeout=", "-t= --type=", "-U= --other-user=", "-u= --user=", "-V --version",
  "-v --validate", "--inline", "--disable-input",
);
// GNU coreutils 8.32 `--help`. timeout: coreutils 9.5 adds -f and -p for its long flags.
const NICE = { ...table("-n= --adjustment="), numeric: true };
const TIMEOUT = table("-f --foreground", "-k= --kill-after=", "-p --preserve-status", "-s= --signal=", "-v --verbose");
const STDBUF = table("-i= --input=", "-o= --output=", "-e= --error=");
// bash(1), SHELL BUILTIN COMMANDS: `exec [-cl] [-a name]`, `command [-pVv]`; the `time [-p]` keyword, and
// GNU time(1)'s -f and -o for /usr/bin/time.
const EXEC = table("-c", "-l", "-a=");
const COMMAND = table("-p", "-v", "-V");
const TIME = table("-p --portability", "-f= --format=", "-o= --output=", "-a --append", "-q --quiet", "-v --verbose");
// GNU findutils 4.10 `xargs --help`; BSD xargs(1) adds -J replstr, -R replacements and -S replsize.
const XARGS = table(
  "-0 --null", "-a= --arg-file=", "-d= --delimiter=", "-E=", "-e[=] --eof[=]", "-I=", "-i[=] --replace[=]",
  "-L= --max-lines=", "-l[=]", "-n= --max-args=", "-o --open-tty", "-P= --max-procs=", "-p --interactive",
  "--process-slot-var=", "-r --no-run-if-empty", "-s= --max-chars=", "--show-limits", "-t --verbose", "-x --exit",
  "-J=", "-R=", "-S=",
);
// npm exec / npx (docs.npmjs.com/cli/commands/npx), with the npm config flags agents pass to it.
const NPX = table(
  "-p= --package=", "-c= --call=", "-y --yes", "--no", "--no-install", "-q --quiet", "-s --silent", "-w= --workspace=",
  "--workspaces --ws", "--include-workspace-root", "--registry=", "--cache=", "--prefix=", "--userconfig=", "--loglevel=",
);
// pnpm.io/pnpm-cli (global options), /cli/exec and /cli/dlx.
const PNPM = table(
  "-C= --dir=", "-w --workspace-root", "-F= --filter=", "-r --recursive", "-s --silent", "--reporter=", "--loglevel=",
  "--stream", "--parallel", "--aggregate-output", "--use-stderr", "--color", "--no-color",
);
const PNPM_RUN = table("-c --shell-mode", "--package=", "--allow-build=", "-s --silent", "--resume-from=", "--report-summary", "-r --recursive", "--parallel");
// yarnpkg.com/cli (classic and berry --cwd), /cli/dlx; bun.sh/docs/cli/bunx.
const YARN = table("--cwd=", "-s --silent", "--verbose");
const YARN_DLX = table("-p= --package=", "-q --quiet");
const BUNX = table("--bun", "-p= --package=", "--silent", "--verbose", "--no-install");

/** The command a package spec runs: `@scope/name@1.2` runs `name` (npx picks the bin named like the package). */
const binOf = (spec: string) => /^(?:@[^/]+\/)?([^@]*)/.exec(spec)![1]!;

/** The unwrapped call after `name` at `words[at]`, or undefined when it is not a wrapper. */
export function unwrap(name: string, words: readonly string[], at: number, dynamic: readonly boolean[]): Unwrapped | undefined {
  const read = (t: Table, from = at + 1) => readOptions(words, from, t, dynamic);
  const opts = (o: Options) => new Map(o.options);
  switch (name) {
    case "nice":
    case "stdbuf":
    case "time": {
      const o = read(name === "nice" ? NICE : name === "stdbuf" ? STDBUF : TIME);
      return { next: o.next, unknown: o.unknown };
    }
    case "timeout": {
      const o = read(TIMEOUT);
      // Then DURATION, then the command.
      return { next: o.next + 1, unknown: o.unknown || dynamic[o.next] === true };
    }
    case "nohup":
    case "builtin":
      return { next: words[at + 1] === "--" ? at + 2 : at + 1 };
    case "coproc":
      // `coproc NAME { ...; }` names a compound command; a simple command takes no NAME (bash(1), Coprocesses).
      return { next: words[at + 2] === "{" ? at + 3 : at + 1 };
    case "command": {
      const o = read(COMMAND);
      return o.options.some(([k]) => k === "-v" || k === "-V") ? { next: o.next, none: true } : { next: o.next, unknown: o.unknown };
    }
    case "exec": {
      const o = read(EXEC);
      return { next: o.next, unknown: o.unknown, ...(opts(o).has("-c") ? { clearEnv: true } : {}) };
    }
    case "sudo": {
      const o = read(SUDO);
      const dir = opts(o).get("-D");
      return { next: o.next, unknown: o.unknown, ...(dir === undefined ? {} : { cwd: dir }) };
    }
    case "env": {
      const o = read(ENV);
      const out: Unwrapped = { next: o.next, unknown: o.unknown };
      // "A mere - implies -i."
      if (words[o.next] === "-" && !o.unknown) out.next++;
      if (out.next !== o.next || o.options.some(([k]) => k === "-i")) out.clearEnv = true;
      const unset = o.options.filter(([k]) => k === "-u").map(([, v]) => v ?? "");
      if (unset.length > 0) out.unset = unset;
      // The variable env -u removes, and the words env -S splits, must be known.
      if (o.dynamic.has("-u") || o.dynamic.has("-S")) out.unknown = true;
      const dir = opts(o).get("-C");
      if (dir !== undefined) out.cwd = dir;
      const split = opts(o).get("-S");
      if (split !== undefined) out.split = split;
      return out;
    }
    case "xargs": {
      const o = read(XARGS);
      const m = opts(o);
      const replace = m.has("-I") ? m.get("-I") : m.has("-i") ? (m.get("-i") ?? "{}") : m.get("-J");
      return { next: o.next, unknown: o.unknown, xargs: { ...(replace === undefined ? {} : { replace }), spread: !m.has("-I") && !m.has("-i") } };
    }
    case "npx":
    case "bunx":
      return packageRunner(words, at + 1, name === "npx" ? NPX : BUNX, dynamic);
    case "npm":
    case "bun":
      if (!(name === "npm" ? ["exec", "x"] : ["x"]).includes(words[at + 1] ?? "")) return undefined;
      return packageRunner(words, at + 2, name === "npm" ? NPX : BUNX, dynamic);
    case "pnpm":
    case "yarn": {
      // Global flags, then `exec`, `dlx`, yarn's `run`, or a bin (pnpm runs one that is not its own command).
      const o = read(name === "pnpm" ? PNPM : YARN);
      const dir = opts(o).get("-C") ?? opts(o).get("--cwd");
      const sub = words[o.next];
      let out: Unwrapped;
      if (sub === "dlx") out = packageRunner(words, o.next + 1, name === "pnpm" ? PNPM_RUN : YARN_DLX, dynamic);
      else if (sub === "exec" || (sub === "run" && name === "yarn")) {
        const e = readOptions(words, o.next + 1, name === "pnpm" ? PNPM_RUN : table(), dynamic);
        out = opts(e).has("-c") ? { next: e.next, script: words.slice(e.next).join(" ") } : { next: e.next, unknown: e.unknown };
      } else out = { next: o.next };
      return { ...out, unknown: o.unknown || out.unknown === true, ...(dir === undefined ? {} : { cwd: dir }) };
    }
  }
  return undefined;
}

/** npx, npm exec, pnpm dlx, yarn dlx, bunx: the first operand is the package, or with -p the command. */
function packageRunner(words: readonly string[], from: number, t: Table, dynamic: readonly boolean[]): Unwrapped {
  const o = readOptions(words, from, t, dynamic);
  const m = new Map(o.options);
  // npx -c takes the line; pnpm dlx -c (--shell-mode) runs the words after the options as one.
  if (m.has("-c")) return { next: o.next, script: m.get("-c") ?? words.slice(o.next).join(" "), unknown: o.unknown };
  const spec = words[o.next];
  if (spec === undefined || m.has("-p")) return { next: o.next, unknown: o.unknown };
  return { next: o.next, bin: binOf(spec), unknown: o.unknown };
}

/** What a call's shell state holds of its environment and folder, as `shellwords.ts` keeps it. */
export interface CallState {
  base?: string;
  cwd?: string;
  exported: Record<string, string>;
  plain: Record<string, string>;
  clearEnv?: boolean;
  callUnset?: string[];
}

/** The state a wrapper's call runs in: its folder (`env -C`), and the variables it removes or empties. */
export function forCall<S extends CallState>(state: S, step: Pick<Unwrapped, "cwd" | "clearEnv" | "unset">, copy: (s: S) => S): S {
  if (step.cwd === undefined && !step.clearEnv && !step.unset) return state;
  const next = copy(state);
  if (step.cwd !== undefined) next.cwd = resolve(state.cwd ?? state.base ?? ".", step.cwd);
  if (step.clearEnv) [next.exported, next.plain, next.clearEnv] = [{}, {}, true];
  for (const name of step.unset ?? []) {
    delete next.exported[name];
    delete next.plain[name];
  }
  if (step.unset) next.callUnset = [...(state.callUnset ?? []), ...step.unset];
  return next;
}

/** The words after a wrapper: env -S's split in, a runner's bin named, and the words xargs adds. */
export function wrappedWords([words, quoted, dynamic, expansions]: Words, step: Unwrapped, split: string[]): Words {
  const [w, q, d, x] = [[...words], [...quoted], [...dynamic], [...expansions]];
  const put = (at: number, remove: number, value: string[]) => {
    w.splice(at, remove, ...value);
    q.splice(at, remove, ...value.map(() => false));
    d.splice(at, remove, ...value.map(() => false));
    x.splice(at, remove, ...value.map(() => undefined));
  };
  put(step.next, 0, split);
  if (step.bin !== undefined && step.next < w.length) put(step.next, 1, [step.bin]);
  const xargs = step.xargs;
  if (xargs && xargs.replace === undefined) put(w.length, 0, [DYNAMIC_WORDS]);
  else if (xargs?.replace) {
    // Each input line (with -J, the input's words) goes where the string is; a flag keeps its name.
    const marker = xargs.spread ? DYNAMIC_WORDS : DYNAMIC_WORD;
    for (let k = step.next; k < w.length; k++) {
      const at = w[k]!.indexOf(xargs.replace);
      if (at !== -1) put(k, 1, [w[k]!.startsWith("-") ? w[k]!.slice(0, at) + marker : marker]);
    }
  }
  return [w, q, d, x];
}
