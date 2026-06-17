@echo off
setlocal
cd /d "%~dp0"
set "MIZUKI_RESTART_BOT_ROOT=%~dp0"
set "MIZUKI_RESTART_DEFAULT_STATUS="
if "%~1"=="" set "MIZUKI_RESTART_DEFAULT_STATUS=1"
set "MIZUKI_RESTART_PRINT_POST_STATUS="
if /i "%~1"=="restart" (
  if /i "%~2"=="confirm" set "MIZUKI_RESTART_PRINT_POST_STATUS=1"
  if /i "%~2"=="confirmed" set "MIZUKI_RESTART_PRINT_POST_STATUS=1"
  if /i "%~2"=="--confirm" set "MIZUKI_RESTART_PRINT_POST_STATUS=1"
  if /i "%~2"=="/confirm" set "MIZUKI_RESTART_PRINT_POST_STATUS=1"
  if /i "%MIZUKI_RESTART_CONFIRM%"=="1" set "MIZUKI_RESTART_PRINT_POST_STATUS=1"
  if /i "%MIZUKI_RESTART_CONFIRM%"=="true" set "MIZUKI_RESTART_PRINT_POST_STATUS=1"
  if /i "%MIZUKI_RESTART_CONFIRM%"=="yes" set "MIZUKI_RESTART_PRINT_POST_STATUS=1"
  if /i "%MIZUKI_RESTART_CONFIRM%"=="y" set "MIZUKI_RESTART_PRINT_POST_STATUS=1"
  if /i "%MIZUKI_RESTART_CONFIRM%"=="on" set "MIZUKI_RESTART_PRINT_POST_STATUS=1"
  if /i "%MIZUKI_RESTART_CONFIRM%"=="confirm" set "MIZUKI_RESTART_PRINT_POST_STATUS=1"
  if /i "%MIZUKI_RESTART_CONFIRM%"=="confirmed" set "MIZUKI_RESTART_PRINT_POST_STATUS=1"
)

powershell -NoProfile -ExecutionPolicy Bypass -Command "$script = Get-Content -LiteralPath '%~f0' -Raw; $marker = '# POWERSHELL_PAYLOAD'; $idx = $script.LastIndexOf($marker); if ($idx -lt 0) { throw 'Missing PowerShell payload.' }; $payload = $script.Substring($idx + $marker.Length).TrimStart(); $block = [scriptblock]::Create($payload); & $block @args" %*
set "RESTART_EXIT=%ERRORLEVEL%"
if not "%RESTART_EXIT%"=="0" exit /b %RESTART_EXIT%

if /i "%~1"=="restart" if /i "%MIZUKI_RESTART_PRINT_POST_STATUS%"=="1" (
  echo.
  echo [restart] confirmed restart completed; final status:
  call "%~f0" status
  set "POST_STATUS_EXIT=%ERRORLEVEL%"
  if not "%POST_STATUS_EXIT%"=="0" exit /b %POST_STATUS_EXIT%
)

set "SKIP_LOG_WINDOW="
if defined MIZUKI_RESTART_DEFAULT_STATUS set "SKIP_LOG_WINDOW=1"
if /i "%~1"=="restart" (
  set "SKIP_LOG_WINDOW=1"
  if /i "%~2"=="confirm" set "SKIP_LOG_WINDOW="
  if /i "%~2"=="confirmed" set "SKIP_LOG_WINDOW="
  if /i "%~2"=="--confirm" set "SKIP_LOG_WINDOW="
  if /i "%~2"=="/confirm" set "SKIP_LOG_WINDOW="
  if /i "%MIZUKI_RESTART_CONFIRM%"=="1" set "SKIP_LOG_WINDOW="
  if /i "%MIZUKI_RESTART_CONFIRM%"=="true" set "SKIP_LOG_WINDOW="
  if /i "%MIZUKI_RESTART_CONFIRM%"=="yes" set "SKIP_LOG_WINDOW="
  if /i "%MIZUKI_RESTART_CONFIRM%"=="y" set "SKIP_LOG_WINDOW="
  if /i "%MIZUKI_RESTART_CONFIRM%"=="on" set "SKIP_LOG_WINDOW="
  if /i "%MIZUKI_RESTART_CONFIRM%"=="confirm" set "SKIP_LOG_WINDOW="
  if /i "%MIZUKI_RESTART_CONFIRM%"=="confirmed" set "SKIP_LOG_WINDOW="
)
for %%A in (%*) do (
  if /i "%%~A"=="-StatusOnly" set "SKIP_LOG_WINDOW=1"
  if /i "%%~A"=="/StatusOnly" set "SKIP_LOG_WINDOW=1"
  if /i "%%~A"=="status" set "SKIP_LOG_WINDOW=1"
)
if defined SKIP_LOG_WINDOW exit /b 0

start "" powershell -NoProfile -ExecutionPolicy Bypass -NoExit -File "%~dp0scripts\watch-bot-daemon-log.ps1"
exit /b 0

