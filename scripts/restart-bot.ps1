$ErrorActionPreference = 'Stop'
if (Get-Variable -Name PSNativeCommandUseErrorActionPreference -ErrorAction SilentlyContinue) {
  $PSNativeCommandUseErrorActionPreference = $false
}

$commandArgs = @($args)
$repoRoot = Resolve-Path (Join-Path $PSScriptRoot '..')
$scriptRoot = Join-Path $repoRoot 'scripts'
$commonPath = Join-Path $scriptRoot 'windows-daemon-common.ps1'
$runnerPath = Join-Path $scriptRoot 'run-bot-daemon.ps1'
$mainPidFile = Join-Path $repoRoot '.mizukibot.lock'
$workerPidFile = Join-Path $repoRoot '.mizukibot-postreply-worker.pid'
$dataDir = Join-Path $repoRoot 'data'
$expectedShutdownFile = Join-Path $dataDir 'bot-main-expected-shutdown.json'
$restartLogFile = Join-Path $dataDir 'restart-bot.log'
$restartResultFile = Join-Path $dataDir 'restart-bot-result.json'
$mainStdoutLogFile = Join-Path $dataDir 'bot-runtime.out.log'
$mainStderrLogFile = Join-Path $dataDir 'bot-runtime.err.log'
$workerStdoutLogFile = Join-Path $dataDir 'post-reply-worker.out.log'
$workerStderrLogFile = Join-Path $dataDir 'post-reply-worker.err.log'
$taskName = 'MizukiBotDaemon'

foreach ($requiredPath in @($commonPath, $runnerPath)) {
  if (-not (Test-Path -LiteralPath $requiredPath)) {
    throw "Missing daemon script: $requiredPath"
  }
}

. $commonPath

function Write-RestartLog {
  param([Parameter(Mandatory = $true)][string]$Message)

  try {
    if (-not (Test-Path -LiteralPath $dataDir)) {
      New-Item -ItemType Directory -Path $dataDir -Force | Out-Null
    }
    $stamp = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
    [System.IO.File]::AppendAllText($restartLogFile, "[$stamp] $Message`r`n", [System.Text.Encoding]::UTF8)
  } catch {
    # Restart logging must never block the restart path.
  }
}

function Exit-RestartScript {
  param([int]$Code = 0)

  Write-RestartLog -Message "exit code=$Code"
  [Environment]::Exit($Code)
}

function Import-DotEnv {
  param([Parameter(Mandatory = $true)][string]$FilePath)

  if (-not (Test-Path -LiteralPath $FilePath)) { return 0 }

  $loadedCount = 0
  foreach ($rawLine in Get-Content -LiteralPath $FilePath -Encoding utf8) {
    $line = ([string]$rawLine).Trim().TrimStart([char]0xFEFF)
    if (-not $line -or $line.StartsWith('#')) { continue }
    if ($line.StartsWith('export ')) { $line = $line.Substring(7).Trim() }

    $eq = $line.IndexOf('=')
    if ($eq -lt 1) { continue }

    $key = $line.Substring(0, $eq).Trim()
    if (-not $key) { continue }

    $value = $line.Substring($eq + 1).Trim()
    if ((($value.StartsWith('"')) -and ($value.EndsWith('"'))) -or (($value.StartsWith("'")) -and ($value.EndsWith("'")))) {
      $value = $value.Substring(1, $value.Length - 2)
    }

    [Environment]::SetEnvironmentVariable($key, $value, 'Process')
    $loadedCount += 1
  }

  return $loadedCount
}

function Read-FirstLine {
  param([Parameter(Mandatory = $true)][string]$Path)

  if (-not (Test-Path -LiteralPath $Path)) { return '' }
  try {
    $line = Get-Content -LiteralPath $Path -TotalCount 1 -Encoding utf8 -ErrorAction Stop
    if ($null -eq $line) { return '' }
    return ([string]$line).Trim()
  } catch {
    return ''
  }
}

