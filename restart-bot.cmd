@echo off
setlocal
cd /d "%~dp0"
set "MIZUKI_RESTART_BOT_ROOT=%~dp0"
set "MIZUKI_RESTART_DEFAULT="
if "%~1"=="" set "MIZUKI_RESTART_DEFAULT=1"

powershell -NoProfile -ExecutionPolicy Bypass -Command "$script = Get-Content -LiteralPath '%~f0' -Raw; $marker = '# POWERSHELL_PAYLOAD'; $idx = $script.LastIndexOf($marker); if ($idx -lt 0) { throw 'Missing PowerShell payload.' }; $payload = $script.Substring($idx + $marker.Length).TrimStart(); $block = [scriptblock]::Create($payload); & $block @args" %*
set "RESTART_EXIT=%ERRORLEVEL%"
if not "%RESTART_EXIT%"=="0" exit /b %RESTART_EXIT%

set "SKIP_LOG_WINDOW="
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
  [switch]$Restart,
  [switch]$StatusOnly,
  [switch]$SkipInstall
)

$ErrorActionPreference = 'Stop'
if (Get-Variable -Name PSNativeCommandUseErrorActionPreference -ErrorAction SilentlyContinue) {
  $PSNativeCommandUseErrorActionPreference = $false
}

if ($env:MIZUKI_RESTART_DEFAULT -eq '1') {
  $Restart = $true
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

function Get-ProcessCommandLineSafe {
  param([Parameter(Mandatory = $true)][int]$ProcessId)

  try {
    $proc = Get-CimInstance Win32_Process -Filter "ProcessId = $ProcessId" -ErrorAction Stop
    return [string]$proc.CommandLine
  } catch {
    return ''
  }
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
    return [pscustomobject]@{ Name = $Name; PidFile = $PidFile; Pid = ''; Running = $false; Match = $false; Process = ''; Detail = 'pid file missing' }
  }
  if (-not $pidValid -or $pidNum -le 0) {
    return [pscustomobject]@{ Name = $Name; PidFile = $PidFile; Pid = $pidText; Running = $false; Match = $false; Process = ''; Detail = 'pid file invalid' }
  }

  $process = Get-Process -Id $pidNum -ErrorAction SilentlyContinue
  if ($null -eq $process) {
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
  return [pscustomobject]@{ Name = $Name; PidFile = $PidFile; Pid = $pidNum; Running = $true; Match = $matches; Process = $processName; Detail = $detail }
}

function Get-BotRuntimeStatus {
  $main = Get-PidFileProcessStatus -Name 'main bot' -PidFile $mainPidFile -ExpectedCommandPattern 'index\.js'
  $worker = Get-PidFileProcessStatus -Name 'post-reply worker' -PidFile $workerPidFile -ExpectedCommandPattern 'post-reply-worker\.js'
  return [pscustomobject]@{
    Main = $main
    Worker = $worker
    Healthy = ($main.Running -and $main.Match -and $worker.Running -and $worker.Match)
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

function Stop-BotForRestart {
  $actions = New-Object System.Collections.ArrayList
  $targetPids = @()

  foreach ($file in @($mainPidFile, $workerPidFile)) {
    $pidText = Read-FirstLine -Path $file
    $pidNum = 0
    if ([int]::TryParse($pidText, [ref]$pidNum) -and $pidNum -gt 0) {
      $targetPids += $pidNum
    }
  }

  $targetPids = @($targetPids | Sort-Object -Unique)
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
    [pscustomobject]@{ Component = 'post-reply worker'; Name = $runtimeStatus.Worker.Name; Exists = (Test-Path $workerPidFile); Enabled = ''; State = if ($runtimeStatus.Worker.Running -and $runtimeStatus.Worker.Match) { 'Running' } else { 'Missing' }; Detail = "PID=$($runtimeStatus.Worker.Pid); $($runtimeStatus.Worker.Detail)" }
  ) | Format-Table -Wrap -AutoSize | Out-Host

  Write-Host ''
  Write-Host '=== Matching Node Processes ==='
  $repoPattern = [regex]::Escape([string]$repoRoot)
  $processListAvailable = $true
  try {
    $processes = @(Get-CimInstance Win32_Process -ErrorAction Stop | Where-Object {
      $_.Name -eq 'node.exe' -and ($_.CommandLine -match "$repoPattern|index\.js|post-reply-worker\.js")
    } | Select-Object ProcessId, ParentProcessId, CommandLine)
  } catch {
    $processListAvailable = $false
    Write-Host ("unavailable: " + $_.Exception.Message)
    $processes = @()
  }

  if ($processes.Count -gt 0) {
    $processes | Format-Table -Wrap -AutoSize | Out-Host
  } elseif ($processListAvailable) {
    Write-Host '(none)'
  }

  return $runtimeStatus.Healthy
}

$actions = New-Object System.Collections.ArrayList

if ($StatusOnly) {
  [void]$actions.Add('status only; start skipped')
  $null = Write-DaemonReport -TaskName $TaskName -Actions @($actions)
  exit 0
}

foreach ($action in Ensure-DaemonConfigured -TaskName $TaskName) {
  [void]$actions.Add($action)
}

if ($Restart) {
  [void]$actions.Add('restart requested')
  foreach ($action in Stop-BotForRestart) {
    [void]$actions.Add($action)
  }
  foreach ($action in Start-BotIfNeeded -TaskName $TaskName) {
    [void]$actions.Add($action)
  }
  Start-Sleep -Seconds 4
} else {
  $runtimeBefore = Get-BotRuntimeStatus
  if ($runtimeBefore.Healthy) {
    [void]$actions.Add('bot and worker already running')
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
