# Guard a Claude Agent SDK app

An agent you build with Anthropic's Claude Agent SDK (`claude-agent-sdk` for Python, `@anthropic-ai/claude-agent-sdk`
for TypeScript) runs Claude Code underneath, with the same `PreToolUse` hooks. So cloudpin can stop its cloud CLI
commands on the wrong account, the way it does in Claude Code. Install cloudpin first (`npm install --global cloudpin`)
and pin the project the agent works in (`cloudpin init`).

<!-- Tested 2026-10-23 on Windows 11 in real SDK sessions (model haiku, read-only `gh repo view`, a made-up GitHub pin
     for the block and the active login for the pass): claude-agent-sdk 0.2.174 on Python 3.13 and
     @anthropic-ai/claude-agent-sdk 0.3.310 on Node 22.17, both bundling Claude Code 2.1.310. The API is from each
     package's own types (claude_agent_sdk/types.py, sdk.d.ts). -->

## When you need nothing

An SDK app loads the same settings files as Claude Code unless you tell it not to: with `setting_sources`
(`settingSources` in TypeScript) left unset, it reads the user, project and local settings. So the hook that
`cloudpin install-hook claude` writes to the project's `.claude/settings.json` already guards the agent:

```sh
cd the-project-your-agent-works-in
cloudpin install-hook claude
```

"The project" is the agent's `cwd` option, and that folder's `.cloudpin.yml` decides the pin, not your app's own folder.
In a test session with only the project's settings loaded (`setting_sources=["project"]`), the agent tried
`gh repo view` against a wrong pin, and the tool result it got back was cloudpin's reason:

```text
PreToolUse:Bash hook error: cloudpin: blocked `gh repo view cli/cli --json name`
  github is pinned in ...\.cloudpin.yml
  - user: expected "acme-deploy-bot", active is "<you>"
  fix: gh auth switch --user acme-deploy-bot
  Do not work around this; ask the user to switch accounts or confirm.
```

A hook installed with `--user` loads with the `"user"` source in the same way. If your app passes `setting_sources=[]`,
or a list without the source that holds the hook, no settings hook runs, and you need the callback below.

## When your app loads no settings: a callback

An SDK hook callback gets the same JSON that `cloudpin hook claude` reads on stdin. So the callback pipes that JSON to
cloudpin and returns cloudpin's answer: a deny with the reason, or nothing, which becomes `{}`. It never returns
`"allow"`, so the SDK's own permission rules still decide everything cloudpin doesn't object to.

The callback has to fail closed itself. With Claude Code 2.1.310, a callback that raised an exception let the command
run (the timeout case is under Timeouts). So in the snippets below, every way the check can fail becomes a deny:
cloudpin not found, a non-zero exit, output that isn't a JSON object, no answer in time, and any other error, caught
around the whole callback.

### Python

Tested with `claude-agent-sdk` 0.2.174. It uses `anyio`, which the SDK already depends on.

```python
import json, os, sys

import anyio
from claude_agent_sdk import ClaudeAgentOptions, HookMatcher
from claude_agent_sdk.types import HookContext, HookInput, HookJSONOutput

# On Windows, cmd.exe starts npm's cloudpin.cmd; NoDefaultCurrentDirectoryInExePath (set below)
# keeps it, and the shim's own `node` lookup, out of the current folder.
if sys.platform == "win32":
    CLOUDPIN = [os.path.join(os.environ["SystemRoot"], "System32", "cmd.exe"), "/d", "/s", "/c", "cloudpin hook claude"]
else:
    CLOUDPIN = ["cloudpin", "hook", "claude"]

def deny(reason: str) -> HookJSONOutput:
    return {"hookSpecificOutput": {"hookEventName": "PreToolUse", "permissionDecision": "deny",
                                   "permissionDecisionReason": f"{reason}, so the command is blocked."}}

async def cloudpin_check(input_data: HookInput, tool_use_id: str | None, context: HookContext) -> HookJSONOutput:
    try:  # every failure must deny: a callback that raises lets the command run
        with anyio.fail_after(55):  # cloudpin answers within 45 s; the SDK's hook timeout is 60 s
            done = await anyio.run_process(CLOUDPIN, input=json.dumps(input_data).encode(), check=False,
                                           env={**os.environ, "NoDefaultCurrentDirectoryInExePath": "1"})
        if done.returncode != 0:
            return deny(f"cloudpin could not check the command (exit {done.returncode})")
        out = done.stdout.decode().strip()
        answer = json.loads(out) if out else {}  # {}: no objection, the agent's own permissions decide
        return answer if isinstance(answer, dict) else deny("cloudpin's answer was not a JSON object")
    except json.JSONDecodeError:
        return deny("cloudpin's answer was not JSON")
    except Exception as err:  # not found, too slow, output that isn't UTF-8, ...
        return deny(f"cloudpin could not check the command ({type(err).__name__})")

options = ClaudeAgentOptions(
    setting_sources=[],  # no settings files load, so no settings hook either: this callback is the guard
    hooks={"PreToolUse": [HookMatcher(matcher="Bash|PowerShell", hooks=[cloudpin_check], timeout=60)]},
)
```

Add your own options (`cwd`, `allowed_tools`, ...) and pass `options` to `query()` or `ClaudeSDKClient`.

### TypeScript

Tested with `@anthropic-ai/claude-agent-sdk` 0.3.310 on Node 22.

