param(
  [string]$PipIndex = "https://pypi.tuna.tsinghua.edu.cn/simple"
)

$ErrorActionPreference = "Stop"

$projectRoot = Split-Path -Parent $PSScriptRoot
$depsDir = Join-Path $projectRoot ".skills_pydeps"
$binDir = Join-Path $projectRoot ".skills_bin"

Write-Host "[skills] project root: $projectRoot"
Write-Host "[skills] deps target : $depsDir"
Write-Host "[skills] bin target  : $binDir"

New-Item -ItemType Directory -Force -Path $depsDir | Out-Null
New-Item -ItemType Directory -Force -Path $binDir | Out-Null

# Keep all skill-related Python deps inside the project directory.
python -m pip install --disable-pip-version-check --no-cache-dir `
  -i $PipIndex `
  --target "$depsDir" `
  duckduckgo-search yt-dlp requests aiohttp websockets

# Windows shim: lets scripts that call "yt-dlp" work when only python package is installed.
$shimPath = Join-Path $binDir "yt-dlp.cmd"
@"
@echo off
python -m yt_dlp %*
"@ | Set-Content -Path $shimPath -Encoding ASCII

Write-Host "[skills] install completed."
Write-Host "[skills] tip: set env MIZUKI_SKILLS_PY_DEPS=$depsDir"
Write-Host "[skills] tip: set env MIZUKI_SKILLS_BIN=$binDir"

