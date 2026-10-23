import type { Verdict } from "./guard.js";

type Block = Extract<Verdict, { action: "block" }>;

// Flags whose value is a credential (vercel --token/-t, kubectl --token/--password,
// helm --kube-token); their values are never repeated in a message.
const SECRET_FLAGS = ["--token", "--password", "--kube-token"];
const SECRET_SHORT: Record<string, string[]> = { vercel: ["-t"], vc: ["-t"] };

function displayCommand(argv: string[]): string {
  const bin = argv[0]?.replace(/\\/g, "/").split("/").pop()?.toLowerCase().replace(/\.(exe|cmd|bat|ps1)$/, "") ?? "";
  const short = SECRET_SHORT[bin] ?? [];
  const secret = [...SECRET_FLAGS, ...short];
  // Vercel's parser (arg 5.0.0) splits a short group such as -dt into -d -t and
  // gives the next word to its last letter (github.com/vercel/arg, index.js).
  const endsGroup = (w: string) =>
    /^-[^-=][^=]+$/.test(w) && short.some((f) => w.endsWith(f.slice(1)));
  const shown = argv.map((a, i) => {
    if (i > 0 && (secret.includes(argv[i - 1]!) || endsGroup(argv[i - 1]!))) return "***";
    const inline = SECRET_FLAGS.find((f) => a.startsWith(`${f}=`));
    if (inline) return `${inline}=***`;
    // A short flag can carry its value joined: -t=VALUE or -tVALUE (#123).
    const joined = i > 0 ? short.find((f) => a.startsWith(f) && a.length > f.length) : undefined;
    if (joined) return a[joined.length] === "=" ? `${joined}=***` : `${joined}***`;
    return a;
  });
  return shown.map((a) => (/[\s"]/.test(a) ? JSON.stringify(a) : a)).join(" ");
}

/** The message shown when a command is blocked, for a human or an agent. */
export function formatBlock(verdict: Block, argv: string[], mode: "shell" | "agent"): string {
  const command = displayCommand(argv);
  const lines = verdict.uncertain
    ? [
        `cloudpin: stopped \`${command}\` because it could not tell which ${verdict.provider ?? "cloud"} account it would use`,
      ]
    : [`cloudpin: blocked \`${command}\``];
  if (verdict.provider && verdict.configPath) {
    lines.push(`  ${verdict.provider} is pinned in ${verdict.configPath}`);
  }
  if (verdict.environment) {
    const { name, source } = verdict.environment;
    lines.push(`  environment: ${name}${verdict.environment.protected ? " (protected)" : ""}, chosen by ${source}`);
  }
  for (const problem of verdict.problems) {
    lines.push(verdict.uncertain ? `  - reason: ${problem}` : `  - ${problem}`);
  }
  if (verdict.uncertain) {
    lines.push("  This is a safety stop: cloudpin blocks whenever it cannot confirm the account.");
    if (verdict.fix) lines.push(`  to see what is wrong: ${verdict.fix}`);
  } else if (verdict.fix) {
    lines.push(`  fix: ${verdict.fix}`);
  }
  lines.push(
    mode === "agent"
      ? "  Do not work around this; ask the user to switch accounts or confirm."
      : `  (to run it anyway, once: CLOUDPIN_SKIP=1 ${command})`,
  );
  return lines.join("\n");
}

type Confirm = Extract<Verdict, { action: "confirm" }>;

/**
 * The confirmation for a protected environment: a terminal prompt, the stop
 * message when no terminal can answer, the question an agent shows the user,
 * or the refusal for an agent whose hook cannot ask.
 */
export function formatConfirm(
  verdict: Confirm,
  argv: string[],
  mode: "prompt" | "no-terminal" | "agent-ask" | "agent-deny",
): string {
  const command = displayCommand(argv);
  const { name, source } = verdict.environment;
  switch (mode) {
    case "prompt":
      return `cloudpin: \`${command}\` will run on ${name.toUpperCase()}, a protected environment (chosen by ${source}).\nContinue? [y/N] `;
    case "no-terminal":
      return [
        `cloudpin: stopped \`${command}\`: ${name} is a protected environment and there is no terminal to confirm`,
        `  the ${verdict.provider} account matches ${verdict.configPath} (environment chosen by ${source})`,
        `  to run it: CLOUDPIN_CONFIRM=${name} ${command}`,
      ].join("\n");
    case "agent-ask":
      return (
        `cloudpin: \`${command}\` would run on the protected environment "${name}" (chosen by ${source}). ` +
        `The ${verdict.provider} account matches the pin, but this command may change something, so it needs your OK.`
      );
    case "agent-deny":
      return [
        `cloudpin: stopped \`${command}\`: it would run on the protected environment "${name}" (chosen by ${source}) and may change something.`,
        "  This agent's hook cannot ask the user to confirm, so cloudpin blocks it.",
        "  Do not work around this; ask the user to run it themselves.",
      ].join("\n");
  }
}
