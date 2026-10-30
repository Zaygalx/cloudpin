import type { Expansion } from "./shell-tokens.js";
import { UNKNOWN_VALUE } from "./types.js";
import type { Variables } from "./word-expansion.js";

/** The words of one statement, as `shellwords.ts` keeps them. */
export type Words = [words: string[], quoted: boolean[], dynamic: boolean[], expansions: (Expansion[] | undefined)[]];

/**
 * PowerShell's statement keywords (about_Language_Keywords): such a statement ends with its ( ) or { }, and
 * another may follow on the same line (#159). return and throw are not here: they run the pipeline after them.
 */
export const PS_KEYWORDS = new Set([
  "if", "elseif", "else", "switch", "foreach", "for", "while", "do", "until", "try", "catch", "finally",
  "function", "filter", "workflow", "trap", "param", "begin", "process", "end", "dynamicparam", "class", "enum",
  "data", "break", "continue", "exit",
]);

/** What a PowerShell line set, as `shellwords.ts` keeps it: its variables are stored as `$name`, in lower case. */
export interface PsState {
  vars: Record<string, string>;
  exported: Record<string, string>;
  /** Variables set from something other than one literal: a list, or a command's output, may be several words. */
  lists: Set<string>;
}

/**
 * How a PowerShell line reads a variable (#159): names ignore case, $env:X is the environment variable X,
 * and a value is never split. One the line set from a single literal is known; one it set from anything
 * else, $args and $input may be several words; any other is one word known only when it runs.
 */
export function psVariables(state: PsState): Variables {
  return {
    keepWhole: true,
    known(name) {
      const lower = name.toLowerCase();
      const value = lower.startsWith("env:")
        ? Object.entries(state.exported).find(([k]) => k.toLowerCase() === lower.slice(4))?.[1]
        : state.vars[`$${lower}`];
      return value === UNKNOWN_VALUE ? undefined : value;
    },
    oneWord: (name) => !state.lists.has(name.toLowerCase()) && !["args", "input"].includes(name.toLowerCase()),
  };
}

const ASSIGNMENT = /^\$(?:(?:script|global|local|private):)?([A-Za-z_]\w*)([-+*/%]?=)?/i;
const NUMBER = /^-?\d+(\.\d+)?$/;

/**
 * `$name = value` (and `$name='value'`, `$s += x`) at the start of a statement: the name, and whether the
 * value is one literal ('x', "x", 5) or something that may be several words, with the value's words.
 * Undefined when the statement is not an assignment ($env: assignments are read apart).
 */
export function psAssignment([words, quoted, dynamic, expansions]: Words): { name: string; literal: boolean; value: Words } | undefined {
  const first = words[0] ?? "";
  const m = ASSIGNMENT.exec(first);
  if (!m || /^\$env:/i.test(first)) return undefined;
  // The assignment operator ends the first word (`$s=x`), or starts the second (`$s = x`, `$s =x`).
  let at = 0;
  let typed = m[0];
  let operator = m[2];
  if (operator === undefined) {
    const op = /^[-+*/%]?=/.exec(words[1] ?? "");
    if (typed.length !== first.length || !op) return undefined;
    at = 1;
    typed = op[0];
    operator = op[0];
  }
  // The rest of the word the operator is in is the value's first word, unless it is empty.
  const head = words[at]!.slice(typed.length);
  const headExpansions = (expansions[at] ?? []).filter((e) => e.at >= typed.length).map((e) => ({ ...e, at: e.at - typed.length }));
  const keep = head !== "" || headExpansions.length > 0 || quoted[at] === true;
  const value: Words = [
    [...(keep ? [head] : []), ...words.slice(at + 1)],
    [...(keep ? [quoted[at]!] : []), ...quoted.slice(at + 1)],
    [...(keep ? [headExpansions.length > 0] : []), ...dynamic.slice(at + 1)],
    [...(keep ? [headExpansions.length > 0 ? headExpansions : undefined] : []), ...expansions.slice(at + 1)],
  ];
  const [w, q] = value;
  const literal = operator === "=" && w.length === 1 && (q[0] === true || NUMBER.test(w[0]!)) && !w[0]!.includes(",");
  return { name: m[1]!.toLowerCase(), literal, value };
}
