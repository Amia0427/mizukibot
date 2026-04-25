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

function Get-ChildProcessTreeIds {
  param(
    [Parameter(Mandatory = $true)]
    [int[]]$RootPids,
    [Parameter(Mandatory = $true)]
    [object[]]$Processes
  )

  $childrenByParent = @{}
  foreach ($proc in $Processes) {
    $parentId = [int]$proc.ParentProcessId
    if (-not $childrenByParent.ContainsKey($parentId)) {
      $childrenByParent[$parentId] = New-Object System.Collections.Generic.List[int]
    }
    $childrenByParent[$parentId].Add([int]$proc.ProcessId)
  }

  $seen = @{}
  $result = New-Object System.Collections.Generic.List[int]
  $queue = New-Object System.Collections.Queue
  foreach ($pidNum in $RootPids) {
    if ($pidNum -gt 0) {
      $seen[$pidNum] = $true
      $queue.Enqueue($pidNum)
    }
  }

  while ($queue.Count -gt 0) {
    $parentPid = [int]$queue.Dequeue()
    if (-not $childrenByParent.ContainsKey($parentPid)) { continue }
    foreach ($childPid in $childrenByParent[$parentPid]) {
      if ($seen.ContainsKey($childPid)) { continue }
      $seen[$childPid] = $true
      $result.Add($childPid)
      $queue.Enqueue($childPid)
    }
  }

  return @($result)
}

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
$processSnapshot = @(Get-CimInstance Win32_Process)
$childPids = @()
if ($targetPids.Count -gt 0) {
  $childPids = @(Get-ChildProcessTreeIds -RootPids $targetPids -Processes $processSnapshot | Sort-Object -Unique)
}
$allStopPids = @($childPids + $targetPids) | Where-Object { $_ -gt 0 } | Select-Object -Unique

$killed = @()
foreach ($pidNum in $allStopPids) {
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
Write-Host ("Roots    : " + ($(if ($targetPids) { $targetPids -join ', ' } else { '(none)' })))
Write-Host ("Children : " + ($(if ($childPids) { $childPids -join ', ' } else { '(none)' })))
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
