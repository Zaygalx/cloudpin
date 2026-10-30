import { describe, expect, it } from "vitest";
import { findInvocations } from "../src/shellwords.js";
import { DYNAMIC_WORD, DYNAMIC_WORDS } from "../src/types.js";

// #159. A command from an agent's PowerShell tool is read with PowerShell's rules, not bash's. Every
// expected argv here is what Windows PowerShell 5.1 passed to an argv printer named like the CLI
// (`powershell.exe -NoProfile -NonInteractive -EncodedCommand`), or a DYNAMIC marker where the value is
// only known when it runs. The first rows are the 2026-10-26 audit's repro lines.

const GUARDED = ["az", "aws", "gcloud", "vercel", "gh", "kubectl", "helm", "supabase", "wrangler"];
const BT = "`";
const CRLF = "\r\n";
const calls = (cmd: string) => findInvocations(cmd, GUARDED, undefined, undefined, "powershell").map((i) => [i.bin, i.args]);
const az = (...args: string[]) => ["az", args];
const OTHER = ["group", "list", "--subscription", "zzother"];

describe("PowerShell: the audit's repro lines (#159)", () => {
  it.each([
    ["az group list --subscription zzother", [az(...OTHER)]],
    ["& az group list --subscription zzother", [az(...OTHER)]],
    ["1 | ForEach-Object { az group list --subscription zzother }", [az(...OTHER)]],
    ["az group list 2>&1 --subscription zzother | Out-Null", [az(...OTHER)]],
    ["az group list # --subscription zzother", [az("group", "list")]],
    // The backtick is the escape character and continues a line.
    [`az group list ${BT}${CRLF}  --subscription zzother`, [az(...OTHER)]],
    [`az group list ${BT}\n  --subscription zzother`, [az(...OTHER)]],
    [`az group list --query "a${BT}nb" --subscription zzother`, [az("group", "list", "--query", "a\nb", "--subscription", "zzother")]],
    [`az group list --query a${BT}|b --subscription zzother`, [az("group", "list", "--query", "a|b", "--subscription", "zzother")]],
    [`Write-Host "done${BT}n"; az group list --subscription zzother`, [az(...OTHER)]],
    // A backslash is a plain character.
    [String.raw`az group list --query "C:\temp\" --subscription zzother`, [az("group", "list", "--query", String.raw`C:\temp\ `.trim(), "--subscription", "zzother")]],
    [String.raw`az group list --query C:\temp\ --subscription zzother`, [az("group", "list", "--query", String.raw`C:\temp\ `.trim(), "--subscription", "zzother")]],
    [String.raw`Get-ChildItem "C:\Windows\" | Out-Null; az group list --subscription zzother`, [az(...OTHER)]],
    // Stop-parsing and block comments.
    ["az --% group list --subscription zzother", [az(...OTHER)]],
    ["az --% group list ; --subscription zzother", [az("group", "list", ";", "--subscription", "zzother")]],
    ["az group list <# note #> --subscription zzother", [az(...OTHER)]],
    // Here-strings, with the quote that closed bash's reading early.
    [`$m = @'${CRLF}it's done${CRLF}'@${CRLF}az group list --subscription zzother`, [az(...OTHER)]],
    [`$m = @"${CRLF}say "hi${CRLF}"@${CRLF}az group list --subscription zzother`, [az(...OTHER)]],
    [`$m = @'${CRLF}all fine${CRLF}'@${CRLF}az group list --subscription zzother`, [az(...OTHER)]],
    ["az group list --query 'it''s' --subscription zzother", [az("group", "list", "--query", "it's", "--subscription", "zzother")]],
    // Variables: a literal set on the line is substituted; an array or a splat may be several words.
    ["$a = @('--subscription','zzother'); az group list @a", [az("group", "list", DYNAMIC_WORDS)]],
    ["$a = '--subscription','zzother'; az group list $a", [az("group", "list", DYNAMIC_WORDS)]],
    ["$s = 'zzother'; az group list --subscription $s", [az(...OTHER)]],
    ["az group list --subscription $(Write-Output zzother)", [az("group", "list", "--subscription", DYNAMIC_WORD)]],
    ["kubectl --context $('zz' + 'ctx') get pods", [["kubectl", ["--context", DYNAMIC_WORD, "get", "pods"]]]],
    // The call operators and script blocks.
    [". az group list --subscription zzother", [az(...OTHER)]],
    ["& { az group list --subscription zzother }", [az(...OTHER)]],
    ["Invoke-Command -ScriptBlock { az group list --subscription zzother }", [az(...OTHER)]],
    ["function run { az @args -o table }; run group list --subscription zzother", [az(DYNAMIC_WORDS, "-o", "table")]],
    // A no-break space separates words, and curly quotes are quotes.
    ["az group list\u00a0--subscription zzother", [az(...OTHER)]],
    ["az group list \u201c--subscription\u201d zzother", [az(...OTHER)]],
    ["az group list \u2018--subscription\u2019 zzother", [az(...OTHER)]],
    ["az group list \u2013-subscription zzother", [az("group", "list", "\u2013-subscription", "zzother")]],
    // Windows PowerShell 5.1 passes an argument with a quote in it unescaped, and the CLI splits it again:
    // both readings are checked (PowerShell 7.3+ passes it as one word).
    [
      "az group list --query 'x \"y --subscription zzother\"'",
      [az("group", "list", "--query", 'x "y --subscription zzother"'), az("group", "list", "--query", "x y", "--subscription", "zzother")],
    ],
    [
      `az group list --query "a${BT}"b" --subscription zzother`,
      [az("group", "list", "--query", 'a"b', "--subscription", "zzother"), az("group", "list", "--query", "ab --subscription zzother")],
    ],
  ])("%j", (cmd, expected) => {
    expect(calls(cmd)).toEqual(expected);
  });

  it("keeps a variable set with $env: for the call", () => {
    const [call] = findInvocations("$env:AZURE_CONFIG_DIR = 'zzdir'; az group list", GUARDED, undefined, undefined, "powershell");
    expect(call?.env).toEqual({ AZURE_CONFIG_DIR: "zzdir" });
  });

  // Not this issue: environment state, the working folder and other runners are #162 and #163.
  it.todo("cmd /c, Start-Process, Invoke-Expression, powershell -EncodedCommand / positional script (#162)");
  it.todo("${env:X} = ..., Set-Item env:, [Environment]::SetEnvironmentVariable, Remove-Item Env:, $env: set in if / & { } (#163)");
  it.todo("Set-Location, sl, Push-Location, cd -Path (#163)");
});

