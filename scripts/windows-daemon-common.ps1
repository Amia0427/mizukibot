$ErrorActionPreference = 'Stop'

function Get-DaemonPaths {
  param(
    [Parameter(Mandatory = $true)]
    [string]$ScriptRoot,
    [string]$TaskName = 'MizukiBotDaemon'
  )

  $runner = Resolve-Path (Join-Path $ScriptRoot 'run-bot-daemon.ps1')
  $startupDir = [Environment]::GetFolderPath('Startup')
  $powerShellExe = (Get-Command powershell.exe -ErrorAction SilentlyContinue).Source
  if (-not $powerShellExe) {
    $powerShellExe = Join-Path $env:WINDIR 'System32\WindowsPowerShell\v1.0\powershell.exe'
  }

  [pscustomobject]@{
    Runner = [string]$runner
    StartupDir = $startupDir
    StartupLauncher = Join-Path $startupDir ($TaskName + '.cmd')
    PowerShellExe = $powerShellExe
    UserId = '{0}\{1}' -f $env:USERDOMAIN, $env:USERNAME
  }
}

function Get-DaemonTaskService {
  $service = New-Object -ComObject 'Schedule.Service'
  $service.Connect()
  return $service
}

function Get-DaemonScheduledTask {
  param(
    [Parameter(Mandatory = $true)]
    [string]$TaskName
  )

  try {
    $service = Get-DaemonTaskService
    $root = $service.GetFolder('\')
    return $root.GetTask($TaskName)
  } catch {
    return $null
  }
}

function Register-DaemonScheduledTask {
  param(
    [Parameter(Mandatory = $true)]
    [string]$TaskName,
    [Parameter(Mandatory = $true)]
    [string]$ScriptRoot
  )

  $paths = Get-DaemonPaths -ScriptRoot $ScriptRoot -TaskName $TaskName
  $service = Get-DaemonTaskService
  $root = $service.GetFolder('\')
  $task = $service.NewTask(0)

  $task.RegistrationInfo.Description = 'MizukiBot local daemon guard'
  $task.Settings.Enabled = $true
  $task.Settings.StartWhenAvailable = $true
  $task.Settings.AllowDemandStart = $true
  $task.Settings.Hidden = $false
  $task.Settings.MultipleInstances = 2
  $task.Settings.DisallowStartIfOnBatteries = $false
  $task.Settings.StopIfGoingOnBatteries = $false
  $task.Settings.ExecutionTimeLimit = 'PT0S'

  $task.Principal.UserId = $paths.UserId
  $task.Principal.LogonType = 3
  $task.Principal.RunLevel = 0

  $daily = $task.Triggers.Create(2)
  $daily.StartBoundary = (Get-Date).ToString("yyyy-MM-dd'T'HH:mm:ss")
  $daily.DaysInterval = 1
  $daily.Enabled = $true
  $daily.Repetition.Interval = 'PT2H'
  $daily.Repetition.Duration = 'P1D'
  $daily.Repetition.StopAtDurationEnd = $false

  $logon = $task.Triggers.Create(9)
  $logon.Enabled = $true
  $logon.UserId = $paths.UserId

  $boot = $task.Triggers.Create(8)
  $boot.Enabled = $true
  $boot.Delay = 'PT30S'

  $action = $task.Actions.Create(0)
  $action.Path = $paths.PowerShellExe
  $action.Arguments = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$($paths.Runner)`""
  $action.WorkingDirectory = Split-Path -Parent $paths.Runner

  $null = $root.RegisterTaskDefinition($TaskName, $task, 6, $paths.UserId, $null, 3, $null)
  return Get-DaemonScheduledTask -TaskName $TaskName
}

function Start-DaemonScheduledTaskNow {
  param(
    [Parameter(Mandatory = $true)]
    [string]$TaskName
  )

  $task = Get-DaemonScheduledTask -TaskName $TaskName
  if (-not $task) {
    return $false
  }
  $null = $task.Run($null)
  return $true
}

function Remove-DaemonScheduledTask {
  param(
    [Parameter(Mandatory = $true)]
    [string]$TaskName
  )

  $service = Get-DaemonTaskService
  $root = $service.GetFolder('\')
  try {
    $root.DeleteTask($TaskName, 0)
    return $true
  } catch {
    return $false
  }
}

function Install-DaemonStartupLauncher {
  param(
    [Parameter(Mandatory = $true)]
    [string]$TaskName,
    [Parameter(Mandatory = $true)]
    [string]$ScriptRoot
  )

  $paths = Get-DaemonPaths -ScriptRoot $ScriptRoot -TaskName $TaskName
  if (-not (Test-Path $paths.StartupDir)) {
    New-Item -ItemType Directory -Path $paths.StartupDir -Force | Out-Null
  }
  $content = @(
    '@echo off'
    ('"{0}" -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "{1}"' -f $paths.PowerShellExe, $paths.Runner)
  )
  Set-Content -Path $paths.StartupLauncher -Value $content -Encoding ascii
  return $paths.StartupLauncher
}

function Remove-DaemonStartupLauncher {
  param(
    [Parameter(Mandatory = $true)]
    [string]$TaskName,
    [Parameter(Mandatory = $true)]
    [string]$ScriptRoot
  )

  $paths = Get-DaemonPaths -ScriptRoot $ScriptRoot -TaskName $TaskName
  if (Test-Path $paths.StartupLauncher) {
    Remove-Item -Path $paths.StartupLauncher -Force
    return $true
  }
  return $false
}

function Get-DaemonStartupLauncherPath {
  param(
    [Parameter(Mandatory = $true)]
    [string]$TaskName,
    [Parameter(Mandatory = $true)]
    [string]$ScriptRoot
  )

  $paths = Get-DaemonPaths -ScriptRoot $ScriptRoot -TaskName $TaskName
  return $paths.StartupLauncher
}

function Convert-DaemonTaskState {
  param([int]$State)

  switch ($State) {
    0 { 'Unknown' }
    1 { 'Disabled' }
    2 { 'Queued' }
    3 { 'Ready' }
    4 { 'Running' }
    default { "State-$State" }
  }
}
