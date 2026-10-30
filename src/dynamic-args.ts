import { DYNAMIC_WORD, DYNAMIC_WORDS } from "./types.js";

const CANT_TELL = "so cloudpin can't tell which account this command would use";

/**
 * Why cloudpin can't tell the account when an argument is known only when the command runs (#160), or
 * undefined when none could pick it. Each reason names a flag, never a value:
 * - the value of one of `targetFlags` (`--context <x>`, `--context=<x>`, `-itn <x>`);
 * - a flag name completed at run time (`"--sub$(...)"`);
 * - an unquoted variable, or "$@", that bash may split into several words, flags included.
 * A `$(...)` or quoted value anywhere else is a value cloudpin doesn't need. Words after "--" are operands.
 */
export function dynamicTarget(args: readonly string[], targetFlags: readonly string[]): { problem: string; fix: string } | undefined {
  const value = (flag: string) => ({
    problem: `the value of ${flag} is only known when the command runs ($(...), backticks or a variable not set earlier in the line), ${CANT_TELL}`,
    fix: `give ${flag} a literal value, or run the command yourself`,
  });
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--") break;
    if (arg.includes(DYNAMIC_WORDS)) {
      return {
        problem: `the command has an unquoted variable not set earlier in the line, or "$@", which could expand to flags that pick the account, ${CANT_TELL}`,
        fix: "quote it if it is one value, give it a literal value, or run the command yourself",
      };
    }
    const at = arg.indexOf(DYNAMIC_WORD);
    if (at === -1) continue;
    if (arg.startsWith("-")) {
      const eq = arg.indexOf("=");
      if (eq !== -1 && eq < at) {
        if (targetFlags.includes(arg.slice(0, eq))) return value(arg.slice(0, eq));
        continue;
      }
      // Only the flag's first letter after a single dash: the rest may be a value (`-pVALUE`).
      const start = arg.startsWith("--") ? arg.slice(0, at) : arg.slice(0, 2);
      return {
        problem: `a flag starting with ${start} is completed by something only known when the command runs, ${CANT_TELL}`,
        fix: "write the flag out, or run the command yourself",
      };
    }
    const prev = args[i - 1] ?? "";
    if (targetFlags.includes(prev)) return value(prev);
    // A group of one-letter flags whose last one takes this value (`-itn <x>`).
    if (/^-[A-Za-z]{2,}$/.test(prev) && targetFlags.includes(`-${prev.at(-1)}`)) return value(`-${prev.at(-1)}`);
  }
  return undefined;
}
