import { homedir } from "node:os";
import { resolve } from "node:path";
import { commandName } from "./guard.js";
import { tokenizePowerShell, windowsPowerShellArgv } from "./ps-tokens.js";
import { psAssignment, psVariables } from "./ps-words.js";
import { type Expansion, tokenize } from "./shell-tokens.js";
import { DYNAMIC_WORD, DYNAMIC_WORDS, UNKNOWN_VALUE } from "./types.js";
import { expandWord, isDynamic, substitute, type Variables } from "./word-expansion.js";

export interface Invocation {
  /** Executable as written, e.g. "gh" or "/usr/bin/gh". */
  bin: string;
  args: string[];
  /**
   * Variables the CLI receives from the line: exported earlier in it (`export X=1;`,
   * PowerShell `$env:X = 1`) or assigned before the command (`X=1 cli`) (#86).
   */
  env: Record<string, string>;
  /** Plain `X=1;` assignments earlier in the line: they reach the CLI only if X is already exported. */
  ifExported?: Record<string, string>;
  /** Names `unset` earlier in the line. */
  unset?: string[];
  /** Folder the call runs in, when a `cd` earlier in the line changed it. */
  cwd?: string;
}

export { UNKNOWN_VALUE };

/** The shell that reads the line: bash (also sh, zsh, Git Bash) or PowerShell (5.1 or 7) (#159). */
export type Dialect = "bash" | "powershell";

const ASSIGNMENT = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/s;
// Words that run the command after them (shell keywords, prefixes, runners).
const PASS_THROUGH = new Set([
  "sudo", "command", "time", "nohup", "exec", "builtin", "nice",
  "npx", "bunx", "{", "!", "if", "then", "else", "elif", "while", "until", "do",
]);
// Runners whose second word is a subcommand, e.g. `pnpm dlx vercel`.
const RUNNER_SUBCOMMANDS: Record<string, string[]> = {
  pnpm: ["dlx", "exec"],
  yarn: ["dlx", "exec"],
  npm: ["exec", "x"],
  bun: ["x"],
};
// Wrappers with flags that take a value, and how many positional words
// (e.g. timeout's duration) come before the wrapped command.
const VALUE_WRAPPERS: Record<string, { valueFlags: string[]; positionals: number }> = {
  timeout: { valueFlags: ["-s", "-k", "--signal", "--kill-after"], positionals: 1 },
  xargs: { valueFlags: ["-n", "-I", "-i", "-P", "-L", "-l", "-d", "-a", "-E", "-e", "-s"], positionals: 0 },
  watch: { valueFlags: ["-n", "--interval"], positionals: 0 },
};
// find options whose arguments, up to ";" or "+", are a command it runs.
const FIND_EXEC = new Set(["-exec", "-execdir", "-ok", "-okdir"]);
const SHELLS = new Set(["bash", "sh", "zsh", "dash"]);
const POWERSHELLS = new Set(["pwsh", "powershell"]);

interface State {
  /** Working directory after any `cd` seen so far; undefined until one is. */
  cwd?: string;
  base?: string;
  /** Variables set by plain `NAME=value` commands earlier in the line. */
  vars: Record<string, string>;
  /** Of those, the ones the shell passes to the commands it runs: `export`ed, or PowerShell `$env:` (#86). */
  exported: Record<string, string>;
  /** Plain `NAME=value` assignments not exported here: they reach a command only if NAME was already exported. */
  plain: Record<string, string>;
  /** Names `unset` and not set again since. */
  unset: Set<string>;
  /** The whole command line, to spot CLI names behind an unknown `$VAR` command. */
  line: string;
  guarded: Set<string>;
  /** The environment the line starts in, when given: only to tell that an unknown variable is one word (#160). */
  env?: NodeJS.ProcessEnv;
  dialect: Dialect;
  /** PowerShell variables set from something other than one literal, which may be several words (#159). */
  lists: Set<string>;
}

