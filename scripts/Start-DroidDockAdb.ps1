#requires -Version 7
[CmdletBinding()]
param([Parameter(Mandatory)][string]$AdbPath)
$ErrorActionPreference = 'Stop'
try {
  $adb = (Get-Command $AdbPath -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
  # ShellExecute isolates the daemon from captured ancestor output handles.
  # -Wait would wait for the daemon's entire process tree, not just its starter.
  $start = [System.Diagnostics.ProcessStartInfo]::new()
  $start.FileName = $adb
  $start.Arguments = 'start-server'
  $start.UseShellExecute = $true
  $start.WindowStyle = [System.Diagnostics.ProcessWindowStyle]::Hidden
  $process = [System.Diagnostics.Process]::Start($start)
  try {
    if (-not $process.WaitForExit(15000)) { $process.Kill(); throw 'ADB startup timed out.' }
    if ($process.ExitCode -ne 0) { throw "ADB startup failed (exit $($process.ExitCode))." }
  } finally { $process.Dispose() }
} catch { Write-Output $_.Exception.Message; exit 1 }
