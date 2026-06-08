# 安装定期重启计划任务
# 每6小时重启一次Bot

param(
  [string]$TaskName = 'MizukiBotPeriodicRestart',
  [int]$IntervalHours = 6
)

$ErrorActionPreference = 'Stop'
$ScriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$ProjectRoot = Split-Path -Parent $ScriptRoot
$RestartScript = Join-Path $ScriptRoot "restart-bot-periodic.ps1"

Write-Host "Installing periodic restart task..."
Write-Host "  Task name: $TaskName"
Write-Host "  Interval: Every $IntervalHours hours"
Write-Host "  Script: $RestartScript"

# 检查管理员权限
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
  Write-Warning "This script requires Administrator privileges."
  Write-Host "Please run PowerShell as Administrator and try again."
  exit 1
}

try {
  # 删除已存在的任务
  $existingTask = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  if ($existingTask) {
    Write-Host "Removing existing task..."
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
  }

  # 计算首次运行时间（6小时后）
  $startTime = (Get-Date).AddHours($IntervalHours).ToString("yyyy-MM-ddTHH:mm:ss")
  $intervalString = "PT${IntervalHours}H"

  # 创建任务XML
  $taskXml = @"
<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>MizukiBot periodic restart every $IntervalHours hours</Description>
  </RegistrationInfo>
  <Triggers>
    <TimeTrigger>
      <Repetition>
        <Interval>$intervalString</Interval>
        <StopAtDurationEnd>false</StopAtDurationEnd>
      </Repetition>
      <StartBoundary>$startTime</StartBoundary>
      <Enabled>true</Enabled>
    </TimeTrigger>
  </Triggers>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>false</Hidden>
    <RunOnlyIfIdle>false</RunOnlyIfIdle>
    <WakeToRun>false</WakeToRun>
    <ExecutionTimeLimit>PT5M</ExecutionTimeLimit>
    <Priority>7</Priority>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>powershell.exe</Command>
      <Arguments>-ExecutionPolicy Bypass -NoProfile -File "$RestartScript"</Arguments>
      <WorkingDirectory>$ProjectRoot</WorkingDirectory>
    </Exec>
  </Actions>
  <Principals>
    <Principal>
      <UserId>$env:USERNAME</UserId>
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>HighestAvailable</RunLevel>
    </Principal>
  </Principals>
</Task>
"@

  # 保存XML到临时文件
  $tempXml = [System.IO.Path]::Combine([System.IO.Path]::GetTempPath(), "mizuki-periodic-restart.xml")
  [System.IO.File]::WriteAllText($tempXml, $taskXml, [System.Text.Encoding]::Unicode)

  # 注册任务
  schtasks /create /tn $TaskName /xml $tempXml /f | Out-Null

  # 清理临时文件
  Remove-Item $tempXml -Force

  Write-Host ""
  Write-Host "[OK] Periodic restart task installed successfully!" -ForegroundColor Green
  Write-Host ""
  Write-Host "Task details:"
  Write-Host "  - Name: $TaskName"
  Write-Host "  - Interval: Every $IntervalHours hours"
  Write-Host "  - First run: $startTime"
  Write-Host ""
  Write-Host "To check task status, run:"
  Write-Host "  schtasks /query /tn $TaskName /fo list /v"
  Write-Host ""
  Write-Host "To uninstall, run:"
  Write-Host "  schtasks /delete /tn $TaskName /f"

} catch {
  Write-Host "[ERROR] Failed to install periodic restart task" -ForegroundColor Red
  Write-Host $_.Exception.Message
  exit 1
}
