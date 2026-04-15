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
$workerPidFile = Join-Path $repoRoot '.mizukibot-postreply-worker.pid'

function Write-DaemonLog {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Message
  )

  $stamp = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
  "[$stamp] $Message" | Out-File -FilePath $logFile -Append -Encoding utf8
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

function Test-LockOwnedByRunningNode {
  param(
    [Parameter(Mandatory = $true)]
    [string]$LockPath
  )

  if (-not (Test-Path $LockPath)) {
    return $false
  }

  try {
    $ownerPidText = (Get-Content -Path $LockPath -TotalCount 1 -Encoding utf8).Trim()
    $ownerPid = [int]$ownerPidText
    if ($ownerPid -le 0) {
      return $false
    }

    $proc = Get-Process -Id $ownerPid -ErrorAction SilentlyContinue
    if ($null -eq $proc -or $proc.ProcessName -ine 'node') {
      return $false
    }

    $commandLine = ''
    try {
      $cim = Get-CimInstance Win32_Process -Filter "ProcessId = $ownerPid" -ErrorAction Stop
      $commandLine = [string]$cim.CommandLine
    } catch {}

    if (-not [string]::IsNullOrWhiteSpace($commandLine) -and $commandLine -match 'index\.js') {
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
    $ownerPidText = (Get-Content -Path $LockPath -TotalCount 1 -Encoding utf8).Trim()
    $ownerPid = [int]$ownerPidText
    if ($ownerPid -le 0) {
      return "lock pid invalid: '$ownerPidText'"
    }

    $proc = Get-Process -Id $ownerPid -ErrorAction SilentlyContinue
    if ($null -eq $proc) {
      return "lock pid=$ownerPid not running"
    }

    $commandLine = ''
    try {
      $cim = Get-CimInstance Win32_Process -Filter "ProcessId = $ownerPid" -ErrorAction Stop
      $commandLine = [string]$cim.CommandLine
    } catch {}

    if ([string]::IsNullOrWhiteSpace($commandLine)) {
      return "lock pid=$ownerPid name=$($proc.ProcessName) path=$($proc.Path)"
    }

    return "lock pid=$ownerPid name=$($proc.ProcessName) cmd=$commandLine"
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
    $ownerPidText = (Get-Content -Path $PidFile -TotalCount 1 -Encoding utf8).Trim()
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
    $mainProc = Start-Process -FilePath $nodeExe -ArgumentList 'index.js' -WorkingDirectory $repoRoot -WindowStyle Hidden -PassThru
    Write-DaemonLog -Message "started main bot pid=$($mainProc.Id)"
    Start-Sleep -Seconds 2
    if (-not (Test-LockOwnedByRunningNode -LockPath $lockFile)) {
      $lockDiag = Get-LockProcessDiagnostics -LockPath $lockFile
      throw "main bot did not acquire lock after daemon start ($lockDiag)"
    }
  }

  if (Test-WorkerOwnedByRunningNode -PidFile $workerPidFile) {
    Write-DaemonLog -Message 'post-reply worker already running, skip duplicate start.'
  } else {
    $workerProc = Start-Process -FilePath $nodeExe -ArgumentList 'scripts/post-reply-worker.js' -WorkingDirectory $repoRoot -WindowStyle Hidden -PassThru
    Set-Content -Path $workerPidFile -Value $workerProc.Id -Encoding utf8
    Write-DaemonLog -Message "started post-reply worker pid=$($workerProc.Id)"
  }
} catch {
  $exitCode = 1
  Write-DaemonLog -Message "daemon task error: $($_.Exception.Message)"
} finally {
  Write-DaemonLog -Message "daemon task exited with code $exitCode"
}

exit $exitCode
