import { PS_KEYWORDS } from "./ps-words.js";
import type { Expansion, Token } from "./shell-tokens.js";

/**
 * A PowerShell command line read as PowerShell reads it (#159), into the tokens `shell-tokens.ts` makes
 * for bash, so `shellwords.ts` finds calls the same way. Each rule was checked against Windows PowerShell
 * 5.1 with an argv printer named like the CLI (about_Parsing, about_Quoting_Rules, about_Special_Characters,
 * about_Comments, about_Redirection, about_Operators):
 * - the backtick escapes the next character (`n, `t... also in a bare word) and, at the start of a word,
 *   continues the line; a backslash is a plain character;
 * - '...' is literal ('' is a quote); "..." expands $var, ${var}, $env:X and $( ), with backtick escapes
 *   and "" for a quote; curly quotes count as quotes, a no-break space as a space;
 * - a word that starts with a quote, $( ), ( ) or @( ) ends where it closes (`'a'b` is two words); one
 *   that starts bare takes quotes in (`a'b c'` is one);
 * - here-strings @'...'@ and @"..."@ close only at the start of a line;
 * - # and <# #> start a comment only at the start of a word;
 * - ; and newlines end a statement, | a pipeline element, && and || (PowerShell 7; a parse error in 5.1);
 * - & and . at the start of a statement are call operators, kept as the word "&" or ".", and a keyword
 *   statement (if, foreach, function...) ends with its ( ) or { };
 * - a bare word that reads --% (also `--% or -'-%') passes the rest of the line, up to a newline or |, as
 *   typed: the CLI splits it, %NAME% expands; a quoted '--%' is dropped;
 * - redirections (>, >>, 2>, 2>&1, *>, 3>&1) at the start of a word are not arguments;
 * - ( ), @( ), $( ), { } and @{ } are read by this same scanner; their text is a "subst" token, so calls
 *   inside are found. As an argument, ( ), @( ) and a script block may be several words (a block becomes
 *   -encodedCommand ...), a bare $var or @splat too; $( ) is one word that is not a flag, as in bash (#160).
 */
export function tokenizePowerShell(input: string): Token[] {
  return scan(input, 0, "").tokens;
}

