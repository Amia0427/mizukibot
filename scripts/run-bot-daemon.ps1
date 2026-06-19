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
$mainRestartStateFile = Join-Path $logDir 'bot-main-restart-state.json'
$mainRuntimeStateFile = Join-Path $logDir 'bot-main-runtime-state.json'
$mainExitObservationsFile = Join-Path $logDir 'bot-main-exit-observations.jsonl'
$mainPortRecoveryStateFile = Join-Path $logDir 'bot-main-port-recovery-state.json'
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

function Test-DaemonTcpPortListening {
  param([Parameter(Mandatory = $true)][Int64]$Port)

  if ($Port -le 0 -or $Port -gt 65535) {
    return $false
  }

  try {
    $connections = @(Get-NetTCPConnection -LocalPort ([int]$Port) -State Listen -ErrorAction SilentlyContinue)
    return $connections.Count -gt 0
  } catch {
    try {
      $pattern = "LISTENING\s+\d+$"
      $rows = @(netstat -ano -p tcp | Where-Object {
        ($_ -match "[:.]$Port\s+") -and ($_ -match $pattern)
      })
      return $rows.Count -gt 0
    } catch {
      return $false
    }
  }
}

function Get-MainHttpReverseIngressState {
  $port = Get-PositiveInt64Env -Name 'NAPCAT_HTTP_REVERSE_PORT' -DefaultValue 3002
  $listening = Test-DaemonTcpPortListening -Port $port
  return [pscustomobject]@{
    Enabled = $true
    Port = $port
    Listening = $listening
    Outage = (-not $listening)
  }
}

function Test-RecentMainHttpReversePortRecovery {
  param(
    [Parameter(Mandatory = $true)][Int64]$Port
  )

  $cooldownMs = Get-PositiveInt64Env -Name 'BOT_DAEMON_HTTP_REVERSE_PORT_RECOVERY_COOLDOWN_MS' -DefaultValue ([Int64]600000)
  if ($cooldownMs -le 0) {
    return $false
  }

  $state = Read-JsonFileSafe -Path $mainPortRecoveryStateFile
  if ($null -eq $state) {
    return $false
  }

  $statePort = 0
  [void][Int64]::TryParse([string]$state.port, [ref]$statePort)
  if ($statePort -ne $Port) {
    return $false
  }

  $lastAttemptAt = [datetime]::MinValue
  if (-not [datetime]::TryParse([string]$state.lastAttemptAt, [ref]$lastAttemptAt)) {
    return $false
  }

  return (((Get-Date).ToUniversalTime() - $lastAttemptAt.ToUniversalTime()).TotalMilliseconds -lt $cooldownMs)
}

function Record-MainHttpReversePortRecovery {
  param(
    [Parameter(Mandatory = $true)][Int64]$Port,
    [int]$PreviousPid = 0,
    [int]$EarlyExitCount = 0,
    [string]$CooldownUntil = ''
  )

  $state = [pscustomobject]@{
    schemaVersion = 'main_http_reverse_port_recovery_v1'
    lastAttemptAt = (Get-Date).ToUniversalTime().ToString('o')
    port = $Port
    previousPid = $PreviousPid
    earlyExitCount = $EarlyExitCount
    cooldownUntil = $CooldownUntil
    reason = 'http_reverse_port_outage'
  }
  [void](Write-JsonFileSafe -Path $mainPortRecoveryStateFile -Value $state)
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

function Archive-DaemonRedirectLogIfNeeded {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Path
  )

  if (-not (Test-Path $Path)) {
    return ''
  }

  try {
    $current = Get-Item -LiteralPath $Path -ErrorAction Stop
    if ($current.Length -le 0) {
      return ''
    }

    $archivePath = Get-DaemonFallbackLogPath -Path $Path
    Copy-Item -LiteralPath $Path -Destination $archivePath -Force
    return $archivePath
  } catch {
    Write-DaemonLog -Message "failed to archive runtime redirect log before truncate. path=$Path error=$($_.Exception.Message)"
    return ''
  }
}