# POWERSHELL_PAYLOAD
param(
  [AllowEmptyString()]
  [string]$TaskName = 'MizukiBotDaemon',
  [AllowEmptyString()]
  [string]$Confirm = '',
  [switch]$Restart,
  [switch]$ConfirmRestart,
  [switch]$StatusOnly,
  [switch]$SkipInstall
)

$ErrorActionPreference = 'Stop'
if (Get-Variable -Name PSNativeCommandUseErrorActionPreference -ErrorAction SilentlyContinue) {
  $PSNativeCommandUseErrorActionPreference = $false
}

if ($env:MIZUKI_RESTART_DEFAULT_STATUS -eq '1') {
  $StatusOnly = $true
}

if ([string]::IsNullOrWhiteSpace($TaskName)) {
  $TaskName = 'MizukiBotDaemon'
}

$positionalCommand = [string]$TaskName
if (-not [string]::IsNullOrWhiteSpace($positionalCommand)) {
  switch -Regex ($positionalCommand.Trim()) {
    '^(?i:restart)$' {
      $TaskName = 'MizukiBotDaemon'
      $Restart = $true
      break
    }
    '^(?i:status|statusonly)$' {
      $TaskName = 'MizukiBotDaemon'
      $StatusOnly = $true
      break
    }
    '^(?i:start)$' {
      $TaskName = 'MizukiBotDaemon'
      break
    }
  }
}

if (-not [string]::IsNullOrWhiteSpace($Confirm)) {
  switch -Regex ($Confirm.Trim()) {
    '^(?i:confirm|confirmed|--confirm|/confirm)$' {
      $ConfirmRestart = $true
      break
    }
  }
}

$repoRoot = Resolve-Path $env:MIZUKI_RESTART_BOT_ROOT
$scriptRoot = Join-Path $repoRoot 'scripts'
$commonPath = Join-Path $scriptRoot 'windows-daemon-common.ps1'
$runnerPath = Join-Path $scriptRoot 'run-bot-daemon.ps1'

foreach ($requiredPath in @($commonPath, $runnerPath)) {
  if (-not (Test-Path $requiredPath)) {
    throw "Missing daemon script: $requiredPath"
  }
}

. $commonPath

$mainPidFile = Join-Path $repoRoot '.mizukibot.lock'
$workerPidFile = Join-Path $repoRoot '.mizukibot-postreply-worker.pid'
$expectedShutdownFile = Join-Path (Join-Path $repoRoot 'data') 'bot-main-expected-shutdown.json'

function Read-FirstLine {
  param([Parameter(Mandatory = $true)][string]$Path)

  if (-not (Test-Path $Path)) { return '' }
  try {
    $line = Get-Content -Path $Path -TotalCount 1 -Encoding utf8 -ErrorAction Stop
    if ($null -eq $line) { return '' }
    return ([string]$line).Trim()
  } catch {
    return ''
  }
}

function Get-PositiveInt64Env {
  param(
    [Parameter(Mandatory = $true)][string]$Name,
    [Parameter(Mandatory = $true)][Int64]$DefaultValue
  )

  $raw = [Environment]::GetEnvironmentVariable($Name, 'Process')
  if ([string]::IsNullOrWhiteSpace($raw)) { return $DefaultValue }

  [Int64]$parsed = 0
  if ([Int64]::TryParse($raw.Trim(), [ref]$parsed) -and $parsed -ge 0) {
    return $parsed
  }

  return $DefaultValue
}

function Read-JsonFileSafe {
  param([Parameter(Mandatory = $true)][string]$Path)

  try {
    if (-not (Test-Path $Path)) { return $null }
    $raw = Get-Content -LiteralPath $Path -Raw -Encoding utf8 -ErrorAction Stop
    if ([string]::IsNullOrWhiteSpace($raw)) { return $null }
    return $raw | ConvertFrom-Json -ErrorAction Stop
  } catch {
    return $null
  }
}

function Write-JsonFileSafe {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)]$Value
  )

  try {
    $dir = Split-Path -Parent $Path
    if ($dir -and -not (Test-Path $dir)) {
      New-Item -ItemType Directory -Path $dir -Force | Out-Null
    }
    $json = $Value | ConvertTo-Json -Depth 8
    [System.IO.File]::WriteAllText($Path, $json + "`r`n", [System.Text.Encoding]::UTF8)
    return $true
  } catch {
    return $false
  }
}

function Get-RestartMarkerTextEnv {
  param(
    [Parameter(Mandatory = $true)][string]$Name,
    [string]$DefaultValue = ''
  )

  $raw = [Environment]::GetEnvironmentVariable($Name, 'Process')
  if ([string]::IsNullOrWhiteSpace($raw)) { return $DefaultValue }
  return $raw.Trim()
}

