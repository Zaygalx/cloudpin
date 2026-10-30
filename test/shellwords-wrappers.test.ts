import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { commandName } from "../src/guard.js";
import { type Dialect, findInvocations } from "../src/shellwords.js";
import { DYNAMIC_WORD as DW, DYNAMIC_WORDS as DWS } from "../src/types.js";
import { envFor } from "../src/user-env.js";

// #162: a wrapper with flags that take a value, or a package runner, no longer hides the call. Each
// wrapper reads its flags from a table taken from its docs (src/wrappers.ts); the shapes marked "real"
// were run in Git Bash 5.2 (GNU coreutils 8.32, findutils 4.10) with an argv printer named like the CLI.
const GUARDED = ["az", "aws", "gcloud", "gh", "kubectl", "helm", "vercel", "supabase", "wrangler"];
const BASE = resolve("/work");
const found = (line: string, dialect: Dialect = "bash") => findInvocations(line, GUARDED, BASE, undefined, dialect);
const calls = (line: string, dialect: Dialect = "bash") => found(line, dialect).map((i) => ({ bin: commandName(i.bin), args: i.args }));
const AZ = ["group", "list", "--subscription", "other"];
const az = (args = AZ) => ({ bin: "az", args });
const cantTell = (bin: string) => [{ bin, args: [DWS] }];

describe("Unix wrappers with value flags (#162)", () => {
  it.each([
    // real
    "nice -n 10 az group list --subscription other",
    "nice -n10 az group list --subscription other",
    "nice --adjustment=5 az group list --subscription other",
    "nice --adjustment 5 az group list --subscription other",
    "nice --adj 5 az group list --subscription other",
    "nice -5 az group list --subscription other",
    "nice -10 az group list --subscription other",
    "nice -- az group list --subscription other",
    "env -C . az group list --subscription other",
    "env --chdir=. az group list --subscription other",
    "env -v az group list --subscription other",
    "env -- az group list --subscription other",
    "env --default-signal=PIPE az group list --subscription other",
    "env -S 'az group list --subscription other'",
    "env -S'az group' list --subscription other",
    "timeout --preserve-status 30 az group list --subscription other",
    "timeout -k5 30 az group list --subscription other",
    "timeout -k 5 30 az group list --subscription other",
    "timeout -s KILL 30 az group list --subscription other",
    "timeout --signal=KILL 30 az group list --subscription other",
    "timeout --foreground 30 az group list --subscription other",
    "timeout -v 30 az group list --subscription other",
    "stdbuf -oL az group list --subscription other",
    "stdbuf -o L az group list --subscription other",
    "stdbuf --output=L -e0 az group list --subscription other",
    "(exec -a foo az group list --subscription other)",
    "(exec -cla foo az group list --subscription other)",
    "(exec -- az group list --subscription other)",
    "coproc az group list --subscription other; wait",
    "coproc NAME { az group list --subscription other; }; wait",
    // sudo(8) and sudo's parse_args.c; Sudo for Windows' --inline
    "sudo -g wheel az group list --subscription other",
    "sudo -u root az group list --subscription other",
    "sudo -E -H -- az group list --subscription other",
    "sudo --preserve-env=AWS_PROFILE az group list --subscription other",
    "sudo -nu root az group list --subscription other",
    "sudo --user=root -C 3 az group list --subscription other",
    "sudo --inline az group list --subscription other",
    // bash's time keyword, and GNU time's -f and -o
    "time -p az group list --subscription other",
    "time -f %e -o t.txt az group list --subscription other",
    "nohup az group list --subscription other",
    "command -p az group list --subscription other",
  ])("finds the call in %j", (line) => {
    expect(calls(line)).toEqual([az()]);
  });

  it("checks the call in the folder env -C, sudo -D and pnpm -C run it in", () => {
    expect(found("env -C sub az group list")[0]?.cwd).toBe(resolve("/work/sub"));
    expect(found("sudo -D /srv/app az group list")[0]?.cwd).toBe(resolve("/srv/app"));
    expect(found("cd a && env --chdir=../b az group list")[0]?.cwd).toBe(resolve("/work/b"));
  });

  it("finds no call in command -v and command -V, which only say where a command is", () => {
    expect(calls("command -v az")).toEqual([]);
    expect(calls("command -V gh && gh pr list")).toEqual([{ bin: "gh", args: ["pr", "list"] }]);
  });

  it.each([
    "nice --weird 5 az group list",
    "sudo -Z az group list",
    "env --frob az group list",
    "timeout --zz 5 az group list",
    "stdbuf -z az group list",
    "xargs --frob az group list",
    "sudo $FLAGS az group list",
  ])("can't tell with a wrapper flag it doesn't know, or one only known when it runs: %j", (line) => {
    expect(calls(line)).toEqual(cantTell("az"));
  });

  it("finds nothing behind an unknown wrapper flag when no guarded CLI follows", () => {
    expect(calls("sudo -Z ls -la")).toEqual([]);
  });
});