function Resolve-DaemonWritableLogPath {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Path
  )

  $archivePath = Archive-DaemonRedirectLogIfNeeded -Path $Path
  if (-not [string]::IsNullOrWhiteSpace($archivePath)) {
    Write-DaemonLog -Message "archived runtime redirect log before restart. source=$Path archive=$archivePath"
  }

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
    Write-DaemonLog -Message "failed to write json state. path=$Path error=$($_.Exception.Message)"
    return $false
  }
}

function Append-JsonLineSafe {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)]$Value
  )

  try {
    $dir = Split-Path -Parent $Path
    if ($dir -and -not (Test-Path $dir)) {
      New-Item -ItemType Directory -Path $dir -Force | Out-Null
    }
    $json = $Value | ConvertTo-Json -Depth 10 -Compress
    [System.IO.File]::AppendAllText($Path, $json + "`r`n", [System.Text.Encoding]::UTF8)
    return $true
  } catch {
    Write-DaemonLog -Message "failed to append json observation. path=$Path error=$($_.Exception.Message)"
    return $false
  }
}

function Parse-DateTimeOrMin {
  param([string]$Value = '')

  $parsed = [datetime]::MinValue
  if (-not [string]::IsNullOrWhiteSpace($Value)) {
    [void][datetime]::TryParse($Value, [ref]$parsed)
  }
  return $parsed
}

function Read-PositivePidFromFile {
  param([Parameter(Mandatory = $true)][string]$FilePath)

  $pidText = (Read-PidFileText -FilePath $FilePath).Trim()
  $pidNum = 0
  if ([int]::TryParse($pidText, [ref]$pidNum) -and $pidNum -gt 0) {
    return $pidNum
  }
  return 0
}

function Get-MainRuntimeStateForPid {
  param([int]$OwnerPid = 0)

  if ($OwnerPid -le 0) {
    return $null
  }

  $state = Read-JsonFileSafe -Path $mainRuntimeStateFile
  if ($null -eq $state) {
    return $null
  }

  $statePid = 0
  [void][int]::TryParse([string]$state.pid, [ref]$statePid)
  if ($statePid -ne $OwnerPid) {
    return $null
  }

  return $state
}

function Get-MainBotExitEvidence {
  param(
    [Parameter(Mandatory = $true)][string]$LockPath,
    [int]$OwnerPid = 0
  )

  $lockAgeMs = Get-MainBotLockAgeMs -LockPath $LockPath
  $runtimeState = Get-MainRuntimeStateForPid -OwnerPid $OwnerPid
  $heartbeatAt = [datetime]::MinValue
  $startedAt = [datetime]::MinValue
  if ($null -ne $runtimeState) {
    $heartbeatAt = Parse-DateTimeOrMin -Value ([string]$runtimeState.heartbeatAt)
    $startedAt = Parse-DateTimeOrMin -Value ([string]$runtimeState.startedAt)
  }

  $heartbeatAgeMs = [Int64]::MaxValue
  if ($heartbeatAt -ne [datetime]::MinValue) {
    $heartbeatAgeMs = [Int64]([Math]::Max(0, ((Get-Date).ToUniversalTime() - $heartbeatAt.ToUniversalTime()).TotalMilliseconds))
  }

  $startedAgeMs = [Int64]::MaxValue
  if ($startedAt -ne [datetime]::MinValue) {
    $startedAgeMs = [Int64]([Math]::Max(0, ((Get-Date).ToUniversalTime() - $startedAt.ToUniversalTime()).TotalMilliseconds))
  }

  $runtimeMs = $lockAgeMs
  $ageSource = 'lock_mtime'
  if ($heartbeatAt -ne [datetime]::MinValue -and $startedAt -ne [datetime]::MinValue) {
    $runtimeMs = [Int64]([Math]::Max(0, ($heartbeatAt.ToUniversalTime() - $startedAt.ToUniversalTime()).TotalMilliseconds))
    $ageSource = 'runtime_heartbeat_lifetime'
  }

  return [pscustomobject]@{
    OwnerPid = $OwnerPid
    LockAgeMs = $lockAgeMs
    HeartbeatAgeMs = $heartbeatAgeMs
    StartedAgeMs = $startedAgeMs
    RuntimeMs = $runtimeMs
    EffectiveAgeMs = $runtimeMs
    AgeSource = $ageSource
    HeartbeatAt = if ($heartbeatAt -ne [datetime]::MinValue) { $heartbeatAt.ToUniversalTime().ToString('o') } else { '' }
    StartedAt = if ($startedAt -ne [datetime]::MinValue) { $startedAt.ToUniversalTime().ToString('o') } else { '' }
    RuntimeStateStage = if ($null -ne $runtimeState) { [string]$runtimeState.stage } else { '' }
    RuntimeStatePath = $mainRuntimeStateFile
  }
}

