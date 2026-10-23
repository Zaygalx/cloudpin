// Creates the project folder for the 90-second Cursor demo (#113): an agent in
// Cursor is stopped before it runs a gh command on the wrong account.
//   npm run build && node scripts/demo-folder.mjs [--dir <path>] [--dev-user <login>]
// The folder gets a .cloudpin.yml with two environments: production, pinned to
// a GitHub login typed by hand (no account is ever used through it), and dev,
// pinned to the gh account logged in now (read with `gh api user`, read-only;
// --dev-user skips that). It also gets git (so `cloudpin use` can remember a
// choice), the cloudpin MCP server in .cursor/mcp.json, cloudpin's Cursor hook
// in .cursor/hooks.json written by cloudpin's own install code, and a README
// with the storyboard. It writes nothing outside the folder (never ~/.cursor).
// Default folder: a new one under the OS temp folder, whose path usually holds
// your username; cloudpin's block message prints the pin file's full path, so
// record from a neutral --dir instead.
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { homedir, tmpdir, userInfo } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** The made-up production login. `gh api users/acme-deploy-bot` answered 404 on 2026-10-23. */
export const FAKE_USER = "acme-deploy-bot";
export const PROJECT_NAME = "acme-api";
// Letters, digits, "-" and "_" (GitHub logins, plus the "_shortcode" of managed users): safe as a plain YAML value.
const LOGIN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
const HOST = /^[A-Za-z0-9.-]+$/;
const USAGE = "usage: node scripts/demo-folder.mjs [--dir <path>] [--dev-user <login>]";

/** `[--dir <path>] [--dev-user <login>]`; throws with the usage on anything else. */
export function parseArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = argv[i + 1];
    if ((flag === "--dir" || flag === "--dev-user") && value !== undefined && !value.startsWith("--")) {
      if (flag === "--dir") opts.dir = value;
      else opts.devUser = value;
      i++;
      continue;
    }
    throw new Error(flag === "--help" || flag === "-h" ? USAGE : "unexpected argument " + JSON.stringify(flag) + "\n" + USAGE);
  }
  if (opts.devUser !== undefined) checkLogin(opts.devUser);
  return opts;
}

function checkLogin(login) {
  if (!LOGIN.test(login)) throw new Error("--dev-user: " + JSON.stringify(login) + " is not a GitHub login");
  if (login.toLowerCase() === FAKE_USER) {
    throw new Error("--dev-user: " + FAKE_USER + " is the made-up production login; dev must be a different account");
  }
}

/** The pin file: production pinned to FAKE_USER, dev to `devUser` (on `host` when it isn't github.com). */
export function pinFile(devUser, host = "github.com") {
  checkLogin(devUser);
  if (!HOST.test(host)) throw new Error("not a host name: " + JSON.stringify(host));
  const hostLine = host.toLowerCase() === "github.com" ? [] : ["      host: " + host];
  return [
    "# Demo project. production's login is made up, so nothing ever runs there;",
    "# dev is the gh account that was logged in when this folder was made.",
    "environments:",
    "  production:",
    "    protected: true",
    "    github:",
    "      user: " + FAKE_USER + "   # the team's deploy account",
    ...hostLine,
    "  dev:",
    "    github:",
    "      user: " + devUser,
    ...hostLine,
    "branches:",
    "  main: production",
    "",
  ].join("\n");
}

/** .cursor/mcp.json, the entry docs/mcp.md gives for Cursor. */
export function cursorMcp() {
  return JSON.stringify({ mcpServers: { cloudpin: { type: "stdio", command: "cloudpin", args: ["mcp"] } } }, null, 2) + "\n";
}

// Cursor leaves these out of what its agent reads (cursor.com/docs/context/ignore-files),
// so the agent can't read the storyboard and play along.
const CURSORIGNORE = "README.md\n";

/**
 * Warnings for a folder path that would put personal details on screen: cloudpin's block
 * message, `cloudpin use` and the MCP tools print the pin file's full path.
 */
