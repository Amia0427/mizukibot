param(
  [string]$Message = '',
  [string]$SessionId = '',
  [string]$WorkspaceRoot = 'D:\waifu'
)

$ErrorActionPreference = 'Stop'

$codex = Get-Command codex -ErrorAction Stop
$args = @()

if ($SessionId) {
  $args += @('--session-id', $SessionId)
}

if ($WorkspaceRoot) {
  Set-Location -LiteralPath $WorkspaceRoot
}

if ($Message) {
  $args += $Message
}

& powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "& '$($codex.Source)' $($args | ForEach-Object { [Management.Automation.Language.CodeGeneration]::QuoteArgument($_) } | Out-String)"