function Test-RestartConfirmed {
  if ($ConfirmRestart) { return $true }

  $raw = Get-RestartMarkerTextEnv -Name 'MIZUKI_RESTART_CONFIRM'
  switch ($raw.ToLowerInvariant()) {
    { $_ -in @('1', 'true', 'yes', 'y', 'on', 'confirm', 'confirmed') } { return $true }
  }

  return $false
}

function Test-PostReplyJobDue {
  param(
    [Parameter(Mandatory = $true)]$Job,
    [Parameter(Mandatory = $true)][datetime]$Now
  )

  $availableAtText = [string]$Job.availableAt
  $nextRetryAtText = [string]$Job.nextRetryAt
  $availableAt = [datetime]::MinValue
  $nextRetryAt = [datetime]::MinValue

  if (-not [string]::IsNullOrWhiteSpace($availableAtText)) {
    if ([datetime]::TryParse($availableAtText, [ref]$availableAt) -and $availableAt.ToUniversalTime() -gt $Now.ToUniversalTime()) {
      return $false
    }
  }

  if (-not [string]::IsNullOrWhiteSpace($nextRetryAtText)) {
    if ([datetime]::TryParse($nextRetryAtText, [ref]$nextRetryAt) -and $nextRetryAt.ToUniversalTime() -gt $Now.ToUniversalTime()) {
      return $false
    }
  }

  return $true
}

function Test-PostReplyProcessingRecoverable {
  param(
    [Parameter(Mandatory = $true)]$Job,
    [Parameter(Mandatory = $true)][datetime]$Now,
    [Parameter(Mandatory = $true)][Int64]$StaleProcessingMs
  )

  $leaseUntilText = [string]$Job.leaseUntil
  $leaseUntil = [datetime]::MinValue
  if (-not [string]::IsNullOrWhiteSpace($leaseUntilText) -and [datetime]::TryParse($leaseUntilText, [ref]$leaseUntil)) {
    return $leaseUntil.ToUniversalTime() -le $Now.ToUniversalTime()
  }

  $updatedAtText = [string]$Job.updatedAt
  $updatedAt = [datetime]::MinValue
  if (-not [string]::IsNullOrWhiteSpace($updatedAtText) -and [datetime]::TryParse($updatedAtText, [ref]$updatedAt)) {
    return ($Now.ToUniversalTime() - $updatedAt.ToUniversalTime()).TotalMilliseconds -ge $StaleProcessingMs
  }

  return $true
}

function Get-PostReplyQueueStartReason {
  $queueRoot = [Environment]::GetEnvironmentVariable('POST_REPLY_QUEUE_DIR', 'Process')
  if ([string]::IsNullOrWhiteSpace($queueRoot)) {
    $queueRoot = Join-Path (Join-Path $repoRoot 'data') 'post_reply_jobs'
  }
  if (-not [System.IO.Path]::IsPathRooted($queueRoot)) {
    $queueRoot = Join-Path $repoRoot $queueRoot
  }

  $now = Get-Date
  $staleProcessingMs = Get-PositiveInt64Env -Name 'POST_REPLY_WORKER_STALE_PROCESSING_MS' -DefaultValue 300000
  $queuedDir = Join-Path $queueRoot 'queued'
  $processingDir = Join-Path $queueRoot 'processing'

  $firstPendingQueuedJob = ''
  if (Test-Path $queuedDir) {
    foreach ($file in @(Get-ChildItem -LiteralPath $queuedDir -Filter '*.json' -File -ErrorAction SilentlyContinue)) {
      $job = Read-JsonFileSafe -Path $file.FullName
      if ($null -ne $job -and (Test-PostReplyJobDue -Job $job -Now $now)) {
        return "queued job due: $($file.Name)"
      }
      if ($null -ne $job -and [string]::IsNullOrWhiteSpace($firstPendingQueuedJob)) {
        $firstPendingQueuedJob = $file.Name
      }
    }
  }

  if (-not [string]::IsNullOrWhiteSpace($firstPendingQueuedJob)) {
    return "queued job pending: $firstPendingQueuedJob"
  }

  if (Test-Path $processingDir) {
    foreach ($file in @(Get-ChildItem -LiteralPath $processingDir -Filter '*.json' -File -ErrorAction SilentlyContinue)) {
      $job = Read-JsonFileSafe -Path $file.FullName
      if ($null -ne $job -and (Test-PostReplyProcessingRecoverable -Job $job -Now $now -StaleProcessingMs $staleProcessingMs)) {
        return "processing job recoverable: $($file.Name)"
      }
    }
  }

  return ''
}

function Get-ProcessCommandLineSafe {
  param([Parameter(Mandatory = $true)][int]$ProcessId)

  try {
    $proc = Get-CimInstance Win32_Process -Filter "ProcessId = $ProcessId" -ErrorAction Stop
    return [string]$proc.CommandLine
  } catch {
    return ''
  }
}

