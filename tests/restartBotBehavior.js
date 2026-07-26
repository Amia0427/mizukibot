'use strict';

const assert = require('assert');
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = path.resolve(__dirname, '..');
const powershellCommand = process.platform === 'win32' ? 'powershell.exe' : 'pwsh';
const restartScript = path.join(root, 'scripts', 'restart-bot.ps1');

function quotePowerShell(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function runPowerShell(lines) {
  return spawnSync(powershellCommand, [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-EncodedCommand',
    Buffer.from(lines.join('; '), 'utf16le').toString('base64')
  ], {
    cwd: root,
    encoding: 'utf8'
  });
}

function readJsonLine(result) {
  assert.ifError(result.error);
  assert.strictEqual(result.status, 0, result.stderr || result.stdout);
  const line = String(result.stdout || '').split(/\r?\n/).findLast((item) => item.trim().startsWith('{'));
  assert.ok(line, result.stdout || result.stderr);
  return JSON.parse(line);
}

module.exports = function runRestartBotBehaviorTest() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mizuki-restart-behavior-'));
  const libraryResult = runPowerShell([
    `. ${quotePowerShell(restartScript)}`,
    `$tempRoot=${quotePowerShell(tempRoot)}`,
    '$expectedShutdownFile=Join-Path $tempRoot "expected.json"',
    '$restartResultFile=Join-Path $tempRoot "result.json"',
    '$env:MIZUKI_RESTART_CONFIRM=""',
    '$cliConfirmed=Test-RestartConfirmed -CliArgs @("restart","confirm")',
    '$notConfirmed=Test-RestartConfirmed -CliArgs @("restart")',
    '$env:MIZUKI_RESTART_CONFIRM="yes"',
    '$envConfirmed=Test-RestartConfirmed -CliArgs @("restart")',
    '$env:MIZUKI_RESTART_CONFIRM=""',
    '$fakeMain=[pscustomobject]@{Name="node.exe";ProcessId=101;ParentProcessId=201;CommandLine="node index.js"}',
    '$fakeWorker=[pscustomobject]@{Name="node.exe";ProcessId=102;ParentProcessId=202;CommandLine="node scripts/post-reply-worker.js"}',
    '$fakeOther=[pscustomobject]@{Name="node.exe";ProcessId=103;ParentProcessId=203;CommandLine="node other.js"}',
    '$launcher=[pscustomobject]@{Name="cmd.exe";ProcessId=201;ParentProcessId=1;CommandLine=("cmd.exe /c " + $repoRoot + " node index.js")}',
    '$mainPids=@(Get-RunningMainBotProcesses -Processes @($fakeMain,$fakeWorker,$fakeOther) | ForEach-Object {[int]$_.ProcessId})',
    '$workerPids=@(Get-RunningPostReplyWorkerProcesses -Processes @($fakeMain,$fakeWorker,$fakeOther) | ForEach-Object {[int]$_.ProcessId})',
    '$launcherPids=@(Get-RestartLauncherPids -Processes @($launcher) -MainProcesses @($fakeMain) -WorkerProcesses @())',
    '$tree=@(Get-ChildProcessTreeEntries -RootPids @(10) -Processes @([pscustomobject]@{ProcessId=11;ParentProcessId=10},[pscustomobject]@{ProcessId=12;ParentProcessId=11}))',
    '$commandLine=New-NodeRestartCommandLine -NodeExe "C:\\Program Files\\nodejs\\node.exe" -ArgumentList @("index.js") -StdoutLog (Join-Path $tempRoot "out.log") -StderrLog (Join-Path $tempRoot "err.log")',
    '$env:MIZUKI_RESTART_REASON="test_reason"',
    '$env:MIZUKI_RESTART_SOURCE="test_source"',
    '$markerWritten=Record-ExpectedMainBotShutdownForRestart -OwnerPid 123',
    'function global:Get-BotRuntimeStatus { [pscustomobject]@{Main=[pscustomobject]@{Pid=321;Detail="main"};Worker=[pscustomobject]@{Pid=654;Detail="worker"};Healthy=$true} }',
    '$resultWritten=Write-RestartResult -Status "success" -Healthy $true -Message "ok" -Actions @("done")',
    '$marker=Get-Content -LiteralPath $expectedShutdownFile -Raw | ConvertFrom-Json',
    '$restartResult=Get-Content -LiteralPath $restartResultFile -Raw | ConvertFrom-Json',
    '[pscustomobject]@{cliConfirmed=$cliConfirmed;notConfirmed=$notConfirmed;envConfirmed=$envConfirmed;statusCommand=(Resolve-RestartCommand -CliArgs @("status"));restartCommand=(Resolve-RestartCommand -CliArgs @("restart","confirm"));mainPids=$mainPids;workerPids=$workerPids;launcherPids=$launcherPids;treePids=@($tree|ForEach-Object {[int]$_.ProcessId});commandLine=$commandLine;markerWritten=$markerWritten;marker=$marker;resultWritten=$resultWritten;restartResult=$restartResult} | ConvertTo-Json -Depth 8 -Compress'
  ]);

  if (libraryResult.error?.code === 'ENOENT' && process.platform !== 'win32') {
    console.log('restartBotBehavior.test.js skipped: pwsh is unavailable');
    return;
  }

  const library = readJsonLine(libraryResult);
  assert.strictEqual(library.cliConfirmed, true);
  assert.strictEqual(library.notConfirmed, false);
  assert.strictEqual(library.envConfirmed, true);
  assert.strictEqual(library.statusCommand, 'status');
  assert.strictEqual(library.restartCommand, 'restart');
  assert.deepStrictEqual(library.mainPids, [101]);
  assert.deepStrictEqual(library.workerPids, [102]);
  assert.deepStrictEqual(library.launcherPids, [201]);
  assert.deepStrictEqual(library.treePids, [11, 12]);
  assert.match(library.commandLine, /^cmd\.exe \/d \/s \/c /);
  assert.ok(library.commandLine.includes('node.exe'));
  assert.ok(library.commandLine.includes('index.js'));
  assert.ok(library.commandLine.includes('1>>'));
  assert.ok(library.commandLine.includes('2>>'));
  assert.strictEqual(library.markerWritten, true);
  assert.strictEqual(library.marker.pid, 123);
  assert.strictEqual(library.marker.reason, 'test_reason');
  assert.strictEqual(library.marker.source, 'test_source');
  assert.strictEqual(library.resultWritten, true);
  assert.strictEqual(library.restartResult.schemaVersion, 'restart_bot_result_v1');
  assert.strictEqual(library.restartResult.mainPid, 321);
  assert.strictEqual(library.restartResult.workerPid, 654);

  const protectedResult = readJsonLine(runPowerShell([
    `. ${quotePowerShell(restartScript)}`,
    '$global:stopped=@()',
    'function global:Get-Process { param([int]$Id,[string]$ErrorAction) [pscustomobject]@{Id=$Id} }',
    'function global:Stop-Process { param([int]$Id,[switch]$Force,[string]$ErrorAction) $global:stopped += $Id }',
    '$result=@(Stop-PidList -Pids @(11,12,12) -Stage "test" -ProtectedPids @(11))',
    '[pscustomobject]@{stopped=@($global:stopped);result=$result} | ConvertTo-Json -Depth 5 -Compress'
  ]));
  assert.deepStrictEqual(protectedResult.stopped, [12]);
  assert.deepStrictEqual(protectedResult.result, [12]);

  const startResult = readJsonLine(runPowerShell([
    `. ${quotePowerShell(restartScript)}`,
    `$tempRoot=${quotePowerShell(tempRoot)}`,
    '$workerPidFile=Join-Path $tempRoot "worker.pid"',
    'Set-Content -LiteralPath $workerPidFile -Value "sentinel" -Encoding utf8',
    '$mainStdoutLogFile=Join-Path $tempRoot "main.out"',
    '$mainStderrLogFile=Join-Path $tempRoot "main.err"',
    '$workerStdoutLogFile=Join-Path $tempRoot "worker.out"',
    '$workerStderrLogFile=Join-Path $tempRoot "worker.err"',
    '$global:launches=@()',
    '$global:statusCall=0',
    'function global:Resolve-NodeExecutable { "node.exe" }',
    'function global:Write-RestartLog { param([string]$Message) }',
    'function global:Start-Sleep { param([int]$Milliseconds) }',
    'function global:Start-NodeRestartProcess { param([string]$NodeExe,[string[]]$ArgumentList,[string]$StdoutLog,[string]$StderrLog) $global:launches += [pscustomobject]@{args=@($ArgumentList);stdout=$StdoutLog;stderr=$StderrLog}; return 700 + $global:launches.Count }',
    'function global:Get-BotRuntimeStatus { $global:statusCall += 1; [pscustomobject]@{Main=[pscustomobject]@{Running=$false;Match=$false;Pid=0};Worker=[pscustomobject]@{Running=$false;Match=$false;Pid=0};WorkerIdleAllowed=$false;Healthy=$false} }',
    '$actions=@(Start-BotRuntimeDirectly)',
    '$workerPid=(Get-Content -LiteralPath $workerPidFile -Raw).Trim()',
    '[pscustomobject]@{launches=@($global:launches);actions=$actions;workerPid=$workerPid} | ConvertTo-Json -Depth 6 -Compress'
  ]));
  assert.deepStrictEqual(startResult.launches.map((item) => item.args), [
    ['index.js'],
    ['scripts/post-reply-worker.js']
  ]);
  assert.strictEqual(startResult.workerPid, 'sentinel');
  assert.ok(startResult.actions.some((item) => item.includes('started main bot launcher pid=')));
  assert.ok(startResult.actions.some((item) => item.includes('started post-reply worker launcher pid=')));

  const stopOrder = readJsonLine(runPowerShell([
    `. ${quotePowerShell(restartScript)}`,
    `$tempRoot=${quotePowerShell(tempRoot)}`,
    '$mainPidFile=Join-Path $tempRoot "main.pid"',
    '$workerPidFile=Join-Path $tempRoot "stale-worker.pid"',
    'Set-Content -LiteralPath $mainPidFile -Value "101" -Encoding utf8',
    'Set-Content -LiteralPath $workerPidFile -Value "999" -Encoding utf8',
    '$global:events=@()',
    '$global:allProcesses=@([pscustomobject]@{Name="node.exe";ProcessId=101;ParentProcessId=201;CommandLine="node index.js"},[pscustomobject]@{Name="node.exe";ProcessId=102;ParentProcessId=202;CommandLine="node scripts/post-reply-worker.js"},[pscustomobject]@{Name="cmd.exe";ProcessId=201;ParentProcessId=1;CommandLine=("cmd.exe /c " + $repoRoot + " node index.js")},[pscustomobject]@{Name="cmd.exe";ProcessId=202;ParentProcessId=1;CommandLine=("cmd.exe /c " + $repoRoot + " node scripts/post-reply-worker.js")})',
    'function global:Get-CimInstance { param($ClassName,$Filter,$ErrorAction) return @($global:allProcesses) }',
    'function global:Test-PidIsRunningMainBot { param([int]$ProcessId) return $ProcessId -eq 101 }',
    'function global:Test-PidIsRunningPostReplyWorker { param([int]$ProcessId) return $ProcessId -eq 102 }',
    'function global:Record-ExpectedMainBotShutdownForRestart { param([int]$OwnerPid) $global:events += "marker:$OwnerPid"; return $true }',
    'function global:Get-TreeChildPids { param([int[]]$RootPids) return @(301) }',
    'function global:Get-CurrentProcessAncestorPids { return @(777,201) }',
    'function global:Stop-PidList { param([int[]]$Pids,[string]$Stage,[int[]]$ProtectedPids) $global:events += "stop:$Stage"; return @($Pids) }',
    'function global:Wait-PidsGone { param([int[]]$Pids,[int]$TimeoutSeconds) return $true }',
    '$actions=@(Stop-BotForRestart)',
    '[pscustomobject]@{events=@($global:events);actions=$actions} | ConvertTo-Json -Depth 6 -Compress'
  ]));
  assert.ok(stopOrder.events.indexOf('marker:101') >= 0);
  assert.ok(stopOrder.events.indexOf('marker:101') < stopOrder.events.indexOf('stop:child'));
  assert.ok(stopOrder.actions.some((item) => item.includes('worker pid file ignored before restart: 999')));
  assert.ok(stopOrder.actions.some((item) => item.includes('protected caller pids: 777')));

  console.log('restartBotBehavior.test.js passed');
};
