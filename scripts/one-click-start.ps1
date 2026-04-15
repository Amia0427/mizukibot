$ErrorActionPreference = 'Stop'

# 从 scripts 目录回到仓库根目录，确保相对路径稳定。
$repoRoot = Resolve-Path (Join-Path $PSScriptRoot '..')
Set-Location $repoRoot

Write-Host '================================================' -ForegroundColor Cyan
Write-Host 'MizukiBot One-Click Start' -ForegroundColor Cyan
Write-Host '================================================' -ForegroundColor Cyan

$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
if (-not $nodeCmd -or -not $nodeCmd.Source) {
  Write-Host '[ERROR] 未找到 node，请先安装 Node.js 并加入 PATH。' -ForegroundColor Red
  exit 1
}

$lockFile = Join-Path $repoRoot '.mizukibot.lock'

Write-Host '[1/4] 停止旧实例（如果存在）...'
if (Test-Path $lockFile) {
  $oldPidText = (Get-Content -Path $lockFile -TotalCount 1 -Encoding utf8).Trim()
  $oldPid = 0
  if ([int]::TryParse($oldPidText, [ref]$oldPid) -and $oldPid -gt 0) {
    Stop-Process -Id $oldPid -Force -ErrorAction SilentlyContinue
    Write-Host "[OK] 已尝试停止旧 PID: $oldPid"
  } else {
    Write-Host '[INFO] lock 文件为空或无效，跳过停止。'
  }
} else {
  Write-Host '[INFO] 未发现 lock 文件，跳过停止。'
}

Write-Host '[2/4] 清理 lock 文件...'
if (Test-Path $lockFile) {
  Set-Content -Path $lockFile -Value '' -Encoding utf8 -ErrorAction SilentlyContinue
}
Write-Host '[OK] lock 已清理。'

function Import-DotEnv {
  param([Parameter(Mandatory = $true)][string]$FilePath)

  if (-not (Test-Path $FilePath)) { return 0 }

  $loaded = 0
  foreach ($rawLine in Get-Content -Path $FilePath -Encoding utf8) {
    # 去掉 BOM 与注释，保持 KEY=VALUE 解析稳定。
    $line = ([string]$rawLine).Trim().TrimStart([char]0xFEFF)
    if (-not $line) { continue }
    if ($line.StartsWith('#')) { continue }
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
    $loaded += 1
  }

  return $loaded
}

Write-Host '[3/4] 加载 .env 并后台启动...'
$envPath = Join-Path $repoRoot '.env'
$loadedCount = Import-DotEnv -FilePath $envPath
Write-Host "[INFO] 已加载环境变量: $loadedCount"

$proc = Start-Process -FilePath $nodeCmd.Source -ArgumentList 'index.js' -WorkingDirectory $repoRoot -WindowStyle Hidden -PassThru
Start-Sleep -Seconds 2

if (Test-Path $lockFile) {
  $newPid = (Get-Content -Path $lockFile -TotalCount 1 -Encoding utf8).Trim()
  Write-Host "[OK] LOCK_PID=$newPid"
} else {
  if ($proc.HasExited) {
    Write-Host "[ERROR] 进程已退出，ExitCode=$($proc.ExitCode)" -ForegroundColor Red
  } else {
    Write-Host "[WARN] 未发现 lock 文件，但进程仍在运行（PID=$($proc.Id)）。" -ForegroundColor Yellow
  }
}

Write-Host '[4/4] 触发守护任务自愈（可选）...'
try {
  & schtasks.exe /Run /TN 'MizukiBotDaemon' *> $null
  if ($LASTEXITCODE -eq 0) {
    Write-Host '[OK] 已触发守护任务 MizukiBotDaemon。'
  } else {
    Write-Host '[WARN] 未触发守护任务（可能尚未安装），可忽略。' -ForegroundColor Yellow
  }
} catch {
  Write-Host '[WARN] 未触发守护任务（可能尚未安装），可忽略。' -ForegroundColor Yellow
}

Write-Host '[DONE] 启动完成。' -ForegroundColor Green
exit 0