function Test-ProcessLooksLikeMainBot {
  param([Parameter(Mandatory = $true)]$Process)

  $commandLine = [string]$Process.CommandLine
  if ([string]::IsNullOrWhiteSpace($commandLine)) {
    return $false
  }

  $normalizedRoot = ([string]$repoRoot).TrimEnd('\')
  $repoIndexPattern = [regex]::Escape($normalizedRoot) + '[\\/]index\.js(["''\s]|$)'
  $bareIndexArg = $commandLine -match '(^|["''\s])index\.js(["''\s]|$)'
  $repoIndexArg = ($commandLine -match $repoIndexPattern)

  return ($bareIndexArg -or $repoIndexArg)
}

function Get-RunningMainBotProcesses {
  try {
    return @(Get-CimInstance Win32_Process -ErrorAction Stop | Where-Object {
      $_.Name -eq 'node.exe' -and (Test-ProcessLooksLikeMainBot -Process $_)
    } | Sort-Object ProcessId)
  } catch {
    return @()
  }
}

function Repair-MainPidFileFromProcess {
  param([Parameter(Mandatory = $true)]$MainProcess)

  $pidNum = [int]$MainProcess.ProcessId
  if ($pidNum -le 0) {
    return $false
  }

  try {
    Set-Content -Path $mainPidFile -Value $pidNum -Encoding utf8
    return $true
  } catch {
    return $false
  }
}

function Test-PidIsRunningMainBot {
  param([Parameter(Mandatory = $true)][int]$ProcessId)

  if ($ProcessId -le 0) {
    return $false
  }

  $process = Get-Process -Id $ProcessId -ErrorAction SilentlyContinue
  if ($null -eq $process -or $process.ProcessName -ine 'node') {
    return $false
  }

  $commandLine = Get-ProcessCommandLineSafe -ProcessId $ProcessId
  if ([string]::IsNullOrWhiteSpace($commandLine)) {
    return $true
  }

  return ($commandLine -match '(^|["''\s])index\.js(["''\s]|$)')
}

function Get-MainBotStatusFromProcessScan {
  param([Parameter(Mandatory = $true)][string]$Name)

  $mainProcesses = @(Get-RunningMainBotProcesses)
  if ($mainProcesses.Count -le 0) {
    return $null
  }

  $mainProcess = $mainProcesses[0]
  $pidNum = [int]$mainProcess.ProcessId
  $repaired = Repair-MainPidFileFromProcess -MainProcess $mainProcess
  $detail = if ($repaired) { 'ok; pid file repaired from process scan' } else { 'ok; pid file repair failed' }
  if ($mainProcesses.Count -gt 1) {
    $detail = "$detail; duplicate main processes=$($mainProcesses.Count)"
  }

  return [pscustomobject]@{ Name = $Name; PidFile = $mainPidFile; Pid = $pidNum; Running = $true; Match = $true; Process = 'node'; Detail = $detail }
}

function Get-PidFileProcessStatus {
  param(
    [Parameter(Mandatory = $true)][string]$Name,
    [Parameter(Mandatory = $true)][string]$PidFile,
    [Parameter(Mandatory = $true)][string]$ExpectedCommandPattern
  )

  $pidText = Read-FirstLine -Path $PidFile
  $exists = Test-Path $PidFile
  $pidNum = 0
  $pidValid = [int]::TryParse($pidText, [ref]$pidNum)

  if (-not $exists) {
    if ($ExpectedCommandPattern -eq 'index\.js') {
      $scanned = Get-MainBotStatusFromProcessScan -Name $Name
      if ($null -ne $scanned) { return $scanned }
    }
    return [pscustomobject]@{ Name = $Name; PidFile = $PidFile; Pid = ''; Running = $false; Match = $false; Process = ''; Detail = 'pid file missing' }
  }
  if (-not $pidValid -or $pidNum -le 0) {
    if ($ExpectedCommandPattern -eq 'index\.js') {
      $scanned = Get-MainBotStatusFromProcessScan -Name $Name
      if ($null -ne $scanned) { return $scanned }
    }
    return [pscustomobject]@{ Name = $Name; PidFile = $PidFile; Pid = $pidText; Running = $false; Match = $false; Process = ''; Detail = 'pid file invalid' }
  }

  $process = Get-Process -Id $pidNum -ErrorAction SilentlyContinue
  if ($null -eq $process) {
    if ($ExpectedCommandPattern -eq 'index\.js') {
      $scanned = Get-MainBotStatusFromProcessScan -Name $Name
      if ($null -ne $scanned) { return $scanned }
    }
    return [pscustomobject]@{ Name = $Name; PidFile = $PidFile; Pid = $pidNum; Running = $false; Match = $false; Process = ''; Detail = 'process not found' }
  }

  $commandLine = Get-ProcessCommandLineSafe -ProcessId $pidNum
  $processName = [string]$process.ProcessName
  $isNode = $processName -ieq 'node'
  $matches = $isNode -and ($commandLine -match $ExpectedCommandPattern)
  if ([string]::IsNullOrWhiteSpace($commandLine)) {
    $matches = $isNode
  }

  $detail = if ($matches) { 'ok' } elseif (-not $isNode) { 'pid is not node' } else { 'command line mismatch' }
  if (-not $matches -and $ExpectedCommandPattern -eq 'index\.js') {
    $scanned = Get-MainBotStatusFromProcessScan -Name $Name
    if ($null -ne $scanned) { return $scanned }
  }
  return [pscustomobject]@{ Name = $Name; PidFile = $PidFile; Pid = $pidNum; Running = $true; Match = $matches; Process = $processName; Detail = $detail }
}

function Get-BotRuntimeStatus {
  $main = Get-PidFileProcessStatus -Name 'main bot' -PidFile $mainPidFile -ExpectedCommandPattern 'index\.js'
  $worker = Get-PidFileProcessStatus -Name 'post-reply worker' -PidFile $workerPidFile -ExpectedCommandPattern 'post-reply-worker\.js'
  $workerHealthy = ($worker.Running -and $worker.Match)
  $workerStartReason = if ($workerHealthy) { '' } else { Get-PostReplyQueueStartReason }
  $workerIdleAllowed = ((-not $workerHealthy) -and [string]::IsNullOrWhiteSpace($workerStartReason))
  return [pscustomobject]@{
    Main = $main
    Worker = $worker
    WorkerStartReason = $workerStartReason
    WorkerIdleAllowed = $workerIdleAllowed
    Healthy = ($main.Running -and $main.Match -and ($workerHealthy -or $workerIdleAllowed))
  }
}

function Get-ScheduledTaskStatus {
  param([Parameter(Mandatory = $true)][string]$TaskName)

  $task = Get-DaemonScheduledTask -TaskName $TaskName
  if (-not $task) {
    return [pscustomobject]@{ Name = $TaskName; Exists = $false; Enabled = $false; State = 'Missing'; LastRunTime = ''; NextRunTime = ''; LastTaskResult = ''; RawTask = $null }
  }

  return [pscustomobject]@{
    Name = $TaskName
    Exists = $true
    Enabled = [bool]$task.Enabled
    State = Convert-DaemonTaskState -State ([int]$task.State)
    LastRunTime = $task.LastRunTime
    NextRunTime = $task.NextRunTime
    LastTaskResult = $task.LastTaskResult
    RawTask = $task
  }
}

function Get-StartupLauncherStatus {
  param([Parameter(Mandatory = $true)][string]$TaskName)

  $path = Get-DaemonStartupLauncherPath -TaskName $TaskName -ScriptRoot $scriptRoot
  return [pscustomobject]@{ Name = 'startup launcher'; Exists = (Test-Path $path); Path = $path }
}

function Enable-DaemonScheduledTask {
  param([Parameter(Mandatory = $true)][string]$TaskName)

  $task = Get-DaemonScheduledTask -TaskName $TaskName
  if (-not $task) { return $false }

  try {
    $task.Enabled = $true
    return $true
  } catch {
    try {
      Enable-ScheduledTask -TaskName $TaskName -ErrorAction Stop | Out-Null
      return $true
    } catch {
      return $false
    }
  }
}

function Ensure-DaemonConfigured {
  param([Parameter(Mandatory = $true)][string]$TaskName)

  $actions = New-Object System.Collections.ArrayList
  $taskStatus = Get-ScheduledTaskStatus -TaskName $TaskName

  if (-not $taskStatus.Exists) {
    if ($SkipInstall) {
      [void]$actions.Add('scheduled task missing; install skipped')
    } else {
      try {
        $null = Register-DaemonScheduledTask -TaskName $TaskName -ScriptRoot $scriptRoot
        [void]$actions.Add('scheduled task registered')
      } catch {
        [void]$actions.Add("scheduled task register failed: $($_.Exception.Message)")
        try {
          $launcherPath = Install-DaemonStartupLauncher -TaskName $TaskName -ScriptRoot $scriptRoot
          [void]$actions.Add("startup launcher installed: $launcherPath")
        } catch {
          [void]$actions.Add("startup launcher install failed: $($_.Exception.Message)")
        }
      }
    }
  } elseif (-not $taskStatus.Enabled) {
    if (Enable-DaemonScheduledTask -TaskName $TaskName) {
      [void]$actions.Add('scheduled task enabled')
    } else {
      [void]$actions.Add('scheduled task enable failed')
      if (-not $SkipInstall) {
        try {
          $launcherPath = Install-DaemonStartupLauncher -TaskName $TaskName -ScriptRoot $scriptRoot
          [void]$actions.Add("startup launcher installed: $launcherPath")
        } catch {
          [void]$actions.Add("startup launcher install failed: $($_.Exception.Message)")
        }
      }
    }
  } else {
    [void]$actions.Add('scheduled task already enabled')
  }

  return @($actions)
}

function Get-ChildProcessTreeEntries {
  param(
    [Parameter(Mandatory = $true)][int[]]$RootPids,
    [Parameter(Mandatory = $true)][object[]]$Processes
  )

  $childrenByParent = @{}
  foreach ($proc in $Processes) {
    $parentId = [int]$proc.ParentProcessId
    if (-not $childrenByParent.ContainsKey($parentId)) {
      $childrenByParent[$parentId] = New-Object System.Collections.ArrayList
    }
    [void]$childrenByParent[$parentId].Add([int]$proc.ProcessId)
  }

  $seen = @{}
  $result = New-Object System.Collections.ArrayList
  $queue = New-Object System.Collections.Queue
  foreach ($pidNum in $RootPids) {
    if ($pidNum -gt 0) {
      $seen[$pidNum] = $true
      $queue.Enqueue([pscustomobject]@{ ProcessId = $pidNum; Depth = 0 })
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
      [void]$result.Add([pscustomobject]@{ ProcessId = [int]$childPid; ParentProcessId = $parentPid; Depth = $nextDepth })
      $queue.Enqueue([pscustomobject]@{ ProcessId = [int]$childPid; Depth = $nextDepth })
    }
  }

  return @($result)
}

function Get-TreeChildPids {
  param([int[]]$RootPids)

  if ($RootPids.Count -le 0) { return @() }
  try {
    $snapshot = @(Get-CimInstance Win32_Process -ErrorAction Stop)
    return @(Get-ChildProcessTreeEntries -RootPids $RootPids -Processes $snapshot | Sort-Object Depth -Descending | Select-Object -ExpandProperty ProcessId)
  } catch {
    return @()
  }
}

function Stop-PidList {
  param(
    [int[]]$Pids,
    [string]$Stage
  )

  $stopped = New-Object System.Collections.ArrayList
  foreach ($pidNum in @($Pids | Where-Object { $_ -gt 0 -and $_ -ne $PID } | Select-Object -Unique)) {
    try {
      Stop-Process -Id $pidNum -Force -ErrorAction Stop
      [void]$stopped.Add($pidNum)
      Write-Host "[restart] stopped $Stage PID $pidNum"
    } catch {
      Write-Warning "Failed to stop $Stage PID ${pidNum}: $($_.Exception.Message)"
    }
  }
  return @($stopped)
}

function Record-ExpectedMainBotShutdownForRestart {
  param([int]$OwnerPid = 0)

  if ($OwnerPid -le 0) {
    return $false
  }

  $now = (Get-Date).ToUniversalTime()
  $markerReason = Get-RestartMarkerTextEnv -Name 'MIZUKI_RESTART_REASON' -DefaultValue 'manual_restart_script'
  $markerSource = Get-RestartMarkerTextEnv -Name 'MIZUKI_RESTART_SOURCE' -DefaultValue 'restart-bot.cmd'
  $marker = [pscustomobject]@{
    pid = $OwnerPid
    reason = $markerReason
    recordedAt = $now.ToString('o')
    expiresAt = $now.AddMinutes(5).ToString('o')
    source = $markerSource
    script = 'restart-bot.cmd'
    requestedBy = Get-RestartMarkerTextEnv -Name 'MIZUKI_RESTART_REQUESTED_BY'
    requestId = Get-RestartMarkerTextEnv -Name 'MIZUKI_RESTART_REQUEST_ID'
    messageId = Get-RestartMarkerTextEnv -Name 'MIZUKI_RESTART_MESSAGE_ID'
    groupId = Get-RestartMarkerTextEnv -Name 'MIZUKI_RESTART_GROUP_ID'
    command = Get-RestartMarkerTextEnv -Name 'MIZUKI_RESTART_COMMAND'
  }

  return (Write-JsonFileSafe -Path $expectedShutdownFile -Value $marker)
}

function Stop-BotForRestart {
  $actions = New-Object System.Collections.ArrayList
  $targetPids = @()
  $mainPid = 0

  foreach ($file in @($mainPidFile, $workerPidFile)) {
    $pidText = Read-FirstLine -Path $file
    $pidNum = 0
    if ([int]::TryParse($pidText, [ref]$pidNum) -and $pidNum -gt 0) {
      $targetPids += $pidNum
      if ($file -eq $mainPidFile) {
        $mainPid = $pidNum
      }
    }
  }

  $mainProcesses = @(Get-RunningMainBotProcesses)
  if ($mainProcesses.Count -gt 0) {
    foreach ($mainProcess in $mainProcesses) {
      $targetPids += [int]$mainProcess.ProcessId
    }

    $mainPidProcess = Get-Process -Id $mainPid -ErrorAction SilentlyContinue
    $mainPidCommandLine = if ($mainPidProcess) { Get-ProcessCommandLineSafe -ProcessId $mainPid } else { '' }
    $mainPidValid = ($mainPidProcess -and $mainPidProcess.ProcessName -ieq 'node' -and ($mainPidCommandLine -match 'index\.js'))
    if (-not $mainPidValid) {
      $mainPid = [int]$mainProcesses[0].ProcessId
      if (Repair-MainPidFileFromProcess -MainProcess $mainProcesses[0]) {
        [void]$actions.Add("main pid file repaired before restart: $mainPid")
      } else {
        [void]$actions.Add("main pid file repair failed before restart: $mainPid")
      }
    }
  }

  $targetPids = @($targetPids | Sort-Object -Unique)
  if ($mainPid -gt 0 -and (Test-PidIsRunningMainBot -ProcessId $mainPid)) {
    if (Record-ExpectedMainBotShutdownForRestart -OwnerPid $mainPid) {
      [void]$actions.Add("expected shutdown marker written for main pid: $mainPid")
    } else {
      [void]$actions.Add("expected shutdown marker write failed for main pid: $mainPid")
    }
  } else {
    [void]$actions.Add('expected shutdown marker skipped: live main bot pid missing')
  }
  $childPids = @(Get-TreeChildPids -RootPids $targetPids)
  $stoppedChildren = @(Stop-PidList -Pids $childPids -Stage 'child')
  $stoppedRoots = @(Stop-PidList -Pids $targetPids -Stage 'root')

  [void]$actions.Add("restart roots: $(if ($targetPids.Count) { $targetPids -join ', ' } else { '(none)' })")
  [void]$actions.Add("stopped children: $(if ($stoppedChildren.Count) { $stoppedChildren -join ', ' } else { '(none)' })")
  [void]$actions.Add("stopped roots: $(if ($stoppedRoots.Count) { $stoppedRoots -join ', ' } else { '(none)' })")

  Start-Sleep -Seconds 1
  return @($actions)
}

function Start-BotIfNeeded {
  param([Parameter(Mandatory = $true)][string]$TaskName)

  $actions = New-Object System.Collections.ArrayList
  $taskStatus = Get-ScheduledTaskStatus -TaskName $TaskName
  $started = $false

  if ($taskStatus.Exists -and $taskStatus.Enabled) {
    try {
      if (Start-DaemonScheduledTaskNow -TaskName $TaskName) {
        [void]$actions.Add('scheduled task triggered')
        $started = $true
      }
    } catch {
      [void]$actions.Add("scheduled task trigger failed: $($_.Exception.Message)")
    }
  }

  if (-not $started) {
    [void]$actions.Add('running daemon script directly')
    & $runnerPath
  }

  return @($actions)
}

function Write-DaemonReport {
  param(
    [Parameter(Mandatory = $true)][string]$TaskName,
    [string[]]$Actions = @()
  )

  $taskStatus = Get-ScheduledTaskStatus -TaskName $TaskName
  $startupStatus = Get-StartupLauncherStatus -TaskName $TaskName
  $runtimeStatus = Get-BotRuntimeStatus
  $workerRunning = ($runtimeStatus.Worker.Running -and $runtimeStatus.Worker.Match)
  $workerState = if ($workerRunning) { 'Running' } elseif ($runtimeStatus.WorkerIdleAllowed) { 'Idle' } else { 'Missing' }
  $workerDetail = "PID=$($runtimeStatus.Worker.Pid); $($runtimeStatus.Worker.Detail)"
  if ($runtimeStatus.WorkerIdleAllowed) {
    $workerDetail = "$workerDetail; queue idle"
  } elseif (-not [string]::IsNullOrWhiteSpace($runtimeStatus.WorkerStartReason)) {
    $workerDetail = "$workerDetail; expected: $($runtimeStatus.WorkerStartReason)"
  }

  Write-Host ''
  Write-Host '=== Daemon Actions ==='
  if ($Actions.Count -gt 0) {
    foreach ($action in $Actions) { Write-Host ("- " + $action) }
  } else {
    Write-Host '- none'
  }

  Write-Host ''
  Write-Host '=== Daemon Status ==='
  @(
    [pscustomobject]@{ Component = 'scheduled task'; Name = $taskStatus.Name; Exists = $taskStatus.Exists; Enabled = $taskStatus.Enabled; State = $taskStatus.State; Detail = "Last=$($taskStatus.LastRunTime); Next=$($taskStatus.NextRunTime); Result=$($taskStatus.LastTaskResult)" }
    [pscustomobject]@{ Component = 'startup fallback'; Name = $startupStatus.Name; Exists = $startupStatus.Exists; Enabled = $startupStatus.Exists; State = if ($startupStatus.Exists) { 'Installed' } else { 'Missing' }; Detail = $startupStatus.Path }
    [pscustomobject]@{ Component = 'main bot'; Name = $runtimeStatus.Main.Name; Exists = (Test-Path $mainPidFile); Enabled = ''; State = if ($runtimeStatus.Main.Running -and $runtimeStatus.Main.Match) { 'Running' } else { 'Missing' }; Detail = "PID=$($runtimeStatus.Main.Pid); $($runtimeStatus.Main.Detail)" }
    [pscustomobject]@{ Component = 'post-reply worker'; Name = $runtimeStatus.Worker.Name; Exists = (Test-Path $workerPidFile); Enabled = ''; State = $workerState; Detail = $workerDetail }
  ) | Format-Table -Wrap -AutoSize | Out-Host

  Write-Host ''
  Write-Host '=== Bot Node Processes ==='
  $processListAvailable = $true
  try {
    $allNodeProcesses = @(Get-CimInstance Win32_Process -ErrorAction Stop | Where-Object {
      $_.Name -eq 'node.exe'
    })
  } catch {
    $processListAvailable = $false
    Write-Host ("unavailable: " + $_.Exception.Message)
    $allNodeProcesses = @()
  }

  $botPidRoles = @{}
  foreach ($entry in @(
    [pscustomobject]@{ Pid = $runtimeStatus.Main.Pid; Role = 'main bot' },
    [pscustomobject]@{ Pid = $runtimeStatus.Worker.Pid; Role = 'post-reply worker' }
  )) {
    $pidNum = 0
    if ([int]::TryParse([string]$entry.Pid, [ref]$pidNum) -and $pidNum -gt 0) {
      $botPidRoles[$pidNum] = [string]$entry.Role
    }
  }

  if ($processListAvailable) {
    $botProcesses = @($allNodeProcesses | Where-Object {
      $botPidRoles.ContainsKey([int]$_.ProcessId)
    } | Select-Object @{Name = 'Role'; Expression = { $botPidRoles[[int]$_.ProcessId] } }, ProcessId, ParentProcessId, CommandLine)

    if ($botProcesses.Count -gt 0) {
      $botProcesses | Format-Table -Wrap -AutoSize | Out-Host
    } else {
      Write-Host '(none)'
    }

    Write-Host ''
    Write-Host '=== Other Related Node Processes (diagnostic only) ==='
    $repoPattern = [regex]::Escape(([string]$repoRoot).TrimEnd('\'))
    $testPattern = '(^|["''\s])scripts[\\/]run-tests\.js(["''\s]|$)|[\\/]tests[\\/][^"''\s]+\.test\.js(["''\s]|$)|(^|["''\s])tests[\\/][^"''\s]+\.test\.js(["''\s]|$)'
    $otherProcesses = @($allNodeProcesses | Where-Object {
      $commandLine = [string]$_.CommandLine
      (-not $botPidRoles.ContainsKey([int]$_.ProcessId)) -and (
        ($commandLine -match $repoPattern) -or
        ($commandLine -match $testPattern) -or
        (Test-ProcessLooksLikeMainBot -Process $_) -or
        ($commandLine -match '(^|["''\s])scripts[\\/]post-reply-worker\.js(["''\s]|$)')
      )
    } | Select-Object ProcessId, ParentProcessId, CommandLine)

    if ($otherProcesses.Count -gt 0) {
      $otherProcesses | Format-Table -Wrap -AutoSize | Out-Host
    } else {
      Write-Host '(none)'
    }
  }

  return $runtimeStatus.Healthy
}

$actions = New-Object System.Collections.ArrayList

if ($StatusOnly) {
  [void]$actions.Add('status only; start skipped (restart requires "restart confirm")')
  $null = Write-DaemonReport -TaskName $TaskName -Actions @($actions)
  exit 0
}

foreach ($action in Ensure-DaemonConfigured -TaskName $TaskName) {
  [void]$actions.Add($action)
}

if ($Restart) {
  [void]$actions.Add('restart requested')
  if (-not (Test-RestartConfirmed)) {
    [void]$actions.Add('restart skipped: explicit confirmation required (run "restart-bot.cmd restart confirm" or set MIZUKI_RESTART_CONFIRM=1)')
    $null = Write-DaemonReport -TaskName $TaskName -Actions @($actions)
    exit 0
  } else {
    [void]$actions.Add('restart confirmation accepted')
    foreach ($action in Stop-BotForRestart) {
      [void]$actions.Add($action)
    }
    foreach ($action in Start-BotIfNeeded -TaskName $TaskName) {
      [void]$actions.Add($action)
    }
    Start-Sleep -Seconds 4
  }
} else {
  $runtimeBefore = Get-BotRuntimeStatus
  if ($runtimeBefore.Healthy) {
    if ($runtimeBefore.WorkerIdleAllowed) {
      [void]$actions.Add('bot running; post-reply worker idle')
    } else {
      [void]$actions.Add('bot and worker already running')
    }
  } else {
    [void]$actions.Add("runtime incomplete: main=$($runtimeBefore.Main.Detail); worker=$($runtimeBefore.Worker.Detail)")
    foreach ($action in Start-BotIfNeeded -TaskName $TaskName) {
      [void]$actions.Add($action)
    }
    Start-Sleep -Seconds 4
  }
}

$healthy = Write-DaemonReport -TaskName $TaskName -Actions @($actions)
if (-not $healthy) {
  throw 'bot/worker not healthy after start attempt'
}

exit 0