function Record-MainBotExitObservation {
  param(
    [int]$OwnerPid = 0,
    [string]$Reason = '',
    [string]$LockDiagnostics = '',
    $Evidence = $null,
    $EarlyExitState = $null
  )

  $expectedMarker = if ($null -ne $EarlyExitState) { $EarlyExitState.ExpectedShutdownMarker } else { $null }
  $payload = [pscustomobject]@{
    schemaVersion = 'main_bot_exit_observation_v1'
    source = 'windows_daemon'
    event = 'daemon_stale_lock'
    observedAt = (Get-Date).ToUniversalTime().ToString('o')
    pid = $OwnerPid
    reason = $Reason
    lockDiagnostics = $LockDiagnostics
    lockAgeMs = if ($null -ne $Evidence) { $Evidence.LockAgeMs } else { 0 }
    heartbeatAgeMs = if ($null -ne $Evidence) { $Evidence.HeartbeatAgeMs } else { 0 }
    runtimeMs = if ($null -ne $Evidence) { $Evidence.RuntimeMs } else { 0 }
    effectiveAgeMs = if ($null -ne $Evidence) { $Evidence.EffectiveAgeMs } else { 0 }
    ageSource = if ($null -ne $Evidence) { $Evidence.AgeSource } else { '' }
    heartbeatAt = if ($null -ne $Evidence) { $Evidence.HeartbeatAt } else { '' }
    startedAt = if ($null -ne $Evidence) { $Evidence.StartedAt } else { '' }
    runtimeStateStage = if ($null -ne $Evidence) { $Evidence.RuntimeStateStage } else { '' }
    earlyExitReason = if ($null -ne $EarlyExitState) { $EarlyExitState.Reason } else { '' }
    earlyExitCount = if ($null -ne $EarlyExitState) { $EarlyExitState.Count } else { 0 }
    cooldownUntil = if ($null -ne $EarlyExitState) { $EarlyExitState.CooldownUntil } else { '' }
    expectedShutdownReason = if ($null -ne $expectedMarker) { [string]$expectedMarker.reason } else { '' }
    expectedShutdownSource = if ($null -ne $expectedMarker) { [string]$expectedMarker.source } else { '' }
    expectedShutdownRecordedAt = if ($null -ne $expectedMarker) { [string]$expectedMarker.recordedAt } else { '' }
    expectedShutdownExpiresAt = if ($null -ne $expectedMarker) { [string]$expectedMarker.expiresAt } else { '' }
    expectedShutdownRequestId = if ($null -ne $expectedMarker) { [string]$expectedMarker.requestId } else { '' }
    expectedShutdownMessageId = if ($null -ne $expectedMarker) { [string]$expectedMarker.messageId } else { '' }
    expectedShutdownGroupId = if ($null -ne $expectedMarker) { [string]$expectedMarker.groupId } else { '' }
  }
  [void](Append-JsonLineSafe -Path $mainExitObservationsFile -Value $payload)
}

