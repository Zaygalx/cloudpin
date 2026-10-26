/**
 * Shell redirections (#154), read as bash reads them (bash(1), REDIRECTION): a stream number written
 * right before the operator, the operator, and one target word, attached or after spaces (`>out`,
 * `> out`, `2>&1`, `>&-`). PowerShell's (about_Redirection) have the same shapes, plus the stream `*`.
 * None of it is an argument of the command, and the `&` in `>&`, `<&` or `&>` does not end it.
 */

// &> &>> > >> >| >& < <> <&. Heredocs and here-strings (<< <<<) are read before this.
const OPERATOR = /&>>?|>[>|&]?|<[>&]?/y;

/** Length of the redirection operator at `at`, or 0. `<(` and `>(` are process substitutions. */
export function redirection(input: string, at: number): number {
  OPERATOR.lastIndex = at;
  const length = OPERATOR.exec(input)?.[0].length ?? 0;
  return input[at + length] === "(" ? 0 : length;
}

/**
 * Whether `word`, unquoted and ending right before the operator at `at`, is the stream it redirects:
 * one digit (`2>`, `1>&2`) or PowerShell's `*`. `&>` takes none, and an escaped `\2>` passes 2, as in
 * bash. Bash also takes `12>`, but PowerShell passes `12>x` as one argument: keeping the word is safe.
 */
export function isStream(input: string, at: number, word: string): boolean {
  return /^[0-9*]$/.test(word) && input[at] !== "&" && input[at - 2] !== "\\";
}
