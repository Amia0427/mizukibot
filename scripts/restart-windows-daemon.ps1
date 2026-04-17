param(
  [string]$TaskName = 'MizukiBotDaemon'
)

$ErrorActionPreference = 'Stop'
if (Get-Variable -Name PSNativeCommandUseErrorActionPreference -ErrorAction SilentlyContinue) {
  $PSNativeCommandUseErrorActionPreference = $false
}

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot '..')
$lockFile = Join-Path $repoRoot '.mizukibot.lock'
$workerPidFile = Join-Path $repoRoot '.mizukibot-postreply-worker.pid'

$targetPids = @()
foreach ($file in @($lockFile, $workerPidFile)) {
  if (Test-Path $file) {
    $pidText = (Get-Content -Path $file -TotalCount 1 -ErrorAction SilentlyContinue).Trim()
    if ($pidText -match '^[0-9]+$') {
      $targetPids += [int]$pidText
    }
  }
}
$targetPids = $targetPids | Sort-Object -Unique

$killed = @()
foreach ($pidNum in $targetPids) {
  try {
    Stop-Process -Id $pidNum -Force -ErrorAction Stop
    $killed += $pidNum
  } catch {
    Write-Warning "Failed to stop PID ${pidNum}: $($_.Exception.Message)"
  }
}

Start-Sleep -Seconds 1
Start-ScheduledTask -TaskName $TaskName
Start-Sleep -Seconds 4

Write-Host "=== Restart Result ==="
Write-Host ("TaskName : " + $TaskName)
Write-Host ("Killed   : " + ($(if ($killed) { $killed -join ', ' } else { '(none)' })))
Write-Host ""
Write-Host "=== Lock Files ==="
foreach ($file in @($lockFile, $workerPidFile)) {
  if (Test-Path $file) {
    $value = (Get-Content -Path $file -TotalCount 1 -ErrorAction SilentlyContinue).Trim()
    Write-Host ("$file => $value")
  } else {
    Write-Host ("$file => MISSING")
  }
}

Write-Host ""
Write-Host "=== Matching Node Processes ==="
Get-CimInstance Win32_Process | Where-Object {
  $_.Name -eq 'node.exe' -and ($_.CommandLine -match 'D:\\waifu|index\.js|post-reply-worker\.js')
} | Select-Object ProcessId, ParentProcessId, CommandLine | Format-Table -Wrap -AutoSize