function Test-ExpectedMainBotShutdownRecent {
  param([int]$OwnerPid = 0)

  $markerPath = Join-Path $logDir 'bot-main-expected-shutdown.json'
  $marker = Read-JsonFileSafe -Path $markerPath
  if ($null -eq $marker) {
    return [pscustomobject]@{ Matched = $false; Marker = $null; Reason = 'missing' }
  }

  if (-not [string]::IsNullOrWhiteSpace([string]$marker.consumedAt)) {
    return [pscustomobject]@{ Matched = $false; Marker = $marker; Reason = 'already_consumed' }
  }

  $expiresAt = [datetime]::MinValue
  if (-not [datetime]::TryParse([string]$marker.expiresAt, [ref]$expiresAt)) {
    return [pscustomobject]@{ Matched = $false; Marker = $marker; Reason = 'invalid_expires_at' }
  }
  if ($expiresAt.ToUniversalTime() -lt (Get-Date).ToUniversalTime()) {
    return [pscustomobject]@{ Matched = $false; Marker = $marker; Reason = 'expired' }
  }

  $markerPid = 0
  [void][int]::TryParse([string]$marker.pid, [ref]$markerPid)
  if ($OwnerPid -le 0 -or $markerPid -le 0 -or $markerPid -ne $OwnerPid) {
    return [pscustomobject]@{ Matched = $false; Marker = $marker; Reason = 'pid_mismatch' }
  }

  $consumedMarker = [ordered]@{}
  foreach ($property in @($marker.PSObject.Properties)) {
    $consumedMarker[$property.Name] = $property.Value
  }
  $consumedMarker['consumedAt'] = (Get-Date).ToUniversalTime().ToString('o')
  $consumedMarker['consumedBy'] = 'windows_daemon'
  $consumedMarker['consumedByPid'] = $PID
  $consumedMarker['consumedOwnerPid'] = $OwnerPid
  [void](Write-JsonFileSafe -Path $markerPath -Value ([pscustomobject]$consumedMarker))

  return [pscustomobject]@{ Matched = $true; Marker = $marker; Reason = 'matched' }
}

function Get-MainBotEarlyExitPolicy {
  return [pscustomobject]@{
    WindowMs = Get-PositiveInt64Env -Name 'BOT_DAEMON_MAIN_EARLY_EXIT_WINDOW_MS' -DefaultValue ([Int64]900000)
    MaxRestarts = Get-PositiveInt64Env -Name 'BOT_DAEMON_MAIN_EARLY_EXIT_MAX_RESTARTS' -DefaultValue ([Int64]2)
    CooldownMs = Get-PositiveInt64Env -Name 'BOT_DAEMON_MAIN_EARLY_EXIT_COOLDOWN_MS' -DefaultValue ([Int64]900000)
  }
}

function Get-MainBotLockAgeMs {
  param([Parameter(Mandatory = $true)][string]$LockPath)

  try {
    if (-not (Test-Path $LockPath)) {
      return [Int64]::MaxValue
    }
    $lockInfo = Get-Item -LiteralPath $LockPath -ErrorAction Stop
    return [Int64]([Math]::Max(0, ((Get-Date) - $lockInfo.LastWriteTime).TotalMilliseconds))
  } catch {
    return [Int64]::MaxValue
  }
}

