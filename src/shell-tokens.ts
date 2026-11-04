import { isStream, redirection } from "./redirections.js";

/**
 * A part of a word known only when it runs (#160): `length` characters of the word's value from `at` are
 * the expansion as typed, none for `$( )`, backticks, `<( )` and `$(( ))`, whose text is left out. `name`
 * is set for `$NAME` and `${NAME}`, which a line can set earlier; `spread` when it may be several words,
 * flags included: an unquoted variable, "$@" or "${a[@]}". A `$( )` or backticks is read as one word
 * that is not a flag, even unquoted (owner decision).
 */
export interface Expansion {
  at: number;
  length: number;
  name?: string;
  spread: boolean;
}

export type Token =
  /**
   * `quoted`: some of it was in quotes, so `"vercel"` is a string, not a command.
   * `dynamic`: it contains `$(...)`, `<(...)`, backticks or a `$NAME` expansion, so its value is only known when it runs.
   * `expansions`: where, when it is dynamic.
   */
  | { kind: "word"; value: string; quoted: boolean; dynamic: boolean; expansions?: Expansion[] }
  /** A control operator: ; & | newline, or ( and ) which open and close a subshell. */
  | { kind: "op"; op: string }
  /** $( ... ), <( ... ), >( ... ) or backticks: a command line run in a subshell. */
  | { kind: "subst"; inner: string }
  /** A heredoc or here-string: text the command reads on its standard input. */
  | { kind: "stdin"; body: string };

// The one-letter escapes of $'...', and its \xHH and \NNN codes (bash(1), QUOTING).
const ANSI_C_ESCAPES: Record<string, string> = {
  a: "\x07", b: "\b", e: "\x1b", E: "\x1b", f: "\f", n: "\n", r: "\r", t: "\t", v: "\v",
  "\\": "\\", "'": "'", '"': '"', "?": "?",
};
const ANSI_C_CODE = /x([0-9A-Fa-f]{1,2})|([0-7]{1,3})/y;

/**
 * Splits a POSIX-shell command line into words, control operators, command
 * substitutions and heredoc bodies, in the order they appear.
 */
export function tokenize(input: string): Token[] {
  // Git Bash drops every carriage return it reads, inside quotes too, so `\` + CRLF continues the line;
  // only a decoded $'\r' keeps one (#161).
  return scan(input.replace(/\r/g, ""), 0, false, new Map()).tokens;
}

type Scanned = { end: number; closed: boolean };

/**
 * Reads from `from` to the end of the input or, when `nested` in a `$( )`, to the `)` that closes it;
 * `end` is the index after that `)`. `seen` keeps each `$( )` read by where it starts: one that is tried as
 * arithmetic first is read twice, and nesting those would double the work at every level.
 */
