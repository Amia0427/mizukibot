# 安装定期重启计划任务
# 每天 09:30、21:30 重启 Bot

param(
  [string]$TaskName = 'MizukiBotPeriodicRestart',
  [string[]]$DailyTime = @('09:30', '21:30'),
  [switch]$ValidateOnly
)

$ErrorActionPreference = 'Stop'
$ScriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$ProjectRoot = Split-Path -Parent $ScriptRoot
$RestartScript = Join-Path $ScriptRoot "restart-bot-periodic.ps1"

Write-Host "Installing periodic restart task..."
Write-Host "  Task name: $TaskName"
Write-Host "  Schedule: Daily at $($DailyTime -join ', ')"
Write-Host "  Script: $RestartScript"

try {
  $now = Get-Date
  $triggers = @(foreach ($dailyTimeValue in $DailyTime) {
    $dailyTimeMatch = [regex]::Match($dailyTimeValue, '^(?<hour>\d{1,2}):(?<minute>\d{2})$')
    if (-not $dailyTimeMatch.Success) {
      throw "DailyTime must be HH:mm, for example 09:30."
    }
    $dailyHour = [int]$dailyTimeMatch.Groups['hour'].Value
    $dailyMinute = [int]$dailyTimeMatch.Groups['minute'].Value
    if ($dailyHour -lt 0 -or $dailyHour -gt 23 -or $dailyMinute -lt 0 -or $dailyMinute -gt 59) {
      throw "DailyTime must be a valid 24-hour time, for example 09:30."
    }

    $firstRun = Get-Date -Date $now.Date -Hour $dailyHour -Minute $dailyMinute -Second 0
    if ($firstRun -le $now) {
      $firstRun = $firstRun.AddDays(1)
    }

    [pscustomobject]@{
      label = '{0:D2}:{1:D2}' -f $dailyHour, $dailyMinute
      startBoundary = $firstRun.ToString("yyyy-MM-ddTHH:mm:ss")
    }
  })
  if ($triggers.Count -eq 0) {
    throw 'DailyTime must contain at least one time.'
  }
  $dailyTimeLabels = @($triggers | ForEach-Object { $_.label })
  $triggerXml = ($triggers | ForEach-Object {
    @"
    <CalendarTrigger>
      <StartBoundary>$($_.startBoundary)</StartBoundary>
      <Enabled>true</Enabled>
      <ScheduleByDay>
        <DaysInterval>1</DaysInterval>
      </ScheduleByDay>
    </CalendarTrigger>
"@
  }) -join "`n"

  # 创建任务XML
  $taskXml = @"
<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>MizukiBot periodic restart daily at $($dailyTimeLabels -join ', ')</Description>
  </RegistrationInfo>
  <Triggers>
$triggerXml
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

  $taskPlan = [ordered]@{
    execute = -not [bool]$ValidateOnly
    taskName = $TaskName
    dailyTime = $dailyTimeLabels -join ', '
    dailyTimes = $dailyTimeLabels
    firstRuns = @($triggers | ForEach-Object { $_.startBoundary })
    restartScript = $RestartScript
    workingDirectory = $ProjectRoot
    taskXml = $taskXml
  }

  if ($ValidateOnly) {
    Write-Output ($taskPlan | ConvertTo-Json -Depth 4 -Compress)
    return
  }

  $isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
  if (-not $isAdmin) {
    Write-Warning "This script requires Administrator privileges."
    Write-Host "Please run PowerShell as Administrator and try again."
    exit 1
  }

  $existingTask = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  if ($existingTask) {
    Write-Host "Removing existing task..."
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
  }

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
  Write-Host "  - Schedule: Daily at $($dailyTimeLabels -join ', ')"
  Write-Host "  - First runs: $($triggers.startBoundary -join ', ')"
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
