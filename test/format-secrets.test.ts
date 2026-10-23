import { describe, expect, it } from "vitest";
import { formatBlock, formatConfirm } from "../src/format.js";

// #123: every message that repeats a command hides a credential flag's value,
// whichever way the value is attached to the flag.

const TOKEN = "tok_fake123";

const block = {
  action: "block" as const,
  provider: "vercel" as const,
  configPath: "/repo/.cloudpin.yml",
  problems: ['team: expected "team_a", active is "team_b"'],
  fix: "vercel switch team_a",
};

const confirm = {
  action: "confirm" as const,
  provider: "vercel" as const,
  configPath: "/repo/.cloudpin.yml",
  environment: { name: "production", protected: true, source: 'branch "main"' },
};

/** Every message that repeats the command, in every mode. */
function messages(argv: string[]): string[] {
  return [
    formatBlock(block, argv, "shell"),
    formatBlock(block, argv, "agent"),
    formatBlock({ ...block, uncertain: true }, argv, "shell"),
    formatConfirm(confirm, argv, "prompt"),
    formatConfirm(confirm, argv, "no-terminal"),
    formatConfirm(confirm, argv, "agent-ask"),
    formatConfirm(confirm, argv, "agent-deny"),
  ];
}

const BINS = ["vercel", "vc", "C:\\x\\vercel.cmd", "/usr/local/bin/VC.EXE"];

const FORMS: [string, string[], string][] = [
  ["-t=VALUE", ["-t=" + TOKEN], "-t=***"],
  ["-tVALUE", ["-t" + TOKEN], "-t***"],
  ["-t VALUE", ["-t", TOKEN], "-t ***"],
  ["--token=VALUE", ["--token=" + TOKEN], "--token=***"],
  ["--token VALUE", ["--token", TOKEN], "--token ***"],
];

describe("a credential flag's value is never repeated", () => {
  for (const bin of BINS) {
    for (const [label, words, masked] of FORMS) {
      it(`${bin} deploy ${label}`, () => {
        const argv = [bin, "deploy", ...words, "--prod"];
        for (const text of messages(argv)) {
          expect(text).not.toContain(TOKEN);
          expect(text).toContain(`${bin} deploy ${masked} --prod`);
        }
      });
    }
  }
});

// Vercel parses flags with arg 5.0.0, which splits a short group (-dt is -d -t)
// and gives the next word to its last letter when that one takes a value.
describe("a credential flag at the end of a short group", () => {
  for (const bin of BINS) {
    it(`${bin} -dt VALUE deploy`, () => {
      for (const text of messages([bin, "-dt", TOKEN, "deploy"])) {
        expect(text).not.toContain(TOKEN);
        expect(text).toContain(`${bin} -dt *** deploy`);
      }
    });
  }
});

describe("other flags stay exactly as typed", () => {
  const asTyped: string[][] = [
    ["vercel", "deploy", "-T=team_a"], // Vercel's team flag, not the token
    ["vc", "deploy", "-Tteam_a"],
    ["vercel", "deploy", "--team=team_a"],
    ["vercel", "deploy", "--team", "team_a"],
    ["kubectl", "exec", "-tdemo", "--", "sh"], // -t is a credential for vercel only
    ["kubectl", "exec", "-t=true", "demo"],
    ["wrangler", "deploy", "-t", "demo"],
    ["vercel", "deploy", "-t"], // nothing to hide
    ["vercel", "-dT", "team_a", "deploy"], // a group ending in the team flag
    ["kubectl", "-it", "demo"], // a group ending in t, on a CLI where -t is no credential
    ["vercel", "--debugt", "demo", "deploy"], // a long flag is not a group
  ];
  for (const argv of asTyped) {
    it(argv.join(" "), () => {
      for (const text of messages(argv)) expect(text).toContain(argv.join(" "));
    });
  }
});
