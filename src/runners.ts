import { cmdCommands } from "./cmd-line.js";
import { splitCommandLine } from "./ps-tokens.js";
import type { Dialect } from "./shellwords.js";
import { DYNAMIC_WORDS } from "./types.js";
import { readOptions, table } from "./wrappers.js";

/**
 * Commands that run a command line or an argument list they are given (#162): bash -c, watch,
 * cmd /c, powershell and pwsh, Invoke-Expression and Start-Process. Checked against real Git Bash, cmd.exe
 * and Windows PowerShell 5.1 with an argv printer, and the docs cited at each.
 */

/** An argument as typed (`raw`), and its value with the line's variables (undefined when it isn't known). */
export interface Arg {
  raw: string;
  value: string | undefined;
  quoted: boolean;
  dynamic: boolean;
}

export interface Run {
  /** Command lines it runs, each read by its shell. */
  lines?: { text: string; dialect: Dialect }[];
  /** Commands it starts with these arguments. */
  argvs?: string[][];
  /** It runs the arguments from this one on, as typed (`watch -x`). */
  from?: number;
  /** It reads its commands from standard input, in this dialect. */
  stdin?: Dialect;
  /** Something cloudpin can't read decides what runs. */
  unknown?: boolean;
  /** Folder the argvs run in, as written (Start-Process -WorkingDirectory). */
  cwd?: string;
}

const SHELLS = new Set(["bash", "sh", "zsh", "dash"]);
// procps-ng watch.c: getopt "+bCcefd::ghq:n:prs:twvx"; without -x it runs the arguments, joined with
// spaces, through system(), which is `sh -c`.
const WATCH = table(
  "-b --beep", "-C --no-color", "-c --color", "-e --errexit", "-f --follow", "-d[=] --differences[=]", "-g --chgexit",
  "-h --help", "-q= --equexit=", "-n= --interval=", "-p --precise", "-r --no-rerun", "-s= --shotsdir=", "-t --no-title",
  "-w --no-wrap", "-v --version", "-x --exec",
);

/** What `name` runs, or undefined when it doesn't run a line or a list it is given. */
export function runner(name: string, args: Arg[], dialect: Dialect): Run | undefined {
  if (SHELLS.has(name)) {
    const flag = args.findIndex((a) => /^-[a-z]*c$/.test(a.raw));
    const script = flag === -1 ? undefined : args[flag + 1]?.raw;
    return script === undefined || script === "-" ? { stdin: "bash" } : { lines: [{ text: script, dialect: "bash" }] };
  }
  if (name === "watch") {
    const o = readOptions(args.map((a) => a.raw), 0, WATCH, args.map((a) => a.dynamic));
    if (o.unknown) return { unknown: true };
    if (o.options.some(([k]) => k === "-x")) return { from: o.next };
    return { lines: [{ text: args.slice(o.next).map((a) => a.raw).join(" "), dialect: "bash" }] };
  }
  if (name === "cmd") return cmd(args, dialect);
  if (name === "powershell" || name === "pwsh") return powershell(args, name === "pwsh");
  if (dialect !== "powershell") return undefined;
  if (name === "iex" || name === "invoke-expression") return invokeExpression(args);
  if (name === "start-process" || name === "saps" || name === "start") return startProcess(args);
  return undefined;
}

/** `cmd [switches] /C|/K|/R string` (`cmd /?`); Git Bash turns `//c` into `/c`. */
function cmd(args: Arg[], dialect: Dialect): Run {
  let delayed = false;
  for (let k = 0; k < args.length; k++) {
    const value = args[k]!.value;
    if (value === undefined) return { unknown: true };
    const word = value.startsWith("//") ? value.slice(1) : value;
    const run = /^\/[ckr](.*)$/is.exec(word);
    if (run) {
      const rest = args.slice(k + 1).map((a) => a.value);
      if (rest.includes(undefined)) return { unknown: true };
      const line = [run[1]!, ...(rest as string[]).map((a) => quote(a, dialect))].filter((a) => a !== "").join(" ");
      const commands = cmdCommands(line, delayed);
      return commands === undefined ? { unknown: true } : { argvs: commands };
    }
    if (/^\/v:on$/i.test(word)) delayed = true;
    else if (!/^\/([aqdsuxy]|[efv]:(on|off)|t:[0-9a-f]{1,2})$/i.test(word)) return { unknown: true };
  }
  return {};
}