/** The variables the line set, as word expansion reads them (#160). */
const variables = (state: State): Variables => (state.dialect === "powershell" ? psVariables(state) : {
  known(name) {
    if (state.unset.has(name)) return "";
    const value = state.vars[name];
    return value === UNKNOWN_VALUE ? undefined : value;
  },
  oneWord(name) {
    // Never its value, which may be a secret: only that it can't split or be a flag.
    const value = name in state.vars ? undefined : state.env?.[name];
    return value !== undefined && !/\s/.test(value) && !value.startsWith("-");
  },
});

/** A copy for code that runs in a child shell, whose `cd` and variables do not come back. */
const child = (state: State): State => ({
  ...state,
  vars: { ...state.vars },
  exported: { ...state.exported },
  plain: { ...state.plain },
  unset: new Set(state.unset),
  lists: new Set(state.lists),
});

// PowerShell assignment: `$name = <value>` or `$name=<value>`.
const PS_ASSIGNMENT = /^\$([A-Za-z_][A-Za-z0-9_]*)(?:=(.*))?$/s;
// PowerShell environment variable: `$env:NAME = <value>` or `$env:NAME=<value>` (#86).
const PS_ENV = /^\$env:([A-Za-z_][A-Za-z0-9_]*)(?:=(.*))?$/is;
// Builtins that export: `export`, and `declare`/`typeset` with -x.
const EXPORTERS = new Set(["export", "declare", "typeset"]);

/** Sets NAME for the rest of the line, exported or not. */
function assign(state: State, name: string, value: string, exported: boolean): void {
  state.vars[name] = value;
  state.unset.delete(name);
  // Assigning to an exported variable updates what commands receive.
  if (exported || name in state.exported) {
    state.exported[name] = value;
    delete state.plain[name];
  } else state.plain[name] = value;
}

