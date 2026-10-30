import type { Expansion } from "./shell-tokens.js";
import { DYNAMIC_WORD, DYNAMIC_WORDS } from "./types.js";

/** How the line can read a variable: its value when set earlier on the line, else whether it is one word. */
export interface Variables {
  /** The value of NAME when the line set it (or unset it: ""), else undefined. */
  known(name: string): string | undefined;
  /** True when NAME, unknown, is still sure to be one word that is not a flag (from the environment given). */
  oneWord(name: string): boolean;
}

const IFS = /[ \t\n]+/;

/**
 * The words bash makes of one word, with each variable the line set replaced by its value: an unquoted
 * one split on spaces, tabs and newlines, a quoted one kept whole (bash(1), EXPANSION) (#160). A word with
 * a part known only when it runs becomes DYNAMIC_WORD, or DYNAMIC_WORDS when bash may split that part;
 * the text before it is kept when it starts like a flag (`--context=`, `-n`), so the flag is still read.
 */
export function expandWord(value: string, expansions: readonly Expansion[], quoted: boolean, vars: Variables): string[] {
  const words: string[] = [];
  let text = "";
  // The word so far is a word even if empty: it had quotes or text.
  let real = false;
  // Text before the first unknown part, and whether that part may be several words.
  let prefix: string | undefined;
  let spread = false;
  const append = (s: string) => {
    text += s;
    if (s) real = true;
  };
  const end = () => {
    if (prefix !== undefined) {
      const marker = spread ? DYNAMIC_WORDS : DYNAMIC_WORD;
      words.push(prefix.startsWith("-") ? prefix + marker : marker);
    } else if (real) words.push(text);
    text = "";
    real = false;
    prefix = undefined;
    spread = false;
  };

  let pos = 0;
  for (const e of expansions) {
    append(value.slice(pos, e.at));
    pos = e.at + e.length;
    const known = e.name === undefined ? undefined : vars.known(e.name);
    if (known === undefined) {
      if (prefix === undefined) prefix = text;
      real = true;
      if (e.spread && !(e.name !== undefined && vars.oneWord(e.name))) spread = true;
    } else if (!e.spread) {
      append(known);
      real = true;
    } else {
      known.split(IFS).forEach((piece, k) => {
        if (k > 0) end();
        append(piece);
      });
    }
  }
  append(value.slice(pos));
  end();
  return words.length === 0 && quoted ? [""] : words;
}

/** The word with the variables the line set replaced, never split (an assignment's value); undefined if a part is unknown. */
export function substitute(value: string, expansions: readonly Expansion[], vars: Variables): string | undefined {
  let out = "";
  let pos = 0;
  for (const e of expansions) {
    const known = e.name === undefined ? undefined : vars.known(e.name);
    if (known === undefined) return undefined;
    out += value.slice(pos, e.at) + known;
    pos = e.at + e.length;
  }
  return out + value.slice(pos);
}

/** True when an argument holds a value known only when the command runs. */
export const isDynamic = (arg: string): boolean => arg.includes(DYNAMIC_WORD) || arg.includes(DYNAMIC_WORDS);
