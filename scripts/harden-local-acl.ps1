param(
  [Parameter(Mandatory = $true)]
  [ValidateNotNullOrEmpty()]
  [string]$ServiceIdentity,

  [switch]$Apply,

  [string]$RootPath,

  [string]$SnapshotDirectory
)

$ErrorActionPreference = 'Stop'
$systemModules = Join-Path $env:WINDIR 'System32\WindowsPowerShell\v1.0\Modules'
$env:PSModulePath = "$PSHOME\Modules;$systemModules"
Import-Module Microsoft.PowerShell.Security -ErrorAction Stop
if ([string]::IsNullOrWhiteSpace($RootPath)) {
  $RootPath = Join-Path $PSScriptRoot '..'
}

function Resolve-FullPath {
  param([Parameter(Mandatory = $true)][string]$Path)

  return [System.IO.Path]::GetFullPath((Resolve-Path -LiteralPath $Path -ErrorAction Stop).ProviderPath).TrimEnd('\')
}

function Test-PathWithin {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][string]$Root
  )

  $normalizedPath = $Path.TrimEnd('\')
  $normalizedRoot = $Root.TrimEnd('\')
  return $normalizedPath.Equals($normalizedRoot, [System.StringComparison]::OrdinalIgnoreCase) -or
    $normalizedPath.StartsWith("$normalizedRoot\", [System.StringComparison]::OrdinalIgnoreCase)
}

function Resolve-ServiceSid {
  param([Parameter(Mandatory = $true)][string]$Identity)

  try {
    if ($Identity -match '^S-\d-') {
      return ([System.Security.Principal.SecurityIdentifier]::new($Identity)).Value
    }

    return ([System.Security.Principal.NTAccount]::new($Identity)).Translate(
      [System.Security.Principal.SecurityIdentifier]
    ).Value
  } catch {
    throw "ServiceIdentity '$Identity' could not be resolved to a Windows SID."
  }
}

function Get-AclSnapshot {
  param([Parameter(Mandatory = $true)][System.IO.FileSystemInfo]$Item)

  $acl = Get-Acl -LiteralPath $Item.FullName
  $rules = @($acl.Access | ForEach-Object {
    [pscustomobject]@{
      identity = $_.IdentityReference.ToString()
      type = $_.AccessControlType.ToString()
      rights = $_.FileSystemRights.ToString()
      inherited = [bool]$_.IsInherited
      inheritanceFlags = $_.InheritanceFlags.ToString()
      propagationFlags = $_.PropagationFlags.ToString()
    }
  })

  return [pscustomobject]@{
    path = $Item.FullName
    kind = if ($Item.PSIsContainer) { 'directory' } else { 'file' }
    owner = $acl.Owner.ToString()
    sddl = $acl.Sddl
    rules = $rules
  }
}

function Get-TargetItems {
  param(
    [Parameter(Mandatory = $true)][string]$Root,
    [Parameter(Mandatory = $true)][string]$RelativePath
  )

  $targetPath = Resolve-FullPath (Join-Path $Root $RelativePath)
  if (-not (Test-Path -LiteralPath $targetPath -PathType Any)) {
    throw "Required sensitive path does not exist: $targetPath"
  }

  $target = Get-Item -LiteralPath $targetPath -Force
  $items = @($target)
  if ($target.PSIsContainer) {
    $items += @(Get-ChildItem -LiteralPath $target.FullName -Force -Recurse -ErrorAction Stop)
  }

  foreach ($item in $items) {
    $fullPath = Resolve-FullPath $item.FullName
    if (-not (Test-PathWithin -Path $fullPath -Root $Root)) {
      throw "Sensitive path escaped RootPath: $fullPath"
    }
    if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
      throw "Reparse points are not supported in sensitive paths: $fullPath"
    }
  }

  return [pscustomobject]@{
    name = $RelativePath
    root = $target
    items = $items
  }
}

function Save-AclSnapshot {
  param(
    [Parameter(Mandatory = $true)][string]$Directory,
    [Parameter(Mandatory = $true)][string]$Root,
    [Parameter(Mandatory = $true)][string]$ServiceSid,
    [Parameter(Mandatory = $true)][object[]]$Targets
  )

  New-Item -ItemType Directory -Path $Directory -Force | Out-Null
  $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
  $file = Join-Path $Directory "acl-$stamp-$PID.json"
  $suffix = 1
  while (Test-Path -LiteralPath $file) {
    $file = Join-Path $Directory "acl-$stamp-$PID-$suffix.json"
    $suffix++
  }

  $snapshot = [pscustomobject]@{
    generatedAt = (Get-Date).ToUniversalTime().ToString('o')
    rootPath = $Root
    serviceIdentity = $ServiceIdentity
    serviceSid = $ServiceSid
    targets = @($Targets | ForEach-Object {
      [pscustomobject]@{
        name = $_.name
        items = @($_.items | ForEach-Object { Get-AclSnapshot -Item $_ })
      }
    })
  }
  $snapshot | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $file -Encoding UTF8
  return $file
}

function New-AccessRule {
  param(
    [Parameter(Mandatory = $true)][string]$Sid,
    [Parameter(Mandatory = $true)][System.Security.AccessControl.FileSystemRights]$Rights,
    [Parameter(Mandatory = $true)][System.Security.AccessControl.InheritanceFlags]$InheritanceFlags,
    [Parameter(Mandatory = $true)][System.Security.AccessControl.PropagationFlags]$PropagationFlags
  )

  return [System.Security.AccessControl.FileSystemAccessRule]::new(
    [System.Security.Principal.SecurityIdentifier]::new($Sid),
    $Rights,
    [System.Security.AccessControl.AccessControlType]::Allow,
    $InheritanceFlags,
    $PropagationFlags
  )
}

function Set-RestrictedAcl {
  param(
    [Parameter(Mandatory = $true)][System.IO.FileSystemInfo]$Item,
    [Parameter(Mandatory = $true)][string]$ServiceSid
  )

  $acl = Get-Acl -LiteralPath $Item.FullName
  $acl.SetAccessRuleProtection($true, $false)
  foreach ($rule in @($acl.Access)) {
    [void]$acl.RemoveAccessRule($rule)
  }

  $systemSid = 'S-1-5-18'
  $administratorsSid = 'S-1-5-32-544'
  if ($Item.PSIsContainer) {
    $inheritance = [System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor
      [System.Security.AccessControl.InheritanceFlags]::ObjectInherit
    $propagation = [System.Security.AccessControl.PropagationFlags]::None
    [void]$acl.AddAccessRule((New-AccessRule -Sid $ServiceSid -Rights ([System.Security.AccessControl.FileSystemRights]::Modify) -InheritanceFlags $inheritance -PropagationFlags $propagation))
    [void]$acl.AddAccessRule((New-AccessRule -Sid $systemSid -Rights ([System.Security.AccessControl.FileSystemRights]::FullControl) -InheritanceFlags $inheritance -PropagationFlags $propagation))
    [void]$acl.AddAccessRule((New-AccessRule -Sid $administratorsSid -Rights ([System.Security.AccessControl.FileSystemRights]::FullControl) -InheritanceFlags $inheritance -PropagationFlags $propagation))
  } else {
    $inheritance = [System.Security.AccessControl.InheritanceFlags]::None
    $propagation = [System.Security.AccessControl.PropagationFlags]::None
    [void]$acl.AddAccessRule((New-AccessRule -Sid $ServiceSid -Rights ([System.Security.AccessControl.FileSystemRights]::Read) -InheritanceFlags $inheritance -PropagationFlags $propagation))
    [void]$acl.AddAccessRule((New-AccessRule -Sid $systemSid -Rights ([System.Security.AccessControl.FileSystemRights]::FullControl) -InheritanceFlags $inheritance -PropagationFlags $propagation))
    [void]$acl.AddAccessRule((New-AccessRule -Sid $administratorsSid -Rights ([System.Security.AccessControl.FileSystemRights]::FullControl) -InheritanceFlags $inheritance -PropagationFlags $propagation))
  }

  Set-Acl -LiteralPath $Item.FullName -AclObject $acl
}

$resolvedRoot = Resolve-FullPath $RootPath
$rootItem = Get-Item -LiteralPath $resolvedRoot -Force
if (-not $rootItem.PSIsContainer) {
  throw "RootPath must be an existing directory: $resolvedRoot"
}
if ($resolvedRoot -eq [System.IO.Path]::GetPathRoot($resolvedRoot).TrimEnd('\')) {
  throw 'RootPath must not be a filesystem root.'
}

$serviceSid = Resolve-ServiceSid $ServiceIdentity
$targets = @(
  (Get-TargetItems -Root $resolvedRoot -RelativePath '.env'),
  (Get-TargetItems -Root $resolvedRoot -RelativePath 'data')
)

if ([string]::IsNullOrWhiteSpace($SnapshotDirectory)) {
  $SnapshotDirectory = Join-Path $resolvedRoot 'artifacts\security\acl-snapshots'
} elseif (-not [System.IO.Path]::IsPathRooted($SnapshotDirectory)) {
  $SnapshotDirectory = Join-Path $resolvedRoot $SnapshotDirectory
}
$snapshotDirectoryFull = [System.IO.Path]::GetFullPath($SnapshotDirectory).TrimEnd('\')
foreach ($target in $targets) {
  foreach ($item in $target.items) {
    if (Test-PathWithin -Path $snapshotDirectoryFull -Root (Resolve-FullPath $item.FullName)) {
      throw 'SnapshotDirectory must not be inside .env or data.'
    }
  }
}

$snapshotPath = $null
if ($Apply) {
  $snapshotPath = Save-AclSnapshot -Directory $snapshotDirectoryFull -Root $resolvedRoot -ServiceSid $serviceSid -Targets $targets
  foreach ($target in $targets) {
    foreach ($item in $target.items) {
      Set-RestrictedAcl -Item $item -ServiceSid $serviceSid
    }
  }
}

$report = [pscustomobject]@{
  apply = [bool]$Apply
  rootPath = $resolvedRoot
  serviceIdentity = $ServiceIdentity
  serviceSid = $serviceSid
  snapshotPath = $snapshotPath
  targets = @($targets | ForEach-Object {
    [pscustomobject]@{
      name = $_.name
      itemCount = @($_.items).Count
      rootPath = $_.root.FullName
    }
  })
}
$report | ConvertTo-Json -Depth 6 -Compress
