# Runs a built cloudpin-X.Y.Z-win-x64.zip the way winget users run it (#96):
#   powershell -NoProfile -File scripts/check-exe.ps1 <path-to-zip>
# from Windows PowerShell 5.1 (Nightly's Windows job, and locally). It unpacks
# the zip into a temporary folder and runs cloudpin.exe by its full path with
# PATH set to System32 (plus, for two checks, a fake az that prints a fixed
# account), so no real cloud CLI or account is involved. Exit 1 if any check
# fails; every check prints its result, and the controls must fail for the
# run to pass.
param([Parameter(Mandatory = $true)][string]$Zip)

$ErrorActionPreference = 'Continue'
Set-StrictMode -Version 2
$script:failures = 0
function Check([string]$name, [bool]$ok, [string]$detail = '') {
  if ($ok) { Write-Output "ok    $name" } else { Write-Output "FAIL  $name $detail"; $script:failures++ }
}

$version = (Get-Content -Raw (Join-Path $PSScriptRoot '..\package.json') | ConvertFrom-Json).version
$work = Join-Path ([IO.Path]::GetTempPath()) ('cloudpin-exe-check-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $work | Out-Null
$savedPath = $env:PATH
try {
  Expand-Archive -Path $Zip -DestinationPath (Join-Path $work 'zip')
  $exe = Join-Path $work 'zip\cloudpin.exe'
  Check 'the zip holds cloudpin.exe and LICENSE' ((Test-Path $exe) -and (Test-Path (Join-Path $work 'zip\LICENSE')))

  foreach ($d in 'unknown', 'azure', 'wrong', 'bin') { New-Item -ItemType Directory -Path (Join-Path $work $d) | Out-Null }
  $sub = '11111111-1111-1111-1111-111111111111'
  Set-Content -Encoding Ascii -Path (Join-Path $work 'unknown\.cloudpin.yml') -Value "terraform:`n  workspace: prod`n"
  Set-Content -Encoding Ascii -Path (Join-Path $work 'azure\.cloudpin.yml') -Value "azure:`n  subscription: $sub`n"
  Set-Content -Encoding Ascii -Path (Join-Path $work 'wrong\.cloudpin.yml') -Value "azure:`n  subscription: 00000000-0000-0000-0000-000000000000`n"
  # A fake az for `az account show --output json` (src/providers/azure.ts reads id and tenantId).
  Set-Content -Encoding Ascii -Path (Join-Path $work 'bin\az.cmd') -Value "@echo {`"id`":`"$sub`",`"tenantId`":`"22222222-2222-2222-2222-222222222222`",`"name`":`"fake`"}"

  $env:CLOUDPIN_NO_UPDATE_CHECK = '1'
  $env:CLOUDPIN_NO_CACHE = '1'
  $system = Join-Path $env:SystemRoot 'System32'
  $env:PATH = $system

  $out = & $exe --version
  Check "--version prints $version" ($LASTEXITCODE -eq 0 -and "$out" -eq $version) "(exit $LASTEXITCODE, printed '$out')"

  Push-Location (Join-Path $work 'unknown')
  $err = (& $exe check 2>&1 | ForEach-Object { "$_" }) -join "`n"
  $code = $LASTEXITCODE
  Pop-Location
  Check 'an unknown section is refused with exit 1' ($code -eq 1) "(exit $code)"
  Check 'and the advice names the exe download' ($err.Contains('download the latest cloudpin-X.Y.Z-win-x64.zip from https://github.com/paureis/cloudpin/releases')) "($err)"

  Push-Location (Join-Path $work 'azure')
  $out = (& $exe check 2>&1 | ForEach-Object { "$_" }) -join "`n"
  $code = $LASTEXITCODE
  Check 'a valid azure pin passes with az absent' ($code -eq 0 -and $out.Contains('az is not installed')) "(exit $($code): $out)"

  # The arguments cmd.exe would re-parse reach cloudpin unchanged.
  # (No embedded double quote: Windows PowerShell 5.1 itself drops it when calling a native program.)
  $want = @('a&b', '%PATH%', '^', 'a|b', 'a b')
  $json = (& $exe explain --json -- az @want) -join "`n"
  $code = $LASTEXITCODE
  $got = @((ConvertFrom-Json $json).calls[0].argv | Select-Object -Skip 1)
  Check 'explain --json gets every argument unchanged' ($code -eq 0 -and (($got -join [char]0) -ceq ($want -join [char]0))) "(exit $code, got: $($got -join ' | '))"
  Check 'control: a changed argument does not compare equal' (-not (($got -join [char]0) -ceq ((@('a&b', '%PATH%', '^', 'a|c', 'a b')) -join [char]0)))

  $env:PATH = (Join-Path $work 'bin') + ';' + $system
  $out = (& $exe check 2>&1 | ForEach-Object { "$_" }) -join "`n"
  $code = $LASTEXITCODE
  Pop-Location
  Check 'the pinned account matches the (fake) active one' ($code -eq 0 -and $out.Contains('matches the pin')) "(exit $($code): $out)"

  Push-Location (Join-Path $work 'wrong')
  $out = (& $exe check 2>&1 | ForEach-Object { "$_" }) -join "`n"
  $code = $LASTEXITCODE
  Check 'control: a wrong pin fails check with exit 1' ($code -eq 1) "(exit $($code): $out)"
  $null = & $exe exec -- az group list 2>&1
  $code = $LASTEXITCODE
  Pop-Location
  Check 'control: exec blocks az on the wrong pin with exit 3' ($code -eq 3) "(exit $code)"
  $env:PATH = $system

  # A copy with its bundled code damaged must not run: the exe really runs what was injected.
  $bytes = [IO.File]::ReadAllBytes($exe)
  $at = [Text.Encoding]::ASCII.GetString($bytes).IndexOf('import { isSea } from "node:sea";')
  Check 'the bundled code is in the exe' ($at -ge 0)
  if ($at -ge 0) {
    for ($k = 0; $k -lt 6; $k++) { $bytes[$at + $k] = 0x40 }
    $bad = Join-Path $work 'zip\cloudpin-damaged.exe'
    [IO.File]::WriteAllBytes($bad, $bytes)
    $null = & $bad --version 2>&1
    Check 'control: a damaged copy fails' ($LASTEXITCODE -ne 0) "(exit $LASTEXITCODE)"
  }
} finally {
  $env:PATH = $savedPath
  Remove-Item -Recurse -Force -Path $work -ErrorAction SilentlyContinue
}

if ($script:failures -gt 0) { Write-Output "$($script:failures) check(s) failed"; exit 1 }
Write-Output 'all checks passed'