const SINGLE = "'\u2018\u2019\u201a\u201b";
const DOUBLE = '"\u201c\u201d\u201e';
const SPACE = /[ \t\v\f\u00a0\u1680\u2000-\u200a\u202f\u205f\u3000]/;
const NEWLINE = "\r\n";
// The backtick escapes 5.1 decodes; any other character stands for itself.
const ESCAPES: Record<string, string> = { "0": "\0", a: "\x07", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t", v: "\v" };
// $name, $scope:name, $env:NAME, and the one-character variables $$ $? $^.
const VARIABLE = /\$(?:([A-Za-z_]\w*):(?=\w))?(\w+)|\$([$?^])/y;
const SCOPES = new Set(["script", "global", "local", "private", "using"]);
// > >> 2> 2>> 2>&1 *> *>&1 3>&1 ... (about_Redirection).
const REDIRECTION = /[1-6*]?>>?(&[1-6])?/y;

const isSpace = (c: string | undefined) => c !== undefined && SPACE.test(c);
/** The name a line can set: `s` for $s and $script:s, `env:X` for $env:X; undefined for other drives. */
function variableName(scope: string | undefined, name: string): string | undefined {
  if (scope === undefined) return name;
  if (scope.toLowerCase() === "env") return `env:${name}`;
  return SCOPES.has(scope.toLowerCase()) ? name : undefined;
}

type Scanned = { tokens: Token[]; end: number; closed: boolean };

/** Reads from `from` to the end, or to the `closer` that closes a ( ) or { } read by the caller. */
function scan(input: string, from: number, closer: string): Scanned {
  const tokens: Token[] = [];
  let word = "";
  let inWord = false;
  let quoted = false;
  let expansions: Expansion[] = [];
  // A word was read in this statement, so a script block here is an argument.
  let commandSeen = false;
  // The statement starts with a keyword (if, foreach, param...): it ends after its ( ) or { }, and
  // another statement may follow on the same line (`if ($x) { } az ...`).
  let keyword = false;
  // The next word is a redirection's target.
  let target = false;

  const flush = () => {
    // A native command never gets an argument that reads --% (5.1 drops '--%' and "--%" too).
    if (inWord && !target && !(word === "--%" && expansions.length === 0)) {
      // Only a bare variable alone in its word may be several words; glued to text it is one string.
      const alone = expansions.length === 1 && expansions[0]!.at === 0 && expansions[0]!.length === word.length;
      if (!alone) for (const e of expansions) if (e.name !== undefined) e.spread = false;
      tokens.push({ kind: "word", value: word, quoted, dynamic: expansions.length > 0, ...(expansions.length > 0 ? { expansions } : {}) });
      if (!commandSeen) keyword = !quoted && expansions.length === 0 && PS_KEYWORDS.has(word.toLowerCase());
      commandSeen = true;
    }
    if (inWord) target = false;
    word = "";
    inWord = quoted = false;
    expansions = [];
  };
  const op = (o: string) => {
    flush();
    tokens.push({ kind: "op", op: o });
    commandSeen = keyword = false;
  };
  // After a keyword statement's ( ) or { }, what follows is another statement.
  const endKeyword = () => {
    if (keyword) op(";");
  };
  const mark = (length: number, spread: boolean, name?: string) => {
    expansions.push({ at: word.length, length, spread, ...(name === undefined ? {} : { name }) });
    inWord = true;
  };
  // Reads a ( ) or { } body starting at `start` with this scanner; its text is run where it appears.
  const nested = (start: number, close: string): number => {
    const found = scan(input, start, close);
    tokens.push({ kind: "subst", inner: input.slice(start, found.closed ? found.end - 1 : found.end) });
    return found.end;
  };
  // A $ expansion at `at`: returns the index after it, or -1 when the $ is a plain character.
  const readDollar = (at: number, inQuotes: boolean): number => {
    const next = input[at + 1];
    if (next === "(") {
      const end = nested(at + 2, ")");
      mark(0, false);
      return end;
    }
    if (next === "{") {
      const close = input.indexOf("}", at + 2);
      const end = close === -1 ? input.length : close + 1;
      const inner = input.slice(at + 2, close === -1 ? input.length : close);
      const colon = inner.indexOf(":");
      mark(end - at, !inQuotes, colon === -1 ? inner : variableName(inner.slice(0, colon), inner.slice(colon + 1)));
      word += input.slice(at, end);
      return end;
    }
    VARIABLE.lastIndex = at;
    const m = VARIABLE.exec(input);
    if (!m) return -1;
    mark(m[0].length, !inQuotes, m[3] ?? variableName(m[1], m[2]!));
    word += m[0];
    return at + m[0].length;
  };
  // Reads expandable text from `at` with backtick escapes and $ expansions, up to `end` (a here-string's
  // body) or, without one, to the quote that closes "..." ("" is a quote). Returns the index after it.
  const readExpandable = (at: number, end?: number): number => {
    let j = at;
    let n: number;
    while (j < (end ?? input.length)) {
      const c = input[j]!;
      if (end === undefined && DOUBLE.includes(c)) {
        if (!DOUBLE.includes(input[j + 1] ?? "x")) return j + 1;
        word += '"';
        j += 2;
      } else if (c === "`") {
        const e = input[j + 1] ?? "";
        word += ESCAPES[e] ?? e;
        j += 2;
      } else if (c !== "$" || (n = readDollar(j, true)) === -1) {
        word += c;
        j++;
      } else j = n;
    }
    return j;
  };
  // A here-string's body, from after the header's line to a line starting with `close` + "@".
  const hereString = (at: number, close: string): number => {
    let start = at + 2;
    while (input[start] === " " || input[start] === "\t") start++;
    if (!NEWLINE.includes(input[start] ?? "x")) return -1;
    start += input.startsWith("\r\n", start) ? 2 : 1;
    let end = start;
    while (end < input.length && !(close.includes(input[end]!) && input[end + 1] === "@" && (end === start || NEWLINE.includes(input[end - 1]!)))) end++;
    const body = end === start ? start : end - (input.slice(end - 2, end) === "\r\n" ? 2 : 1);
    inWord = quoted = true;
    if (close === SINGLE) word += input.slice(start, Math.max(start, body));
    else readExpandable(start, Math.max(start, body));
    flush();
    return Math.min(end + 2, input.length);
  };

  let i = from;
  let n: number;
  while (i < input.length) {
    const c = input[i]!;
    const next = input[i + 1];
    if (NEWLINE.includes(c)) {
      op("\n");
      i += c === "\r" && next === "\n" ? 2 : 1;
    } else if (isSpace(c) && inWord && word === "--%" && expansions.length === 0) {
      // Stop-parsing: a bare word that reads --% (`--%, -'-%' too); flush() drops the word itself.
      flush();
      i = stopParsing(input, i + 1, tokens);
      commandSeen = true;
    } else if (isSpace(c)) {
      flush();
      i++;
    } else if (c === "`") {
      if (!inWord && next !== undefined && NEWLINE.includes(next)) i += next === "\r" && input[i + 2] === "\n" ? 3 : 2;
      else if (!inWord && isSpace(next)) i += 2;
      else {
        if (next !== undefined) word += ESCAPES[next] ?? next;
        inWord = true;
        i += 2;
      }
    } else if (SINGLE.includes(c)) {
      const starts = !inWord;
      let j = i + 1;
      while (j < input.length && !(SINGLE.includes(input[j]!) && !SINGLE.includes(input[j + 1] ?? "x"))) {
        word += SINGLE.includes(input[j]!) ? "'" : input[j];
        j += SINGLE.includes(input[j]!) ? 2 : 1;
      }
      inWord = quoted = true;
      i = j + 1;
      if (starts) flush();
    } else if (DOUBLE.includes(c)) {
      const starts = !inWord;
      inWord = quoted = true;
      i = readExpandable(i + 1);
      if (starts) flush();
    } else if (c === "@" && !inWord && next !== undefined && (SINGLE + DOUBLE).includes(next) && (n = hereString(i, SINGLE.includes(next) ? SINGLE : DOUBLE)) !== -1) {
      i = n;
    } else if (c === "@" && !inWord && (next === "(" || next === "{")) {
      i = nested(i + 2, next === "(" ? ")" : "}");
      mark(0, next === "(");
      flush();
    } else if (c === "@" && !inWord && /\w/.test(next ?? "")) {
      // A splat: the elements of an array, or a hashtable's -name value pairs.
      const name = /^\w+/.exec(input.slice(i + 1))![0];
      mark(name.length + 1, true);
      word += `@${name}`;
      i += name.length + 1;
    } else if (c === "$") {
      const starts = !inWord;
      if ((n = readDollar(i, false)) === -1) {
        word += c;
        inWord = true;
        i++;
      } else {
        i = n;
        // A bare $var followed by .Member or [index] is an expression known only when it runs.
        const last = expansions.at(-1)!;
        if (starts && last.name !== undefined && ((input[i] === "." && /[A-Za-z_]/.test(input[i + 1] ?? "")) || input[i] === "[")) {
          delete last.name;
          last.spread = false;
        }
        if (starts && input[i - 1] === ")" && last.length === 0) flush();
      }
    } else if (c === "#" && !inWord) {
      while (i < input.length && !NEWLINE.includes(input[i]!)) i++;
    } else if (c === "<" && next === "#" && !inWord) {
      const end = input.indexOf("#>", i + 2);
      i = end === -1 ? input.length : end + 2;
    } else if (!inWord && (REDIRECTION.lastIndex = i, (n = REDIRECTION.exec(input)?.[0].length ?? 0) > 0)) {
      flush();
      target = !input.slice(i, i + n).includes("&");
      i += n;
    } else if (c === ";") {
      op(";");
      i++;
    } else if (c === "|" || (c === "&" && next === "&")) {
      op(next === c ? c + c : c);
      i += next === c ? 2 : 1;
    } else if (c === "&" && !inWord && !commandSeen) {
      // The call operator: the command follows (a name, a string, a variable or a script block). The
      // dot-source operator is a bare word ".", which shellwords drops the same way.
      tokens.push({ kind: "word", value: c, quoted: false, dynamic: false });
      i++;
    } else if (c === "&") {
      op("&");
      i++;
    } else if (c === "(") {
      flush();
      i = nested(i + 1, ")");
      mark(0, true);
      flush();
      endKeyword();
    } else if (c === "{") {
      flush();
      const argument = commandSeen;
      i = nested(i + 1, "}");
      if (argument) {
        mark(0, true);
        flush();
      }
      endKeyword();
    } else if (c === closer) {
      flush();
      return { tokens, end: i + 1, closed: true };
    } else if (c === ")" || c === "}" || (c === "<" && !inWord) || (c === "," && !inWord && (next === undefined || isSpace(next)))) {
      flush();
      i++;
    } else {
      word += c;
      inWord = true;
      i++;
    }
  }
  flush();
  return { tokens, end: i, closed: false };
}

/**
 * After --%, the text up to a newline or | goes to the program as typed, which splits it as the Windows C
 * runtime does: spaces separate words, "..." groups, a backslash escapes a quote. %NAME% is expanded first,
 * so it may hold several words.
 */
function stopParsing(input: string, from: number, tokens: Token[]): number {
  let end = from;
  while (end < input.length && !"\r\n|".includes(input[end]!)) end++;
  tokens.push(...splitCommandLine(input.slice(from, end), true));
  return end;
}

/**
 * The arguments a CLI gets from Windows PowerShell 5.1, which joins them into one command line without
 * escaping the quotes inside them, quoting only an argument with a space outside quotes (and dropping an
 * empty one): `'x "y --subscription z"'` reaches the CLI as `x y`, `--subscription`, `z`. PowerShell 7.3+
 * passes them as they are, except to .cmd and .bat files (az is az.cmd), so both readings are checked.
 */
export function windowsPowerShellArgv(args: readonly string[]): string[] {
  const needsQuotes = (arg: string) => {
    let inQuotes = false;
    for (const c of arg) {
      if (c === '"') inQuotes = !inQuotes;
      else if (/\s/.test(c) && !inQuotes) return true;
    }
    return false;
  };
  return splitCommandLine(args.map((a) => (needsQuotes(a) ? `"${a}"` : a)).join(" "), false).map((t) => t.value);
}

/**
 * Splits a Windows command line as the C runtime does: spaces and tabs separate words, "..." groups ("" in
 * it is a quote), and 2n backslashes before a quote are n, 2n+1 are n and a quote. With `percent`, %NAME%
 * (expanded before the CLI sees it, so it may hold several words) is marked as known only when it runs.
 */
function splitCommandLine(text: string, percent: boolean): (Token & { kind: "word" })[] {
  const out: (Token & { kind: "word" })[] = [];
  let word = "";
  let has = false;
  let quoted = false;
  let inQuotes = false;
  let expansions: Expansion[] = [];
  const push = () => {
    if (has) out.push({ kind: "word", value: word, quoted, dynamic: expansions.length > 0, ...(expansions.length > 0 ? { expansions } : {}) });
    word = "";
    has = quoted = false;
    expansions = [];
  };
  let k = 0;
  while (k < text.length) {
    const c = text[k]!;
    let slashes = 0;
    while (text[k + slashes] === "\\") slashes++;
    const env = percent && c === "%" ? /^%[A-Za-z_]\w*%/.exec(text.slice(k)) : null;
    has ||= c !== " " && c !== "\t";
    if (slashes > 0) {
      const quote = text[k + slashes] === '"';
      word += "\\".repeat(quote ? slashes >> 1 : slashes);
      if (quote && slashes % 2 === 1) word += '"';
      k += slashes + (quote && slashes % 2 === 1 ? 1 : 0);
    } else if (c === '"') {
      quoted = true;
      if (inQuotes && text[k + 1] === '"') {
        word += '"';
        k += 2;
      } else {
        inQuotes = !inQuotes;
        k++;
      }
    } else if ((c === " " || c === "\t") && !inQuotes) {
      push();
      k++;
    } else if (env) {
      expansions.push({ at: word.length, length: env[0].length, spread: true });
      word += env[0];
      k += env[0].length;
    } else {
      word += c;
      k++;
    }
  }
  push();
  return out;
}
