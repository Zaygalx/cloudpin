import { splitCommandLine } from "./ps-tokens.js";

/**
 * `cmd /c` and `/k` (#162): the commands cmd.exe runs from the rest of its command line, each as the
 * arguments its program gets, or undefined when cmd.exe could make something cloudpin can't follow of it.
 * Checked against real cmd.exe from Windows PowerShell 5.1 and Git Bash with an argv printer, and
 * `cmd /?`:
 * - after /C, a line starting with a quote loses that quote and the last one, unless it holds exactly two,
 *   with no `&<>()@^|` and a space between them, and names a program; both readings are returned;
 * - outside quotes, & && || | and a newline end a command, ( ) group, `@` at the start echoes nothing,
 *   and `>`, `>>`, `<`, `2>`, `2>&1` with their target are redirections, not arguments;
 * - `call` runs the command after it;
 * - %NAME% (and !NAME! with /V:ON) is expanded and ^ escapes the next character, before and again after a
 *   pipe; `if`, `for` and `start` take arguments of their own: none of these are followed.
 * The .cmd layer under a CLI such as az.cmd is #168.
 */
export function cmdCommands(line: string, delayed: boolean): string[][] | undefined {
  if (/%[^%]+%/.test(line) || line.includes("^") || (delayed && line.includes("!"))) return undefined;
  const readings = [line];
  if (line.startsWith('"')) {
    const last = line.lastIndexOf('"');
    const inner = line.slice(1, last);
    readings[0] = inner + line.slice(last + 1);
    // Rule 1 of `cmd /?`: the quotes stay; cloudpin can't tell whether the text names a program.
    if (last > 0 && !inner.includes('"') && !/[&<>()@^|]/.test(inner) && /\s/.test(inner)) readings.push(line);
  }
  const out: string[][] = [];
  for (const reading of readings) {
    const commands = split(reading);
    if (commands === undefined) return undefined;
    out.push(...commands);
  }
  return out;
}

function split(line: string): string[][] | undefined {
  const commands: string[] = [];
  let current = "";
  let inQuotes = false;
  let i = 0;
  while (i < line.length) {
    const c = line[i]!;
    if (c === '"') {
      inQuotes = !inQuotes;
      current += c;
      i++;
    } else if (inQuotes) {
      current += c;
      i++;
    } else if (c === "&" || c === "|" || c === "\n" || c === "\r") {
      commands.push(current);
      current = "";
      i += line[i + 1] === c ? 2 : 1;
    } else if (c === "(" || c === ")") {
      current += " ";
      i++;
    } else if (c === "<" || c === ">") {
      // A stream number just before it belongs to it (`2>`), then `>>`, then `&1` or the target.
      current = current.replace(/(^|\s)\d$/, (_, before: string) => before);
      i += line[i + 1] === ">" ? 2 : 1;
      if (line[i] === "&") i += 2;
      else {
        while (line[i] === " " || line[i] === "\t") i++;
        let quoted = false;
        while (i < line.length && (quoted || !/[\s&|<>()]/.test(line[i]!))) {
          if (line[i] === '"') quoted = !quoted;
          i++;
        }
      }
      current += " ";
    } else {
      current += c;
      i++;
    }
  }
  commands.push(current);
  const out: string[][] = [];
  for (const command of commands) {
    const words = splitCommandLine(command.trim().replace(/^[@\s]+/, () => ""), false).map((t) => t.value);
    if (words.length === 0 || /^rem$/i.test(words[0]!)) continue;
    if (/^(if|for|start)$/i.test(words[0]!)) return undefined;
    out.push(/^call$/i.test(words[0]!) ? words.slice(1) : words);
  }
  return out;
}