function Read-JsonFileSafe {
  param([Parameter(Mandatory = $true)][string]$Path)

  try {
    if (-not (Test-Path -LiteralPath $Path)) { return $null }
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
    if ($dir -and -not (Test-Path -LiteralPath $dir)) {
      New-Item -ItemType Directory -Path $dir -Force | Out-Null
    }
    $json = $Value | ConvertTo-Json -Depth 8
    [System.IO.File]::WriteAllText($Path, $json + "`r`n", [System.Text.Encoding]::UTF8)
    return $true
  } catch {
    return $false
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

function Get-BoolEnv {
  param(
    [Parameter(Mandatory = $true)][string]$Name,
    [Parameter(Mandatory = $true)][bool]$DefaultValue
  )

  $raw = [Environment]::GetEnvironmentVariable($Name, 'Process')
  if ([string]::IsNullOrWhiteSpace($raw)) { return $DefaultValue }

  switch ($raw.Trim().ToLowerInvariant()) {
    { $_ -in @('1', 'true', 'yes', 'y', 'on') } { return $true }
    { $_ -in @('0', 'false', 'no', 'n', 'off') } { return $false }
    default { return $DefaultValue }
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

function Resolve-NodeExecutable {
  $cmd = Get-Command node -ErrorAction SilentlyContinue
  if ($cmd -and $cmd.Source) { return $cmd.Source }

  $candidates = @(
    (Join-Path $env:ProgramFiles 'nodejs\node.exe'),
    (Join-Path ${env:ProgramFiles(x86)} 'nodejs\node.exe')
  ) | Where-Object { $_ -and (Test-Path -LiteralPath $_) }

  if ($candidates.Count -gt 0) { return $candidates[0] }
  return $null
}

function Get-RestartFallbackLogPath {
  param([Parameter(Mandatory = $true)][string]$Path)

  $directory = Split-Path -Parent $Path
  $leaf = Split-Path -Leaf $Path
  $extension = [System.IO.Path]::GetExtension($leaf)
  $baseName = [System.IO.Path]::GetFileNameWithoutExtension($leaf)
  $stamp = Get-Date -Format 'yyyyMMdd-HHmmss-fff'
  return Join-Path $directory "$baseName.$stamp$extension"
}

function New-EmptyRestartLogFile {
  param([Parameter(Mandatory = $true)][string]$Path)

  $stream = $null
  try {
    $stream = [System.IO.File]::Open($Path, [System.IO.FileMode]::Create, [System.IO.FileAccess]::Write, [System.IO.FileShare]::Read)
    return $true
  } catch {
    return $false
  } finally {
    if ($null -ne $stream) { $stream.Close() }
  }
}

function Resolve-RestartWritableLogPath {
  param([Parameter(Mandatory = $true)][string]$Path)

  if (Test-Path -LiteralPath $Path) {
    try {
      $current = Get-Item -LiteralPath $Path -ErrorAction Stop
      if ($current.Length -gt 0) {
        $archivePath = Get-RestartFallbackLogPath -Path $Path
        Copy-Item -LiteralPath $Path -Destination $archivePath -Force
        Write-RestartLog -Message "archived runtime redirect log before restart. source=$Path archive=$archivePath"
      }
    } catch {
      Write-RestartLog -Message "runtime redirect log archive failed. path=$Path error=$($_.Exception.Message)"
    }
  }

  if (New-EmptyRestartLogFile -Path $Path) { return $Path }

  $fallbackPath = Get-RestartFallbackLogPath -Path $Path
  if (-not (New-EmptyRestartLogFile -Path $fallbackPath)) {
    throw "unable to open restart log for write: requested=$Path fallback=$fallbackPath"
  }
  Write-RestartLog -Message "log file locked, using fallback log. requested=$Path fallback=$fallbackPath"
  return $fallbackPath
}

function ConvertTo-CmdQuotedArgument {
  param([Parameter(Mandatory = $true)][string]$Value)

  return '"' + ($Value -replace '"', '\"') + '"'
}

function Start-NodeRestartProcess {
  param(
    [Parameter(Mandatory = $true)][string]$NodeExe,
    [Parameter(Mandatory = $true)][string[]]$ArgumentList,
    [Parameter(Mandatory = $true)][string]$StdoutLog,
    [Parameter(Mandatory = $true)][string]$StderrLog
  )

  $resolvedStdoutLog = Resolve-RestartWritableLogPath -Path $StdoutLog
  $resolvedStderrLog = Resolve-RestartWritableLogPath -Path $StderrLog

  $commandParts = @((ConvertTo-CmdQuotedArgument -Value $NodeExe))
  foreach ($argument in $ArgumentList) {
    $commandParts += (ConvertTo-CmdQuotedArgument -Value $argument)
  }
  $innerCommand = ($commandParts -join ' ') + ' 1>>' + (ConvertTo-CmdQuotedArgument -Value $resolvedStdoutLog) + ' 2>>' + (ConvertTo-CmdQuotedArgument -Value $resolvedStderrLog)
  $commandLine = 'cmd.exe /d /s /c "' + $innerCommand + '"'
  $startup = ([wmiclass]'Win32_ProcessStartup').CreateInstance()
  $startup.ShowWindow = 0
  $result = ([wmiclass]'Win32_Process').Create($commandLine, [string]$repoRoot, $startup)
  if ([int]$result.ReturnValue -ne 0) {
    throw "failed to start node process through WMI. code=$($result.ReturnValue)"
  }

  return [int]$result.ProcessId
}

function Test-RestartConfirmed {
  param([string[]]$CliArgs = @())

  foreach ($arg in $CliArgs) {
    $normalizedArg = ([string]$arg).Trim().ToLowerInvariant()
    switch ($normalizedArg) {
      { $_ -in @('confirm', 'confirmed', '--confirm', '/confirm') } { return $true }
    }
  }

  $raw = Get-RestartMarkerTextEnv -Name 'MIZUKI_RESTART_CONFIRM'
  switch ($raw.ToLowerInvariant()) {
    { $_ -in @('1', 'true', 'yes', 'y', 'on', 'confirm', 'confirmed') } { return $true }
  }

  return $false
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
  if ([string]::IsNullOrWhiteSpace($commandLine)) { return $false }

  $normalizedRoot = ([string]$repoRoot).TrimEnd('\')
  $repoIndexPattern = [regex]::Escape($normalizedRoot) + '[\\/]index\.js(["''\s]|$)'
  $bareIndexArg = $commandLine -match '(^|["''\s])index\.js(["''\s]|$)'
  $repoIndexArg = $commandLine -match $repoIndexPattern
  return ($bareIndexArg -or $repoIndexArg)
}

function Test-ProcessLooksLikePostReplyWorker {
  param([Parameter(Mandatory = $true)]$Process)

  $commandLine = [string]$Process.CommandLine
  if ([string]::IsNullOrWhiteSpace($commandLine)) { return $false }

  $normalizedRoot = ([string]$repoRoot).TrimEnd('\')
  return ($commandLine -match 'post-reply-worker\.js') -and (
    $commandLine -like "*$normalizedRoot*" -or
    $commandLine -match '(^|[\\/\s])scripts[\\/]post-reply-worker\.js(["''\s]|$)' -or
    $commandLine -match '(^|[\\/\s])post-reply-worker\.js(["''\s]|$)'
  )
}

function Get-NodeProcessSnapshot {
  try {
    return @(Get-CimInstance Win32_Process -ErrorAction Stop | Where-Object { $_.Name -eq 'node.exe' })
  } catch {
    return @()
  }
}

function Get-RunningMainBotProcesses {
  param([object[]]$Processes = @())

  if ($null -eq $Processes -or $Processes.Count -le 0) {
    $Processes = Get-NodeProcessSnapshot
  }

  return @($Processes | Where-Object { Test-ProcessLooksLikeMainBot -Process $_ } | Sort-Object ProcessId)
}

function Get-RunningPostReplyWorkerProcesses {
  param([object[]]$Processes = @())

  if ($null -eq $Processes -or $Processes.Count -le 0) {
    $Processes = Get-NodeProcessSnapshot
  }

  return @($Processes | Where-Object { Test-ProcessLooksLikePostReplyWorker -Process $_ } | Sort-Object ProcessId)
}

function Repair-MainPidFileFromProcess {
  param([Parameter(Mandatory = $true)]$MainProcess)

  $pidNum = [int]$MainProcess.ProcessId
  if ($pidNum -le 0) { return $false }

  try {
    Set-Content -LiteralPath $mainPidFile -Value $pidNum -Encoding utf8
    return $true
  } catch {
    return $false
  }
}

function Repair-WorkerPidFileFromProcess {
  param([Parameter(Mandatory = $true)]$WorkerProcess)

  $pidNum = [int]$WorkerProcess.ProcessId
  if ($pidNum -le 0) { return $false }

  try {
    Set-Content -LiteralPath $workerPidFile -Value $pidNum -Encoding utf8
    return $true
  } catch {
    return $false
  }
}

function Test-PidIsRunningMainBot {
  param([Parameter(Mandatory = $true)][int]$ProcessId)

  if ($ProcessId -le 0) { return $false }

  $process = Get-Process -Id $ProcessId -ErrorAction SilentlyContinue
  if ($null -eq $process -or $process.ProcessName -ine 'node') { return $false }

  $commandLine = Get-ProcessCommandLineSafe -ProcessId $ProcessId
  if ([string]::IsNullOrWhiteSpace($commandLine)) { return $true }

  return ($commandLine -match '(^|["''\s])index\.js(["''\s]|$)')
}

function Test-PidIsRunningPostReplyWorker {
  param([Parameter(Mandatory = $true)][int]$ProcessId)

  if ($ProcessId -le 0) { return $false }

  $process = Get-Process -Id $ProcessId -ErrorAction SilentlyContinue
  if ($null -eq $process -or $process.ProcessName -ine 'node') { return $false }

  $commandLine = Get-ProcessCommandLineSafe -ProcessId $ProcessId
  if ([string]::IsNullOrWhiteSpace($commandLine)) { return $true }

  return ($commandLine -match 'post-reply-worker\.js')
}

function Get-MainBotStatusFromProcessScan {
  param(
    [Parameter(Mandatory = $true)][string]$Name,
    [object[]]$Processes = @()
  )

  $mainProcesses = @(Get-RunningMainBotProcesses -Processes $Processes)
  if ($mainProcesses.Count -le 0) { return $null }

  $mainProcess = $mainProcesses[0]
  $pidNum = [int]$mainProcess.ProcessId
  $repaired = Repair-MainPidFileFromProcess -MainProcess $mainProcess
  $detail = if ($repaired) { 'ok; pid file repaired from process scan' } else { 'ok; pid file repair failed' }
  if ($mainProcesses.Count -gt 1) {
    $detail = "$detail; duplicate main processes=$($mainProcesses.Count)"
  }

  return [pscustomobject]@{ Name = $Name; PidFile = $mainPidFile; Pid = $pidNum; Running = $true; Match = $true; Process = 'node'; Detail = $detail }
}

function Get-WorkerStatusFromProcessScan {
  param(
    [Parameter(Mandatory = $true)][string]$Name,
    [object[]]$Processes = @()
  )

  $workerProcesses = @(Get-RunningPostReplyWorkerProcesses -Processes $Processes)
  if ($workerProcesses.Count -le 0) { return $null }

  $workerProcess = $workerProcesses[0]
  $pidNum = [int]$workerProcess.ProcessId
  $repaired = Repair-WorkerPidFileFromProcess -WorkerProcess $workerProcess
  $detail = if ($repaired) { 'ok; pid file repaired from process scan' } else { 'ok; pid file repair failed' }
  if ($workerProcesses.Count -gt 1) {
    $detail = "$detail; duplicate worker processes=$($workerProcesses.Count)"
  }

  return [pscustomobject]@{ Name = $Name; PidFile = $workerPidFile; Pid = $pidNum; Running = $true; Match = $true; Process = 'node'; Detail = $detail }
}

function Get-ProcessStatusFromProcessScan {
  param(
    [Parameter(Mandatory = $true)][string]$Name,
    [Parameter(Mandatory = $true)][string]$ExpectedCommandPattern,
    [object[]]$Processes = @()
  )

  switch ($ExpectedCommandPattern) {
    'index\.js' { return Get-MainBotStatusFromProcessScan -Name $Name -Processes $Processes }
    'post-reply-worker\.js' { return Get-WorkerStatusFromProcessScan -Name $Name -Processes $Processes }
    default { return $null }
  }
}

function Get-PidFileProcessStatus {
  param(
    [Parameter(Mandatory = $true)][string]$Name,
    [Parameter(Mandatory = $true)][string]$PidFile,
    [Parameter(Mandatory = $true)][string]$ExpectedCommandPattern,
    [object[]]$Processes = @()
  )

  $pidText = Read-FirstLine -Path $PidFile
  $exists = Test-Path -LiteralPath $PidFile
  $pidNum = 0
  $pidValid = [int]::TryParse($pidText, [ref]$pidNum)

  if (-not $exists) {
    $scanned = Get-ProcessStatusFromProcessScan -Name $Name -ExpectedCommandPattern $ExpectedCommandPattern -Processes $Processes
    if ($null -ne $scanned) { return $scanned }
    return [pscustomobject]@{ Name = $Name; PidFile = $PidFile; Pid = ''; Running = $false; Match = $false; Process = ''; Detail = 'pid file missing' }
  }

  if (-not $pidValid -or $pidNum -le 0) {
    $scanned = Get-ProcessStatusFromProcessScan -Name $Name -ExpectedCommandPattern $ExpectedCommandPattern -Processes $Processes
    if ($null -ne $scanned) { return $scanned }
    return [pscustomobject]@{ Name = $Name; PidFile = $PidFile; Pid = $pidText; Running = $false; Match = $false; Process = ''; Detail = 'pid file invalid' }
  }

  $process = Get-Process -Id $pidNum -ErrorAction SilentlyContinue
  if ($null -eq $process) {
    $scanned = Get-ProcessStatusFromProcessScan -Name $Name -ExpectedCommandPattern $ExpectedCommandPattern -Processes $Processes
    if ($null -ne $scanned) { return $scanned }
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
  if (-not $matches) {
    $scanned = Get-ProcessStatusFromProcessScan -Name $Name -ExpectedCommandPattern $ExpectedCommandPattern -Processes $Processes
    if ($null -ne $scanned) { return $scanned }
  }

  return [pscustomobject]@{ Name = $Name; PidFile = $PidFile; Pid = $pidNum; Running = $true; Match = $matches; Process = $processName; Detail = $detail }
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

function Test-ExternalPostReplyWorkerEnabled {
  return ((Get-BoolEnv -Name 'POST_REPLY_WORKER_ENABLED' -DefaultValue $false) -and (-not (Get-BoolEnv -Name 'POST_REPLY_WORKER_INLINE' -DefaultValue $false)))
}

function Test-PostReplyWorkerIdleRecycleEnabled {
  return (Get-BoolEnv -Name 'POST_REPLY_WORKER_IDLE_RECYCLE_ENABLED' -DefaultValue $false)
}

function Test-ExternalPostReplyWorkerResidentExpected {
  return ((Test-ExternalPostReplyWorkerEnabled) -and (-not (Test-PostReplyWorkerIdleRecycleEnabled)))
}

function Get-PostReplyQueueStartReason {
  $queueRoot = [Environment]::GetEnvironmentVariable('POST_REPLY_QUEUE_DIR', 'Process')
  if ([string]::IsNullOrWhiteSpace($queueRoot)) {
    $queueRoot = Join-Path $dataDir 'post_reply_jobs'
  }
  if (-not [System.IO.Path]::IsPathRooted($queueRoot)) {
    $queueRoot = Join-Path $repoRoot $queueRoot
  }

  if (Test-ExternalPostReplyWorkerResidentExpected) {
    return 'external worker expected resident'
  }

  $now = Get-Date
  $staleProcessingMs = Get-PositiveInt64Env -Name 'POST_REPLY_WORKER_STALE_PROCESSING_MS' -DefaultValue 300000
  $queuedDir = Join-Path $queueRoot 'queued'
  $processingDir = Join-Path $queueRoot 'processing'

  $firstPendingQueuedJob = ''
  if (Test-Path -LiteralPath $queuedDir) {
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

  if (Test-Path -LiteralPath $processingDir) {
    foreach ($file in @(Get-ChildItem -LiteralPath $processingDir -Filter '*.json' -File -ErrorAction SilentlyContinue)) {
      $job = Read-JsonFileSafe -Path $file.FullName
      if ($null -ne $job -and (Test-PostReplyProcessingRecoverable -Job $job -Now $now -StaleProcessingMs $staleProcessingMs)) {
        return "processing job recoverable: $($file.Name)"
      }
    }
  }

  return ''
}

function Get-BotRuntimeStatus {
  $processes = Get-NodeProcessSnapshot
  $main = Get-PidFileProcessStatus -Name 'main bot' -PidFile $mainPidFile -ExpectedCommandPattern 'index\.js' -Processes $processes
  $worker = Get-PidFileProcessStatus -Name 'post-reply worker' -PidFile $workerPidFile -ExpectedCommandPattern 'post-reply-worker\.js' -Processes $processes
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
    return [pscustomobject]@{ Name = $TaskName; Exists = $false; Enabled = $false; State = 'Missing'; LastRunTime = ''; NextRunTime = ''; LastTaskResult = '' }
  }

  return [pscustomobject]@{
    Name = $TaskName
    Exists = $true
    Enabled = [bool]$task.Enabled
    State = Convert-DaemonTaskState -State ([int]$task.State)
    LastRunTime = $task.LastRunTime
    NextRunTime = $task.NextRunTime
    LastTaskResult = $task.LastTaskResult
  }
}

function Get-StartupLauncherStatus {
  param([Parameter(Mandatory = $true)][string]$TaskName)

  $path = Get-DaemonStartupLauncherPath -TaskName $TaskName -ScriptRoot $scriptRoot
  return [pscustomobject]@{ Name = 'startup launcher'; Exists = (Test-Path -LiteralPath $path); Path = $path }
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

function Test-ProcessLooksLikeRestartLauncher {
  param(
    [Parameter(Mandatory = $true)]$Process,
    [Parameter(Mandatory = $true)][string]$ChildCommandPattern
  )

  $commandLine = [string]$Process.CommandLine
  if ([string]::IsNullOrWhiteSpace($commandLine)) { return $false }
  if ([string]$Process.Name -ine 'cmd.exe') { return $false }
  if ($commandLine -notmatch $ChildCommandPattern) { return $false }

  $normalizedRoot = ([string]$repoRoot).TrimEnd('\')
  return ($commandLine -like "*$normalizedRoot*")
}

function Get-RestartLauncherPids {
  param(
    [object[]]$Processes = @(),
    [object[]]$MainProcesses = @(),
    [object[]]$WorkerProcesses = @()
  )

  $processByPid = @{}
  foreach ($process in $Processes) {
    $processByPid[[int]$process.ProcessId] = $process
  }

  $launcherPids = New-Object System.Collections.ArrayList
  foreach ($entry in @($MainProcesses)) {
    $parentPid = [int]$entry.ParentProcessId
    if ($processByPid.ContainsKey($parentPid) -and (Test-ProcessLooksLikeRestartLauncher -Process $processByPid[$parentPid] -ChildCommandPattern '(^|["''\s])index\.js(["''\s]|$)')) {
      [void]$launcherPids.Add($parentPid)
    }
  }
  foreach ($entry in @($WorkerProcesses)) {
    $parentPid = [int]$entry.ParentProcessId
    if ($processByPid.ContainsKey($parentPid) -and (Test-ProcessLooksLikeRestartLauncher -Process $processByPid[$parentPid] -ChildCommandPattern 'post-reply-worker\.js')) {
      [void]$launcherPids.Add($parentPid)
    }
  }

  return @($launcherPids | Where-Object { $_ -gt 0 } | Sort-Object -Unique)
}

function Get-CurrentProcessAncestorPids {
  try {
    $processes = @{}
    Get-CimInstance Win32_Process -ErrorAction Stop | ForEach-Object {
      $processes[[int]$_.ProcessId] = $_
    }

    $ancestors = New-Object System.Collections.ArrayList
    $currentPid = [int]$PID
    while ($processes.ContainsKey($currentPid)) {
      $parentPid = [int]$processes[$currentPid].ParentProcessId
      if ($parentPid -le 0 -or $ancestors.Contains($parentPid)) { break }
      [void]$ancestors.Add($parentPid)
      $currentPid = $parentPid
    }
    return @($ancestors)
  } catch {
    return @()
  }
}

function Stop-PidList {
  param(
    [int[]]$Pids,
    [string]$Stage,
    [int[]]$ProtectedPids = @()
  )

  $stopped = New-Object System.Collections.ArrayList
  $protected = @{}
  foreach ($protectedPid in @($ProtectedPids + @([int]$PID) | Where-Object { $_ -gt 0 } | Select-Object -Unique)) {
    $protected[[int]$protectedPid] = $true
  }

  foreach ($pidNum in @($Pids | Where-Object { $_ -gt 0 -and (-not $protected.ContainsKey([int]$_)) } | Select-Object -Unique)) {
    try {
      $process = Get-Process -Id $pidNum -ErrorAction SilentlyContinue
      if ($null -eq $process) {
        Write-Host "[restart] $Stage PID $pidNum already stopped"
        continue
      }
      Stop-Process -Id $pidNum -Force -ErrorAction Stop
      [void]$stopped.Add($pidNum)
      Write-Host "[restart] stopped $Stage PID $pidNum"
    } catch {
      $errorMessage = $_.Exception.Message
      $errorId = [string]$_.FullyQualifiedErrorId
      if ($errorId -match 'NoProcessFound' -or $errorMessage -match 'Cannot find a process') {
        Write-Host "[restart] $Stage PID $pidNum already stopped"
      } else {
        Write-Warning "Failed to stop $Stage PID ${pidNum}: $errorMessage"
      }
    }
  }
  return @($stopped)
}

function Wait-PidsGone {
  param(
    [int[]]$Pids,
    [int]$TimeoutSeconds = 10
  )

  $stopwatch = [System.Diagnostics.Stopwatch]::StartNew()
  while ($stopwatch.Elapsed.TotalSeconds -lt $TimeoutSeconds) {
    $live = @($Pids | Where-Object { $_ -gt 0 -and (Get-Process -Id $_ -ErrorAction SilentlyContinue) })
    if ($live.Count -le 0) { return $true }
    Start-Sleep -Milliseconds 250
  }

  return $false
}

function Record-ExpectedMainBotShutdownForRestart {
  param([int]$OwnerPid = 0)

  if ($OwnerPid -le 0) { return $false }

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

function Write-RestartResult {
  param(
    [Parameter(Mandatory = $true)][string]$Status,
    [bool]$Healthy = $false,
    [string]$Message = '',
    [string[]]$Actions = @()
  )

  $runtimeStatus = Get-BotRuntimeStatus
  $now = (Get-Date).ToUniversalTime()
  $result = [pscustomobject]@{
    schemaVersion = 'restart_bot_result_v1'
    status = $Status
    healthy = $Healthy
    recordedAt = $now.ToString('o')
    source = Get-RestartMarkerTextEnv -Name 'MIZUKI_RESTART_SOURCE' -DefaultValue 'restart-bot.cmd'
    reason = Get-RestartMarkerTextEnv -Name 'MIZUKI_RESTART_REASON' -DefaultValue 'manual_restart_script'
    requestedBy = Get-RestartMarkerTextEnv -Name 'MIZUKI_RESTART_REQUESTED_BY'
    requestId = Get-RestartMarkerTextEnv -Name 'MIZUKI_RESTART_REQUEST_ID'
    messageId = Get-RestartMarkerTextEnv -Name 'MIZUKI_RESTART_MESSAGE_ID'
    groupId = Get-RestartMarkerTextEnv -Name 'MIZUKI_RESTART_GROUP_ID'
    command = Get-RestartMarkerTextEnv -Name 'MIZUKI_RESTART_COMMAND'
    mainPid = $runtimeStatus.Main.Pid
    mainDetail = $runtimeStatus.Main.Detail
    workerPid = $runtimeStatus.Worker.Pid
    workerDetail = $runtimeStatus.Worker.Detail
    message = $Message
    actions = @($Actions)
  }

  return (Write-JsonFileSafe -Path $restartResultFile -Value $result)
}

function Stop-BotForRestart {
  $actions = New-Object System.Collections.ArrayList
  $targetPids = @()
  $mainPid = 0
  try {
    $allProcesses = @(Get-CimInstance Win32_Process -ErrorAction Stop)
  } catch {
    $allProcesses = @()
    [void]$actions.Add("process snapshot unavailable before restart: $($_.Exception.Message)")
  }
  $processes = @($allProcesses | Where-Object { $_.Name -eq 'node.exe' })

  $mainPidText = Read-FirstLine -Path $mainPidFile
  $mainPidFromFile = 0
  if ([int]::TryParse($mainPidText, [ref]$mainPidFromFile) -and $mainPidFromFile -gt 0) {
    if (Test-PidIsRunningMainBot -ProcessId $mainPidFromFile) {
      $targetPids += $mainPidFromFile
      $mainPid = $mainPidFromFile
    } else {
      [void]$actions.Add("main pid file ignored before restart: $mainPidFromFile is not a live main bot")
    }
  }

  $workerPidText = Read-FirstLine -Path $workerPidFile
  $workerPidFromFile = 0
  if ([int]::TryParse($workerPidText, [ref]$workerPidFromFile) -and $workerPidFromFile -gt 0) {
    if (Test-PidIsRunningPostReplyWorker -ProcessId $workerPidFromFile) {
      $targetPids += $workerPidFromFile
    } else {
      [void]$actions.Add("worker pid file ignored before restart: $workerPidFromFile is not a live post-reply worker")
    }
  }

  $mainProcesses = @(Get-RunningMainBotProcesses -Processes $processes)
  if ($mainProcesses.Count -gt 0) {
    foreach ($mainProcess in $mainProcesses) {
      $targetPids += [int]$mainProcess.ProcessId
    }

    if (-not (Test-PidIsRunningMainBot -ProcessId $mainPid)) {
      $mainPid = [int]$mainProcesses[0].ProcessId
      if (Repair-MainPidFileFromProcess -MainProcess $mainProcesses[0]) {
        [void]$actions.Add("main pid file repaired before restart: $mainPid")
      } else {
        [void]$actions.Add("main pid file repair failed before restart: $mainPid")
      }
    }
  }

  $workerProcesses = @(Get-RunningPostReplyWorkerProcesses -Processes $processes)
  foreach ($workerProcess in $workerProcesses) {
    $targetPids += [int]$workerProcess.ProcessId
  }

  $launcherPids = @(Get-RestartLauncherPids -Processes $allProcesses -MainProcesses $mainProcesses -WorkerProcesses $workerProcesses)
  $targetPids = @($targetPids | Sort-Object -Unique)
  $stopRootPids = @($targetPids + $launcherPids | Sort-Object -Unique)
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
  $protectedPids = @(Get-CurrentProcessAncestorPids | Where-Object { $stopRootPids -notcontains [int]$_ })
  $stoppedChildren = @(Stop-PidList -Pids $childPids -Stage 'child' -ProtectedPids $protectedPids)
  $stoppedRoots = @(Stop-PidList -Pids $targetPids -Stage 'root' -ProtectedPids $protectedPids)
  $stoppedLaunchers = @(Stop-PidList -Pids $launcherPids -Stage 'launcher' -ProtectedPids $protectedPids)
  $allStopped = @($stoppedChildren + $stoppedRoots + $stoppedLaunchers | Sort-Object -Unique)
  $gone = Wait-PidsGone -Pids $allStopped -TimeoutSeconds 10

  [void]$actions.Add("restart roots: $(if ($targetPids.Count) { $targetPids -join ', ' } else { '(none)' })")
  [void]$actions.Add("restart launchers: $(if ($launcherPids.Count) { $launcherPids -join ', ' } else { '(none)' })")
  [void]$actions.Add("protected caller pids: $(if ($protectedPids.Count) { $protectedPids -join ', ' } else { '(none)' })")
  [void]$actions.Add("stopped children: $(if ($stoppedChildren.Count) { $stoppedChildren -join ', ' } else { '(none)' })")
  [void]$actions.Add("stopped roots: $(if ($stoppedRoots.Count) { $stoppedRoots -join ', ' } else { '(none)' })")
  [void]$actions.Add("stopped launchers: $(if ($stoppedLaunchers.Count) { $stoppedLaunchers -join ', ' } else { '(none)' })")
  [void]$actions.Add("stopped process wait: $(if ($gone) { 'complete' } else { 'timeout' })")

  return @($actions)
}

function Start-BotRuntimeDirectly {
  $nodeExe = Resolve-NodeExecutable
  if (-not $nodeExe) { throw 'node.exe not found in PATH or common install locations.' }

  $actions = New-Object System.Collections.ArrayList
  Write-RestartLog -Message "direct start using node=$nodeExe"

  $statusBefore = Get-BotRuntimeStatus
  if (-not ($statusBefore.Main.Running -and $statusBefore.Main.Match)) {
    $mainLauncherPid = Start-NodeRestartProcess -NodeExe $nodeExe -ArgumentList @('index.js') -StdoutLog $mainStdoutLogFile -StderrLog $mainStderrLogFile
    [void]$actions.Add("started main bot launcher pid=$mainLauncherPid")
    Write-RestartLog -Message "started main bot launcher pid=$mainLauncherPid"
  } else {
    [void]$actions.Add("main bot already running pid=$($statusBefore.Main.Pid)")
  }

  Start-Sleep -Milliseconds 800
  $statusAfterMain = Get-BotRuntimeStatus
  if (-not ($statusAfterMain.Worker.Running -and $statusAfterMain.Worker.Match) -and (-not $statusAfterMain.WorkerIdleAllowed)) {
    $workerLauncherPid = Start-NodeRestartProcess -NodeExe $nodeExe -ArgumentList @('scripts/post-reply-worker.js') -StdoutLog $workerStdoutLogFile -StderrLog $workerStderrLogFile
    [void]$actions.Add("started post-reply worker launcher pid=$workerLauncherPid")
    Write-RestartLog -Message "started post-reply worker launcher pid=$workerLauncherPid"
  } elseif ($statusAfterMain.WorkerIdleAllowed) {
    [void]$actions.Add('post-reply worker not started; queue idle')
  } else {
    [void]$actions.Add("post-reply worker already running pid=$($statusAfterMain.Worker.Pid)")
  }

  return @($actions)
}

function Wait-BotHealthy {
  param(
    [int]$TimeoutSeconds = 60,
    [int]$PollMilliseconds = 1000
  )

  $stopwatch = [System.Diagnostics.Stopwatch]::StartNew()
  $lastStatus = $null
  while ($stopwatch.Elapsed.TotalSeconds -le $TimeoutSeconds) {
    $lastStatus = Get-BotRuntimeStatus
    if ($lastStatus.Healthy) {
      return [pscustomobject]@{ Healthy = $true; Status = $lastStatus; ElapsedMs = [Int64]$stopwatch.ElapsedMilliseconds }
    }
    Start-Sleep -Milliseconds $PollMilliseconds
  }

  return [pscustomobject]@{ Healthy = $false; Status = $lastStatus; ElapsedMs = [Int64]$stopwatch.ElapsedMilliseconds }
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
    [pscustomobject]@{ Component = 'main bot'; Name = $runtimeStatus.Main.Name; Exists = (Test-Path -LiteralPath $mainPidFile); Enabled = ''; State = if ($runtimeStatus.Main.Running -and $runtimeStatus.Main.Match) { 'Running' } else { 'Missing' }; Detail = "PID=$($runtimeStatus.Main.Pid); $($runtimeStatus.Main.Detail)" }
    [pscustomobject]@{ Component = 'post-reply worker'; Name = $runtimeStatus.Worker.Name; Exists = (Test-Path -LiteralPath $workerPidFile); Enabled = ''; State = $workerState; Detail = $workerDetail }
  ) | Format-Table -Wrap -AutoSize | Out-Host

  Write-Host ''
  Write-Host '=== Bot Node Processes ==='
  $processListAvailable = $true
  try {
    $allNodeProcesses = @(Get-CimInstance Win32_Process -ErrorAction Stop | Where-Object { $_.Name -eq 'node.exe' })
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

function Resolve-RestartCommand {
  param([string[]]$CliArgs = @())

  if ($CliArgs.Count -le 0) { return 'status' }

  $first = ([string]$CliArgs[0]).Trim().ToLowerInvariant()
  switch ($first) {
    '' { return 'status' }
    'status' { return 'status' }
    'statusonly' { return 'status' }
    '-statusonly' { return 'status' }
    'restart' { return 'restart' }
    'start' { return 'start' }
    default { return $first }
  }
}

[void](Import-DotEnv -FilePath (Join-Path $repoRoot '.env'))

$command = Resolve-RestartCommand -CliArgs $commandArgs
Write-RestartLog -Message "command=$command args=$($commandArgs -join ',')"
$actions = New-Object System.Collections.ArrayList

switch ($command) {
  'status' {
    [void]$actions.Add('status only; start skipped (restart requires "restart confirm")')
    $null = Write-DaemonReport -TaskName $taskName -Actions @($actions)
    Exit-RestartScript -Code 0
  }
  'restart' {
    [void]$actions.Add('restart requested')
    if (-not (Test-RestartConfirmed -CliArgs $commandArgs)) {
      [void]$actions.Add('restart skipped: explicit confirmation required (run "restart-bot.cmd restart confirm" or set MIZUKI_RESTART_CONFIRM=1)')
      $null = Write-DaemonReport -TaskName $taskName -Actions @($actions)
      Exit-RestartScript -Code 0
    }

    [void]$actions.Add('restart confirmation accepted')
    try {
      Write-RestartLog -Message 'stop begin'
      foreach ($action in Stop-BotForRestart) { [void]$actions.Add($action) }
      Write-RestartLog -Message 'stop done'
      foreach ($action in Start-BotRuntimeDirectly) { [void]$actions.Add($action) }
      Write-RestartLog -Message 'health wait begin'
      $waitResult = Wait-BotHealthy -TimeoutSeconds 60 -PollMilliseconds 1000
      [void]$actions.Add("health wait: healthy=$($waitResult.Healthy), elapsed_ms=$($waitResult.ElapsedMs)")
      Write-RestartLog -Message "health wait done healthy=$($waitResult.Healthy) elapsed_ms=$($waitResult.ElapsedMs)"
      $healthy = Write-DaemonReport -TaskName $taskName -Actions @($actions)
      Write-RestartLog -Message "report done healthy=$healthy"
      $resultStatus = if ($healthy) { 'success' } else { 'failed' }
      $resultMessage = if ($healthy) { 'restart completed' } else { 'bot/worker not healthy after synchronous restart' }
      [void](Write-RestartResult -Status $resultStatus -Healthy $healthy -Message $resultMessage -Actions @($actions))
      if (-not $healthy) { throw 'bot/worker not healthy after synchronous restart' }
      Exit-RestartScript -Code 0
    } catch {
      $failureMessage = $_.Exception.Message
      Write-RestartLog -Message "restart failed: $failureMessage"
      [void](Write-RestartResult -Status 'failed' -Healthy $false -Message $failureMessage -Actions @($actions))
      throw
    }
  }
  'start' {
    [void]$actions.Add('start requested')
    foreach ($action in Start-BotRuntimeDirectly) { [void]$actions.Add($action) }
    $waitResult = Wait-BotHealthy -TimeoutSeconds 60 -PollMilliseconds 1000
    [void]$actions.Add("health wait: healthy=$($waitResult.Healthy), elapsed_ms=$($waitResult.ElapsedMs)")
    $healthy = Write-DaemonReport -TaskName $taskName -Actions @($actions)
    if (-not $healthy) { throw 'bot/worker not healthy after synchronous start' }
    Exit-RestartScript -Code 0
  }
  default {
    [void]$actions.Add("unknown command: $command")
    [void]$actions.Add('usage: restart-bot.cmd status | restart-bot.cmd restart confirm | restart-bot.cmd start')
    $null = Write-DaemonReport -TaskName $taskName -Actions @($actions)
    Exit-RestartScript -Code 2
  }
}