function scan(input: string, from: number, nested: boolean, seen: Map<number, Scanned>): Scanned & { tokens: Token[] } {
  const tokens: Token[] = [];
  // Subshells opened by ( and not closed yet, inside this $( ).
  let depth = 0;
  let word = "";
  let inWord = false;
  let quoted = false;
  let dynamic = false;
  let expansions: Expansion[] = [];
  // The next word is a here-string (`<<< word`), not an argument.
  let hereString = false;
  // The next word is a redirection's target (#154).
  let target = false;
  // Heredocs whose bodies start after the next newline.
  const pending: { token: { kind: "stdin"; body: string }; delimiter: string; stripTabs: boolean }[] = [];
  const flush = () => {
    if (inWord && !target) {
      tokens.push(
        hereString
          ? { kind: "stdin", body: word }
          : { kind: "word", value: word, quoted, dynamic, ...(expansions.length > 0 ? { expansions } : {}) },
      );
    }
    if (inWord) hereString = target = false;
    word = "";
    inWord = false;
    quoted = false;
    dynamic = false;
    expansions = [];
  };
  // Notes a part of the word known only when it runs, starting here and `length` characters long.
  const mark = (length: number, spread: boolean, name?: string) => {
    expansions.push({ at: word.length, length, spread, ...(name === undefined ? {} : { name }) });
    dynamic = true;
  };
  // Reads a parameter expansion at the "$": `$NAME`, `${...}` or a special parameter (`$@`, `$1`, `$?`),
  // adding it to the word as typed. Returns the index after it, or -1 when the "$" is a plain character.
  const readParameter = (at: number, inQuotes: boolean): number => {
    const next = input[at + 1] ?? "";
    let end: number;
    let name: string | undefined;
    // Several words even in quotes: "$@", "${a[@]}". One word in quotes: "$*", "${a[*]}".
    let many = false;
    let spread = !inQuotes;
    if (next === "{") {
      let depth = 0;
      end = at + 1;
      while (end < input.length && !(input[end] === "}" && --depth === 0)) if (input[end++] === "{") depth++;
      const inner = input.slice(at + 2, end);
      end = Math.min(end + 1, input.length);
      if (/^[A-Za-z_]\w*$/.test(inner)) name = inner;
      many = inner === "@" || /\[@\]$/.test(inner);
    } else if (/[A-Za-z_]/.test(next)) {
      name = /^[A-Za-z_]\w*/.exec(input.slice(at + 1))![0];
      end = at + 1 + name.length;
    } else if ("@*0123456789#?$!-".includes(next) && next !== "") {
      end = at + 2;
      many = next === "@";
      // A number or the shell's flags: never several words.
      if ("#?$!-".includes(next)) spread = false;
    } else return -1;
    mark(end - at, spread || many, name);
    word += input.slice(at, end);
    return end;
  };

  // Reads $( ... ), <( ... ) or >( ... ) starting after the "(", with this same tokenizer, so quotes,
  // comments and heredoc bodies inside it are read as on the outer line (#161).
  const readParen = (start: number): number => {
    let found = seen.get(start);
    if (!found) {
      const { end, closed } = scan(input, start, true, seen);
      seen.set(start, (found = { end, closed }));
    }
    tokens.push({ kind: "subst", inner: input.slice(start, found.closed ? found.end - 1 : found.end) });
    return found.end;
  };
  const readBacktick = (start: number): number => {
    let i = start;
    while (i < input.length && input[i] !== "`") i += input[i] === "\\" ? 2 : 1;
    tokens.push({ kind: "subst", inner: input.slice(start, i) });
    return i + 1;
  };
  // Reads (( ... )) arithmetic starting after the "((", so `1 << 3` is not a heredoc; only the $( ) and
  // backticks inside it run. Returns the index after the "))", or -1 where bash reads nested subshells
  // instead (the ")" that closes the first "(" is not followed by another) or a quote makes it unclear.
  const readArithmetic = (start: number): number => {
    const kept = tokens.length;
    let open = 0;
    let i = start;
    while (i < input.length && input[i] !== "'" && input[i] !== '"') {
      const c = input[i]!;
      if (c === "$" && input[i + 1] === "(" && input[i + 2] !== "(") i = readParen(i + 2);
      else if (c === "`") i = readBacktick(i + 1);
      else if (c === ")" && open === 0) {
        if (input[i + 1] === ")") return i + 2;
        break;
      } else {
        if (c === "(") open++;
        if (c === ")") open--;
        i += c === "\\" ? 2 : 1;
      }
    }
    tokens.length = kept;
    return -1;
  };
  // Reads $'...' starting after the "'", decoding escapes as bash does (bash(1), QUOTING). \u, \U, \c,
  // a NUL (where bash ends the word) or a byte past ASCII make the word known only when it runs.
  const readAnsiC = (start: number): number => {
    let i = start;
    while (i < input.length && input[i] !== "'") {
      const c = input[i]!;
      const e = input[i + 1] ?? "";
      ANSI_C_CODE.lastIndex = i + 1;
      const code = c === "\\" ? ANSI_C_CODE.exec(input) : null;
      if (c !== "\\") {
        word += c;
        i++;
      } else if (e in ANSI_C_ESCAPES) {
        word += ANSI_C_ESCAPES[e];
        i += 2;
      } else if (code) {
        const value = parseInt(code[1] ?? code[2]!, code[1] ? 16 : 8);
        if (value === 0 || value > 0x7f) mark(0, false);
        else word += String.fromCharCode(value);
        i = ANSI_C_CODE.lastIndex;
      } else {
        // bash keeps the backslash of an escape it does not know.
        if (e && "uUc".includes(e)) mark(2, false);
        word += c + e;
        i += 2;
      }
    }
    return i + 1;
  };
  // Reads $( ... ) or $(( ... )) starting at the "$".
  const readDollarParen = (at: number): number => {
    const end = input[at + 2] === "(" ? readArithmetic(at + 3) : -1;
    return end === -1 ? readParen(at + 2) : end;
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

  let i = from;
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
          mark(0, false);
          i = readDollarParen(i);
        } else if (d === "`") {
          mark(0, false);
          i = readBacktick(i + 1);
        } else if (d !== "$" || (n = readParameter(i, true)) === -1) {
          word += d;
          i++;
        } else i = n;
      }
      i++;
    } else if (c === "$" && input[i + 1] === "'") {
      inWord = true;
      quoted = true;
      i = readAnsiC(i + 2);
    } else if (c === "$" && input[i + 1] === '"') {
      // A locale string, $"...", reads like "..." (#161).
      i++;
    } else if (c === "\\") {
      if (i + 1 < input.length && input[i + 1] !== "\n") {
        word += input[i + 1];
        inWord = true;
      }
      i += 2;
    } else if ("$<>".includes(c) && input[i + 1] === "(") {
      // $(...), or a process substitution <(...) >(...): one argument, joined with any text around it (#156).
      inWord = true;
      // One word: $(( )) is a number, <( ) a path, and an unquoted $( ) is read as one value that is not a
      // flag (owner decision, #160), though bash would split its output.
      const arithmetic = c === "$" && input[i + 2] === "(" ? readArithmetic(i + 3) : -1;
      mark(0, false);
      i = arithmetic !== -1 ? arithmetic : readParen(i + 2);
    } else if (c === "(" && input[i + 1] === "(" && !inWord && (n = readArithmetic(i + 2)) !== -1) {
      // An arithmetic command, (( ... )), or a C-style `for ((...))`.
      i = n;
    } else if (c === "`") {
      inWord = true;
      // One value that is not a flag, like an unquoted $( ) (#160).
      mark(0, false);
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
    } else if (nested && c === ")" && depth === 0) {
      flush();
      return { tokens, end: i + 1, closed: true };
    } else if (";&|()\n".includes(c)) {
      flush();
      tokens.push({ kind: "op", op: c });
      if (c === "(") depth++;
      if (c === ")") depth--;
      i++;
      if (c === "\n" && pending.length > 0) i = readBodies(i);
    } else {
      inWord = true;
      if (c !== "$" || (n = readParameter(i, false)) === -1) {
        word += c;
        i++;
      } else i = n;
    }
  }
  flush();
  return { tokens, end: i, closed: false };
}
