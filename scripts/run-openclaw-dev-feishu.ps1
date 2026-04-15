$ErrorActionPreference = 'Stop'

$openclawCmd = 'C:\Users\Administrator\openclaw\openclaw.cmd'

foreach ($name in @(
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'all_proxy',
  'no_proxy'
)) {
  Remove-Item "Env:$name" -ErrorAction SilentlyContinue
}

& $openclawCmd --dev gateway run
