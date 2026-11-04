/** One call to a guarded CLI, as `findInvocations` (shellwords.ts) finds it in a line. */
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
  /** The call starts with an empty environment (`env -i`, `exec -c`): only `env` reaches the CLI (#162). */
  clearEnv?: boolean;
}
