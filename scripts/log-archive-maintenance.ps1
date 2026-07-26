function Get-LogArchivePositiveInt64Env {
  param(
    [Parameter(Mandatory = $true)][string]$Name,
    [Parameter(Mandatory = $true)][Int64]$DefaultValue
  )

  $raw = [Environment]::GetEnvironmentVariable($Name, 'Process')
  [Int64]$parsed = 0
  if (-not [string]::IsNullOrWhiteSpace($raw) -and [Int64]::TryParse($raw.Trim(), [ref]$parsed) -and $parsed -ge 0) {
    return $parsed
  }
  return $DefaultValue
}

function Get-ManagedLogArchiveRecords {
  param([Parameter(Mandatory = $true)][string]$LogDirectory)

  if (-not (Test-Path -LiteralPath $LogDirectory)) { return @() }
  $records = @()
  foreach ($file in Get-ChildItem -LiteralPath $LogDirectory -File -ErrorAction SilentlyContinue) {
    $family = ''
    if ($file.Name -match '^(bot-daemon\.log)\.\d{8}-\d{6}-\d{3}$') {
      $family = $Matches[1]
    } elseif ($file.Name -match '^((?:bot-runtime|post-reply-worker)\.(?:out|err))\.\d{8}-\d{6}-\d{3}\.log$') {
      $family = $Matches[1]
    }
    if ($family) {
      $records += [pscustomobject]@{ File = $file; Family = $family }
    }
  }
  return @($records)
}

function Invoke-ManagedLogArchiveMaintenance {
  param(
    [Parameter(Mandatory = $true)][string]$LogDirectory,
    [scriptblock]$WarningSink = $null
  )

  $maxFiles = Get-LogArchivePositiveInt64Env -Name 'LOG_ROTATE_MAX_FILES' -DefaultValue 10
  $maxAgeMs = Get-LogArchivePositiveInt64Env -Name 'LOG_ROTATE_MAX_AGE_MS' -DefaultValue 2592000000
  $maxTotalBytes = Get-LogArchivePositiveInt64Env -Name 'LOG_ROTATE_MAX_TOTAL_BYTES' -DefaultValue 1073741824
  $nowUtc = [DateTime]::UtcNow

  $warn = {
    param([string]$Message)
    if ($null -ne $WarningSink) { & $WarningSink $Message } else { Write-Warning $Message }
  }
  $remove = {
    param($Record)
    try {
      Remove-Item -LiteralPath $Record.File.FullName -Force -ErrorAction Stop
      return $true
    } catch {
      & $warn "log archive cleanup failed; skipped path=$($Record.File.FullName) error=$($_.Exception.Message)"
      return $false
    }
  }

  if ($maxAgeMs -gt 0) {
    foreach ($record in Get-ManagedLogArchiveRecords -LogDirectory $LogDirectory) {
      if (($nowUtc - $record.File.LastWriteTimeUtc).TotalMilliseconds -gt $maxAgeMs) {
        [void](& $remove $record)
      }
    }
  }

  if ($maxFiles -gt 0) {
    $families = Get-ManagedLogArchiveRecords -LogDirectory $LogDirectory | Group-Object Family
    foreach ($family in $families) {
      $ordered = @($family.Group | Sort-Object { $_.File.LastWriteTimeUtc }, { $_.File.Name })
      $excess = [Math]::Max(0, $ordered.Count - $maxFiles)
      for ($index = 0; $index -lt $excess; $index += 1) {
        [void](& $remove $ordered[$index])
      }
    }
  }

  if ($maxTotalBytes -gt 0) {
    $ordered = @(Get-ManagedLogArchiveRecords -LogDirectory $LogDirectory | Sort-Object { $_.File.LastWriteTimeUtc }, { $_.File.Name })
    [Int64]$totalBytes = 0
    foreach ($activeName in @('bot-daemon.log','bot-runtime.out.log','bot-runtime.err.log','post-reply-worker.out.log','post-reply-worker.err.log')) {
      $activePath = Join-Path $LogDirectory $activeName
      if (Test-Path -LiteralPath $activePath -PathType Leaf) {
        try { $totalBytes += [Int64](Get-Item -LiteralPath $activePath -ErrorAction Stop).Length } catch {
          & $warn "active log capacity check failed; skipped path=$activePath error=$($_.Exception.Message)"
        }
      }
    }
    foreach ($record in $ordered) { $totalBytes += [Int64]$record.File.Length }
    foreach ($record in $ordered) {
      if ($totalBytes -le $maxTotalBytes) { break }
      if (& $remove $record) { $totalBytes -= [Int64]$record.File.Length }
    }
  }
}
