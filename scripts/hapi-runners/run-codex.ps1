param(
  [string]$Message = '',
  [string]$SessionId = '',
  [string]$WorkspaceRoot = 'D:\waifu'
)

$ErrorActionPreference = 'Stop'

$codexCmd = 'C:\Users\Administrator\AppData\Roaming\npm\codex.cmd'
if (-not (Test-Path $codexCmd)) {
  throw "Codex CLI shim not found: $codexCmd"
}
$args = @('exec')

if ($SessionId) {
  $args += @('-c', "experimental_resume=$SessionId")
}

if ($WorkspaceRoot) {
  $args += @('-C', $WorkspaceRoot)
}

if ($Message) {
  $args += $Message
}

& $codexCmd @args