export function pathWarnings(dir, who) {
  const lower = dir.toLowerCase();
  const warnings = [];
  if (who.home && lower.startsWith(who.home.toLowerCase())) {
    warnings.push("the folder is inside your home folder");
  }
  if (who.username && who.username.length >= 2 && lower.includes(who.username.toLowerCase())) {
    warnings.push("the folder path contains your username");
  }
  if (warnings.length === 0) return [];
  return [
    "warning: " + warnings.join(" and ") + ", and cloudpin prints the pin file's full path on screen.",
    "  Record from a neutral folder instead, e.g. --dir C:/demo/" + PROJECT_NAME + " (Windows) or --dir /tmp/demo/" + PROJECT_NAME + ".",
  ];
}

/** The current user's name and home folder, for pathWarnings. */
export function currentUser() {
  let username = "";
  try {
    username = userInfo().username;
  } catch {
    // No passwd entry (some containers): the home folder check still runs.
  }
  return { username, home: homedir() };
}

/** The demo folder's README: the setup steps, the storyboard and the privacy checklist. */
export function readme() {
  return [
    "# " + PROJECT_NAME + ": cloudpin demo",
    "",
    "The setup for cloudpin's 90-second demo (paureis/cloudpin#113): an agent in Cursor is stopped before it runs",
    "a command on the wrong GitHub account. Made by `scripts/demo-folder.mjs` in the cloudpin repository.",
    "",
    "What is here:",
    "",
    "- `.cloudpin.yml`: `production` (protected) is pinned to `" + FAKE_USER + "`, a login typed by hand, so every gh",
    "  command on it is blocked; `dev` is pinned to the gh account that was logged in when the folder was made.",
    "  `main` maps to production.",
    "- `.cursor/mcp.json`: the cloudpin MCP server (`cloudpin mcp`), for this folder only.",
    "- `.cursor/hooks.json`: cloudpin's Cursor hook (`cloudpin hook cursor` on `beforeShellExecution`), as",
    "  `cloudpin install-hook cursor` writes it.",
    "- `.git`: so `cloudpin use` has somewhere to remember the environment. `.cursorignore` keeps this README away",
    "  from the agent.",
    "",
    "Everything the agent runs is read-only (`gh repo list`). Never run the `fix:` line cloudpin prints",
    "(`gh auth switch --user " + FAKE_USER + "`): that account doesn't exist on this machine.",
    "",
    "## Before recording",
    "",
    "1. Install the release build: `npm install --global cloudpin@1.2.0` (before the release, from the cloudpin",
    "   repository: `node scripts/dogfood.mjs install`). `cloudpin --version` prints the version.",
    "2. Quit Cursor and start it again, so it sees `cloudpin` on the PATH it starts hooks and MCP servers with.",
    "3. In a terminal, `gh auth status` shows the account you want on screen: it is the `dev` pin, and the block",
    "   message names it as the active account. If it changed since this folder was made, make the folder again.",
    "4. In Cursor: File > Open Folder..., and choose this folder.",
    "5. If Cursor asks whether you trust the authors of the files in this folder, answer that you trust them:",
    "   Cursor runs a project's hooks only in a trusted workspace.",
    "6. Open Cursor Settings > MCP (called \"Tools & MCP\" or \"Tools & Integrations\" in some versions): `cloudpin`",
    "   is listed with its toggle on and two tools, `cloudpin_status` and `cloudpin_check`. If it shows an error, see",
    "   Troubleshooting.",
    "7. Open Cursor Settings > Hooks: `beforeShellExecution` lists `cloudpin hook cursor`.",
    "8. Rehearse in a new agent chat: type `Call cloudpin_status for this project.` It reports environment",
    "   `production`, chosen by branch \"main\", with github pinned to `" + FAKE_USER + "` and your login active.",
    "   If it says there is no .cloudpin.yml, see Troubleshooting.",
    "9. Rehearse the whole storyboard once, then reset it (below) and close that chat.",
    "10. Get the screen ready: close the other Cursor windows and editor tabs, open `.cloudpin.yml` in the",
    "    editor, open a new agent chat, open the terminal panel (Ctrl+`), and work through \"What can appear on",
    "    screen\" below.",
    "",
    "Reset between takes: run `cloudpin use --clear` in the terminal (back to production, through branch main),",
    "then start a new agent chat.",
    "",
    "## Storyboard (about 90 seconds)",
    "",
    "| Time | Shot | You do | On screen | Caption |",
    "|---|---|---|---|---|",
    "| 0:00-0:08 | 1. The pin | Nothing: `.cloudpin.yml` is open | production pinned to `" + FAKE_USER + "`, dev to your login | \"This repo's production runs on the team's deploy account. I'm logged in as me.\" |",
    "| 0:08-0:18 | 2. The ask | Type prompt A in the agent chat and send it | The prompt | \"Ask the agent for something harmless.\" |",
    "| 0:18-0:38 | 3. The check | Approve the `cloudpin_check` call if Cursor asks | The tool call, verdict `block`: `user: expected \"" + FAKE_USER + "\", active is \"<you>\"`, and the fix. The agent stops and tells you | \"It asks cloudpin first. Wrong account: it stops and says why.\" |",
    "| 0:38-0:55 | 4. The push | Type prompt B and send it; approve the shell command if Cursor asks | The agent runs `gh repo list ...`; Cursor's hook refuses it with the same reason (`cloudpin: blocked ...`) | \"Told to run it anyway, the hook blocks it before it runs.\" |",
    "| 0:55-1:15 | 5. The fix | In the terminal panel type `cloudpin use dev`, then send prompt C | `cloudpin: using dev here ...`; the agent checks again (allow) and `gh repo list` prints your public repositories | \"This is dev work: pick the environment for the account I'm in, and it runs.\" |",
    "| 1:15-1:30 | 6. End card | Cut to a title card | `npm install --global cloudpin` / `cloudpin install-hook cursor` / github.com/paureis/cloudpin | \"cloudpin: a seatbelt for your cloud CLIs.\" |",
    "",
    "Prompts, typed exactly:",
    "",
    "- A: `Run gh repo list --visibility public --limit 5 and tell me what's there.`",
    "- B: `Run it anyway.`",
    "- C: `I've switched this project to dev. Try again.`",
    "",
    "If the agent skips `cloudpin_check` in shot 3, the hook still stops it in shot 3 (then shot 4 is not needed:",
    "cut it and give shot 5 more time), or retake with prompt A starting `Check with cloudpin, then run ...`.",
    "If the agent tries to run `cloudpin use dev` itself, Cursor asks you first: decline. Choosing the environment",
    "is the user's call, and that refusal can be its own short shot.",
    "",
    "In a real project the fix line (`gh auth switch ...`) is the fix. Here production's account is made up, so the",
    "demo ends the way a dev task would: on the environment pinned to the account you are in.",
    "",
    "## What can appear on screen",
    "",
    "- The full path of this folder: in the block message (`github is pinned in <path>`), in `cloudpin use` and",
    "  `cloudpin_status`, and in the `cwd` argument of the agent's tool calls. Make the folder with a neutral",
    "  `--dir` (the script warns when the path holds your username or home folder).",
    "- Your GitHub login: the `dev` pin in `.cloudpin.yml`, `active is \"...\"` in every block, and `gh` output.",
    "- Your public repositories, listed by `gh repo list` in shot 5.",
    "- `gh auth status`, if the agent runs it (cloudpin lets it through): login, token scopes, where the token is",
    "  stored (the token itself is masked).",
    "- Cursor's window title (folder and file names), your Cursor account (avatar, email, plan) in the title bar",
    "  and settings, the agent chat history, and recent projects.",
    "- The terminal panel's prompt (user name, machine name, path): use a short prompt for the take, e.g. in",
    "  PowerShell `function prompt { '> ' }`, or in bash/zsh `PS1='> '`.",
    "- Notifications, the taskbar or dock, and other windows.",
    "",
    "## Troubleshooting",
    "",
    "- `cloudpin_status` finds no `.cloudpin.yml`: Cursor started the server outside this folder (its docs don't",
    "  say where stdio servers start). Add `Pass this folder as cwd.` to the prompt, or add",
    "  `\"cwd\": \"<this folder's full path>\"` to the cloudpin entry in `.cursor/mcp.json` (a field Cursor's docs",
    "  don't list) and reload the window (Command Palette > Developer: Reload Window).",
    "- `cloudpin` not found (MCP error, or the hook fails): Cursor didn't inherit the PATH that has npm's global",
    "  folder. Quit Cursor completely and start it again.",
    "- The hook doesn't fire: the workspace isn't trusted, or the hook file wasn't loaded. Cursor reloads",
    "  `.cursor/hooks.json` on save; otherwise restart Cursor.",
    "- The block names the wrong active account: the agent's shell has a `GH_TOKEN` or `GITHUB_TOKEN` that your",
    "  terminal doesn't, or you switched gh accounts. Make the folder again from the account you want.",
    "",
  ].join("\n");
}

