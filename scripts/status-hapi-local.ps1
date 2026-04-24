$ErrorActionPreference = 'Stop'

$env:HAPI_HOME = 'D:\waifu\data\hapi-home'
if (-not $env:CLI_API_TOKEN -and $env:HAPI_CLI_API_TOKEN) {
  $env:CLI_API_TOKEN = $env:HAPI_CLI_API_TOKEN
}
$env:HAPI_CLAUDE_PATH = 'C:\Users\Administrator\AppData\Roaming\npm\claude.cmd'
$env:CLAUDE_PATH = 'C:\Users\Administrator\AppData\Roaming\npm\claude.cmd'
$npmBin = 'C:\Users\Administrator\AppData\Roaming\npm'
if (-not (($env:PATH -split ';') -contains $npmBin)) {
  $env:PATH = "$npmBin;$env:PATH"
}

Write-Host '== HAPI auth status =='
hapi auth status

Write-Host ''
Write-Host '== HAPI runner status =='
hapi runner status

Write-Host ''
Write-Host '== HAPI runner sessions =='
hapi runner list
