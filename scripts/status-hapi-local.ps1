$ErrorActionPreference = 'Stop'

$env:HAPI_HOME = 'D:\waifu\data\hapi-home'
$env:CLI_API_TOKEN = 'FUcQwzRjozCZIApUYZyd-B4zjkXj0Ief80_i618xH8Q'

Write-Host '== HAPI auth status =='
hapi auth status

Write-Host ''
Write-Host '== HAPI runner status =='
hapi runner status

Write-Host ''
Write-Host '== HAPI runner sessions =='
hapi runner list
