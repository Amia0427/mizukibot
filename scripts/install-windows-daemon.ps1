param(
  [string]$TaskName = 'MizukiBotDaemon'
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'windows-daemon-common.ps1')

$paths = Get-DaemonPaths -ScriptRoot $PSScriptRoot -TaskName $TaskName

try {
  $task = Register-DaemonScheduledTask -TaskName $TaskName -ScriptRoot $PSScriptRoot
  $null = Start-DaemonScheduledTaskNow -TaskName $TaskName
  Write-Host "[OK] Daemon scheduled task installed: $TaskName"
  Write-Host "     Runner : $($paths.Runner)"
  Write-Host "     State  : $(Convert-DaemonTaskState -State $task.State)"
} catch {
  $launcher = Install-DaemonStartupLauncher -TaskName $TaskName -ScriptRoot $PSScriptRoot
  Write-Warning ("Scheduled task install failed, fallback to Startup launcher. Reason: " + $_.Exception.Message)
  Write-Host "[OK] Startup launcher installed: $launcher"
  Write-Host "     Runner : $($paths.Runner)"
}
