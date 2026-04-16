$ErrorActionPreference = 'Stop'

$env:HAPI_HOME = 'D:\waifu\data\hapi-home'
$env:CLI_API_TOKEN = 'FUcQwzRjozCZIApUYZyd-B4zjkXj0Ief80_i618xH8Q'
$env:HAPI_API_URL = 'http://127.0.0.1:3006'
$npmBin = 'C:\Users\Administrator\AppData\Roaming\npm'
if (-not (($env:PATH -split ';') -contains $npmBin)) {
  $env:PATH = "$npmBin;$env:PATH"
}

Write-Host "HAPI_HOME=$env:HAPI_HOME"
Write-Host "HAPI_API_URL=$env:HAPI_API_URL"
Write-Host "npm bin added to PATH: $npmBin"
Write-Host "CLI_API_TOKEN is set for current shell"
