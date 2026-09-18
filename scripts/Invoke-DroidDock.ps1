#requires -Version 7.0
[CmdletBinding()]
param([Parameter(Mandatory)][ValidateSet('open', 'status', 'disconnect')][string]$Action)
$ErrorActionPreference = 'Stop'
$droidNode = (Get-Command node -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
& $droidNode (Join-Path $PSScriptRoot 'phone.mjs') $Action
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
