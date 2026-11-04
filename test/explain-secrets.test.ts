import { describe, expect, it } from "vitest";
import type { FoundConfig } from "../src/config.js";
import { explain, formatExplain, type ExplainedCall } from "../src/explain.js";
import type { GuardDeps } from "../src/guard.js";
import { cloudpinTools } from "../src/mcp-tools.js";
import type { ProviderDef, Resolution } from "../src/types.js";
import { fakeDoctorHost } from "./fake-doctor-host.js";

// #134: `cloudpin explain` (text and --json) and the MCP cloudpin_check tool hide
// a credential flag's value as block messages do (#123). Masking is display-only:
// the guard still reads the real words.

const TOKEN = "tok_fake123";
const OTHER = "tok_fake456";

/** Every argv each fake provider's resolve was handed, to prove the guard saw the real token. */
const seen: string[][] = [];

// The account follows the token: TOKEN is the pinned team, OTHER another one.
function fake(name: "vercel" | "kubernetes", bins: string[]): ProviderDef {
  return {
    name,
    bins,
    isExempt: () => false,
    resolve: async (ctx): Promise<Resolution> => {
      seen.push([...ctx.args]);
      const words = ctx.args.join(" ");
      const team = words.includes(TOKEN) ? "team_acme" : words.includes(OTHER) ? "team_other" : "team_none";
      return { kind: "identity", identity: { team }, source: "the token" };
    },
    compare: (pin: Record<string, string>, id) => (pin.team === id.team ? [] : [`team: pinned "${pin.team}", the command would use "${id.team}"`]),
    switchHint: (pin: Record<string, string>) => `switch to ${pin.team}`,
    statusCommand: `${bins[0]} whoami`,
    cacheInputs: () => ({ env: [], files: [], dirs: [] }),
  } as ProviderDef;
}

const config = {
  path: "/repo/.cloudpin.yml",
  pins: { vercel: { team: "team_acme" }, kubernetes: { team: "team_acme" } },
} as unknown as FoundConfig;

const deps: GuardDeps = {
  providers: [fake("vercel", ["vercel", "vc"]), fake("kubernetes", ["kubectl", "helm"])],
  exec: async () => ({ code: 1, stdout: "", stderr: "", notFound: true }),
  findConfig: () => config,
};

const CWD = "/repo/app";
const ENV = { HOME: "/home/me" } as NodeJS.ProcessEnv;
const mcp = cloudpinTools(deps, { cwd: CWD, env: ENV, read: () => null, isDir: () => true, doctor: fakeDoctorHost }).find((t) => t.name === "cloudpin_check")!;

/** What each output path shows for one command, given as argv words and as a shell line. */
async function outputs(argv: string[]) {
  const line = argv.join(" ");
  const fromArgv = await explain(argv, { mode: "shell", cwd: CWD, env: ENV }, deps);
  const fromLine = await explain(line, { mode: "shell", cwd: CWD, env: ENV }, deps);
  const agent = (await mcp.call({ command: line })) as { mode: string; calls: ExplainedCall[] };
  return {
    text: [formatExplain(fromArgv, ENV).join("\n"), formatExplain(fromLine, ENV).join("\n")],
    // What `cloudpin explain --json` prints (src/cli.ts, explainCommand).
    json: [JSON.stringify({ mode: "shell", calls: fromArgv }, null, 2), JSON.stringify({ mode: "shell", calls: fromLine }, null, 2)],
    jsonArgv: [fromArgv[0]!.argv, fromLine[0]!.argv],
    mcp: JSON.stringify(agent),
    mcpArgv: agent.calls[0]!.argv,
    verdicts: [fromArgv[0]!.verdict, fromLine[0]!.verdict, agent.calls[0]!.verdict],
  };
}