/**
 * How an argument reaches a program's command line: Windows PowerShell 5.1 quotes one with a space outside
 * quotes and leaves its quotes alone (ps-tokens.ts); Git Bash (Cygwin) quotes one with a space or a quote,
 * escaping the quotes inside with a backslash.
 */
function quote(arg: string, dialect: Dialect): string {
  if (dialect === "powershell") {
    let inQuotes = false;
    for (const c of arg) {
      if (c === '"') inQuotes = !inQuotes;
      else if (/\s/.test(c) && !inQuotes) return `"${arg}"`;
    }
    return arg;
  }
  if (arg !== "" && !/[\s"]/.test(arg)) return arg;
  const escaped = arg.replace(/(\\*)"/g, (_, slashes: string) => `${slashes}${slashes}\\"`);
  return `"${escaped.replace(/(\\*)$/, (slashes: string) => slashes + slashes)}"`;
}

// Parameters of powershell.exe (about_PowerShell_exe) and pwsh (CommandLineParameterParser.cs), in the order
// pwsh matches them: a name matches when it is at least the shortest form given and starts the full one.
const PS_PARAMS: [full: string, shortest: string, takes: "none" | "value" | "command" | "cwa" | "encoded" | "file"][] = [
  ["version", "v", "none"], ["help", "h", "none"], ["?", "?", "none"], ["login", "l", "none"], ["noexit", "noe", "none"],
  ["noprofile", "nop", "none"], ["nologo", "nol", "none"], ["noninteractive", "noni", "none"],
  ["socketservermode", "so", "none"], ["servermode", "s", "none"], ["namedpipeservermode", "nam", "none"],
  ["sshservermode", "sshs", "none"], ["interactive", "i", "none"], ["configurationfile", "configurationfile", "value"],
  ["configurationname", "config", "value"], ["custompipename", "cus", "value"], ["commandwithargs", "commandwithargs", "cwa"],
  ["cwa", "cwa", "cwa"], ["command", "c", "command"], ["windowstyle", "w", "value"], ["file", "f", "file"],
  ["outputformat", "o", "value"], ["of", "o", "value"], ["inputformat", "inp", "value"], ["if", "if", "value"],
  ["executionpolicy", "ex", "value"], ["ep", "ep", "value"], ["encodedcommand", "e", "encoded"], ["ec", "e", "encoded"],
  ["encodedarguments", "encodeda", "value"], ["ea", "ea", "value"], ["settingsfile", "settings", "value"],
  ["sta", "sta", "none"], ["mta", "mta", "none"], ["workingdirectory", "wo", "value"], ["wd", "wd", "value"],
  ["psconsolefile", "psc", "value"],
];

/**
 * powershell / pwsh: -Command (or -c, and in Windows PowerShell 5.1 the first other argument) takes the
 * rest of the arguments, joined with spaces, as its script; `-` reads it from standard input; -EncodedCommand
 * is the script in base64 UTF-16LE. pwsh's first other argument is a script file, like -File: a script file
 * is not read, as `bash deploy.sh` is not.
 */
function powershell(args: Arg[], pwsh: boolean): Run {
  const script = (from: number): Run => {
    const values = args.slice(from).map((a) => a.value);
    if (values.length === 1 && values[0] === "-") return { stdin: "powershell" };
    // A script block was read where it appears (ps-tokens.ts).
    if (args[from]?.raw.startsWith("{")) return {};
    return values.includes(undefined) ? { unknown: true } : { lines: [{ text: values.join(" "), dialect: "powershell" }] };
  };
  for (let k = 0; k < args.length; k++) {
    const { value, raw } = args[k]!;
    if (value === undefined) return raw.startsWith("{") ? {} : { unknown: true };
    const key = /^(?:--?|\/)(.*)$/s.exec(value)?.[1]?.toLowerCase();
    const param = key === undefined ? undefined : PS_PARAMS.find(([full, shortest]) => full.startsWith(key) && key.length >= shortest.length);
    // The first argument it doesn't know starts the script: a command in 5.1, a file in pwsh.
    if (!param) return pwsh ? {} : script(k);
    const takes = param[2];
    if (takes === "none") continue;
    if (takes === "value") k++;
    else if (takes === "command") return script(k + 1);
    else if (takes === "file") return args[k + 1]?.value === "-" ? { stdin: "powershell" } : {};
    else {
      // -CommandWithArgs takes one argument as its script, and the rest as its $args.
      const text = args[k + 1]?.value;
      if (text === undefined) return args[k + 1] ? { unknown: true } : {};
      if (takes === "cwa") return { lines: [{ text, dialect: "powershell" }] };
      if (!/^[A-Za-z0-9+/]+={0,2}$/.test(text) || text.length % 4 !== 0) return {};
      return { lines: [{ text: Buffer.from(text, "base64").toString("utf16le"), dialect: "powershell" }] };
    }
  }
  return {};
}

/** `Invoke-Expression [-Command] <string>`, or the strings piped to it. */
function invokeExpression(args: Arg[]): Run {
  const rest = args[0] && /^-c(o(m(m(a(n(d)?)?)?)?)?)?$/i.test(args[0].raw) ? args.slice(1) : args;
  const arg = rest[0];
  if (arg === undefined) return { stdin: "powershell" };
  if (arg.raw.startsWith("{")) return {};
  return arg.value === undefined ? { unknown: true } : { lines: [{ text: arg.value, dialect: "powershell" }] };
}

// Start-Process's parameters with their aliases (Microsoft.PowerShell.Management docs), and the common
// parameters. `arg` is the list it runs the program with; `stop` runs it as someone else, elevated or in
// an environment the line doesn't show.
const START_PROCESS: [names: string[], takes: "none" | "value" | "file" | "arg" | "cwd" | "stop"][] = [
  [["filepath", "pspath", "path"], "file"], [["argumentlist", "args"], "arg"], [["workingdirectory"], "cwd"],
  [["credential", "runas"], "stop"], [["verb"], "stop"], [["usenewenvironment"], "stop"], [["environment"], "stop"],
  [["loaduserprofile", "lup"], "none"], [["nonewwindow", "nnw"], "none"], [["passthru"], "none"], [["wait"], "none"],
  [["redirectstandarderror", "rse"], "value"], [["redirectstandardinput", "rsi"], "value"],
  [["redirectstandardoutput", "rso"], "value"], [["windowstyle"], "value"], [["verbose", "vb"], "none"],
  [["debug", "db"], "none"], [["erroraction", "ea"], "value"], [["warningaction", "wa"], "value"],
  [["informationaction", "infa"], "value"], [["progressaction", "proga"], "value"], [["errorvariable", "ev"], "value"],
  [["warningvariable", "wv"], "value"], [["informationvariable", "iv"], "value"], [["outvariable", "ov"], "value"],
  [["outbuffer", "ob"], "value"], [["pipelinevariable", "pv"], "value"],
];

/**
 * `Start-Process [-FilePath] <file> [[-ArgumentList] <string[]>]`: the list is joined with spaces, unquoted,
 * into the program's command line, which the program splits again (real, Windows PowerShell 5.1).
 */
function startProcess(args: Arg[]): Run {
  let file: Arg | undefined;
  let cwd: string | undefined;
  const list: Arg[] = [];
  let inList = false;
  for (let k = 0; k < args.length; k++) {
    const arg = args[k]!;
    const named = /^-([A-Za-z]+)(?::(.*))?$/s.exec(arg.raw);
    if (named && (!arg.quoted || named[2] !== undefined)) {
      const key = named[1]!.toLowerCase();
      const exact = START_PROCESS.filter(([names]) => names.includes(key));
      const matches = exact.length > 0 ? exact : START_PROCESS.filter(([names]) => names[0]!.startsWith(key));
      if (matches.length !== 1 || matches[0]![1] === "stop") return { unknown: true };
      const takes = matches[0]![1];
      inList = takes === "arg";
      if (takes === "none") continue;
      const value: Arg = named[2] !== undefined ? { ...arg, raw: named[2], value: arg.value === undefined ? undefined : named[2] } : args[++k]!;
      if (value === undefined) return {};
      if (takes === "file") file = value;
      else if (takes === "cwd") cwd = value.value;
      else if (takes === "arg") list.push(value);
      continue;
    }
    if (file === undefined && !inList) file = arg;
    else {
      inList = true;
      list.push(arg);
    }
  }
  if (file?.value === undefined || file.raw.startsWith("{")) return file === undefined ? {} : { unknown: true };
  // An element cloudpin can't read stands in as one character until the line is split. The tokenizer keeps
  // `'a','b'` as `a` and `,b`: a word that starts with a comma, or a bare one, is a list.
  const elements = list.map((a) => (a.value === undefined ? "\u0001" : a.quoted && !a.value.startsWith(",") ? a.value : a.value.split(",").join(" ")));
  const words = splitCommandLine(elements.join(" "), false).map((t) => (t.value.includes("\u0001") ? DYNAMIC_WORDS : t.value));
  return { argvs: [[file.value, ...words]], ...(cwd === undefined ? {} : { cwd }) };
}
