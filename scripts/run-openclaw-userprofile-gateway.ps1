$ErrorActionPreference = 'Stop'

$openclawHome = 'C:\Users\Administrator'
$tempDir = 'C:\Users\Administrator\AppData\Local\Temp'
if (-not (Test-Path $tempDir)) {
  $tempDir = 'C:\Windows\Temp'
}

$env:OPENCLAW_HOME = $openclawHome
$env:TMPDIR = $tempDir
$env:TEMP = $tempDir
$env:TMP = $tempDir
$env:OPENCLAW_GATEWAY_PORT = '18789'

foreach ($name in @(
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'http_proxy',
  'https_proxy',
  'all_proxy'
)) {
  Remove-Item "Env:$name" -ErrorAction SilentlyContinue
}

$env:NO_PROXY = 'localhost,127.0.0.1,::1'
$env:no_proxy = 'localhost,127.0.0.1,::1'

Set-Location 'C:\Users\Administrator\openclaw'

& 'C:\Program Files\nodejs\node.exe' 'C:\Users\Administrator\openclaw\node_modules\openclaw\dist\index.js' gateway --port 18789
