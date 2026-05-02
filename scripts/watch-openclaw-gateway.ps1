$ErrorActionPreference = 'Stop'

$taskName = 'OpenClawGatewayStable'
$gatewayPort = 18789
$gatewayScriptPattern = 'C:\Users\Administrator\openclaw\node_modules\openclaw\dist\index.js'
$gatewayArgsPattern = 'gateway --port 18789'
$launcherPattern = 'run-openclaw-userprofile-gateway.ps1'

function Get-GatewayPids {
  @(Get-NetTCPConnection -State Listen -LocalPort $gatewayPort -ErrorAction SilentlyContinue |
    Select-Object -ExpandProperty OwningProcess -Unique)
}

function Get-GatewayProcesses {
  $pids = Get-GatewayPids
  if (-not $pids -or $pids.Count -eq 0) {
    return @()
  }

  @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
    Where-Object {
      $pids -contains $_.ProcessId -and (
        ($_.CommandLine -like "*$gatewayScriptPattern*" -and $_.CommandLine -like "*$gatewayArgsPattern*") -or
        ($_.CommandLine -like "*$launcherPattern*")
      )
    })
}

function Test-GatewayHealthy {
  $procs = @(Get-GatewayProcesses)
  return $procs.Count -gt 0
}

function Stop-StaleGateway {
  $pids = Get-GatewayPids
  if ($pids -and $pids.Count -gt 0) {
    foreach ($gatewayPid in $pids) {
      try {
        Stop-Process -Id $gatewayPid -Force -ErrorAction Stop
      } catch {
      }
    }
  }
}

if (Test-GatewayHealthy) {
  Write-Output 'GATEWAY_HEALTHY'
  exit 0
}

try {
  Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue | Out-Null
} catch {
}

Stop-StaleGateway

Start-ScheduledTask -TaskName $taskName
Start-Sleep -Seconds 15

if (Test-GatewayHealthy) {
  Write-Output 'GATEWAY_RECOVERED'
  exit 0
}

Write-Error 'OpenClaw gateway watchdog failed to recover the gateway.'
exit 1
