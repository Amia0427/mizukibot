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

function Test-CanOpenDaemonLogForWrite {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Path
  )

  try {
    $stream = [System.IO.File]::Open($Path, [System.IO.FileMode]::OpenOrCreate, [System.IO.FileAccess]::Write, [System.IO.FileShare]::Read)
    $stream.Close()
    return $true
  } catch {
    return $false
  }
}

function Resolve-DaemonWritableLogPath {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Path
  )

  if (Test-CanOpenDaemonLogForWrite -Path $Path) {
    Set-Content -LiteralPath $Path -Value '' -Encoding utf8
    return $Path
  }

  $fallbackPath = Get-DaemonFallbackLogPath -Path $Path
  Set-Content -LiteralPath $fallbackPath -Value '' -Encoding utf8
  Write-DaemonLog -Message "log file locked, using fallback log. requested=$Path fallback=$fallbackPath"
  return $fallbackPath
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

  return Start-Process `
    -FilePath $NodeExe `
    -ArgumentList $ArgumentList `
    -WorkingDirectory $repoRoot `
    -WindowStyle Hidden `
    -RedirectStandardOutput $resolvedStdoutLog `
    -RedirectStandardError $resolvedStderrLog `
    -PassThru
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
    return ($null -ne $proc -and $proc.ProcessName -ieq 'node')
  } catch {
    return $false
  }
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
    Start-Sleep -Seconds 2
    if (-not (Test-LockOwnedByRunningNode -LockPath $lockFile)) {
      $lockDiag = Get-LockProcessDiagnostics -LockPath $lockFile
      throw "main bot did not acquire lock after daemon start ($lockDiag)"
    }
  }

  if (Test-WorkerOwnedByRunningNode -PidFile $workerPidFile) {
    Write-DaemonLog -Message 'post-reply worker already running, skip duplicate start.'
  } else {
    $workerProc = Start-NodeDaemonProcess -NodeExe $nodeExe -ArgumentList @('scripts/post-reply-worker.js') -StdoutLog $workerStdoutLogFile -StderrLog $workerStderrLogFile
    Set-Content -Path $workerPidFile -Value $workerProc.Id -Encoding utf8
    Write-DaemonLog -Message "started post-reply worker pid=$($workerProc.Id), stdout=$workerStdoutLogFile, stderr=$workerStderrLogFile"
  }
} catch {
  $exitCode = 1
  Write-DaemonLog -Message "daemon task error: $($_.Exception.Message)"
} finally {
  Write-DaemonLog -Message "daemon task exited with code $exitCode"
}

exit $exitCode
