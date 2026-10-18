import { writeFileSync } from "node:fs";
import { type CheckReport, checkExitCode, formatCheckText, parseCheckArgs, runCheck } from "./check.js";
import type { GuardDeps, Trace } from "./guard.js";
import { type Candidate, planProvider, type Step } from "./switch-plan.js";

/*
 * `cloudpin switch` (#14; docs/superpowers/specs/2026-10-18-switch-design.md):
 * plan, confirm once, run each command without a shell, re-check. It never logs
 * in or out, never reads or writes a credential and never prints a token.
 */

/** Where switch talks: stdout for the plan and results, a question for the user. */
export interface SwitchIO {
  /** Whether a person can answer. */
  isTTY: boolean;
  ask(question: string): Promise<string>;
  out(line: string): void;
  err(line: string): void;
}

export interface SwitchOptions {
  yes: boolean;
  json: boolean;
  only?: string[];
}

/** One plan line in `--json`. */
export interface PlanJson {
  provider: string;
  status: Step["status"];
  commands?: string[][];
  candidates?: string[];
  reason?: string;
}

/** One command switch ran; its output is never captured (CLIs may echo account details). */
export interface RanJson {
  provider: string;
  command: string[];
  code: number;
}

export interface SwitchJson {
  result: CheckReport["result"];
  path: string | null;
  environment: CheckReport["environment"];
  error?: string;
  plan: PlanJson[];
  ran: RanJson[];
  /** The `cloudpin check --json` report after the switches, or null when nothing ran. */
  after: CheckReport | null;
}

const USAGE = "usage: cloudpin switch [--yes] [--json] [--only <clouds>]";

/** `switch`'s flags: `--yes`, and `check`'s `--json` and `--only`. */
export function parseSwitchArgs(args: string[]): SwitchOptions | { help: true } | { error: string } {
  if (args.includes("--help") || args.includes("-h")) return { help: true };
  const rest = args.filter((a) => a !== "--yes");
  const parsed = parseCheckArgs(rest);
  if ("error" in parsed) return parsed;
  return { yes: rest.length !== args.length, json: parsed.json, ...(parsed.only ? { only: parsed.only } : {}) };
}

export const switchUsage = USAGE;

