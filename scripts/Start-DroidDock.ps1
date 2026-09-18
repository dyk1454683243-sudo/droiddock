#requires -Version 7.0
[CmdletBinding()]
param([switch]$OpenBrowser)
$ErrorActionPreference = 'Stop'
$droidRoot = Split-Path -Parent $PSScriptRoot
if (-not (Test-Path -LiteralPath (Join-Path $droidRoot 'dist/droiddock/server.js'))) { throw 'Build DroidDock first with npm run build, or run Install-DroidDock.ps1.' }
$droidNode = (Get-Command node -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
$droidUrl = & $droidNode (Join-Path $PSScriptRoot 'launch.mjs')
if ($LASTEXITCODE -ne 0) { throw 'DroidDock could not start. See the launcher diagnostic above.' }
if ($OpenBrowser) { Start-Process $droidUrl }
Write-Output $droidUrl
