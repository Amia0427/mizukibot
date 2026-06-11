$ErrorActionPreference = 'Stop'
if (Get-Variable -Name PSNativeCommandUseErrorActionPreference -ErrorAction SilentlyContinue) {
  $PSNativeCommandUseErrorActionPreference = $false
}

# Always run from repo root so relative paths (.env/data) stay stable.
$repoRoot = Resolve-Path (Join-Path $PSScriptRoot '..')
Set-Location $repoRoot

$logDir = Join-Path $repoRoot 'data'
if (-not (Test-Path $logDir)) {
  New-Item -ItemType Directory -Path $logDir -Force | Out-Null
}

$logFile = Join-Path $logDir 'bot-daemon.log'
$mainStdoutLogFile = Join-Path $logDir 'bot-runtime.out.log'
$mainStderrLogFile = Join-Path $logDir 'bot-runtime.err.log'
$workerStdoutLogFile = Join-Path $logDir 'post-reply-worker.out.log'
$workerStderrLogFile = Join-Path $logDir 'post-reply-worker.err.log'
$workerPidFile = Join-Path $repoRoot '.mizukibot-postreply-worker.pid'

function Get-PositiveInt64Env {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Name,

    [Parameter(Mandatory = $true)]
    [Int64]$DefaultValue
  )

  $raw = [Environment]::GetEnvironmentVariable($Name, 'Process')
  if ([string]::IsNullOrWhiteSpace($raw)) {
    return $DefaultValue
  }

  [Int64]$parsed = 0
  if ([Int64]::TryParse($raw.Trim(), [ref]$parsed) -and $parsed -ge 0) {
    return $parsed
  }

  return $DefaultValue
}

function Get-BoolEnv {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Name,

    [Parameter(Mandatory = $true)]
    [bool]$DefaultValue
  )

  $raw = [Environment]::GetEnvironmentVariable($Name, 'Process')
  if ([string]::IsNullOrWhiteSpace($raw)) {
    return $DefaultValue
  }

  switch ($raw.Trim().ToLowerInvariant()) {
    { $_ -in @('1', 'true', 'yes', 'y', 'on') } { return $true }
    { $_ -in @('0', 'false', 'no', 'n', 'off') } { return $false }
    default { return $DefaultValue }
  }
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

function Rotate-DaemonLogIfNeeded {
  param(
    [Parameter(Mandatory = $true)]
    [string]$IncomingText
  )

  $maxBytes = Get-PositiveInt64Env -Name 'BOT_DAEMON_LOG_ROTATE_MAX_BYTES' -DefaultValue ([Int64](100MB))
  if ($maxBytes -le 0) {
    return
  }

  if (-not (Test-Path $logFile)) {
    return
  }

  try {
    $current = Get-Item -LiteralPath $logFile -ErrorAction Stop
    $incomingBytes = [System.Text.Encoding]::UTF8.GetByteCount($IncomingText)
    if (($current.Length + $incomingBytes) -le $maxBytes) {
      return
    }

    $archiveStamp = Get-Date -Format 'yyyyMMdd-HHmmss-fff'
    $archivePath = "$logFile.$archiveStamp"
    Move-Item -LiteralPath $logFile -Destination $archivePath -Force
  } catch {
    # Logging must never stop the daemon from starting the bot.
  }
}

function Write-DaemonLog {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Message
  )

  $stamp = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
  $line = "[$stamp] $Message`r`n"
  Rotate-DaemonLogIfNeeded -IncomingText $line
  [System.IO.File]::AppendAllText($logFile, $line, [System.Text.Encoding]::UTF8)
}

function Get-DaemonFallbackLogPath {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Path
  )

  $directory = Split-Path -Parent $Path
  $leaf = Split-Path -Leaf $Path
  $extension = [System.IO.Path]::GetExtension($leaf)
  $baseName = [System.IO.Path]::GetFileNameWithoutExtension($leaf)
  $stamp = Get-Date -Format 'yyyyMMdd-HHmmss-fff'

  return Join-Path $directory "$baseName.$stamp$extension"
}