/** A command as the user would type it; arguments with spaces or quotes are quoted. */
const shown = (argv: string[]): string => argv.map((a) => (/[\s"']/.test(a) ? JSON.stringify(a) : a)).join(" ");

/** The commands and AWS_PROFILE a step will apply, once any choice is made. */
interface Action {
  step: Step;
  commands: string[][];
  awsProfile?: string;
}

const actionCount = (actions: Action[]): number =>
  actions.reduce((n, a) => n + a.commands.length + (a.awsProfile !== undefined ? 1 : 0), 0);

function reasonOf(step: Step): string | undefined {
  const parts: string[] = [];
  if (step.awsProfile !== undefined) parts.push(`set AWS_PROFILE=${step.awsProfile} in this shell, through the cloudpin shell function`);
  if (step.status === "choose") parts.push("several targets match; pick one by running cloudpin switch in a terminal");
  parts.push(...step.notes);
  if (step.manual.length > 0) {
    const manual = step.manual.join("; ");
    parts.push(step.status === "run" || step.status === "choose" ? `then, by hand: ${manual}` : manual);
  }
  return parts.length > 0 ? parts.join("; ") : undefined;
}

function planJson(step: Step): PlanJson {
  const reason = reasonOf(step);
  const candidates = step.candidates?.map((c) => c.name) ?? step.listed;
  return {
    provider: step.provider,
    status: step.status,
    ...(step.commands.length > 0 ? { commands: step.commands } : {}),
    ...(candidates ? { candidates } : {}),
    ...(reason !== undefined && step.status !== "ok" ? { reason } : {}),
  };
}

function formatPlan(report: CheckReport, steps: Step[], willChoose: boolean): string[] {
  const lines = [`cloudpin: switching to the accounts pinned in ${report.path}`];
  if (report.environment) {
    const { name, source } = report.environment;
    lines.push(`  environment: ${name}${report.environment.protected ? " (protected)" : ""}, chosen by ${source}`);
  }
  for (const step of steps) {
    const p = step.provider;
    switch (step.status) {
      case "ok":
        lines.push(`  ok ${p}: already on the pinned account`);
        continue;
      case "not-installed":
        lines.push(`  -  ${p}: ${step.manual[0] ?? "not installed"}, nothing to switch`);
        continue;
      case "run":
        lines.push(`  -> ${p}`);
        for (const command of step.commands) lines.push(`     run: ${shown(command)}`);
        if (step.awsProfile !== undefined) lines.push(`     set: AWS_PROFILE=${step.awsProfile} in this shell (through the cloudpin shell function)`);
        break;
      case "choose":
        lines.push(`  ?  ${p}: several match; ${willChoose ? "pick one below" : "skipped (run cloudpin switch in a terminal to pick one)"}`);
        step.candidates!.forEach((c, i) => lines.push(`     ${i + 1}) ${c.name}${describe(c)}`));
        break;
      case "manual":
        lines.push(`  !  ${p}: cloudpin won't switch this one; by hand:`);
        break;
    }
    for (const note of step.notes) lines.push(`     note: ${note}`);
    for (const manual of step.manual) lines.push(step.status === "manual" ? `     - ${manual}` : `     by hand: ${manual}`);
  }
  return lines;
}

function describe(c: Candidate): string {
  const parts = c.commands.map(shown);
  if (c.awsProfile !== undefined) parts.push(`AWS_PROFILE=${c.awsProfile}`);
  return parts.length > 0 ? `: ${parts.join(", then ")}` : "";
}

/**
 * Runs `cloudpin switch` and returns its exit code: 0 only when every pinned,
 * installed provider matches afterwards (or nothing is pinned, as with check).
 * `deps.exec` runs the planners' read-only listings and the switch commands;
 * production passes realExec, which never uses a shell. `env` is the command's
 * environment; `CLOUDPIN_ENV_FILE` in it lets the cloudpin shell function apply
 * AWS_PROFILE afterwards.
 */
export async function runSwitch(cwd: string, env: NodeJS.ProcessEnv, deps: GuardDeps, opts: SwitchOptions, io: SwitchIO): Promise<number> {
  const only = opts.only ? { only: opts.only } : {};
  const traces = new Map<string, Trace>();
  const report = await runCheck(cwd, env, deps, { ...only, traces });
  const emit = (plan: PlanJson[], ran: RanJson[], after: CheckReport | null) => {
    const json: SwitchJson = {
      result: (after ?? report).result,
      path: report.path,
      environment: report.environment,
      ...(report.error !== undefined ? { error: report.error } : {}),
      plan,
      ran,
      after,
    };
    io.out(JSON.stringify(json, null, 2));
  };

  if (report.error !== undefined || report.path === null) {
    if (opts.json) emit([], [], null);
    else if (report.error !== undefined) io.err(`cloudpin switch: ${report.error}`);
    else io.out("cloudpin: no .cloudpin.yml found here or in any parent folder; nothing is pinned, so there is nothing to switch.");
    return checkExitCode(report);
  }

  const envFile = env.CLOUDPIN_ENV_FILE || undefined;
  const steps: Step[] = [];
  for (const entry of report.providers) {
    const provider = deps.providers.find((p) => p.name === entry.provider)!;
    const trace = traces.get(entry.provider);
    steps.push(
      await planProvider({
        provider,
        pin: trace?.pin ?? {},
        entry,
        ...(trace?.resolution ? { resolution: trace.resolution } : {}),
        env,
        cwd,
        // The raw exec: the identity cache must never hold these listings.
        exec: deps.exec,
        ...(deps.onPath ? { onPath: (bin: string) => deps.onPath!(bin, env) } : {}),
        envFile: envFile !== undefined,
      }),
    );
  }

  const canChoose = io.isTTY && !opts.yes && !opts.json;
  if (opts.json && !opts.yes) {
    emit(steps.map(planJson), [], null);
    return checkExitCode(report);
  }
  if (!opts.json) for (const line of formatPlan(report, steps, canChoose)) io.out(line);

  const actions: Action[] = steps
    .filter((s) => s.status === "run")
    .map((step) => ({ step, commands: step.commands, ...(step.awsProfile !== undefined ? { awsProfile: step.awsProfile } : {}) }));
  const choosing = steps.filter((s) => s.status === "choose");

  if (!opts.json && !opts.yes) {
    if (!io.isTTY) {
      if (actions.length > 0 || choosing.length > 0) {
        io.out("cloudpin: not a terminal, so nothing was run; re-run with --yes to run the commands above.");
      }
      return checkExitCode(report);
    }
    for (const step of choosing) {
      const n = step.candidates!.length;
      const answer = (await io.ask(`Which one for ${step.provider}? [1-${n}, Enter to skip] `)).trim();
      const pick = /^\d+$/.test(answer) ? Number(answer) : 0;
      const candidate = pick >= 1 && pick <= n ? step.candidates![pick - 1]! : undefined;
      if (candidate) {
        actions.push({ step, commands: candidate.commands, ...(candidate.awsProfile !== undefined ? { awsProfile: candidate.awsProfile } : {}) });
      } else {
        io.out(`cloudpin: skipped ${step.provider}.`);
      }
    }
  }

  const count = actionCount(actions);
  if (count === 0) {
    if (!opts.json) {
      io.out(steps.every((s) => s.status === "ok" || s.status === "not-installed")
        ? "cloudpin: nothing to switch."
        : "cloudpin: nothing cloudpin can run; the lines above say what to do by hand.");
      return checkExitCode(report);
    }
    emit(steps.map(planJson), [], report);
    return checkExitCode(report);
  }

  if (!opts.yes) {
    const answer = await io.ask(`Run ${count === 1 ? "this command" : `these ${count} commands`}? [y/N] `);
    if (!/^y(es)?$/i.test(answer.trim())) {
      io.out("cloudpin: nothing run.");
      return checkExitCode(report);
    }
  }

  // Order follows the plan, so a choice made later still runs in provider order.
  actions.sort((a, b) => steps.indexOf(a.step) - steps.indexOf(b.step));
  const ran: RanJson[] = [];
  let after = env;
  const say = (line: string) => {
    if (!opts.json) io.out(line);
  };
  say("cloudpin: switching");
  for (const action of actions) {
    let failed = false;
    for (const command of action.commands) {
      if (failed && action.step.chained) {
        say(`  skipped: ${shown(command)} (the command before it failed)`);
        continue;
      }
      say(`  $ ${shown(command)}`);
      const res = await deps.exec(command[0]!, command.slice(1), env);
      ran.push({ provider: action.step.provider, command, code: res.code });
      if (res.code === 0) {
        say("    ok");
      } else {
        failed = true;
        const first = res.stderr.split(/\r?\n/).map((l) => l.trim()).find(Boolean)?.slice(0, 200);
        say(`    failed (exit ${res.code})${first ? `: ${first}` : ""}`);
      }
    }
    if (action.awsProfile !== undefined && envFile !== undefined) {
      try {
        writeFileSync(envFile, `AWS_PROFILE=${action.awsProfile}\n`);
        say(`  AWS_PROFILE=${action.awsProfile}: set in this shell when cloudpin returns`);
        after = { ...after, AWS_PROFILE: action.awsProfile };
        delete after.AWS_DEFAULT_PROFILE;
      } catch {
        say(`  AWS_PROFILE: could not write CLOUDPIN_ENV_FILE; set it yourself: export AWS_PROFILE=${action.awsProfile}`);
      }
    }
  }

  // The CLI passes deps without the identity cache, as for check, so this asks each CLI afresh.
  const recheck = await runCheck(cwd, after, deps, only);
  if (opts.json) {
    emit(steps.map(planJson), ran, recheck);
  } else {
    io.out("cloudpin: after switching");
    const lines = formatCheckText(recheck);
    for (const line of recheck.error !== undefined ? lines : lines.slice(1)) io.out(line);
  }
  return checkExitCode(recheck);
}
