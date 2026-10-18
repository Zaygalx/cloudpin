/**
 * Shell functions that route each guarded CLI through `cloudpin exec`.
 * cloudpin then starts the real executable directly (no shell), so the
 * functions never call themselves. If cloudpin is not installed (or was
 * uninstalled), each function runs the real CLI unchanged, so a missing
 * cloudpin can never stop a guarded CLI from working.
 *
 * Aliases (#69): `name() {` fails to parse when `name` is already an alias, and
 * in zsh that stops the whole eval, so the functions use `function name {`,
 * whose name is never alias-expanded. An alias that calls the CLI itself then
 * reaches the function; one that runs another program (kubectl=kubecolor,
 * `command gh`) bypasses it, so each shell start warns about those.
 *
 * It also defines a `cloudpin` function (#14). Only for `cloudpin switch` it
 * passes a temporary side file in CLOUDPIN_ENV_FILE, then reads it line by line
 * and applies just `AWS_PROFILE=<name>` where the name is [A-Za-z0-9._-]{1,64}
 * (unsetting AWS_DEFAULT_PROFILE): never eval or Invoke-Expression, so nothing
 * in the file can run. It deletes the file and returns cloudpin's exit code.
 * Every other `cloudpin ...` passes straight through with stdio untouched.
 * Because a `cloudpin` function now exists, the guarded functions look for
 * the executable itself (`type -P`, `whence -p`), not `command -v`, which
 * the function would satisfy after cloudpin is uninstalled.
 */
export function shellInit(shell: string, bins: string[]): string {
  switch (shell) {
    case "bash":
    case "zsh": {
      // bash 4+ and zsh expose aliases as an associative array; bash 3.2 (macOS) has none and stays quiet.
      const aliasOf = shell === "bash" ? '${BASH_ALIASES[$__cloudpin_bin]-}' : '${aliases[$__cloudpin_bin]-}';
      // An executable on PATH only: bash's type -P and zsh's whence -p skip functions and aliases.
      const lookup = shell === "bash" ? "type -P cloudpin" : "whence -p cloudpin";
      return [
        `# cloudpin: guard cloud CLIs. Install: add to your ~/.${shell}rc`,
        `#   eval "$(cloudpin shell-init ${shell})"`,
        "# Remove that line to uninstall.",
        ...bins.map(
          (bin) =>
            `function ${bin} { if ${lookup} >/dev/null 2>&1; then command cloudpin exec -- ${bin} "$@"; else command ${bin} "$@"; fi; }`,
        ),
        ...POSIX_CLOUDPIN,
        `for __cloudpin_bin in ${bins.join(" ")}; do`,
        `  __cloudpin_alias="${aliasOf}"`,
        '  __cloudpin_first="${__cloudpin_alias%%[[:space:]]*}"',
        '  if [ -n "$__cloudpin_alias" ] && [ "$__cloudpin_first" != "$__cloudpin_bin" ] && [ "$__cloudpin_first" != "\\\\$__cloudpin_bin" ]; then',
        `    printf "cloudpin: alias %s='%s' runs another program, so %s is not guarded in this shell. Remove the alias to guard it.\\n" "$__cloudpin_bin" "$__cloudpin_alias" "$__cloudpin_bin" >&2`,
        "  fi",
        "done",
        "unset __cloudpin_bin __cloudpin_alias __cloudpin_first",
        "",
      ].join("\n");
    }
    case "pwsh":
    case "powershell":
      return [
        "# cloudpin: guard cloud CLIs. Install: add to your PowerShell profile ($PROFILE)",
        "#   cloudpin shell-init pwsh | Out-String | Invoke-Expression",
        "# Remove that line to uninstall.",
        ...bins.map((bin) =>
          [
            `function ${bin} {`,
            `  if (Get-Command cloudpin -CommandType Application -ErrorAction SilentlyContinue) {`,
            `    if ($MyInvocation.ExpectingInput) { $input | cloudpin exec -- ${bin} @args } else { cloudpin exec -- ${bin} @args }`,
            `  } else {`,
            `    $real = (Get-Command ${bin} -CommandType Application | Select-Object -First 1).Source`,
            `    if ($MyInvocation.ExpectingInput) { $input | & $real @args } else { & $real @args }`,
            `  }`,
            `}`,
          ].join("\n"),
        ),
        ...POWERSHELL_CLOUDPIN,
        // PowerShell runs an alias before a function of the same name, so any alias of a guarded CLI bypasses it (#69).
        `foreach ($__cloudpin_alias in @(Get-Alias -Name ${bins.map((b) => `'${b}'`).join(", ")} -ErrorAction SilentlyContinue)) {`,
        `  [Console]::Error.WriteLine("cloudpin: alias $($__cloudpin_alias.Name) -> $($__cloudpin_alias.Definition) runs instead of the cloudpin wrapper, so $($__cloudpin_alias.Name) is not guarded in this shell. Remove the alias to guard it.")`,
        "}",
        "Remove-Variable __cloudpin_alias -ErrorAction SilentlyContinue",
        "",
      ].join("\n");
    default:
      throw new Error(`unsupported shell "${shell}" (supported: bash, zsh, pwsh)`);
  }
}

