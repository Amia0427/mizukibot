'use strict';

const assert = require('assert');
const { spawnSync } = require('child_process');
const path = require('path');

const root = path.resolve(__dirname, '..');
const tracked = spawnSync('git', ['ls-files', '--', 'scripts/*.ps1', 'scripts/*.psm1'], {
  cwd: root,
  encoding: 'utf8'
});
assert.strictEqual(tracked.status, 0, tracked.stderr || tracked.stdout);
const files = tracked.stdout.split(/\r?\n/).map((item) => item.trim()).filter(Boolean);
assert.ok(files.length > 0, 'tracked PowerShell scripts must be discovered');

const command = String.raw`
$files = @((ConvertFrom-Json -InputObject $env:MIZUKI_PS_FILES_JSON))
$results = foreach ($relativePath in $files) {
  $filePath = Join-Path $env:MIZUKI_REPO_ROOT $relativePath
  $tokens = $null
  $errors = $null
  [System.Management.Automation.Language.Parser]::ParseFile($filePath, [ref]$tokens, [ref]$errors) | Out-Null
  [pscustomobject]@{
    file = $relativePath
    ok = @($errors).Count -eq 0
    errors = @($errors | ForEach-Object {
      [pscustomobject]@{
        message = $_.Message
        errorId = $_.ErrorId
        startLine = $_.Extent.StartLineNumber
        startColumn = $_.Extent.StartColumnNumber
        endLine = $_.Extent.EndLineNumber
        endColumn = $_.Extent.EndColumnNumber
      }
    })
  }
}
ConvertTo-Json -InputObject @($results) -Depth 6 -Compress
if (@($results | Where-Object { -not $_.ok }).Count -gt 0) { exit 1 }
`;

const powershellCommand = process.platform === 'win32' ? 'powershell.exe' : 'pwsh';
const result = spawnSync(powershellCommand, [
  '-NoProfile',
  '-NonInteractive',
  '-ExecutionPolicy',
  'Bypass',
  '-EncodedCommand',
  Buffer.from(command, 'utf16le').toString('base64')
], {
  cwd: root,
  encoding: 'utf8',
  env: {
    ...process.env,
    MIZUKI_REPO_ROOT: root,
    MIZUKI_PS_FILES_JSON: JSON.stringify(files)
  }
});

if (result.error?.code === 'ENOENT' && process.platform !== 'win32') {
  console.log('powershellSyntaxPolicy.test.js skipped: pwsh is unavailable');
} else {
  assert.ifError(result.error);
  const outputLine = result.stdout.trim().split(/\r?\n/).filter(Boolean).at(-1);
  const report = JSON.parse(outputLine);
  assert.strictEqual(result.status, 0, result.stderr || JSON.stringify(report, null, 2));
  assert.strictEqual(report.length, files.length);
  assert.deepStrictEqual(report.map((item) => item.file).sort(), files.slice().sort());
  assert.ok(report.every((item) => item.ok && item.errors.length === 0));
  console.log('powershellSyntaxPolicy.test.js passed');
}
