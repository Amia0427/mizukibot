param(
  [string]$TaskName = 'MizukiBotDaemon'
)

$ErrorActionPreference = 'Stop'

$scriptPath = Join-Path $PSScriptRoot 'scripts\restart-windows-daemon.ps1'
if (-not (Test-Path $scriptPath)) {
  throw "Missing restart script: $scriptPath"
}

& $scriptPath -TaskName $TaskName