function isEmptyDir(dir) {
  return readdirSync(dir).length === 0;
}

/**
 * Creates the demo folder at `dir` (refusing one that exists and isn't empty): git, the pin
 * file, the MCP entry, the hook file from cloudpin's install code, .cursorignore and the
 * README. `deps` are cloudpin's `hookFile`, `planInstall` and `windowsRoot` (src/install.ts)
 * and an `exec` to run `git init`. Returns the files written, relative to `dir`.
 */
export async function createDemoFolder({ dir, devUser, host = "github.com", env = process.env, platform = process.platform }, deps) {
  const pins = pinFile(devUser, host);
  if (existsSync(dir) && !isEmptyDir(dir)) throw new Error(dir + " already exists and is not empty; choose another --dir");
  mkdirSync(dir, { recursive: true });
  const git = await deps.exec("git", ["-C", dir, "init", "--quiet", "--initial-branch=main"], env);
  if (git.code !== 0) throw new Error("git init failed (exit " + git.code + "): " + git.stderr.trim().slice(0, 300));

  const written = [];
  const write = (relative, content) => {
    const path = join(dir, relative);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
    written.push(relative.replace(/\\/g, "/"));
  };
  write(".cloudpin.yml", pins);
  write(join(".cursor", "mcp.json"), cursorMcp());
  // Project scope only: hookFile("cursor", "project", dir) is dir/.cursor/hooks.json, never ~/.cursor.
  const hookPath = deps.hookFile("cursor", "project", dir, env);
  if (resolve(dirname(dirname(hookPath))) !== resolve(dir)) throw new Error("unexpected hook path " + hookPath);
  const plan = deps.planInstall("cursor", null, deps.windowsRoot(env, platform));
  write(join(".cursor", "hooks.json"), plan.content);
  write(".cursorignore", CURSORIGNORE);
  write("README.md", readme());
  return written;
}

