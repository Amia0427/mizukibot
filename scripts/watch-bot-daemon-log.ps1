param(
  [int]$TailLines = 200,
  [switch]$NoWait
)

$ErrorActionPreference = 'Stop'
if (Get-Variable -Name PSNativeCommandUseErrorActionPreference -ErrorAction SilentlyContinue) {
  $PSNativeCommandUseErrorActionPreference = $false
}

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot '..')
$dataDir = Join-Path $repoRoot 'data'
$logFiles = @(
  [pscustomobject]@{ Name = 'daemon'; Path = (Join-Path $dataDir 'bot-daemon.log') }
  [pscustomobject]@{ Name = 'bot stdout'; Path = (Join-Path $dataDir 'bot-runtime.out.log') }
  [pscustomobject]@{ Name = 'bot stderr'; Path = (Join-Path $dataDir 'bot-runtime.err.log') }
  [pscustomobject]@{ Name = 'worker stdout'; Path = (Join-Path $dataDir 'post-reply-worker.out.log') }
  [pscustomobject]@{ Name = 'worker stderr'; Path = (Join-Path $dataDir 'post-reply-worker.err.log') }
)

if (-not (Test-Path $dataDir)) {
  New-Item -ItemType Directory -Path $dataDir -Force | Out-Null
}

foreach ($entry in $logFiles) {
  if (-not (Test-Path $entry.Path)) {
    New-Item -ItemType File -Path $entry.Path -Force | Out-Null
  }
}

try {
  $Host.UI.RawUI.WindowTitle = 'MizukiBot Log'
} catch {
}

Write-Host '=== MizukiBot Log ==='
foreach ($entry in $logFiles) {
  Write-Host ("{0}: {1}" -f $entry.Name, $entry.Path)
}
Write-Host 'press Ctrl+C to close'
Write-Host ''

$paths = @($logFiles | ForEach-Object { $_.Path })
if ($NoWait) {
  Get-Content -LiteralPath $paths -Tail $TailLines
} else {
  Get-Content -LiteralPath $paths -Tail $TailLines -Wait
}