// [command words before the credential, credential words, the same words masked, words after]
const CASES: [string, string[], string[], string[], string[]][] = [
  ["vercel --token=VALUE", ["vercel", "deploy"], ["--token=@"], ["--token=***"], ["--prod"]],
  ["vercel --token VALUE", ["vercel", "deploy"], ["--token", "@"], ["--token", "***"], ["--prod"]],
  ["vc -t VALUE", ["vc", "deploy"], ["-t", "@"], ["-t", "***"], ["--prod"]],
  ["vercel -t=VALUE", ["vercel", "deploy"], ["-t=@"], ["-t=***"], ["--prod"]],
  ["vercel -tVALUE", ["vercel", "deploy"], ["-t@"], ["-t***"], ["--prod"]],
  ["vercel -dt VALUE", ["vercel"], ["-dt", "@"], ["-dt", "***"], ["deploy"]],
  ["kubectl --token=VALUE", ["kubectl", "get", "pods"], ["--token=@"], ["--token=***"], ["-A"]],
  ["kubectl --token VALUE", ["kubectl", "get", "pods"], ["--token", "@"], ["--token", "***"], ["-A"]],
  ["kubectl --password VALUE", ["kubectl", "get", "pods"], ["--password", "@"], ["--password", "***"], ["-A"]],
  ["kubectl --password=VALUE", ["kubectl", "get", "pods"], ["--password=@"], ["--password=***"], ["-A"]],
  ["helm --kube-token VALUE", ["helm", "list"], ["--kube-token", "@"], ["--kube-token", "***"], ["-a"]],
  ["helm --kube-token=VALUE", ["helm", "list"], ["--kube-token=@"], ["--kube-token=***"], ["-a"]],
];

const fill = (words: string[], token: string) => words.map((w) => w.replace("@", token));

describe("explain hides a credential flag's value in every output", () => {
  for (const [label, before, secret, masked, after] of CASES) {
    for (const [token, verdict] of [[TOKEN, "allow"], [OTHER, "block"]] as const) {
      const argv = [...before, ...fill(secret, token), ...after];
      const shown = [...before, ...masked, ...after];

      it(`${label} (${verdict}): text`, async () => {
        for (const text of (await outputs(argv)).text) {
          expect(text).not.toContain(token);
          expect(text.split("\n")[0]).toBe(shown.join(" "));
        }
      });

      it(`${label} (${verdict}): --json`, async () => {
        const out = await outputs(argv);
        for (const json of out.json) expect(json).not.toContain(token);
        // Masked in place: same length, same positions, so readers of argv[i] don't shift.
        for (const words of out.jsonArgv) expect(words).toEqual(shown);
      });

      it(`${label} (${verdict}): MCP cloudpin_check`, async () => {
        const out = await outputs(argv);
        expect(out.mcp).not.toContain(token);
        expect(out.mcpArgv).toEqual(shown);
      });

      it(`${label} (${verdict}): the guard still decides on the real token`, async () => {
        seen.length = 0;
        const out = await outputs(argv);
        expect(out.verdicts).toEqual([verdict, verdict, verdict]);
        expect(seen.length).toBe(3);
        for (const args of seen) expect(args).toEqual(argv.slice(1));
      });
    }
  }
});

describe("explain shows other words exactly as typed", () => {
  const asTyped: string[][] = [
    ["vercel", "deploy", "-T=team_a"], // Vercel's team flag, not the token
    ["vc", "deploy", "-Tteam_a", "--prod"],
    ["vercel", "-dT", "team_a", "deploy"], // a group ending in the team flag
    ["vercel", "deploy", "--scope", "team_a"],
    ["kubectl", "exec", "-tdemo", "--", "sh"], // -t is a credential for vercel only
    ["kubectl", "get", "pods", "--token-file", "/run/token"], // a file path, not a credential
    ["helm", "list", "--kube-context", "prod"],
  ];
  for (const argv of asTyped) {
    it(argv.join(" "), async () => {
      const out = await outputs(argv);
      for (const text of out.text) expect(text.split("\n")[0]).toBe(argv.join(" "));
      for (const words of out.jsonArgv) expect(words).toEqual(argv);
      expect(out.mcpArgv).toEqual(argv);
    });
  }
});
