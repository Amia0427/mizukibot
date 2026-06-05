$ErrorActionPreference = 'Stop'

$TaskName = 'OpenClaw Gateway'
$Port = 18789
$LogDir = 'C:\Users\Administrator\AppData\Local\Temp\openclaw'
$LogPath = Join-Path $LogDir 'gateway-watchdog.log'

function Write-WatchdogLog {
    param([string] $Message)
    New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
    $stamp = Get-Date -Format 'yyyy-MM-dd HH:mm:ss zzz'
    Add-Content -LiteralPath $LogPath -Value "$stamp $Message"
}

function Test-GatewayPort {
    try {
        $listeners = Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction Stop
        return ($null -ne $listeners)
    } catch {
        return $false
    }
}

try {
    if (Test-GatewayPort) {
        Write-WatchdogLog "gateway already listening on port $Port"
        exit 0
    }

    $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction Stop
    if ($task.State -eq 'Disabled') {
        Write-WatchdogLog "task '$TaskName' is disabled"
        exit 1
    }

    Write-WatchdogLog "starting scheduled task '$TaskName'"
    schtasks.exe /Run /TN $TaskName | Out-Null

    $deadline = (Get-Date).AddSeconds(60)
    while ((Get-Date) -lt $deadline) {
        Start-Sleep -Seconds 2
        if (Test-GatewayPort) {
            Write-WatchdogLog "gateway is listening on port $Port"
            exit 0
        }
    }

    Write-WatchdogLog "gateway did not bind port $Port within 60 seconds"
    exit 1
} catch {
    Write-WatchdogLog "failed: $($_.Exception.Message)"
    exit 1
}
