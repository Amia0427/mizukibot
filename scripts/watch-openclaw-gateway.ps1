$ErrorActionPreference = 'Stop'

$Port = 18789
$RunScript = 'D:\waifu\scripts\run-openclaw-userprofile-gateway.ps1'
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
        Write-WatchdogLog "watch ok: gateway listening on port $Port"
        exit 0
    }

    Write-WatchdogLog "watch detected port $Port is not listening; invoking recovery"
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $RunScript
    exit $LASTEXITCODE
} catch {
    Write-WatchdogLog "watch failed: $($_.Exception.Message)"
    exit 1
}
