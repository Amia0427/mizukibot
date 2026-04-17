param(
  [string]$Message = '',
  [string]$SessionId = '',
  [string]$WorkspaceRoot = 'D:\waifu',
  [string]$Model = '',
  [string]$PermissionMode = 'default',
  [switch]$PlainText,
  [switch]$ReturnMetadata,
  [string]$TranscriptPath = '',
  [string]$ResumeSessionId = ''
)

$ErrorActionPreference = 'Stop'

$claudeCmd = Get-Command claude -ErrorAction Stop
$sessionIdToUse = if ($ResumeSessionId) { $ResumeSessionId } else { $SessionId }
$args = @('-p')

if ($sessionIdToUse -and $sessionIdToUse -match '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$') {
  $args += @('--session-id', $sessionIdToUse)
}

if (-not $PlainText) {
  $args += @('--verbose', '--output-format', 'stream-json')
}

if ($WorkspaceRoot) {
  $args += @('--add-dir', $WorkspaceRoot)
}

if ($PermissionMode) {
  $args += @('--permission-mode', $PermissionMode)
}

if ($Model) {
  $args += @('--model', $Model)
}

$args += $Message

$rawLines = @(& $claudeCmd.Source @args 2>&1)
$exitCode = $LASTEXITCODE
$rawOutput = ($rawLines | ForEach-Object { [string]$_ }) -join "`n"

function Get-LatestTranscriptPath {
  param(
    [string]$Workspace = ''
  )

  if ($TranscriptPath -and (Test-Path $TranscriptPath)) {
    return (Resolve-Path $TranscriptPath).Path
  }

  if (-not $Workspace) {
    return ''
  }

  $workspaceSlug = $Workspace.Replace(':', '').Replace('\', '-').Replace('/', '-')
  $projectDir = Join-Path $HOME ".claude\projects\$workspaceSlug"
  if (-not (Test-Path $projectDir)) {
    return ''
  }

  $latest = Get-ChildItem $projectDir -Filter '*.jsonl' -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime -Descending |
    Select-Object -First 1
  if (-not $latest) {
    return ''
  }
  return $latest.FullName
}

function Get-LatestSessionIdFromOutput {
  foreach ($line in $rawLines) {
    $text = [string]$line
    if ($text -match '"session_id":"([0-9a-fA-F-]+)"') {
      return $matches[1]
    }
    if ($text -match '"session_id":"([^"]+)"') {
      return $matches[1]
    }
  }
  return ''
}

if ($ReturnMetadata) {
  $metadata = [ordered]@{
    session_id = Get-LatestSessionIdFromOutput
    transcript_path = Get-LatestTranscriptPath -Workspace $WorkspaceRoot
    status = if ($exitCode -eq 0) { 'ok' } else { 'error' }
    output = $rawOutput
  }
  ($metadata | ConvertTo-Json -Depth 4 -Compress)
  exit $exitCode
}

if (-not $PlainText) {
  $rawOutput
  exit $exitCode
}

$lines = @($rawLines | ForEach-Object { [string]$_ })
$resultLine = $lines | Where-Object { $_ -match '"type":"result"' } | Select-Object -Last 1
if (-not $resultLine) {
  $assistantLine = $lines | Where-Object { $_ -match '"type":"assistant"' } | Select-Object -Last 1
  if ($assistantLine) {
    try {
      $parsedAssistant = $assistantLine | ConvertFrom-Json -Depth 20
      $textChunks = @($parsedAssistant.message.content | Where-Object { $_.type -eq 'text' } | ForEach-Object { $_.text })
      if ($textChunks.Count -gt 0) {
        ($textChunks -join "`n").Trim()
        exit $exitCode
      }
    } catch {}
  }
  $rawOutput
  exit $exitCode
}

try {
  $parsed = $resultLine | ConvertFrom-Json -Depth 20
  $resultText = [string]$parsed.result
  if ($resultText) {
    $resultText.Trim()
    exit $exitCode
  }
} catch {}

$rawOutput
exit $exitCode
