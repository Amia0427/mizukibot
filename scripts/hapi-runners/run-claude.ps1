param(
  [string]$Message = '',
  [string]$SessionId = '',
  [string]$WorkspaceRoot = 'D:\waifu',
  [string]$Model = '',
  [string]$PermissionMode = 'default'
)

$ErrorActionPreference = 'Stop'

$claudeCmd = Get-Command claude -ErrorAction Stop
$args = @(
  '-p',
  '--output-format', 'stream-json',
  '--add-dir', $WorkspaceRoot,
  '--permission-mode', $PermissionMode
)

if ($SessionId) {
  $args += @('--session-id', $SessionId)
}

if ($Model) {
  $args += @('--model', $Model)
}

$args += $Message

& $claudeCmd.Source @args
