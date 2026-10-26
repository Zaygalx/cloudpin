import { homedir } from "node:os";
import { resolve } from "node:path";
import { commandName } from "./guard.js";
import { isStream, redirection } from "./redirections.js";
import { UNKNOWN_VALUE } from "./types.js";

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

type Token =
  /**
   * `quoted`: some of it was in quotes, so `"vercel"` is a string, not a command.
   * `dynamic`: it contains `$(...)`, backticks or a `$NAME` expansion, so its value is only known when it runs.
   */
  | { kind: "word"; value: string; quoted: boolean; dynamic: boolean }
  /** A control operator: ; & | newline, or ( and ) which open and close a subshell. */
  | { kind: "op"; op: string }
  /** $( ... ) or backticks: a command line run in a subshell. */
  | { kind: "subst"; inner: string }
  /** A heredoc or here-string: text the command reads on its standard input. */
  | { kind: "stdin"; body: string };

/**
 * Splits a POSIX-shell command line into words, control operators, command
 * substitutions and heredoc bodies, in the order they appear.
 */
function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let word = "";
  let inWord = false;
  let quoted = false;
  let dynamic = false;
  // The next word is a here-string (`<<< word`), not an argument.
  let hereString = false;
  // The next word is a redirection's target (#154).
  let target = false;
  // Heredocs whose bodies start after the next newline.
  const pending: { token: { kind: "stdin"; body: string }; delimiter: string; stripTabs: boolean }[] = [];
  const flush = () => {
    if (inWord && !target) tokens.push(hereString ? { kind: "stdin", body: word } : { kind: "word", value: word, quoted, dynamic });
    if (inWord) hereString = target = false;
    word = "";
    inWord = false;
    quoted = false;
    dynamic = false;
  };
  // `$NAME` or `${NAME}` (not `$` alone or `$1`): an expansion outside single quotes.
  const expands = (at: number) => /[A-Za-z_{]/.test(input[at + 1] ?? "");

  // Reads $( ... ) starting after "$(", honouring nesting and quotes.
  const readParen = (start: number): number => {
    let depth = 1;
    let i = start;
    let quote: string | null = null;
    for (; i < input.length && depth > 0; i++) {
      const c = input[i]!;
      if (quote) {
        if (c === "\\" && quote === '"') i++;
        else if (c === quote) quote = null;
      } else if (c === "'" || c === '"') quote = c;
      else if (c === "\\") i++;
      else if (c === "(") depth++;
      else if (c === ")") depth--;
    }
    tokens.push({ kind: "subst", inner: input.slice(start, i - 1) });
    return i;
  };
  const readBacktick = (start: number): number => {
    let i = start;
    while (i < input.length && input[i] !== "`") i += input[i] === "\\" ? 2 : 1;
    tokens.push({ kind: "subst", inner: input.slice(start, i) });
    return i + 1;
  };
  // Reads a heredoc delimiter word, removing its quotes ('EOF', "EOF", \EOF).
  const readDelimiter = (start: number): [string, number] => {
    let i = start;
    let delimiter = "";
    while (i < input.length && !" \t\r\n;&|()<>".includes(input[i]!)) {
      const c = input[i]!;
      if (c === "'" || c === '"') {
        const end = input.indexOf(c, i + 1);
        const stop = end === -1 ? input.length : end;
        delimiter += input.slice(i + 1, stop);
        i = stop + 1;
      } else if (c === "\\") {
        delimiter += input[i + 1] ?? "";
        i += 2;
      } else {
        delimiter += c;
        i++;
      }
    }
    return [delimiter, i];
  };
  // Reads the pending heredoc bodies that start at `start`, one after another.
  const readBodies = (start: number): number => {
    let i = start;
    for (const { token, delimiter, stripTabs } of pending.splice(0)) {
      const lines: string[] = [];
      while (i < input.length) {
        const end = input.indexOf("\n", i);
        const raw = input.slice(i, end === -1 ? input.length : end);
        i = end === -1 ? input.length : end + 1;
        const line = stripTabs ? raw.replace(/^\t+/, "") : raw;
        if (line.replace(/\r$/, "") === delimiter) break;
        lines.push(line);
      }
      token.body = lines.join("\n");
    }
    return i;
  };

  let i = 0;
  let n = 0;
  while (i < input.length) {
    const c = input[i]!;
    if (c === "'") {
      const end = input.indexOf("'", i + 1);
      const stop = end === -1 ? input.length : end;
      word += input.slice(i + 1, stop);
      inWord = true;
      quoted = true;
      i = stop + 1;
    } else if (c === '"') {
      inWord = true;
      quoted = true;
      i++;
      while (i < input.length && input[i] !== '"') {
        const d = input[i]!;
        if (d === "\\" && i + 1 < input.length && '"\\$`\n'.includes(input[i + 1]!)) {
          word += input[i + 1];
          i += 2;
        } else if (d === "$" && input[i + 1] === "(") {
          dynamic = true;
          i = readParen(i + 2);
        } else if (d === "`") {
          dynamic = true;
          i = readBacktick(i + 1);
        } else {
          if (d === "$" && expands(i)) dynamic = true;
          word += d;
          i++;
        }
      }
      i++;
    } else if (c === "\\") {
      if (i + 1 < input.length && input[i + 1] !== "\n") {
        word += input[i + 1];
        inWord = true;
      }
      i += 2;
    } else if (c === "$" && input[i + 1] === "(") {
      inWord = true;
      dynamic = true;
      i = readParen(i + 2);
    } else if (c === "`") {
      inWord = true;
      dynamic = true;
      i = readBacktick(i + 1);
    } else if (c === "#" && !inWord) {
      // A comment runs to the end of the line.
      while (i < input.length && input[i] !== "\n") i++;
    } else if (c === "<" && input[i + 1] === "<" && input[i + 2] === "<") {
      flush();
      hereString = true;
      i += 3;
    } else if (c === "<" && input[i + 1] === "<") {
      flush();
      i += 2;
      const stripTabs = input[i] === "-";
      if (stripTabs) i++;
      while (input[i] === " " || input[i] === "\t") i++;
      const [delimiter, next] = readDelimiter(i);
      const token = { kind: "stdin" as const, body: "" };
      tokens.push(token);
      pending.push({ token, delimiter, stripTabs });
      i = next;
    } else if ((n = redirection(input, i))) {
      if (!quoted && !dynamic && isStream(input, i, word)) inWord = false;
      flush();
      target = true;
      i += n;
    } else if (" \t\r".includes(c)) {
      flush();
      i++;
    } else if (";&|()\n".includes(c)) {
      flush();
      tokens.push({ kind: "op", op: c });
      i++;
      if (c === "\n" && pending.length > 0) i = readBodies(i);
    } else {
      if (c === "$" && expands(i)) dynamic = true;
      word += c;
      inWord = true;
      i++;
    }
  }
  flush();
  return tokens;
}