function New-EmptyDaemonLogFile {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Path
  )

  $stream = $null
  try {
    $stream = [System.IO.File]::Open($Path, [System.IO.FileMode]::Create, [System.IO.FileAccess]::Write, [System.IO.FileShare]::Read)
    return $true
  } catch {
    return $false
  } finally {
    if ($null -ne $stream) {
      $stream.Close()
    }
  }
}

function Resolve-DaemonWritableLogPath {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Path
  )

  if (New-EmptyDaemonLogFile -Path $Path) {
    return $Path
  }

  $fallbackPath = Get-DaemonFallbackLogPath -Path $Path
  if (-not (New-EmptyDaemonLogFile -Path $fallbackPath)) {
    throw "unable to open daemon log for write: requested=$Path fallback=$fallbackPath"
  }
  Write-DaemonLog -Message "log file locked, using fallback log. requested=$Path fallback=$fallbackPath"
  return $fallbackPath
}

function Start-NodeDaemonProcessWithResolvedLogs {
  param(
    [Parameter(Mandatory = $true)]
    [string]$NodeExe,

    [Parameter(Mandatory = $true)]
    [string[]]$ArgumentList,

    [Parameter(Mandatory = $true)]
    [string]$StdoutLog,

    [Parameter(Mandatory = $true)]
    [string]$StderrLog
  )

  return Start-Process `
    -FilePath $NodeExe `
    -ArgumentList $ArgumentList `
    -WorkingDirectory $repoRoot `
    -WindowStyle Hidden `
    -RedirectStandardOutput $StdoutLog `
    -RedirectStandardError $StderrLog `
    -PassThru
}

function Start-NodeDaemonProcess {
  param(
    [Parameter(Mandatory = $true)]
    [string]$NodeExe,

    [Parameter(Mandatory = $true)]
    [string[]]$ArgumentList,

    [Parameter(Mandatory = $true)]
    [string]$StdoutLog,

    [Parameter(Mandatory = $true)]
    [string]$StderrLog
  )

  $resolvedStdoutLog = Resolve-DaemonWritableLogPath -Path $StdoutLog
  $resolvedStderrLog = Resolve-DaemonWritableLogPath -Path $StderrLog

  try {
    return Start-NodeDaemonProcessWithResolvedLogs -NodeExe $NodeExe -ArgumentList $ArgumentList -StdoutLog $resolvedStdoutLog -StderrLog $resolvedStderrLog
  } catch {
    if (($resolvedStdoutLog -ne $StdoutLog) -and ($resolvedStderrLog -ne $StderrLog)) {
      throw
    }

    $retryStdoutLog = if ($resolvedStdoutLog -eq $StdoutLog) { Get-DaemonFallbackLogPath -Path $StdoutLog } else { $resolvedStdoutLog }
    $retryStderrLog = if ($resolvedStderrLog -eq $StderrLog) { Get-DaemonFallbackLogPath -Path $StderrLog } else { $resolvedStderrLog }

    foreach ($retryPath in @($retryStdoutLog, $retryStderrLog | Select-Object -Unique)) {
      if (-not (New-EmptyDaemonLogFile -Path $retryPath)) {
        throw
      }
    }

    Write-DaemonLog -Message "process redirect log became unavailable, retrying with fallback logs. stdout=$retryStdoutLog stderr=$retryStderrLog error=$($_.Exception.Message)"
    return Start-NodeDaemonProcessWithResolvedLogs -NodeExe $NodeExe -ArgumentList $ArgumentList -StdoutLog $retryStdoutLog -StderrLog $retryStderrLog
  }
}

function Import-DotEnv {
  param(
    [Parameter(Mandatory = $true)]
    [string]$FilePath
  )

  if (-not (Test-Path $FilePath)) {
    return 0
  }

  $loadedCount = 0
  foreach ($rawLine in Get-Content -Path $FilePath -Encoding utf8) {
    # Strip UTF-8 BOM and whitespace to keep KEY=VALUE parsing predictable.
    $line = ([string]$rawLine).Trim().TrimStart([char]0xFEFF)
    if (-not $line) { continue }
    if ($line.StartsWith('#')) { continue }

    # Support shell syntax: export KEY=value
    if ($line.StartsWith('export ')) {
      $line = $line.Substring(7).Trim()
    }

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

function Resolve-NodeExecutable {
  $cmd = Get-Command node -ErrorAction SilentlyContinue
  if ($cmd -and $cmd.Source) {
    return $cmd.Source
  }

  $candidates = @(
    (Join-Path $env:ProgramFiles 'nodejs\node.exe'),
    (Join-Path ${env:ProgramFiles(x86)} 'nodejs\node.exe')
  ) | Where-Object { $_ -and (Test-Path $_) }

  if ($candidates.Count -gt 0) {
    return $candidates[0]
  }

  return $null
}

function Get-ProcessCommandLine {
  param(
    [Parameter(Mandatory = $true)]
    [int]$ProcessId
  )

  if ($ProcessId -le 0) {
    return ''
  }

  try {
    $cim = Get-CimInstance Win32_Process -Filter "ProcessId = $ProcessId" -ErrorAction Stop
    return [string]$cim.CommandLine
  } catch {
    return ''
  }
}

function Read-PidFileText {
  param(
    [Parameter(Mandatory = $true)]
    [string]$FilePath
  )

  if (-not (Test-Path $FilePath)) {
    return ''
  }

  try {
    $raw = Get-Content -Path $FilePath -TotalCount 1 -Encoding utf8 -ErrorAction Stop
    if ($null -eq $raw) {
      return ''
    }
    return [string]$raw
  } catch {
    return ''
  }
}

function Test-LockPidMatchesProcessLifetime {
  param(
    [Parameter(Mandatory = $true)]
    [string]$LockPath,

    [Parameter(Mandatory = $true)]
    [System.Diagnostics.Process]$Process
  )

  if (-not (Test-Path $LockPath)) {
    return $false
  }

  try {
    $lockInfo = Get-Item -LiteralPath $LockPath -ErrorAction Stop
    $deltaSeconds = [math]::Abs(($lockInfo.LastWriteTime - $Process.StartTime).TotalSeconds)
    # The main bot writes the lock at startup, so matching start/lock times are
    # a strong fallback signal when CommandLine is unavailable.
    return $deltaSeconds -le 300
  } catch {
    return $false
  }
}

function Test-LockOwnedByRunningNode {
  param(
    [Parameter(Mandatory = $true)]
    [string]$LockPath
  )

  if (-not (Test-Path $LockPath)) {
    return $false
  }

  try {
    $ownerPidText = (Read-PidFileText -FilePath $LockPath).Trim()
    $ownerPid = [int]$ownerPidText
    if ($ownerPid -le 0) {
      return $false
    }

    $proc = Get-Process -Id $ownerPid -ErrorAction SilentlyContinue
    if ($null -eq $proc -or $proc.ProcessName -ine 'node') {
      return $false
    }

    $commandLine = Get-ProcessCommandLine -ProcessId $ownerPid

    if (-not [string]::IsNullOrWhiteSpace($commandLine) -and $commandLine -match 'index\.js') {
      return $true
    }

    if (Test-LockPidMatchesProcessLifetime -LockPath $LockPath -Process $proc) {
      return $true
    }

    return $false
  } catch {
    return $false
  }
}

function Get-LockProcessDiagnostics {
  param(
    [Parameter(Mandatory = $true)]
    [string]$LockPath
  )

  if (-not (Test-Path $LockPath)) {
    return 'lock file missing'
  }

  try {
    $ownerPidText = (Read-PidFileText -FilePath $LockPath).Trim()
    $ownerPid = [int]$ownerPidText
    if ($ownerPid -le 0) {
      return "lock pid invalid: '$ownerPidText'"
    }

    $proc = Get-Process -Id $ownerPid -ErrorAction SilentlyContinue
    if ($null -eq $proc) {
      return "lock pid=$ownerPid not running"
    }

    $commandLine = Get-ProcessCommandLine -ProcessId $ownerPid
    $startMatchesLock = Test-LockPidMatchesProcessLifetime -LockPath $LockPath -Process $proc

    if ([string]::IsNullOrWhiteSpace($commandLine)) {
      return "lock pid=$ownerPid name=$($proc.ProcessName) path=$($proc.Path) start_matches_lock=$startMatchesLock"
    }

    return "lock pid=$ownerPid name=$($proc.ProcessName) start_matches_lock=$startMatchesLock cmd=$commandLine"
  } catch {
    return "lock diagnostics failed: $($_.Exception.Message)"
  }
}

function Wait-MainBotLockOwnership {
  param(
    [Parameter(Mandatory = $true)]
    [string]$LockPath,

    [Parameter(Mandatory = $true)]
    [System.Diagnostics.Process]$StartedProcess
  )

  $timeoutMs = Get-PositiveInt64Env -Name 'BOT_DAEMON_LOCK_WAIT_MS' -DefaultValue ([Int64]30000)
  $pollMs = Get-PositiveInt64Env -Name 'BOT_DAEMON_LOCK_POLL_MS' -DefaultValue ([Int64]500)
  if ($pollMs -lt 100) {
    $pollMs = 100
  }
  if ($pollMs -gt 2000) {
    $pollMs = 2000
  }

  $stopwatch = [System.Diagnostics.Stopwatch]::StartNew()
  while ($true) {
    if (Test-LockOwnedByRunningNode -LockPath $LockPath) {
      return [pscustomobject]@{
        Acquired = $true
        Reason = 'acquired'
        ElapsedMs = [Int64]$stopwatch.ElapsedMilliseconds
        TimeoutMs = [Int64]$timeoutMs
        ProcessExited = $false
        ExitCode = $null
      }
    }

    try {
      $StartedProcess.Refresh()
      if ($StartedProcess.HasExited) {
        return [pscustomobject]@{
          Acquired = $false
          Reason = 'process_exited_before_lock'
          ElapsedMs = [Int64]$stopwatch.ElapsedMilliseconds
          TimeoutMs = [Int64]$timeoutMs
          ProcessExited = $true
          ExitCode = $StartedProcess.ExitCode
        }
      }
    } catch {
      # If process inspection fails, keep polling the lock until the deadline.
    }

    if ($stopwatch.ElapsedMilliseconds -ge $timeoutMs) {
      return [pscustomobject]@{
        Acquired = $false
        Reason = 'timeout'
        ElapsedMs = [Int64]$stopwatch.ElapsedMilliseconds
        TimeoutMs = [Int64]$timeoutMs
        ProcessExited = $false
        ExitCode = $null
      }
    }

    $remainingMs = [Int64]($timeoutMs - $stopwatch.ElapsedMilliseconds)
    $sleepMs = [int][Math]::Max(50, [Math]::Min($pollMs, $remainingMs))
    Start-Sleep -Milliseconds $sleepMs
  }
}

function Test-WorkerOwnedByRunningNode {
  param(
    [Parameter(Mandatory = $true)]
    [string]$PidFile
  )

  if (-not (Test-Path $PidFile)) {
    return $false
  }

  try {
    $ownerPidText = (Read-PidFileText -FilePath $PidFile).Trim()
    $ownerPid = [int]$ownerPidText
    if ($ownerPid -le 0) {
      return $false
    }

    $proc = Get-Process -Id $ownerPid -ErrorAction SilentlyContinue
    if ($null -eq $proc -or $proc.ProcessName -ine 'node') {
      return $false
    }

    $commandLine = Get-ProcessCommandLine -ProcessId $ownerPid
    if ([string]::IsNullOrWhiteSpace($commandLine)) {
      return $true
    }

    return ($commandLine -match 'post-reply-worker\.js')
  } catch {
    return $false
  }
}

function Get-NodeProcessSnapshot {
  try {
    return @(Get-CimInstance Win32_Process -ErrorAction Stop | Where-Object { $_.Name -eq 'node.exe' })
  } catch {
    return @()
  }
}

function Test-ProcessLooksLikePostReplyWorker {
  param([Parameter(Mandatory = $true)]$Process)

  $commandLine = [string]$Process.CommandLine
  if ([string]::IsNullOrWhiteSpace($commandLine)) {
    return $false
  }

  $normalizedRoot = ([string]$repoRoot).TrimEnd('\')
  return ($commandLine -match 'post-reply-worker\.js') -and (
    $commandLine -like "*$normalizedRoot*" -or
    $commandLine -match '(^|[\\/\s])scripts[\\/]post-reply-worker\.js(\s|$)' -or
    $commandLine -match '(^|[\\/\s])post-reply-worker\.js(\s|$)'
  )
}

function Get-RunningPostReplyWorkerProcesses {
  param([object[]]$Processes = @())

  if ($null -eq $Processes -or $Processes.Count -le 0) {
    $Processes = Get-NodeProcessSnapshot
  }

  return @($Processes | Where-Object { Test-ProcessLooksLikePostReplyWorker -Process $_ } | Sort-Object ProcessId)
}

function Repair-WorkerPidFileFromProcess {
  param([Parameter(Mandatory = $true)]$WorkerProcess)

  $pidNum = [int]$WorkerProcess.ProcessId
  if ($pidNum -le 0) {
    return $false
  }

  try {
    Set-Content -Path $workerPidFile -Value $pidNum -Encoding utf8
    Write-DaemonLog -Message "repaired post-reply worker pid file from running process pid=$pidNum"
    return $true
  } catch {
    Write-DaemonLog -Message "failed to repair post-reply worker pid file from pid=$pidNum error=$($_.Exception.Message)"
    return $false
  }
}

function Get-WorkerRuntimeState {
  $processes = Get-NodeProcessSnapshot
  $workers = @(Get-RunningPostReplyWorkerProcesses -Processes $processes)
  $pidOwnerRunning = Test-WorkerOwnedByRunningNode -PidFile $workerPidFile

  if ($workers.Count -gt 0) {
    if (-not $pidOwnerRunning) {
      $null = Repair-WorkerPidFileFromProcess -WorkerProcess $workers[0]
    }
    return [pscustomobject]@{
      Running = $true
      Source = if ($pidOwnerRunning) { 'pid_file' } else { 'process_scan' }
      Pid = [int]$workers[0].ProcessId
      Count = $workers.Count
      Processes = $workers
    }
  }

  if ($pidOwnerRunning) {
    $pidText = (Read-PidFileText -FilePath $workerPidFile).Trim()
    $pidNum = 0
    [void][int]::TryParse($pidText, [ref]$pidNum)
    return [pscustomobject]@{
      Running = $true
      Source = 'pid_file'
      Pid = $pidNum
      Count = 1
      Processes = @()
    }
  }

  return [pscustomobject]@{
    Running = $false
    Source = if (Test-Path $workerPidFile) { 'pid_file_stale_or_invalid' } else { 'missing' }
    Pid = 0
    Count = 0
    Processes = @()
  }
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
    [Parameter(Mandatory = $true)][int]$StaleProcessingMs
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
  $staleProcessingMs = [int](Get-PositiveInt64Env -Name 'POST_REPLY_WORKER_STALE_PROCESSING_MS' -DefaultValue 300000)
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

Write-DaemonLog -Message 'daemon task started'

$exitCode = 0
try {
  # Load .env manually because dotenv may not exist in production dependencies.
  $envFile = Join-Path $repoRoot '.env'
  $loadedEnvCount = Import-DotEnv -FilePath $envFile
  $apiKey = [Environment]::GetEnvironmentVariable('API_KEY', 'Process')
  $apiKeyLen = if ([string]::IsNullOrWhiteSpace($apiKey)) { 0 } else { $apiKey.Length }
  Write-DaemonLog -Message "dotenv loaded keys=$loadedEnvCount, api_key_len=$apiKeyLen"

  # If bot is already alive, report success to keep scheduled-task status healthy.
  $lockFile = Join-Path $repoRoot '.mizukibot.lock'
  $nodeExe = Resolve-NodeExecutable
  if (-not $nodeExe) {
    throw 'node.exe not found in PATH or common install locations.'
  }

  Write-DaemonLog -Message "using node: $nodeExe"
  $mainBotStartedByDaemon = $false
  if (Test-LockOwnedByRunningNode -LockPath $lockFile) {
    $lockDiag = Get-LockProcessDiagnostics -LockPath $lockFile
    Write-DaemonLog -Message "bot already running, skip duplicate start. $lockDiag"
  } else {
    if (Test-Path $lockFile) {
      $lockDiag = Get-LockProcessDiagnostics -LockPath $lockFile
      Write-DaemonLog -Message "lock present but not owned by active main bot. $lockDiag"
    }
    $mainProc = Start-NodeDaemonProcess -NodeExe $nodeExe -ArgumentList @('index.js') -StdoutLog $mainStdoutLogFile -StderrLog $mainStderrLogFile
    Write-DaemonLog -Message "started main bot pid=$($mainProc.Id), stdout=$mainStdoutLogFile, stderr=$mainStderrLogFile"
    $lockWait = Wait-MainBotLockOwnership -LockPath $lockFile -StartedProcess $mainProc
    if (-not $lockWait.Acquired) {
      $lockDiag = Get-LockProcessDiagnostics -LockPath $lockFile
      throw "main bot did not acquire lock after daemon start (reason=$($lockWait.Reason), elapsed_ms=$($lockWait.ElapsedMs), timeout_ms=$($lockWait.TimeoutMs), exit_code=$($lockWait.ExitCode), $lockDiag)"
    }
    $lockDiag = Get-LockProcessDiagnostics -LockPath $lockFile
    Write-DaemonLog -Message "main bot lock acquired after daemon start. started_pid=$($mainProc.Id), elapsed_ms=$($lockWait.ElapsedMs), $lockDiag"
    $mainBotStartedByDaemon = $true
  }

  $workerState = Get-WorkerRuntimeState
  if ($workerState.Running) {
    $detail = if ($workerState.Count -gt 1) { " count=$($workerState.Count)" } else { '' }
    Write-DaemonLog -Message "post-reply worker already running, skip duplicate start. pid=$($workerState.Pid) source=$($workerState.Source)$detail"
  } else {
    $workerStartReason = Get-PostReplyQueueStartReason
    if ([string]::IsNullOrWhiteSpace($workerStartReason) -and $mainBotStartedByDaemon -and (Test-ExternalPostReplyWorkerEnabled)) {
      $workerStartReason = 'main bot started by daemon; ensure external worker'
    } elseif ([string]::IsNullOrWhiteSpace($workerStartReason) -and (Test-ExternalPostReplyWorkerResidentExpected)) {
      $workerStartReason = 'external worker expected resident; restart missing worker'
    }
    if ([string]::IsNullOrWhiteSpace($workerStartReason)) {
      Write-DaemonLog -Message 'post-reply worker not running, queue idle; skip idle restart.'
    } else {
      $workerProc = Start-NodeDaemonProcess -NodeExe $nodeExe -ArgumentList @('scripts/post-reply-worker.js') -StdoutLog $workerStdoutLogFile -StderrLog $workerStderrLogFile
      Set-Content -Path $workerPidFile -Value $workerProc.Id -Encoding utf8
      Write-DaemonLog -Message "started post-reply worker pid=$($workerProc.Id), reason=$workerStartReason, stdout=$workerStdoutLogFile, stderr=$workerStderrLogFile"
    }
  }
} catch {
  $exitCode = 1
  Write-DaemonLog -Message "daemon task error: $($_.Exception.Message)"
} finally {
  Write-DaemonLog -Message "daemon task exited with code $exitCode"
}

exit $exitCode