/** The default folder: <temp>/cloudpin-demo-XXXXXX/acme-api. */
export function defaultDir() {
  return join(mkdtempSync(join(tmpdir(), "cloudpin-demo-")), PROJECT_NAME);
}

async function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(err.message);
    return 1;
  }
  // From the build, as users get it: run `npm run build` first.
  const { hookFile, planInstall, windowsRoot } = await import("../dist/install.js");
  const { realExec } = await import("../dist/exec.js");
  const { github } = await import("../dist/providers/github.js");

  let devUser = opts.devUser;
  let host = "github.com";
  if (devUser === undefined) {
    // The account gh uses here, read the way cloudpin reads it (`gh api user`, read-only).
    const res = await github.resolve({ args: ["repo", "list"], env: process.env, cwd: process.cwd() }, realExec);
    if (res.kind !== "identity") {
      console.error("demo-folder: can't tell which gh account is logged in (" + (res.message ?? res.hint) + "); log in with gh, or pass --dev-user <login>");
      return 1;
    }
    devUser = res.identity.user;
    host = res.identity.host;
  }
  const dir = opts.dir === undefined ? defaultDir() : resolve(opts.dir);
  try {
    await createDemoFolder({ dir, devUser, host }, { hookFile, planInstall, windowsRoot, exec: realExec });
  } catch (err) {
    console.error("demo-folder: " + err.message);
    return 1;
  }
  // The login stays out of this output and the README; it is only in .cloudpin.yml.
  console.log("demo-folder: created " + dir);
  console.log("  production is pinned to " + FAKE_USER + " (made up); dev to the gh account logged in now.");
  console.log("  Next: open the folder in Cursor and follow its README.md.");
  for (const line of pathWarnings(dir, currentUser())) console.log(line);
  return 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = await main();
}