describe("watch runs its arguments through sh -c (#162)", () => {
  it.each([
    "watch -n 5 'az group list --subscription other'",
    "watch -n5 -d az group list --subscription other",
    "watch --interval=5 'az group list --subscription other | head'",
    "watch -x az group list --subscription other",
    "watch -c -t --differences=permanent az group list --subscription other",
  ])("reads %j", (line) => {
    expect(calls(line)).toEqual([az()]);
  });

  it("reads the string as a line, so each call in it is found", () => {
    expect(calls("watch 'kubectl get pods; az group list --subscription other'")).toEqual([
      { bin: "kubectl", args: ["get", "pods"] },
      az(),
    ]);
  });
});

describe("env -u, env -i and exec -c change the call's environment (#162)", () => {
  const base = { AWS_PROFILE: "pinned", PATH: "/usr/bin", HOME: "/home/u", SYSTEMROOT: "C:\\Windows", CLOUDPIN_ENV: "prod" };
  const one = (line: string) => found(line)[0]!;

  it.each([
    "env -u AWS_PROFILE aws s3 ls",
    "env -uAWS_PROFILE aws s3 ls",
    "env --unset=AWS_PROFILE aws s3 ls",
    "env --uns AWS_PROFILE aws s3 ls",
  ])("removes the variable for the call: %j", (line) => {
    expect(envFor(base, one(line), { agent: true }).AWS_PROFILE).toBeUndefined();
  });

  it("unsets before it sets, as env does (real)", () => {
    expect(envFor(base, one("env -u AWS_PROFILE AWS_PROFILE=other aws s3 ls")).AWS_PROFILE).toBe("other");
  });

  it("only for that call", () => {
    const [first, second] = found("env -u AWS_PROFILE aws s3 ls; aws s3 ls");
    expect(envFor(base, second!).AWS_PROFILE).toBe("pinned");
    expect(envFor(base, first!).AWS_PROFILE).toBeUndefined();
  });

  it.each(["env -i aws s3 ls", "env - aws s3 ls", "env -iu X aws s3 ls", "env --ignore-environment aws s3 ls", "(exec -c aws s3 ls)", "export AWS_PROFILE=other; env -i aws s3 ls"])(
    "starts the call with an empty environment: %j",
    (line) => {
      // PATH stays so cloudpin can find the CLI; Git Bash gives a Windows program SYSTEMROOT back (real);
      // CLOUDPIN_ENV is the user's to set, never the agent's line.
      expect(envFor(base, one(line), { agent: true })).toEqual({ PATH: "/usr/bin", SYSTEMROOT: "C:\\Windows", CLOUDPIN_ENV: "prod" });
    },
  );

  it("keeps what env -i sets after it", () => {
    expect(envFor(base, one("env -i AWS_PROFILE=other aws s3 ls"), { agent: true }).AWS_PROFILE).toBe("other");
  });

  it("can't tell when the name env -u removes is only known when it runs", () => {
    expect(calls('env -u "$V" aws s3 ls')).toEqual(cantTell("aws"));
  });
});

