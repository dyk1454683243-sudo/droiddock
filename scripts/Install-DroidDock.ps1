#requires -Version 5.1
[CmdletBinding()]
param(
  [string]$DeviceSerial,
  [string]$AdbPath,
  [ValidateRange(1024,65535)][int]$Port,
  [switch]$NoLaunch,
  [switch]$SkipDependencyInstall
)
$ErrorActionPreference = 'Stop'
$droidRoot = Split-Path -Parent $PSScriptRoot

function Refresh-DroidPath {
  # Repeated PATH copies can exceed cmd.exe's limit when npm adds local bins.
  # Preserve the current tool precedence and append newly installed tools once.
  $seenPaths = [System.Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
  $mergedPaths = foreach ($pathList in @($env:Path, [Environment]::GetEnvironmentVariable('Path','Machine'), [Environment]::GetEnvironmentVariable('Path','User'))) {
    foreach ($entry in ($pathList -split ';')) {
      $entry = $entry.Trim()
      if ($entry -and $seenPaths.Add($entry.TrimEnd('\'))) { $entry }
    }
  }
  $env:Path = $mergedPaths -join ';'
}
function Find-DroidExecutable([string]$Name, [string[]]$Candidates) {
  $command = Get-Command $Name -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($command) { return $command.Source }
  foreach ($candidate in $Candidates) {
    if ($candidate -and (Test-Path -LiteralPath $candidate -PathType Leaf)) { return $candidate }
  }
  return $null
}
function Install-DroidDependency([string]$Id) {
  if ($SkipDependencyInstall) { throw "Missing prerequisite $Id. Rerun without -SkipDependencyInstall to install it." }
  $winget = Find-DroidExecutable 'winget.exe' @()
  if (-not $winget) { throw 'WinGet is unavailable. The agent must install or repair Microsoft App Installer, or install the official prerequisites documented in docs/SETUP.md, then rerun.' }
  # Keep package-manager progress out of the final machine-readable result.
  & $winget install --id $Id --exact --source winget --silent --accept-source-agreements --accept-package-agreements --disable-interactivity | Out-Host
  if ($LASTEXITCODE -ne 0) { throw "WinGet could not install $Id (exit $LASTEXITCODE). Inspect its output, resolve installation policy/elevation/restart requirements, then rerun." }
  Refresh-DroidPath
}

try {
  if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) { throw 'This installer supports Windows only.' }
  $local = @{}
  $configPath = Join-Path $droidRoot 'config.local.json'
  if (Test-Path -LiteralPath $configPath) { $local = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json }
  Refresh-DroidPath
  $node = Find-DroidExecutable 'node.exe' @("$env:ProgramFiles\nodejs\node.exe")
  if (-not $node -or [int]((& $node --version) -replace '^v(\d+).*','$1') -lt 24) {
    Install-DroidDependency 'OpenJS.NodeJS.LTS'
    $node = Find-DroidExecutable 'node.exe' @("$env:ProgramFiles\nodejs\node.exe")
  }
  if (-not $node -or [int]((& $node --version) -replace '^v(\d+).*','$1') -lt 24) { throw 'Node.js 24 or newer is required. Resolve PATH/version-manager selection and rerun.' }
  $pwsh = Find-DroidExecutable 'pwsh.exe' @("$env:ProgramFiles\PowerShell\7\pwsh.exe")
  if (-not $pwsh) {
    Install-DroidDependency 'Microsoft.PowerShell'
    $pwsh = Find-DroidExecutable 'pwsh.exe' @("$env:ProgramFiles\PowerShell\7\pwsh.exe")
  }
  if (-not $pwsh) { throw 'PowerShell 7 could not be located after installation.' }
  $env:Path = (Split-Path -Parent $node) + ';' + (Split-Path -Parent $pwsh) + ';' + $env:Path
  if (-not $AdbPath) { $AdbPath = $env:DROIDDOCK_ADB }
  if (-not $AdbPath) { $AdbPath = $local.adb }
  if ($AdbPath) {
    $adb = Find-DroidExecutable $AdbPath @($AdbPath)
    if (-not $adb) { throw 'Configured ADB executable is missing. Rerun with -AdbPath pointing to an installed ADB, or repair the existing installation.' }
  } else {
    $candidates = @("$env:LOCALAPPDATA\Android\Sdk\platform-tools\adb.exe", "$env:ProgramFiles\SCRCPY\adb.exe", "$env:LOCALAPPDATA\Microsoft\WinGet\Links\adb.exe")
    if ($env:ANDROID_HOME) { $candidates += "$env:ANDROID_HOME\platform-tools\adb.exe" }
    if ($env:ANDROID_SDK_ROOT) { $candidates += "$env:ANDROID_SDK_ROOT\platform-tools\adb.exe" }
    $adb = Find-DroidExecutable 'adb.exe' $candidates
    if (-not $adb) {
      Install-DroidDependency 'Google.PlatformTools'
      $adb = Find-DroidExecutable 'adb.exe' $candidates
    }
    if (-not $adb) { throw 'ADB could not be located after installation. Resolve WinGet/PATH and rerun with -AdbPath.' }
  }
  $setupArgs = @((Join-Path $PSScriptRoot 'setup.mjs'), '--adb', $adb)
  if ($DeviceSerial) { $setupArgs += @('--device-serial', $DeviceSerial) }
  if ($PSBoundParameters.ContainsKey('Port')) { $setupArgs += @('--port', [string]$Port) }
  if ($NoLaunch) { $setupArgs += '--no-launch' }
  & $node @setupArgs
  exit $LASTEXITCODE
} catch {
  @{ status='error'; stage='prerequisites'; message=$_.Exception.Message } | ConvertTo-Json -Compress
  exit 1
}
