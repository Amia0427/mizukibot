param(
  [string]$TaskName = 'MizukiBotDaemon'
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'windows-daemon-common.ps1')

$taskRemoved = Remove-DaemonScheduledTask -TaskName $TaskName
$launcherRemoved = Remove-DaemonStartupLauncher -TaskName $TaskName -ScriptRoot $PSScriptRoot

if (-not $taskRemoved -and -not $launcherRemoved) {
  throw "No daemon task or startup launcher found for '$TaskName'"
}

if ($taskRemoved) {
  Write-Host "[OK] Daemon scheduled task removed: $TaskName"
}
if ($launcherRemoved) {
  Write-Host "[OK] Startup launcher removed: $TaskName"
}