function Update-MainBotEarlyExitState {
  param(
    [Parameter(Mandatory = $true)][string]$LockPath,
    [int]$OwnerPid = 0
  )

  $policy = Get-MainBotEarlyExitPolicy
  if ($policy.MaxRestarts -le 0 -or $policy.WindowMs -le 0 -or $policy.CooldownMs -le 0) {
    return [pscustomobject]@{ Blocked = $false; Reason = 'disabled'; Count = 0; CooldownUntil = '' }
  }

  if ($OwnerPid -le 0) {
    return [pscustomobject]@{ Blocked = $false; Reason = 'no_owner_pid'; Count = 0; CooldownUntil = '' }
  }

  $expectedShutdown = Test-ExpectedMainBotShutdownRecent -OwnerPid $OwnerPid
  if ($expectedShutdown.Matched) {
    $marker = $expectedShutdown.Marker
    Write-DaemonLog -Message "main bot previous exit marked expected; skip early-exit backoff. pid=$OwnerPid marker_reason=$([string]$marker.reason) marker_source=$([string]$marker.source) marker_recorded_at=$([string]$marker.recordedAt) marker_request_id=$([string]$marker.requestId) marker_message_id=$([string]$marker.messageId) marker_group_id=$([string]$marker.groupId)"
    $state = [pscustomobject]@{
      firstExitAt = ''
      lastExitAt = (Get-Date).ToUniversalTime().ToString('o')
      count = 0
      cooldownUntil = ''
      lastPid = $OwnerPid
      lastReason = 'expected_shutdown'
      expectedShutdownReason = [string]$marker.reason
      expectedShutdownSource = [string]$marker.source
      expectedShutdownRecordedAt = [string]$marker.recordedAt
      expectedShutdownRequestId = [string]$marker.requestId
      expectedShutdownMessageId = [string]$marker.messageId
      expectedShutdownGroupId = [string]$marker.groupId
    }
    [void](Write-JsonFileSafe -Path $mainRestartStateFile -Value $state)
    return [pscustomobject]@{ Blocked = $false; Reason = 'expected_shutdown'; Count = 0; CooldownUntil = ''; ExpectedShutdownMarker = $marker }
  }

  $exitEvidence = Get-MainBotExitEvidence -LockPath $LockPath -OwnerPid $OwnerPid
  $lockAgeMs = $exitEvidence.LockAgeMs
  $effectiveRuntimeMs = $exitEvidence.EffectiveAgeMs
  if ($effectiveRuntimeMs -gt $policy.WindowMs) {
    Write-DaemonLog -Message "main bot stale lock is outside early-exit window; reset backoff. pid=$OwnerPid lock_age_ms=$lockAgeMs effective_runtime_ms=$effectiveRuntimeMs age_source=$($exitEvidence.AgeSource) heartbeat_at=$($exitEvidence.HeartbeatAt) started_at=$($exitEvidence.StartedAt) window_ms=$($policy.WindowMs)"
    $state = [pscustomobject]@{
      firstExitAt = ''
      lastExitAt = (Get-Date).ToUniversalTime().ToString('o')
      count = 0
      cooldownUntil = ''
      lastPid = $OwnerPid
      lastReason = 'outside_window'
      lockAgeMs = $lockAgeMs
      effectiveRuntimeMs = $effectiveRuntimeMs
      runtimeAgeSource = $exitEvidence.AgeSource
      heartbeatAt = $exitEvidence.HeartbeatAt
      startedAt = $exitEvidence.StartedAt
    }
    [void](Write-JsonFileSafe -Path $mainRestartStateFile -Value $state)
    return [pscustomobject]@{ Blocked = $false; Reason = 'outside_window'; Count = 0; CooldownUntil = ''; Evidence = $exitEvidence }
  }

  $now = (Get-Date).ToUniversalTime()
  $state = Read-JsonFileSafe -Path $mainRestartStateFile
  $firstExitAt = [datetime]::MinValue
  $cooldownUntil = [datetime]::MinValue
  if ($null -ne $state) {
    [void][datetime]::TryParse([string]$state.firstExitAt, [ref]$firstExitAt)
    [void][datetime]::TryParse([string]$state.cooldownUntil, [ref]$cooldownUntil)
  }

  if ($cooldownUntil -gt $now) {
    $activeCount = 0
    [void][int]::TryParse([string]$state.count, [ref]$activeCount)
    return [pscustomobject]@{
      Blocked = $true
      Reason = 'cooldown_active'
      Count = $activeCount
      CooldownUntil = $cooldownUntil.ToString('o')
    }
  }

  $count = 1
  if ($firstExitAt -ne [datetime]::MinValue -and (($now - $firstExitAt).TotalMilliseconds -le $policy.WindowMs)) {
    $priorCount = 0
    [void][int]::TryParse([string]$state.count, [ref]$priorCount)
    $count = $priorCount + 1
  } else {
    $firstExitAt = $now
  }

  $blocked = $count -ge $policy.MaxRestarts
  $newCooldownUntil = if ($blocked) { $now.AddMilliseconds($policy.CooldownMs) } else { [datetime]::MinValue }
  $newState = [pscustomobject]@{
    firstExitAt = $firstExitAt.ToString('o')
    lastExitAt = $now.ToString('o')
    count = $count
    cooldownUntil = if ($blocked) { $newCooldownUntil.ToString('o') } else { '' }
    lastPid = $OwnerPid
    lastReason = 'hard_exit_while_lock_owned'
    lockAgeMs = $lockAgeMs
    effectiveRuntimeMs = $effectiveRuntimeMs
    runtimeAgeSource = $exitEvidence.AgeSource
    heartbeatAt = $exitEvidence.HeartbeatAt
    startedAt = $exitEvidence.StartedAt
    windowMs = $policy.WindowMs
    maxRestarts = $policy.MaxRestarts
    cooldownMs = $policy.CooldownMs
  }
  [void](Write-JsonFileSafe -Path $mainRestartStateFile -Value $newState)

  return [pscustomobject]@{
    Blocked = $blocked
    Reason = if ($blocked) { 'threshold_reached' } else { 'counted' }
    Count = $count
    CooldownUntil = if ($blocked) { $newCooldownUntil.ToString('o') } else { '' }
    Evidence = $exitEvidence
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
  $httpReverseIngressState = Get-MainHttpReverseIngressState
  if (Test-LockOwnedByRunningNode -LockPath $lockFile) {
    $lockDiag = Get-LockProcessDiagnostics -LockPath $lockFile
    Write-DaemonLog -Message "bot already running, skip duplicate start. $lockDiag"
  } else {
    $previousMainPid = 0
    if (Test-Path $lockFile) {
      $previousMainPid = Read-PositivePidFromFile -FilePath $lockFile
      $lockDiag = Get-LockProcessDiagnostics -LockPath $lockFile
      Write-DaemonLog -Message "lock present but not owned by active main bot. $lockDiag"
      $earlyExitState = Update-MainBotEarlyExitState -LockPath $lockFile -OwnerPid $previousMainPid
      Record-MainBotExitObservation -OwnerPid $previousMainPid -Reason 'lock_present_not_owned' -LockDiagnostics $lockDiag -Evidence $earlyExitState.Evidence -EarlyExitState $earlyExitState
      if ($earlyExitState.Blocked) {
        if ($httpReverseIngressState.Outage -and (-not (Test-RecentMainHttpReversePortRecovery -Port $httpReverseIngressState.Port))) {
          Record-MainHttpReversePortRecovery -Port $httpReverseIngressState.Port -PreviousPid $previousMainPid -EarlyExitCount $earlyExitState.Count -CooldownUntil $earlyExitState.CooldownUntil
          Write-DaemonLog -Message "main bot early-exit backoff bypassed for HTTP reverse port outage. port=$($httpReverseIngressState.Port), previous_pid=$previousMainPid, count=$($earlyExitState.Count), cooldown_until=$($earlyExitState.CooldownUntil)"
        } else {
          throw "main bot exited repeatedly soon after startup; backoff active (reason=$($earlyExitState.Reason), count=$($earlyExitState.Count), cooldown_until=$($earlyExitState.CooldownUntil), http_reverse_enabled=$($httpReverseIngressState.Enabled), http_reverse_port=$($httpReverseIngressState.Port), http_reverse_listening=$($httpReverseIngressState.Listening), $lockDiag)"
        }
      }
      if ($earlyExitState.Reason -ne 'disabled' -and $earlyExitState.Reason -ne 'no_owner_pid') {
        Write-DaemonLog -Message "main bot early-exit state updated. reason=$($earlyExitState.Reason), previous_pid=$previousMainPid, count=$($earlyExitState.Count), cooldown_until=$($earlyExitState.CooldownUntil)"
      }
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