// The profile-name check is a glob of explicit characters, so no locale can widen a range.
const POSIX_CLOUDPIN = [
  "function cloudpin {",
  '  if [ "${1-}" != "switch" ]; then command cloudpin "$@"; return; fi',
  "  local __cloudpin_file __cloudpin_rc __cloudpin_line __cloudpin_value",
  '  __cloudpin_file="$(mktemp 2>/dev/null)" || { command cloudpin "$@"; return; }',
  '  CLOUDPIN_ENV_FILE="$__cloudpin_file" command cloudpin "$@"',
  "  __cloudpin_rc=$?",
  '  while IFS= read -r __cloudpin_line || [ -n "$__cloudpin_line" ]; do',
  '    case "$__cloudpin_line" in',
  "      AWS_PROFILE=*)",
  '        __cloudpin_value="${__cloudpin_line#AWS_PROFILE=}"',
  '        case "$__cloudpin_value" in',
  '          ""|*[!ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789._-]*) ;;',
  '          *) if [ "${#__cloudpin_value}" -le 64 ]; then export AWS_PROFILE="$__cloudpin_value"; unset AWS_DEFAULT_PROFILE; fi ;;',
  "        esac ;;",
  "    esac",
  '  done < "$__cloudpin_file"',
  '  rm -f "$__cloudpin_file"',
  "  return $__cloudpin_rc",
  "}",
];

// The real cloudpin is the first one PowerShell would run without this function
// (a .ps1 shim before a .cmd in the same folder), so arguments reach it the same way.
const POWERSHELL_CLOUDPIN = [
  "function cloudpin {",
  "  $__cloudpin_real = Get-Command cloudpin -CommandType ExternalScript, Application -ErrorAction SilentlyContinue | Select-Object -First 1",
  "  if (-not $__cloudpin_real) {",
  '    [Console]::Error.WriteLine("cloudpin: not installed; remove the cloudpin shell-init line from your PowerShell profile")',
  "    $global:LASTEXITCODE = 127",
  "    return",
  "  }",
  "  if ($args.Count -eq 0 -or $args[0] -cne 'switch') {",
  "    if ($MyInvocation.ExpectingInput) { $input | & $__cloudpin_real @args } else { & $__cloudpin_real @args }",
  "    return",
  "  }",
  "  $__cloudpin_file = [IO.Path]::GetTempFileName()",
  "  $__cloudpin_saved = $env:CLOUDPIN_ENV_FILE",
  "  try {",
  "    $env:CLOUDPIN_ENV_FILE = $__cloudpin_file",
  "    & $__cloudpin_real @args",
  "    $__cloudpin_rc = $LASTEXITCODE",
  "  } finally {",
  "    $env:CLOUDPIN_ENV_FILE = $__cloudpin_saved",
  "  }",
  "  if (Test-Path -LiteralPath $__cloudpin_file) {",
  "    foreach ($__cloudpin_line in [IO.File]::ReadAllLines($__cloudpin_file)) {",
  "      if ($__cloudpin_line -cmatch '^AWS_PROFILE=([A-Za-z0-9._-]{1,64})\\z') {",
  "        $env:AWS_PROFILE = $Matches[1]",
  "        Remove-Item Env:AWS_DEFAULT_PROFILE -ErrorAction SilentlyContinue",
  "      }",
  "    }",
  "    Remove-Item -LiteralPath $__cloudpin_file -Force -ErrorAction SilentlyContinue",
  "  }",
  "  $global:LASTEXITCODE = $__cloudpin_rc",
  "}",
];
