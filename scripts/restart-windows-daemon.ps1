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

function Get-ChildProcessTreeEntries {
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
  $result = New-Object System.Collections.Generic.List[object]
  $queue = New-Object System.Collections.Queue
  foreach ($pidNum in $RootPids) {
    if ($pidNum -gt 0) {
      $seen[$pidNum] = $true
      $queue.Enqueue([pscustomobject]@{
        ProcessId = $pidNum
        Depth = 0
      })
    }
  }

  while ($queue.Count -gt 0) {
    $current = $queue.Dequeue()
    $parentPid = [int]$current.ProcessId
    $nextDepth = [int]$current.Depth + 1
    if (-not $childrenByParent.ContainsKey($parentPid)) { continue }
    foreach ($childPid in $childrenByParent[$parentPid]) {
      if ($seen.ContainsKey($childPid)) { continue }
      $seen[$childPid] = $true
      $result.Add([pscustomobject]@{
        ProcessId = [int]$childPid
        ParentProcessId = $parentPid
        Depth = $nextDepth
      })
      $queue.Enqueue([pscustomobject]@{
        ProcessId = [int]$childPid
        Depth = $nextDepth
      })
    }
  }

  return @($result)
}

function Stop-PidList {
  param(
    [int[]]$Pids,
    [string]$Stage
  )

  foreach ($pidNum in @($Pids | Where-Object { $_ -gt 0 -and $_ -ne $PID } | Select-Object -Unique)) {
    try {
      Stop-Process -Id $pidNum -Force -ErrorAction Stop
      $script:killed += $pidNum
      Write-Host "[restart] stopped $Stage PID $pidNum"
    } catch {
      Write-Warning "Failed to stop $Stage PID ${pidNum}: $($_.Exception.Message)"
    }
  }
}

function Get-TreeChildPids {
  param(
    [int[]]$RootPids
  )

  if ($RootPids.Count -le 0) { return @() }
  $snapshot = @(Get-CimInstance Win32_Process)
  return @(
    Get-ChildProcessTreeEntries -RootPids $RootPids -Processes $snapshot |
      Sort-Object Depth -Descending |
      Select-Object -ExpandProperty ProcessId
  )
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
$killed = @()
$childPids = @(Get-TreeChildPids -RootPids $targetPids)
Stop-PidList -Pids $childPids -Stage 'child'
Stop-PidList -Pids $targetPids -Stage 'root'

for ($pass = 1; $pass -le 2; $pass++) {
  Start-Sleep -Milliseconds 700
  $residualChildPids = @(Get-TreeChildPids -RootPids $targetPids)
  if ($residualChildPids.Count -le 0) { break }
  Write-Host "[restart] residual child cleanup pass ${pass}: $($residualChildPids -join ', ')"
  Stop-PidList -Pids $residualChildPids -Stage "residual-child-$pass"
}

$oldRootAlivePids = @()
foreach ($pidNum in $targetPids) {
  if (Get-Process -Id $pidNum -ErrorAction SilentlyContinue) {
    $oldRootAlivePids += $pidNum
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
Write-Host ("OldAlive : " + ($(if ($oldRootAlivePids) { $oldRootAlivePids -join ', ' } else { '(none)' })))
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
