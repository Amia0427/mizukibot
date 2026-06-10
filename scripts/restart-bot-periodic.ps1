# 定期重启Bot脚本
# 用途：每天凌晨 04:00 重启一次Bot以释放内存

param(
  [string]$LogFile = "",
  [switch]$ValidateOnly
)

$ErrorActionPreference = 'Stop'
$ScriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$ProjectRoot = Split-Path -Parent $ScriptRoot

if ($LogFile -eq "") {
  $LogFile = Join-Path $ProjectRoot "data\bot-restart.log"
}

$logDir = Split-Path -Parent $LogFile
if ($logDir -and -not (Test-Path $logDir)) {
  New-Item -ItemType Directory -Path $logDir -Force | Out-Null
}

function Write-Log {
  param([string]$Message)
  $timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
  $logEntry = "[$timestamp] $Message"
  Write-Host $logEntry
  Add-Content -Path $LogFile -Value $logEntry -Encoding UTF8
}

function Resolve-NodeExecutable {
  $cmd = Get-Command node.exe -ErrorAction SilentlyContinue
  if (-not $cmd) {
    $cmd = Get-Command node -ErrorAction SilentlyContinue
  }
  if ($cmd -and $cmd.Source -and (Test-Path $cmd.Source)) {
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
  param([Parameter(Mandatory = $true)][int]$ProcessId)

  if ($ProcessId -le 0) {
    return ''
  }

  try {
    $proc = Get-CimInstance Win32_Process -Filter "ProcessId = $ProcessId" -ErrorAction Stop
    return [string]$proc.CommandLine
  } catch {
    return ''
  }
}

function Read-PidFileText {
  param([Parameter(Mandatory = $true)][string]$FilePath)

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

function Test-CommandLineLooksLikeMainBot {
  param([string]$CommandLine)

  $value = ([string]$CommandLine).Trim()
  if ([string]::IsNullOrWhiteSpace($value)) {
    return $false
  }

  return ($value -like '*index.js*') -and ($value -notlike '*post-reply-worker*')
}

function Test-ProcessIsMainBot {
  param([Parameter(Mandatory = $true)][int]$ProcessId)

  $proc = Get-Process -Id $ProcessId -ErrorAction SilentlyContinue
  if ($null -eq $proc -or $proc.ProcessName -ine 'node') {
    return $false
  }

  $commandLine = Get-ProcessCommandLine -ProcessId $ProcessId
  if ([string]::IsNullOrWhiteSpace($commandLine)) {
    return $true
  }

  return Test-CommandLineLooksLikeMainBot -CommandLine $commandLine
}

function Test-LockOwnedByRunningMainBot {
  param([Parameter(Mandatory = $true)][string]$LockPath)

  $pidText = (Read-PidFileText -FilePath $LockPath).Trim()
  $ownerPid = 0
  $parsedPid = [int]::TryParse($pidText, [ref]$ownerPid)
  if ((-not $parsedPid) -or $ownerPid -le 0) {
    return $false
  }

  return Test-ProcessIsMainBot -ProcessId $ownerPid
}

function Get-LockDiagnostics {
  param([Parameter(Mandatory = $true)][string]$LockPath)

  if (-not (Test-Path $LockPath)) {
    return 'lock file missing'
  }

  $pidText = (Read-PidFileText -FilePath $LockPath).Trim()
  $ownerPid = 0
  $parsedPid = [int]::TryParse($pidText, [ref]$ownerPid)
  if ((-not $parsedPid) -or $ownerPid -le 0) {
    return "lock pid invalid: '$pidText'"
  }

  $proc = Get-Process -Id $ownerPid -ErrorAction SilentlyContinue
  if ($null -eq $proc) {
    return "lock pid=$ownerPid not running"
  }

  $commandLine = Get-ProcessCommandLine -ProcessId $ownerPid
  return "lock pid=$ownerPid name=$($proc.ProcessName) cmd=$commandLine"
}

function Get-RunningMainBotProcesses {
  try {
    return @(Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" -ErrorAction Stop | Where-Object {
      Test-CommandLineLooksLikeMainBot -CommandLine $_.CommandLine
    } | Sort-Object ProcessId)
  } catch {
    return @()
  }
}

try {
  Write-Log "=== Periodic restart triggered ==="

  $nodeExe = Resolve-NodeExecutable
  if (-not $nodeExe) {
    throw 'node.exe not found in PATH or common install locations.'
  }
  Write-Log "Using node: $nodeExe"

  if ($ValidateOnly) {
    Write-Log "Validation only; restart not executed"
    Write-Log "=== Periodic restart validation completed ==="
    exit 0
  }

  $lockFile = Join-Path $ProjectRoot ".mizukibot.lock"
  if (Test-Path $lockFile) {
    $currentPidText = (Read-PidFileText -FilePath $lockFile).Trim()
    $currentPid = 0
    $hasPid = [int]::TryParse($currentPidText, [ref]$currentPid)
    Write-Log "Current Bot PID: $currentPidText"

    $lockOwnedByBot = $false
    if ($hasPid -and $currentPid -gt 0) {
      $lockOwnedByBot = Test-ProcessIsMainBot -ProcessId $currentPid
    }

    if ($lockOwnedByBot) {
      Write-Log "Stopping Bot process $currentPid..."
      Stop-Process -Id $currentPid -Force
      Start-Sleep -Seconds 2
      Write-Log "Bot stopped"
    }
    if (-not $lockOwnedByBot) {
      $lockDiag = Get-LockDiagnostics -LockPath $lockFile
      Write-Log "Lock is not owned by a running main bot ($lockDiag)"
    }
  }

  if (-not (Test-Path $lockFile)) {
    Write-Log "Lock file not found, searching for node processes..."
    $nodeProcesses = Get-RunningMainBotProcesses
    foreach ($proc in $nodeProcesses) {
      Write-Log "Stopping node process $($proc.ProcessId)..."
      Stop-Process -Id $proc.ProcessId -Force
    }
    if ($nodeProcesses.Count -gt 0) {
      Start-Sleep -Seconds 2
    }
  }

  Write-Log "Starting Bot..."
  Push-Location $ProjectRoot
  try {
    $startProcess = Start-Process -FilePath $nodeExe -ArgumentList @("index.js") -WorkingDirectory $ProjectRoot -WindowStyle Hidden -PassThru
    Write-Log "Bot started with PID: $($startProcess.Id)"
    Start-Sleep -Seconds 3
    if (-not (Test-LockOwnedByRunningMainBot -LockPath $lockFile)) {
      $lockDiag = Get-LockDiagnostics -LockPath $lockFile
      throw "main bot did not acquire lock after periodic restart ($lockDiag)"
    }
  } finally {
    Pop-Location
  }

  Write-Log "=== Periodic restart completed ==="

} catch {
  Write-Log "ERROR: $($_.Exception.Message)"
  Write-Log "Stack: $($_.ScriptStackTrace)"
  exit 1
}