describe("PowerShell: rules checked against Windows PowerShell 5.1 (#159)", () => {
  it.each([
    // Backtick escapes in a bare word, and continuation only at the start of a word.
    [`az a${BT}nb c${BT}tc`, [az("a\nb", "c\tc")]],
    [`az a${BT} b`, [az("a b")]],
    [`az a${BT}\nb`, [az("a\nb")]],
    [`az a${BT}${CRLF}b`, [az("a\r")]],
    // A word that starts with a quote ends at its closing quote; one that starts bare takes quotes in.
    ["az 'a'b c", [az("a", "b", "c")]],
    ['az "a"b c', [az("a", "b", "c")]],
    ["az a'b c'd e\"f g\"h", [az("ab cd", "ef gh")]],
    ["az '--sub'=other", [az("--sub", "=other")]],
    ['az --x="a b" --y=\'c d\'', [az("--x=a b", "--y=c d")]],
    // Comments start only at the start of a word.
    ["az a#b c #d", [az("a#b", "c")]],
    ["az 'a'#b c", [az("a")]],
    ["az a<#x#>b c", [az("a<#x#>b", "c")]],
    ["az <#x#>b c", [az("b", "c")]],
    [`az a <# x${CRLF}y #> b`, [az("a", "b")]],
    // Stop-parsing: the rest of the line, up to a newline or |, as typed; %NAME% is expanded.
    // (The 5.1 re-reading is not needed after --%, which passes the text as typed; it costs an extra check.)
    [String.raw`az --% a "b c" \"d`, [az("a", "b c", '"d'), az("a", "b c", "d")]],
    ["az --% a | Out-Null; az b", [az("a"), az("b")]],
    [`az --% a${CRLF}az b`, [az("a"), az("b")]],
    ["az --% a %FOO% b", [az("a", DYNAMIC_WORDS, "b")]],
    // Any bare word that reads --% stops parsing; a quoted '--%' is only dropped.
    [`az a ${BT}--% b ; c # d`, [az("a", "b", ";", "c", "#", "d")]],
    ["az a -'-%' b ; c", [az("a", "b", ";", "c")]],
    ["az a '--%' b ; az c", [az("a", "b"), az("c")]],
    // Separators, pipelines, PowerShell 7's && and ||, and the call operators.
    ["az a;az b", [az("a"), az("b")]],
    ["az a|az b", [az("a"), az("b")]],
    ["az a && az b || az c", [az("a"), az("b"), az("c")]],
    ["& 'az' a", [az("a")]],
    ['& "az" a', [az("a")]],
    ["&az x", [az("x")]],
    [". 'az' x", [az("x")]],
    ["$c = 'az'; & $c q", [az("q")]],
    ["(az a b)", [az("a", "b")]],
    // Redirections at the start of a word are not arguments; a > inside a word is.
    ["az a 2>&1 b *> $null; az c > out.txt d", [az("a", "b"), az("c", "d")]],
    ["az a 3>&1 b", [az("a", "b")]],
    ["az a>out.txt b; az c 2>err.txt d", [az("a>out.txt", "b"), az("c", "d")]],
    // Variables: one word each, never split; a known one is substituted.
    ["$s='v w'; az $s x$s ${s}y", [az("v w", "xv w", "v wy")]],
    ["$env:FOO='zz1 2'; az $env:FOO", [az("zz1 2")]],
    ["az $nope --x", [az(DYNAMIC_WORD, "--x")]],
    ["$a='--sub','x'; az $a y$a", [az(DYNAMIC_WORDS, DYNAMIC_WORD)]],
    ["az @('--sub','x') z", [az(DYNAMIC_WORDS, "z")]],
    ["az ('a','b') c", [az(DYNAMIC_WORDS, "c")]],
    ["$s='abc'; az $s.Length", [az(DYNAMIC_WORD)]],
    ["az x {y} z", [az("x", DYNAMIC_WORDS, "z")]],
    ["$n = 5; az --x $n", [az("--x", "5")]],
    ['$s = "pinned"; az --x $s', [az("--x", "pinned")]],
    ['$s = "$t"; az --x $s', [az("--x", DYNAMIC_WORD)]],
    ["$s = Get-Content f; az --x $s", [az("--x", DYNAMIC_WORDS)]],
    ["$files | ForEach-Object { gh pr view $_ }", [["gh", ["pr", "view", DYNAMIC_WORD]]]],
    // Double quotes: backtick escapes, "" for a quote (5.1 then drops it: both readings), $( ) runs.
    [`az "c${BT}$d" 'it''s' "it's"`, [az("c$d", "it's", "it's")]],
    ['az "e""f"', [az('e"f'), az("ef")]],
    ['az "a$(az inner)b" c', [az("inner"), az(DYNAMIC_WORD, "c")]],
    // Here-strings as arguments; one closes only at the start of a line.
    [`az @'${CRLF}x y${CRLF}'@ w`, [az("x y", "w")]],
    [`az @'${CRLF}a '@ b${CRLF}'@ w`, [az("a '@ b", "w")]],
    [`az @"${CRLF}$(az inner)${CRLF}"@`, [az("inner"), az(DYNAMIC_WORD)]],
    // Keywords run their blocks, and are not commands themselves.
    ["if ($true) { az a } else { az b }", [az("a"), az("b")]],
    ["foreach ($x in 1, 2) { az --x $x }", [az("--x", DYNAMIC_WORD)]],
    ["try { az a } catch { Write-Host $_ } finally { az b }", [az("a"), az("b")]],
    // A keyword statement ends with its ( ) or { }: another may follow on the same line.
    ["if ($true) { } az x", [az("x")]],
    ["foreach ($i in 1) { } az x", [az("x")]],
    ["function f { } az x", [az("x")]],
    ["try { } catch { } az x", [az("x")]],
    ["while ($false) { } az x", [az("x")]],
    ["& { param($x) az --subscription $x } zzother", [az("--subscription", DYNAMIC_WORD)]],
    // return and throw run the pipeline after them.
    ["& { return az r1 }", [az("r1")]],
    ["try { throw az t1 } catch { }", [az("t1")]],
    ["return $x", []],
    // A comma between spaced words, and in a word.
    ["az a , b --sub,other", [az("a", "b", "--sub,other")]],
  ])("%j", (cmd, expected) => {
    expect(calls(cmd)).toEqual(expected);
  });

  it("reads a pwsh or powershell -Command script with PowerShell's rules, from bash too", () => {
    const line = "pwsh -NoProfile -Command 'az group list <# x #> --subscription zzother'";
    expect(findInvocations(line, GUARDED).map((i) => [i.bin, i.args])).toEqual([az(...OTHER)]);
  });

  it("reads a bash -c script with bash's rules, from PowerShell", () => {
    expect(calls("bash -c 's=zzother; az group list --subscription $s'")).toEqual([az(...OTHER)]);
  });

  it("never throws, and stays linear on deep nesting", () => {
    for (const line of ["@'", '@"x', "$(", "{{{", "<#", "--%", "`", "'", '"$(', "@(", "@{", "$", "& ", ". "]) calls(line);
    const start = Date.now();
    calls(`${"$(".repeat(1000)}az x${")".repeat(1000)}`);
    calls(`${"{".repeat(1000)}az x${"}".repeat(1000)}`);
    expect(Date.now() - start).toBeLessThan(3000);
  });
});