describe("xargs adds words to the call (#162)", () => {
  it.each([
    // real: xargs appends what it reads
    ["echo other | xargs az group list --subscription", ["group", "list", "--subscription", DWS]],
    ["echo --subscription other | xargs az group list", ["group", "list", DWS]],
    ["xargs -n 1 az group delete", ["group", "delete", DWS]],
    ["xargs -0 az x", ["x", DWS]],
    ["xargs -r az x", ["x", DWS]],
    ["xargs -L 1 az x", ["x", DWS]],
    ["xargs -l az x", ["x", DWS]],
    ["xargs -eEND az x", ["x", DWS]],
    ["xargs -d , az x", ["x", DWS]],
    ["xargs -s 100 az x", ["x", DWS]],
    ["xargs -a args.txt az x", ["x", DWS]],
    ["xargs --process-slot-var=S -t -P 4 az x", ["x", DWS]],
    ["xargs sudo az x", ["x", DWS]],
    // real: -I, -i and --replace put one input line where the string is, and add nothing
    ["xargs -I {} az group show -n {}", ["group", "show", "-n", DW]],
    ["xargs -I{} az group list --subscription={}", ["group", "list", `--subscription=${DW}`]],
    ["xargs -i az group show -n {}", ["group", "show", "-n", DW]],
    ["xargs -i@ az group show -n @", ["group", "show", "-n", DW]],
    ["xargs --replace az group show -n {}", ["group", "show", "-n", DW]],
    ["xargs --replace=@ az group show -n @", ["group", "show", "-n", DW]],
    // BSD xargs(1): -J puts the input where the string is
    ["xargs -J % az group show -n % -o json", ["group", "show", "-n", DWS, "-o", "json"]],
  ])("%j", (line, args) => {
    expect(calls(line as string)).toEqual([{ bin: "az", args }]);
  });
});

describe("package runners (#162)", () => {
  it.each([
    ["npx wrangler@latest deploy --env prod", "wrangler", ["deploy", "--env", "prod"]],
    ["npx -y vercel@latest deploy --scope team", "vercel", ["deploy", "--scope", "team"]],
    ["npx --yes vercel deploy", "vercel", ["deploy"]],
    ["npx -p vercel vercel deploy --scope team", "vercel", ["deploy", "--scope", "team"]],
    ["npx --package=vercel@33 vercel deploy", "vercel", ["deploy"]],
    ["npx @cloudflare/wrangler@1 deploy", "wrangler", ["deploy"]],
    ["npx -- vercel deploy", "vercel", ["deploy"]],
    ["npx --registry https://registry.example vercel deploy", "vercel", ["deploy"]],
    ["npx -c 'vercel deploy --scope team'", "vercel", ["deploy", "--scope", "team"]],
    ["npm exec -- vercel@latest deploy", "vercel", ["deploy"]],
    ["npm exec --package=vercel -- vercel deploy", "vercel", ["deploy"]],
    ["npm x vercel deploy", "vercel", ["deploy"]],
    ["pnpm wrangler deploy", "wrangler", ["deploy"]],
    ["pnpm exec wrangler deploy", "wrangler", ["deploy"]],
    ["pnpm --filter web exec wrangler deploy", "wrangler", ["deploy"]],
    ["pnpm exec -c 'wrangler deploy'", "wrangler", ["deploy"]],
    ["pnpm dlx vercel@latest deploy", "vercel", ["deploy"]],
    ["pnpm dlx --package=vercel vercel deploy", "vercel", ["deploy"]],
    ["yarn vercel deploy", "vercel", ["deploy"]],
    ["yarn run vercel deploy", "vercel", ["deploy"]],
    ["yarn exec vercel deploy", "vercel", ["deploy"]],
    ["yarn dlx vercel deploy", "vercel", ["deploy"]],
    ["yarn dlx -p vercel vercel deploy", "vercel", ["deploy"]],
    ["bunx vercel@1 deploy", "vercel", ["deploy"]],
    ["bunx --bun vercel deploy", "vercel", ["deploy"]],
    ["bunx -p vercel vercel deploy", "vercel", ["deploy"]],
    ["bun x vercel deploy", "vercel", ["deploy"]],
  ])("%j runs %s", (line, bin, args) => {
    expect(calls(line as string)).toEqual([{ bin, args }]);
    // In PowerShell, a bare @name is a splat, so a scoped package has to be quoted there.
    if (!(line as string).includes(" @")) expect(calls(line as string, "powershell")).toEqual([{ bin, args }]);
  });

  it("checks the call in the folder pnpm -C runs it in", () => {
    expect(found("pnpm -C apps/web vercel deploy")[0]?.cwd).toBe(resolve("/work/apps/web"));
    expect(found("pnpm --dir=apps/web exec vercel deploy")[0]?.cwd).toBe(resolve("/work/apps/web"));
  });

  it.each(["npm install vercel", "pnpm add wrangler", "yarn add vercel", "npx tsx deploy.ts", "npm run vercel"])("finds no call in %j", (line) => {
    expect(calls(line)).toEqual([]);
  });

  it("can't tell with a runner flag it doesn't know", () => {
    expect(calls("npx --frob x vercel deploy")).toEqual(cantTell("vercel"));
  });
});
