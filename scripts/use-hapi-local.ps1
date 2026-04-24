$ErrorActionPreference = 'Stop'

$env:HAPI_HOME = 'D:\waifu\data\hapi-home'
if (-not $env:CLI_API_TOKEN -and $env:HAPI_CLI_API_TOKEN) {
  $env:CLI_API_TOKEN = $env:HAPI_CLI_API_TOKEN
}
$env:HAPI_API_URL = 'http://127.0.0.1:3006'
$env:HAPI_CLAUDE_PATH = 'C:\Users\Administrator\AppData\Roaming\npm\claude.cmd'
$env:CLAUDE_PATH = 'C:\Users\Administrator\AppData\Roaming\npm\claude.cmd'
$npmBin = 'C:\Users\Administrator\AppData\Roaming\npm'
if (-not (($env:PATH -split ';') -contains $npmBin)) {
  $env:PATH = "$npmBin;$env:PATH"
}

Write-Host "HAPI_HOME=$env:HAPI_HOME"
Write-Host "HAPI_API_URL=$env:HAPI_API_URL"
Write-Host "HAPI_CLAUDE_PATH=$env:HAPI_CLAUDE_PATH"
Write-Host "npm bin added to PATH: $npmBin"
Write-Host "CLI_API_TOKEN is set for current shell"
