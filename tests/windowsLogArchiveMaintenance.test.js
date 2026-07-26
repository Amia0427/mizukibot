const assert = require('assert');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = path.resolve(__dirname, '..');
const scriptPath = path.join(root, 'scripts', 'log-archive-maintenance.ps1').replace(/'/g, "''");
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mizuki-windows-log-retention-'));
const quotedTempDir = tempDir.replace(/'/g, "''");
const command = [
  `. '${scriptPath}'`,
  `$dir='${quotedTempDir}'`,
  "$env:LOG_ROTATE_MAX_FILES='10'",
  "$env:LOG_ROTATE_MAX_AGE_MS='0'",
  "$env:LOG_ROTATE_MAX_TOTAL_BYTES='35'",
  "$names=@('bot-daemon.log.20260712-010101-001','bot-runtime.out.20260712-010102-001.log','post-reply-worker.err.20260712-010103-001.log','bot-daemon.log','bot-runtime.out.log','memory-events.jsonl.20260712010101001')",
  '$index=0',
  'foreach($name in $names){ $file=Join-Path $dir $name; [IO.File]::WriteAllText($file, ("x" * 20)); (Get-Item -LiteralPath $file).LastWriteTimeUtc=[DateTime]::UtcNow.AddMinutes(-10 + $index); $index += 1 }',
  'Invoke-ManagedLogArchiveMaintenance -LogDirectory $dir',
  '$locked=Join-Path $dir "bot-runtime.err.20260712-010104-001.log"',
  '[IO.File]::WriteAllText($locked, ("z" * 40))',
  '$stream=[IO.File]::Open($locked,[IO.FileMode]::Open,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)',
  '$global:testWarnings=@()',
  "$env:LOG_ROTATE_MAX_TOTAL_BYTES='1'",
  'try { Invoke-ManagedLogArchiveMaintenance -LogDirectory $dir -WarningSink { param($message) $global:testWarnings += $message } } finally { $stream.Close() }',
  '[pscustomobject]@{ names=@(Get-ChildItem -LiteralPath $dir -File | Select-Object -ExpandProperty Name); warnings=@($global:testWarnings) } | ConvertTo-Json -Compress'
].join('; ');

const result = JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', command], {
  cwd: root,
  encoding: 'utf8'
}).trim());

assert.ok(result.names.includes('bot-daemon.log'), 'current daemon log must remain');
assert.ok(result.names.includes('bot-runtime.out.log'), 'current runtime redirect target must remain');
assert.ok(result.names.includes('memory-events.jsonl.20260712010101001'), 'non-allowlisted state data must remain');
assert.ok(result.names.includes('bot-runtime.err.20260712-010104-001.log'), 'failed archive removal must be skipped');
assert.ok(result.warnings.length >= 1, 'failed archive removal must emit a warning');
assert.ok(!result.names.includes('bot-daemon.log.20260712-010101-001'), 'oldest allowlisted archive should be removed by global capacity');

console.log('windowsLogArchiveMaintenance.test.js passed');
