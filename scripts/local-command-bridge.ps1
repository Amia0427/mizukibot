$ErrorActionPreference = 'Stop'

$listener = [System.Net.HttpListener]::new()
$listener.Prefixes.Add('http://127.0.0.1:3210/')
$listener.Start()

function Read-Body($request) {
  $reader = New-Object System.IO.StreamReader($request.InputStream, $request.ContentEncoding)
  try {
    return $reader.ReadToEnd()
  } finally {
    $reader.Dispose()
  }
}

function Write-Json($response, $statusCode, $obj) {
  $json = $obj | ConvertTo-Json -Depth 10 -Compress
  $bytes = [System.Text.Encoding]::UTF8.GetBytes($json)
  $response.StatusCode = $statusCode
  $response.ContentType = 'application/json; charset=utf-8'
  $response.ContentLength64 = $bytes.Length
  $response.OutputStream.Write($bytes, 0, $bytes.Length)
  $response.OutputStream.Close()
}

function Run-Command($command, $args, $cwd, $timeoutMs, $envMap) {
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = $command
  foreach ($arg in $args) { [void]$psi.ArgumentList.Add([string]$arg) }
  $psi.WorkingDirectory = $cwd
  $psi.RedirectStandardOutput = $true
  $psi.RedirectStandardError = $true
  $psi.UseShellExecute = $false
  $psi.CreateNoWindow = $true

  if ($envMap -and $envMap.PSObject.Properties.Count -gt 0) {
    foreach ($prop in $envMap.PSObject.Properties) {
      $psi.Environment[$prop.Name] = [string]$prop.Value
    }
  }

  $proc = New-Object System.Diagnostics.Process
  $proc.StartInfo = $psi
  [void]$proc.Start()

  if (-not $proc.WaitForExit([int]$timeoutMs)) {
    try { $proc.Kill($true) } catch {}
    return @{
      ok = $false
      code = -1
      stdout = ''
      stderr = "command timeout after ${timeoutMs}ms"
    }
  }

  return @{
    ok = ($proc.ExitCode -eq 0)
    code = $proc.ExitCode
    stdout = $proc.StandardOutput.ReadToEnd().Trim()
    stderr = $proc.StandardError.ReadToEnd().Trim()
  }
}

while ($listener.IsListening) {
  try {
    $context = $listener.GetContext()
    $request = $context.Request
    $response = $context.Response

    if ($request.HttpMethod -eq 'GET' -and $request.Url.AbsolutePath -eq '/health') {
      Write-Json $response 200 @{ ok = $true }
      continue
    }

    if ($request.HttpMethod -eq 'POST' -and $request.Url.AbsolutePath -eq '/run') {
      $payload = Read-Body $request | ConvertFrom-Json
      $command = [string]$payload.command
      $args = @()
      if ($payload.args) { $args = @($payload.args) }
      $cwd = if ($payload.cwd) { [string]$payload.cwd } else { (Get-Location).Path }
      $timeoutMs = if ($payload.timeoutMs) { [int]$payload.timeoutMs } else { 30000 }
      $envMap = $payload.env

      if (-not $command) {
        Write-Json $response 400 @{ ok = $false; error = 'missing command' }
        continue
      }

      $result = Run-Command $command $args $cwd $timeoutMs $envMap
      Write-Json $response 200 $result
      continue
    }

    if ($request.HttpMethod -eq 'POST' -and $request.Url.AbsolutePath -eq '/mcp/discover') {
      $body = Read-Body $request
      $result = @{
        tools = @()
      }
      try {
        $raw = Get-Content -Path 'D:\waifu\.mcp.json' -Encoding utf8 | Out-String | ConvertFrom-Json
        foreach ($server in $raw.mcpServers.PSObject.Properties) {
          $name = [string]$server.Name
          $entry = $server.Value
          $result.tools += @{
            serverName = $name
            toolName = 'status'
            functionName = "mcp_${name}_status".ToLower().Replace('-', '_')
            description = "Bridge placeholder for MCP server $name"
            inputSchema = @{
              type = 'object'
              properties = @{}
            }
          }
        }
        Write-Json $response 200 $result
      } catch {
        Write-Json $response 500 @{ ok = $false; error = $_.Exception.Message }
      }
      continue
    }

    if ($request.HttpMethod -eq 'POST' -and $request.Url.AbsolutePath -eq '/mcp/call') {
      [void](Read-Body $request)
      Write-Json $response 410 @{ ok = $false; error = 'external_mcp_bridge_removed' }
      continue
    }

    Write-Json $response 404 @{ ok = $false; error = 'not_found' }
  } catch {
    try {
      Write-Json $context.Response 500 @{ ok = $false; error = $_.Exception.Message }
    } catch {}
  }
}
