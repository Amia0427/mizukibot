param(
  [AllowEmptyString()]
  [string]$TaskName = 'MizukiBotDaemon'
)

$ErrorActionPreference = 'Stop'
if ([string]::IsNullOrWhiteSpace($TaskName)) {
  $TaskName = 'MizukiBotDaemon'
}
if (Get-Variable -Name PSNativeCommandUseErrorActionPreference -ErrorAction SilentlyContinue) {
  $PSNativeCommandUseErrorActionPreference = $false
}
. (Join-Path $PSScriptRoot 'windows-daemon-common.ps1')

Write-Host "=== Scheduled Task ==="
$task = Get-DaemonScheduledTask -TaskName $TaskName
if ($task) {
  [pscustomobject]@{
    Name = $task.Name
    Path = $task.Path
    State = Convert-DaemonTaskState -State $task.State
    Enabled = $task.Enabled
    LastRunTime = $task.LastRunTime
    NextRunTime = $task.NextRunTime
    LastTaskResult = $task.LastTaskResult
  } | Format-List
} else {
  Write-Host "[WARN] Scheduled task not found."
}

Write-Host ""
Write-Host "=== Startup Launcher ==="
$safeTaskName = if ([string]::IsNullOrWhiteSpace($TaskName)) { 'MizukiBotDaemon' } else { $TaskName }
$launcherPaths = Get-DaemonPaths -ScriptRoot $PSScriptRoot -TaskName $safeTaskName
$launcher = $launcherPaths.StartupLauncher
if (Test-Path $launcher) {
  [pscustomobject]@{
    Path = $launcher
    LastWriteTime = (Get-Item $launcher).LastWriteTime
  } | Format-List
} else {
  Write-Host "Startup launcher not found."
}

Write-Host ""
Write-Host "=== Node Processes ==="
$nodeProcs = Get-Process node -ErrorAction SilentlyContinue
if ($nodeProcs) {
  $nodeProcs | Select-Object Id, ProcessName, StartTime | Format-Table -AutoSize
} else {
  Write-Host "No node process found."
}

Write-Host ""
Write-Host "=== Runtime Hotspots ==="
$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
$hotspotScript = Join-Path $PSScriptRoot 'diagnose-runtime-hotspots.js'
if ($nodeCmd -and (Test-Path $hotspotScript)) {
  & $nodeCmd.Source $hotspotScript --text --window 30m
} else {
  Write-Host "Node or diagnose-runtime-hotspots.js not found."
}