const ASSIGNMENT = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/s;
const VARIABLE = /^\$(?:([A-Za-z_][A-Za-z0-9_]*)|\{([A-Za-z_][A-Za-z0-9_]*)\})$/;
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
}

/** A copy for code that runs in a child shell, whose `cd` and variables do not come back. */
const child = (state: State): State => ({
  ...state,
  vars: { ...state.vars },
  exported: { ...state.exported },
  plain: { ...state.plain },
  unset: new Set(state.unset),
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
): void {
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
  const ps = PS_ASSIGNMENT.exec(words[0] ?? "");
  if (ps && (ps[2] !== undefined || words[1] === "=")) {
    // `$x = "vercel"` stores a string; `$x = vercel ls` runs vercel and stores its output.
    const inline = ps[2] !== undefined && ps[2] !== "";
    const rest = inline ? [ps[2]!, ...words.slice(1)] : words.slice(ps[2] !== undefined ? 1 : 2);
    const restQuoted = inline ? quoted : quoted.slice(ps[2] !== undefined ? 1 : 2);
    const restDynamic = inline ? dynamic : dynamic.slice(ps[2] !== undefined ? 1 : 2);
    if (rest.length === 1 && restQuoted[0]) {
      state.vars[ps[1]!] = rest[0]!;
      return;
    }
    delete state.vars[ps[1]!];
    if (rest.length > 0) analyse(rest, stdin, out, state, restQuoted, restDynamic);
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
      env[assignment[1]!] = dynamic[i] ? UNKNOWN_VALUE : assignment[2]!;
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

  // A command held in a variable: `CLI=vercel; $CLI deploy`.
  const variable = VARIABLE.exec(bin);
  if (variable) {
    const held = state.vars[variable[1] ?? variable[2]!];
    const value = held === UNKNOWN_VALUE ? undefined : held;
    if (value === undefined) {
      // Unknown here (set elsewhere): check every guarded CLI the line names.
      // A bare `$files` is most likely a value (PowerShell pipes it), not a command.
      if (args.length > 0) for (const named of namedClis(state)) out.push(invocation(named, args, env, state));
      return;
    }
    // Unquoted expansion splits on whitespace.
    const [first, ...rest] = value.trim().split(/\s+/);
    if (!first) return;
    bin = first;
    args = [...rest, ...args];
  }

  const name = commandName(bin);
  if (EXPORTERS.has(name)) {
    // `declare`/`typeset` export only with -x; `export -n` un-exports (left alone: it never adds a variable).
    const flags = args.filter((a) => a.startsWith("-"));
    if (name !== "export" && !flags.some((f) => /^-[a-zA-Z]*x/.test(f))) return;
    if (flags.includes("-n")) return;
    const offset = i + 1;
    args.forEach((arg, k) => {
      if (arg.startsWith("-")) return;
      const set = ASSIGNMENT.exec(arg);
      if (set) assign(state, set[1]!, dynamic[offset + k] ? UNKNOWN_VALUE : set[2]!, true);
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
  if (state.guarded.has(name)) {
    out.push(invocation(bin, args, env, state));
  } else if (name === "eval") {
    // eval joins its arguments and runs them as a command line, in this shell.
    collect(args.join(" "), out, state);
  } else if (name === "find") {
    for (let k = 0; k < args.length; k++) {
      if (!FIND_EXEC.has(args[k]!)) continue;
      const end = args.findIndex((a, j) => j > k && (a === ";" || a === "+"));
      analyse(args.slice(k + 1, end === -1 ? undefined : end), [], out, state);
    }
  } else if (SHELLS.has(name) || POWERSHELLS.has(name)) {
    const flag = args.findIndex((a) =>
      SHELLS.has(name) ? /^-[a-z]*c$/.test(a) : /^-(c|command)$/i.test(a),
    );
    const script = flag === -1 ? undefined : args[flag + 1];
    if (script !== undefined && script !== "-") collect(script, out, child(state));
    // A shell without a script reads its commands from standard input:
    // `bash <<EOF`, `bash <<< "..."`, `pwsh -Command - <<EOF`.
    else for (const body of stdin) collect(body, out, child(state));
  } else if (args.includes("{")) {
    // A PowerShell script block, e.g. `ForEach-Object { gh pr view $_ }`: its
    // first statement shares this segment (later ones are segments of their own).
    const open = args.indexOf("{");
    const close = args.lastIndexOf("}");
    analyse(args.slice(open + 1, close > open ? close : undefined), [], out, state);
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
  let stdin: string[] = [];
  // What to go back to when a ( ) subshell ends: its `cd` and variables don't come back (#86).
  const saved: State[] = [];
  const end = () => {
    if (segment.length > 0) analyse(segment, stdin, out, state, quoted, dynamic);
    segment = [];
    quoted = [];
    dynamic = [];
    stdin = [];
  };
  for (const token of tokenize(input)) {
    if (token.kind === "word") {
      segment.push(token.value);
      quoted.push(token.quoted);
      dynamic.push(token.dynamic);
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
 * line names is checked.
 */
export function findInvocations(command: string, guardedBins: string[], baseCwd?: string): Invocation[] {
  const out: Invocation[] = [];
  collect(command, out, {
    base: baseCwd,
    vars: {},
    exported: {},
    plain: {},
    unset: new Set(),
    line: command,
    guarded: new Set(guardedBins),
  });
  return out;
}