```ts
import { execFile } from "node:child_process";
import { join } from "node:path";
import type { HookCallback, HookJSONOutput, Options } from "@anthropic-ai/claude-agent-sdk";

// Node won't start npm's cloudpin.cmd without a shell, so on Windows cmd.exe starts it;
// NoDefaultCurrentDirectoryInExePath (set below) keeps it, and the shim's `node`, out of the current folder.
const [file, args] = process.platform === "win32"
  ? [join(process.env.SystemRoot ?? "C:\\Windows", "System32", "cmd.exe"), ["/d", "/s", "/c", "cloudpin hook claude"]]
  : ["cloudpin", ["hook", "claude"]];

const deny = (reason: string): HookJSONOutput => ({
  hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny",
    permissionDecisionReason: `${reason}, so the command is blocked.` },
});

export const cloudpinCheck: HookCallback = (input, _toolUseID, { signal }) =>
  new Promise((resolve) => {
    try { // every failure must deny: a callback that throws or rejects lets the command run
      const stdin = JSON.stringify(input);
      const env = { ...process.env, NoDefaultCurrentDirectoryInExePath: "1" };
      const child = execFile(file, args, { env, signal, timeout: 55_000 }, (err, stdout) => {
        if (err) {
          const why = typeof err.code === "number" ? `exit ${err.code}` : (err.code ?? err.signal ?? err.name);
          return resolve(deny(`cloudpin could not check the command (${why})`));
        }
        try {
          const answer = stdout.trim() ? JSON.parse(stdout) : {}; // {}: no objection, the agent's permissions decide
          const isObject = answer && typeof answer === "object" && !Array.isArray(answer);
          resolve(isObject ? answer : deny("cloudpin's answer was not a JSON object"));
        } catch { resolve(deny("cloudpin's answer was not JSON")); }
      });
      child.stdin?.on("error", () => {}); // a cloudpin that failed to start is reported by the callback above
      child.stdin?.end(stdin);
    } catch (err) { resolve(deny(`cloudpin could not check the command (${(err as Error)?.name ?? "error"})`)); }
  });

export const options: Options = {
  settingSources: [], // no settings files load, so no settings hook either: this callback is the guard
  hooks: { PreToolUse: [{ matcher: "Bash|PowerShell", hooks: [cloudpinCheck], timeout: 60 }] },
};
```

Spread `options` into the options you pass to `query()`.

### What the tests showed

In real sessions with `setting_sources=[]`, each callback denied `gh repo view` against a made-up GitHub pin, with
cloudpin's reason in the tool result, and let it run (`{"name":"cli"}`) with the active login pinned. Called directly,
outside a session, each one denied when cloudpin wasn't on PATH, exited 3 with no output, printed text that wasn't
JSON or JSON that wasn't an object, or didn't answer before its deadline. The Python one also denied output that
wasn't valid UTF-8; the TypeScript one also denied when the SDK aborted the call, and when the call threw before
cloudpin started (an input `JSON.stringify` can't serialize).

## Windows

The snippets start cloudpin through `cmd.exe` with a fixed command line, `cloudpin hook claude`, and the
`NoDefaultCurrentDirectoryInExePath` variable set. That is the same command `cloudpin install-hook` writes for Codex
and Copilot CLI on Windows. Here is why:

- npm installs `cloudpin` as a `.cmd` shim. Node refuses to start a `.cmd` file without a shell. Python starts one
  without `shell=True`, but only by handing it to `cmd.exe` behind your back.
- Looking cloudpin up yourself is no safer. Python's `shutil.which("cloudpin")` returned `.\cloudpin.CMD` from the
  current folder when one was there, and npm's shim runs `node` by name, which `cmd.exe` also looks for in the current
  folder first. A `cloudpin.cmd` or `node.cmd` an agent writes into your app's folder would run in place of the real one
  (the same problem as
  [GHSA-3cf7-5v5w-q5vr](https://github.com/paureis/cloudpin/security/advisories/GHSA-3cf7-5v5w-q5vr)). The variable
  makes `cmd.exe` skip the current folder. In a test, a planted `cloudpin.cmd` in the app's folder answered "no
  objection" when the variable was left out, and the snippets blocked the command instead.
- Nothing from the agent reaches `cmd.exe`'s parser: the command line is fixed, and the hook JSON goes in on stdin.
- A `.` or other relative entry in PATH brings the current folder back. `cloudpin doctor` warns about one.

The matcher is `Bash|PowerShell` because Claude Code on Windows can run commands through either tool.

## Timeouts

cloudpin gives itself 45 seconds (`src/hooks/agents.ts`), then answers with a deny. The snippets wait 55 seconds,
below the 60 seconds the SDK gives a matcher by default (`timeout` on the matcher, in seconds). With Claude Code
2.1.310, a callback that overran its matcher's timeout didn't run the command ("The tool call was not executed"), but
the agent saw only a timeout and no reason. Keep the callback's own deadline below the matcher's, so a slow check still
ends with cloudpin's explanation or the callback's own deny.

## Protected environments

On a protected environment, and for `cloudpin use`, cloudpin answers `"ask"` instead of deny. The SDK sends an ask to
your `can_use_tool` (`canUseTool`) callback. According to the SDK's types, an app without one treats the ask as a deny.

## The MCP server: advice, not enforcement

`cloudpin mcp` gives the agent three read-only tools: which account each CLI uses here, whether cloudpin would allow
a command, and why cloudpin may not be guarding (see [cloudpin's MCP server](mcp.md)). An SDK app adds it like any stdio server:

```python
options = ClaudeAgentOptions(mcp_servers={"cloudpin": {"type": "stdio", "command": "cloudpin", "args": ["mcp"]}})
```

```ts
const options: Options = { mcpServers: { cloudpin: { type: "stdio", command: "cloudpin", args: ["mcp"] } } };
```

The tools advise the agent. Nothing stops it from running a command without asking first, so keep the hook or the
callback as well.
