# 定期重启Bot脚本
# 用途：每6小时重启一次Bot以释放内存

param(
  [string]$LogFile = ""
)

$ErrorActionPreference = 'Stop'
$ScriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$ProjectRoot = Split-Path -Parent $ScriptRoot

if ($LogFile -eq "") {
  $LogFile = Join-Path $ProjectRoot "data\bot-restart.log"
}

function Write-Log {
  param([string]$Message)
  $timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
  $logEntry = "[$timestamp] $Message"
  Write-Host $logEntry
  Add-Content -Path $LogFile -Value $logEntry -Encoding UTF8
}

try {
  Write-Log "=== Periodic restart triggered ==="

  # 读取锁文件获取当前PID
  $lockFile = Join-Path $ProjectRoot ".mizukibot.lock"
  if (Test-Path $lockFile) {
    $currentPid = Get-Content $lockFile -Raw | ForEach-Object { $_.Trim() }
    Write-Log "Current Bot PID: $currentPid"

    # 检查进程是否存在
    $process = Get-Process -Id $currentPid -ErrorAction SilentlyContinue
    if ($process) {
      Write-Log "Stopping Bot process $currentPid..."
      Stop-Process -Id $currentPid -Force
      Start-Sleep -Seconds 2
      Write-Log "Bot stopped"
    } else {
      Write-Log "Bot process $currentPid not found (already stopped?)"
    }
  } else {
    Write-Log "Lock file not found, searching for node processes..."
    # 尝试找到node index.js进程
    $nodeProcesses = Get-Process node -ErrorAction SilentlyContinue | Where-Object {
      $_.CommandLine -like "*index.js*" -and $_.CommandLine -notlike "*post-reply-worker*"
    }
    if ($nodeProcesses) {
      foreach ($proc in $nodeProcesses) {
        Write-Log "Stopping node process $($proc.Id)..."
        Stop-Process -Id $proc.Id -Force
      }
      Start-Sleep -Seconds 2
    }
  }

  # 启动Bot
  Write-Log "Starting Bot..."
  Push-Location $ProjectRoot
  try {
    $startProcess = Start-Process -FilePath "npm" -ArgumentList "start" -NoNewWindow -PassThru
    Write-Log "Bot started with PID: $($startProcess.Id)"
  } finally {
    Pop-Location
  }

  Write-Log "=== Periodic restart completed ==="

} catch {
  Write-Log "ERROR: $($_.Exception.Message)"
  Write-Log "Stack: $($_.ScriptStackTrace)"
  exit 1
}