function analyse(
  words: string[],
  stdin: string[],
  out: Invocation[],
  state: State,
  quoted: boolean[] = [],
  dynamic: boolean[] = [],
  expansions: (Expansion[] | undefined)[] = [],
): void {
  const vars = variables(state);
  // An assignment word's value with the variables the line set; UNKNOWN_VALUE when a part isn't known.
  const valueOf = (k: number, set: RegExpExecArray): string =>
    dynamic[k] ? (substitute(words[k]!, expansions[k] ?? [], vars)?.slice(set[1]!.length + 1) ?? UNKNOWN_VALUE) : set[2]!;
  if (state.dialect === "powershell") {
    // & and . run the command after them (about_Operators), return and throw the pipeline after them.
    if (!quoted[0] && ["&", ".", "return", "throw"].includes(words[0]?.toLowerCase() ?? "")) {
      [words, quoted, dynamic, expansions] = [words.slice(1), quoted.slice(1), dynamic.slice(1), expansions.slice(1)];
    } else {
      const set = psAssignment([words, quoted, dynamic, expansions]);
      if (set) {
        // `$x = vercel ls` runs vercel; a single literal is the value, a "..." with $( ) one unknown word.
        const [w, q, d, x] = set.value;
        if (!set.literal && w.length > 0) analyse(w, stdin, out, state, q, d, x);
        state.vars[`$${set.name}`] = !set.literal ? UNKNOWN_VALUE : d[0] ? (substitute(w[0]!, x[0] ?? [], vars) ?? UNKNOWN_VALUE) : w[0]!;
        state.lists[set.literal ? "delete" : "add"](set.name);
        return;
      }
      // An expression is not a command (`$cli x` is a parse error); its ( ) and $( ) parts were read already.
      if (!PS_ENV.test(words[0] ?? "") && dynamic[0]) return;
    }
  }
  const psEnv = PS_ENV.exec(words[0] ?? "");
  if (psEnv && (psEnv[2] !== undefined || words[1] === "=")) {
    // A single literal (`'other'`, `other`) is known; anything else (an expression,
    // a command, `(Get-Content f)`, `$x`) is only known when it runs.
    const inline = psEnv[2] !== undefined && psEnv[2] !== "";
    const from = inline ? 1 : psEnv[2] !== undefined ? 1 : 2;
    const value = inline ? psEnv[2]! : words[from];
    // Inline, the word's own `$env:` counts as an expansion, so look at the value part alone.
    const expandsValue = inline ? /\$[A-Za-z_{(]/.test(value!) : dynamic[from];
    const known = value !== undefined && words.length === (inline ? 1 : from + 1) && !expandsValue;
    assign(state, psEnv[1]!, known ? value : UNKNOWN_VALUE, true);
    return;
  }
  const ps = state.dialect === "bash" ? PS_ASSIGNMENT.exec(words[0] ?? "") : null;
  if (ps && (ps[2] !== undefined || words[1] === "=")) {
    // `$x = "vercel"` stores a string; `$x = vercel ls` runs vercel and stores its output.
    const inline = ps[2] !== undefined && ps[2] !== "";
    const rest = inline ? [ps[2]!, ...words.slice(1)] : words.slice(ps[2] !== undefined ? 1 : 2);
    const restQuoted = inline ? quoted : quoted.slice(ps[2] !== undefined ? 1 : 2);
    const restDynamic = inline ? [false, ...dynamic.slice(1)] : dynamic.slice(ps[2] !== undefined ? 1 : 2);
    const restExpansions = inline ? [undefined, ...expansions.slice(1)] : expansions.slice(ps[2] !== undefined ? 1 : 2);
    if (rest.length === 1 && restQuoted[0]) {
      state.vars[ps[1]!] = rest[0]!;
      return;
    }
    delete state.vars[ps[1]!];
    if (rest.length > 0) analyse(rest, stdin, out, state, restQuoted, restDynamic, restExpansions);
    return;
  }
  const env: Record<string, string> = {};
  let i = 0;
  for (;;) {
    const word = words[i];
    if (word === undefined) {
      // Only assignments: they set shell variables for the rest of the line.
      for (const [name, value] of Object.entries(env)) assign(state, name, value, false);
      return;
    }
    const assignment = ASSIGNMENT.exec(word);
    const name = commandName(word);
    const wrapper = VALUE_WRAPPERS[name];
    if (assignment) {
      env[assignment[1]!] = valueOf(i, assignment);
      i++;
    } else if (wrapper) {
      i++;
      while (words[i]?.startsWith("-")) {
        const flag = words[i]!;
        i += wrapper.valueFlags.includes(flag) ? 2 : 1;
      }
      i += wrapper.positionals;
    } else if (name === "env" || PASS_THROUGH.has(name)) {
      i++;
      // Skip the wrapper's own flags (sudo -u root, npx --yes, env -i).
      while (words[i]?.startsWith("-")) i += words[i] === "-u" ? 2 : 1;
    } else if (RUNNER_SUBCOMMANDS[name]?.includes(words[i + 1] ?? "")) {
      i += 2;
      while (words[i]?.startsWith("-")) i++;
    } else {
      break;
    }
  }
  let bin = words[i]!;
  let args = words.slice(i + 1);
  // Where `args` starts in `words`, while it holds the words as typed.
  let from = i + 1;
  let name = commandName(bin);
  if (!EXPORTERS.has(name) && name !== "unset" && name !== "cd") {
    // The words bash passes on: the variables the line set substituted, the rest marked as known only
    // when it runs (#160).
    const expanded = words
      .slice(i)
      .flatMap((w, k) => (expansions[i + k] ? expandWord(w, expansions[i + k]!, quoted[i + k] ?? false, vars) : [w]));
    if (expanded.length === 0) return;
    if (expanded[0] === DYNAMIC_WORD || expanded[0] === DYNAMIC_WORDS) {
      // A command held in a variable set elsewhere: check every guarded CLI the line names.
      // A bare `$files` is most likely a value (PowerShell pipes it), not a command.
      if (expanded.length > 1) for (const named of namedClis(state)) out.push(invocation(named, expanded.slice(1), env, state));
      return;
    }
    bin = expanded[0]!;
    name = commandName(bin);
    if (state.guarded.has(name)) {
      out.push(invocation(bin, expanded.slice(1), env, state));
      // Windows PowerShell 5.1 passes quotes inside an argument unescaped, and the CLI splits it again (#159).
      const legacy = state.dialect === "powershell" ? windowsPowerShellArgv(expanded.slice(1)) : [];
      if (state.dialect === "powershell" && JSON.stringify(legacy) !== JSON.stringify(expanded.slice(1))) out.push(invocation(bin, legacy, env, state));
      return;
    }
    // eval, shells, find and script blocks get the words as typed, which the code they run expands;
    // from a variable (`SH=bash; $SH -c ...`) they no longer line up with what was typed.
    if (dynamic[i]) [args, from] = [expanded.slice(1), -1];
  }
  // The words from `a` to `b` of `args`, with what analyse needs to expand them.
  const part = (a: number, b?: number): Parameters<typeof analyse> => {
    const end = b === undefined ? undefined : from + b;
    const slice = <T>(list: T[]) => (from === -1 ? [] : list.slice(from + a, end));
    return [args.slice(a, b), [], out, state, slice(quoted), slice(dynamic), slice(expansions)];
  };

  if (EXPORTERS.has(name)) {
    // `declare`/`typeset` export only with -x; `export -n` un-exports (left alone: it never adds a variable).
    const flags = args.filter((a) => a.startsWith("-"));
    if (name !== "export" && !flags.some((f) => /^-[a-zA-Z]*x/.test(f))) return;
    if (flags.includes("-n")) return;
    const offset = i + 1;
    args.forEach((arg, k) => {
      if (arg.startsWith("-")) return;
      const set = ASSIGNMENT.exec(arg);
      if (set) assign(state, set[1]!, valueOf(offset + k, set), true);
      else if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(arg) && arg in state.vars) assign(state, arg, state.vars[arg]!, true);
    });
    return;
  }
  if (name === "unset") {
    if (args.includes("-f")) return;
    for (const arg of args) {
      if (arg.startsWith("-")) continue;
      delete state.vars[arg];
      delete state.exported[arg];
      delete state.plain[arg];
      state.unset.add(arg);
    }
    return;
  }
  if (name === "cd") {
    const target = args[0];
    if (target !== undefined && target !== "-") {
      const expanded = target === "~" || target.startsWith("~/") ? homedir() + target.slice(1) : target;
      state.cwd = resolve(state.cwd ?? state.base ?? ".", expanded);
    }
    return;
  }
  if (name === "eval") {
    // eval joins its arguments and runs them as a command line, in this shell.
    if (!isDynamic(args.join(" "))) collect(args.join(" "), out, state);
  } else if (name === "find") {
    for (let k = 0; k < args.length; k++) {
      if (!FIND_EXEC.has(args[k]!)) continue;
      const end = args.findIndex((a, j) => j > k && (a === ";" || a === "+"));
      analyse(...part(k + 1, end === -1 ? undefined : end));
    }
  } else if (SHELLS.has(name) || POWERSHELLS.has(name)) {
    const flag = args.findIndex((a) =>
      SHELLS.has(name) ? /^-[a-z]*c$/.test(a) : /^-(c|command)$/i.test(a),
    );
    const script = flag === -1 ? undefined : args[flag + 1];
    // The script is read with the rules of the shell that runs it (#159).
    const inner = (): State => ({ ...child(state), dialect: POWERSHELLS.has(name) ? "powershell" : "bash" });
    if (script !== undefined && script !== "-") {
      if (!isDynamic(script)) collect(script, out, inner());
    }
    // A shell without a script reads its commands from standard input:
    // `bash <<EOF`, `bash <<< "..."`, `pwsh -Command - <<EOF`.
    else for (const body of stdin) collect(body, out, inner());
  } else if (args.includes("{")) {
    // A PowerShell script block, e.g. `ForEach-Object { gh pr view $_ }`: its
    // first statement shares this segment (later ones are segments of their own).
    const open = args.indexOf("{");
    const close = args.lastIndexOf("}");
    analyse(...part(open + 1, close > open ? close : undefined));
  }
}

function invocation(bin: string, args: string[], env: Record<string, string>, state: State): Invocation {
  const inv: Invocation = { bin, args, env: { ...state.exported, ...env } };
  if (Object.keys(state.plain).length > 0) inv.ifExported = { ...state.plain };
  if (state.unset.size > 0) inv.unset = [...state.unset];
  if (state.cwd !== undefined) inv.cwd = state.cwd;
  return inv;
}

/** Guarded CLI names that appear as whole words anywhere in the line. */
function namedClis(state: State): string[] {
  return [...state.guarded].filter((name) =>
    new RegExp(`(^|[^A-Za-z0-9_.-])${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^A-Za-z0-9_.-]|$)`).test(state.line),
  );
}

function collect(input: string, out: Invocation[], state: State): void {
  let segment: string[] = [];
  let quoted: boolean[] = [];
  let dynamic: boolean[] = [];
  let expansions: (Expansion[] | undefined)[] = [];
  let stdin: string[] = [];
  // What to go back to when a ( ) subshell ends: its `cd` and variables don't come back (#86).
  const saved: State[] = [];
  const end = () => {
    if (segment.length > 0) analyse(segment, stdin, out, state, quoted, dynamic, expansions);
    segment = [];
    quoted = [];
    dynamic = [];
    expansions = [];
    stdin = [];
  };
  for (const token of state.dialect === "powershell" ? tokenizePowerShell(input) : tokenize(input)) {
    if (token.kind === "word") {
      segment.push(token.value);
      quoted.push(token.quoted);
      dynamic.push(token.dynamic);
      expansions.push(token.expansions);
    }
    else if (token.kind === "stdin") stdin.push(token.body);
    // Runs where it appears, in a child shell, so a `cd` inside does not leak.
    else if (token.kind === "subst") collect(token.inner, out, child(state));
    else {
      end();
      if (token.op === "(") saved.push(child(state));
      else if (token.op === ")" && saved.length > 0) {
        const outer = saved.pop()!;
        state.cwd = outer.cwd;
        state.vars = outer.vars;
        state.exported = outer.exported;
        state.plain = outer.plain;
        state.unset = outer.unset;
      }
    }
  }
  end();
}

/**
 * Finds every call to a guarded CLI in a shell command line, including inside
 * pipelines, lists, subshells, command substitutions, `bash -c` strings and
 * heredocs fed to a shell. With `baseCwd`, a `cd` earlier in the line sets the
 * call's `cwd` (scoped to its subshell), so `cd ../other && vercel deploy` is
 * checked against ../other's pins. A command held in a variable is resolved
 * from assignments earlier in the line; if it can't be, every guarded CLI the
 * line names is checked. A variable the line set is substituted; any other
 * expansion becomes DYNAMIC_WORD or DYNAMIC_WORDS, which `env` (the
 * environment the line starts in) can only narrow to one word (#160).
 * `dialect` is the shell that reads the line: a PowerShell line is read with
 * PowerShell's rules (`ps-tokens.ts`), and each call also as Windows
 * PowerShell 5.1 passes it on (#159).
 */
export function findInvocations(
  command: string,
  guardedBins: string[],
  baseCwd?: string,
  env?: NodeJS.ProcessEnv,
  dialect: Dialect = "bash",
): Invocation[] {
  const out: Invocation[] = [];
  collect(command, out, {
    base: baseCwd,
    vars: {},
    exported: {},
    plain: {},
    unset: new Set(),
    line: command,
    guarded: new Set(guardedBins),
    dialect,
    lists: new Set(),
    ...(env ? { env } : {}),
  });
  return out;
}
