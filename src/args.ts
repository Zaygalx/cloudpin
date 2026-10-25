/**
 * Reads a flag's value from an argument list, supporting `--flag value`,
 * `--flag=value` and short aliases. The last occurrence wins, matching how
 * most CLIs parse repeated flags.
 */
export function flagValue(args: string[], names: string[]): string | undefined {
  let found: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--") break;
    for (const name of names) {
      if (arg === name && i + 1 < args.length) {
        found = args[i + 1];
      } else if (name.startsWith("--") && arg.startsWith(`${name}=`)) {
        found = arg.slice(name.length + 1);
      }
    }
  }
  return found;
}

/** Positional words before the first flag, e.g. ["auth", "switch"]. */
export function leadingWords(args: string[]): string[] {
  const words: string[] = [];
  for (const arg of args) {
    if (arg.startsWith("-")) break;
    words.push(arg);
  }
  return words;
}

/**
 * The command's words with flags left out, and with the values of `valueFlags`
 * (global flags that take a separate value) skipped, e.g. ["sso", "login"] for
 * `aws --profile prod sso login`. `--flag=value` needs no entry. Stops at "--".
 */
export function commandWords(args: string[], valueFlags: ReadonlySet<string>): string[] {
  const words: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--") break;
    if (arg.startsWith("-")) {
      if (valueFlags.has(arg)) i++;
      continue;
    }
    words.push(arg);
  }
  return words;
}

/**
 * Whether one of `names` is a word of its own before "--". Use it where a flag grants an
 * exemption (help, version, --dry-run): every CLI reads the words after "--" as operands, and
 * cobra and yargs read `--help=false` as "no help" (#146).
 */
export function hasBareFlag(args: string[], names: string[]): boolean {
  for (const arg of args) {
    if (arg === "--") return false;
    if (names.includes(arg)) return true;
  }
  return false;
}

export function hasAnyFlag(args: string[], names: string[]): boolean {
  return args.some((a) => names.includes(a) || names.some((n) => a.startsWith(`${n}=`)));
}
