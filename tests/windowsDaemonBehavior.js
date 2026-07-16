'use strict';

const assert = require('assert');
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = path.resolve(__dirname, '..');
const powershellCommand = process.platform === 'win32' ? 'powershell.exe' : 'pwsh';
const daemonScript = path.join(root, 'scripts', 'run-bot-daemon.ps1');

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
    encoding: 'utf8',
    timeout: 15000
  });
}

function readJsonLine(result) {
  if (result.error) {
    throw new Error(`${result.error.message}\n${result.stdout || ''}\n${result.stderr || ''}`);
  }
  assert.strictEqual(result.status, 0, result.stderr || result.stdout);
  const line = String(result.stdout || '').split(/\r?\n/).findLast((item) => item.trim().startsWith('{'));
  assert.ok(line, result.stdout || result.stderr);
  return JSON.parse(line);
}

module.exports = function runWindowsDaemonBehaviorTest() {
  if (process.platform !== 'win32') {
    console.log('windowsDaemonBehavior.test.js skipped: Windows is required');
    return;
  }

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mizuki-daemon-behavior-'));
  const result = runPowerShell([
    `. ${quotePowerShell(daemonScript)}`,
    `$tempRoot=${quotePowerShell(tempRoot)}`,
    '$logDir=$tempRoot',
    '$logFile=Join-Path $tempRoot "daemon.log"',
    '$mainRestartStateFile=Join-Path $tempRoot "restart-state.json"',
    '$mainRuntimeStateFile=Join-Path $tempRoot "runtime-state.json"',
    '$mainExitObservationsFile=Join-Path $tempRoot "exit-observations.jsonl"',
    '$mainPortRecoveryStateFile=Join-Path $tempRoot "port-recovery.json"',
    '$env:POST_REPLY_WORKER_ENABLED="true"',
    '$env:POST_REPLY_WORKER_INLINE="false"',
    '$env:POST_REPLY_WORKER_IDLE_RECYCLE_ENABLED="false"',
    '$externalEnabled=Test-ExternalPostReplyWorkerEnabled',
    '$residentExpected=Test-ExternalPostReplyWorkerResidentExpected',
    '$queueReason=Resolve-ExternalWorkerStartReason -QueueReason "queued job due" -MainBotStartedByDaemon $true',
    '$daemonStartReason=Resolve-ExternalWorkerStartReason -QueueReason "" -MainBotStartedByDaemon $true',
    '$residentReason=Resolve-ExternalWorkerStartReason -QueueReason "" -MainBotStartedByDaemon $false',
    '$env:POST_REPLY_WORKER_IDLE_RECYCLE_ENABLED="true"',
    '$idleReason=Resolve-ExternalWorkerStartReason -QueueReason "" -MainBotStartedByDaemon $false',
    '$blockedState=[pscustomobject]@{Blocked=$true}',
    '$unblockedState=[pscustomobject]@{Blocked=$false}',
    '$outageState=[pscustomobject]@{Outage=$true}',
    '$onlineState=[pscustomobject]@{Outage=$false}',
    '$recoverAction=Resolve-MainBotEarlyExitAction -EarlyExitState $blockedState -HttpReverseIngressState $outageState -RecentPortRecovery $false',
    '$repeatRecoveryAction=Resolve-MainBotEarlyExitAction -EarlyExitState $blockedState -HttpReverseIngressState $outageState -RecentPortRecovery $true',
    '$onlineBlockAction=Resolve-MainBotEarlyExitAction -EarlyExitState $blockedState -HttpReverseIngressState $onlineState -RecentPortRecovery $false',
    '$continueAction=Resolve-MainBotEarlyExitAction -EarlyExitState $unblockedState -HttpReverseIngressState $outageState -RecentPortRecovery $false',
    'function Test-DaemonTcpPortListening { param([Int64]$Port) return $Port -eq 3002 }',
    '$env:NAPCAT_HTTP_REVERSE_PORT="3002"',
    '$ingress=Get-MainHttpReverseIngressState',
    '$env:BOT_DAEMON_HTTP_REVERSE_PORT_RECOVERY_COOLDOWN_MS="600000"',
    'Record-MainHttpReversePortRecovery -Port 3002 -PreviousPid 44 -EarlyExitCount 2 -CooldownUntil "soon"',
    '$recentRecovery=Test-RecentMainHttpReversePortRecovery -Port 3002',
    '$markerPath=Join-Path $tempRoot "bot-main-expected-shutdown.json"',
    '$marker=[pscustomobject]@{pid=444;reason="remote_restart_scheduled";source="admin";recordedAt=(Get-Date).ToUniversalTime().ToString("o");expiresAt=(Get-Date).ToUniversalTime().AddMinutes(5).ToString("o");requestId="req";messageId="msg";groupId="group"}',
    '$marker | ConvertTo-Json | Set-Content -LiteralPath $markerPath -Encoding utf8',
    '$env:BOT_DAEMON_MAIN_EARLY_EXIT_WINDOW_MS="600000"',
    '$env:BOT_DAEMON_MAIN_EARLY_EXIT_MAX_RESTARTS="2"',
    '$env:BOT_DAEMON_MAIN_EARLY_EXIT_COOLDOWN_MS="600000"',
    '$expected=Update-MainBotEarlyExitState -LockPath (Join-Path $tempRoot "expected.lock") -OwnerPid 444',
    '$consumedMarker=Get-Content -LiteralPath $markerPath -Raw | ConvertFrom-Json',
    '$expectedState=Get-Content -LiteralPath $mainRestartStateFile -Raw | ConvertFrom-Json',
    '$alreadyConsumed=Test-ExpectedMainBotShutdownRecent -OwnerPid 444',
    'Record-MainBotExitObservation -OwnerPid 444 -Reason "expected" -LockDiagnostics "expected marker" -Evidence $null -EarlyExitState $expected',
    '$observation=Get-Content -LiteralPath $mainExitObservationsFile -Tail 1 | ConvertFrom-Json',
    '$global:daemonMessages=@()',
    'function Write-DaemonLog { param([string]$Message) $global:daemonMessages += $Message }',
    'function Test-ExpectedMainBotShutdownRecent { param([int]$OwnerPid) [pscustomobject]@{Matched=$false;Marker=$null;Reason="missing"} }',
    'function Get-MainBotExitEvidence { param([string]$LockPath,[int]$OwnerPid) [pscustomobject]@{LockAgeMs=100;EffectiveAgeMs=100;AgeSource="runtime_heartbeat_lifetime";HeartbeatAt="heartbeat";StartedAt="started"} }',
    '$firstExit=Update-MainBotEarlyExitState -LockPath (Join-Path $tempRoot "lock") -OwnerPid 1',
    '$secondExit=Update-MainBotEarlyExitState -LockPath (Join-Path $tempRoot "lock") -OwnerPid 2',
    '$cooldownExit=Update-MainBotEarlyExitState -LockPath (Join-Path $tempRoot "lock") -OwnerPid 3',
    '$redirectLog=Join-Path $tempRoot "runtime.out.log"',
    '[IO.File]::WriteAllText($redirectLog,"runtime output")',
    '$archivePath=Archive-DaemonRedirectLogIfNeeded -Path $redirectLog',
    '$archiveText=if(Test-Path -LiteralPath $archivePath){Get-Content -LiteralPath $archivePath -Raw}else{""}',
    '$currentProcess=Microsoft.PowerShell.Management\\Get-Process -Id $PID',
    '$env:BOT_DAEMON_LOCK_WAIT_MS="0"',
    '$env:BOT_DAEMON_LOCK_POLL_MS="100"',
    'function Test-LockOwnedByRunningNode { param([string]$LockPath) return $false }',
    '$timeoutWait=Wait-MainBotLockOwnership -LockPath (Join-Path $tempRoot "missing.lock") -StartedProcess $currentProcess',
    'function Test-LockOwnedByRunningNode { param([string]$LockPath) return $true }',
    '$acquiredWait=Wait-MainBotLockOwnership -LockPath (Join-Path $tempRoot "owned.lock") -StartedProcess $currentProcess',
    '$exitedProcess=Start-Process -FilePath "cmd.exe" -ArgumentList @("/d","/c","exit 7") -WindowStyle Hidden -PassThru',
    '$exitedProcess.WaitForExit()',
    '$env:BOT_DAEMON_LOCK_WAIT_MS="1000"',
    'function Test-LockOwnedByRunningNode { param([string]$LockPath) return $false }',
    '$exitedWait=Wait-MainBotLockOwnership -LockPath (Join-Path $tempRoot "exited.lock") -StartedProcess $exitedProcess',
    '[pscustomobject]@{externalEnabled=[bool]$externalEnabled;residentExpected=[bool]$residentExpected;queueReason=[string]$queueReason;daemonStartReason=[string]$daemonStartReason;residentReason=[string]$residentReason;idleReason=[string]$idleReason;recoverAction=[string]$recoverAction;repeatRecoveryAction=[string]$repeatRecoveryAction;onlineBlockAction=[string]$onlineBlockAction;continueAction=[string]$continueAction;ingressEnabled=[bool]$ingress.Enabled;ingressPort=[int]$ingress.Port;ingressListening=[bool]$ingress.Listening;ingressOutage=[bool]$ingress.Outage;recentRecovery=[bool]$recentRecovery;expectedReason=[string]$expected.Reason;expectedSource=[string]$expectedState.expectedShutdownSource;alreadyConsumedReason=[string]$alreadyConsumed.Reason;observationSource=[string]$observation.source;observationExpectedSource=[string]$observation.expectedShutdownSource;consumedAt=[string]$consumedMarker.consumedAt;consumedBy=[string]$consumedMarker.consumedBy;firstReason=[string]$firstExit.Reason;firstBlocked=[bool]$firstExit.Blocked;secondReason=[string]$secondExit.Reason;secondBlocked=[bool]$secondExit.Blocked;cooldownReason=[string]$cooldownExit.Reason;cooldownBlocked=[bool]$cooldownExit.Blocked;archiveExists=[bool](Test-Path -LiteralPath $archivePath);archiveText=[string]$archiveText;timeoutReason=[string]$timeoutWait.Reason;timeoutAcquired=[bool]$timeoutWait.Acquired;acquiredReason=[string]$acquiredWait.Reason;acquired=[bool]$acquiredWait.Acquired;exitedReason=[string]$exitedWait.Reason;exitedCode=[int]$exitedWait.ExitCode} | ConvertTo-Json -Compress'
  ]);

  if (result.error?.code === 'ENOENT' && process.platform !== 'win32') {
    console.log('windowsDaemonBehavior.test.js skipped: pwsh is unavailable');
    return;
  }

  const behavior = readJsonLine(result);
  assert.strictEqual(behavior.externalEnabled, true);
  assert.strictEqual(behavior.residentExpected, true);
  assert.strictEqual(behavior.queueReason, 'queued job due');
  assert.strictEqual(behavior.daemonStartReason, 'main bot started by daemon; ensure external worker');
  assert.strictEqual(behavior.residentReason, 'external worker expected resident; restart missing worker');
  assert.strictEqual(behavior.idleReason, '');
  assert.strictEqual(behavior.recoverAction, 'recover_http_reverse');
  assert.strictEqual(behavior.repeatRecoveryAction, 'block');
  assert.strictEqual(behavior.onlineBlockAction, 'block');
  assert.strictEqual(behavior.continueAction, 'continue');
  assert.strictEqual(behavior.ingressEnabled, true);
  assert.strictEqual(behavior.ingressPort, 3002);
  assert.strictEqual(behavior.ingressListening, true);
  assert.strictEqual(behavior.ingressOutage, false);
  assert.strictEqual(behavior.recentRecovery, true);
  assert.strictEqual(behavior.expectedReason, 'expected_shutdown');
  assert.strictEqual(behavior.expectedSource, 'admin');
  assert.strictEqual(behavior.alreadyConsumedReason, 'already_consumed');
  assert.strictEqual(behavior.observationSource, 'windows_daemon');
  assert.strictEqual(behavior.observationExpectedSource, 'admin');
  assert.ok(behavior.consumedAt);
  assert.strictEqual(behavior.consumedBy, 'windows_daemon');
  assert.strictEqual(behavior.firstReason, 'counted');
  assert.strictEqual(behavior.firstBlocked, false);
  assert.strictEqual(behavior.secondReason, 'threshold_reached');
  assert.strictEqual(behavior.secondBlocked, true);
  assert.strictEqual(behavior.cooldownReason, 'cooldown_active');
  assert.strictEqual(behavior.cooldownBlocked, true);
  assert.strictEqual(behavior.archiveExists, true);
  assert.strictEqual(behavior.archiveText, 'runtime output');
  assert.strictEqual(behavior.timeoutReason, 'timeout');
  assert.strictEqual(behavior.timeoutAcquired, false);
  assert.strictEqual(behavior.acquiredReason, 'acquired');
  assert.strictEqual(behavior.acquired, true);
  assert.strictEqual(behavior.exitedReason, 'process_exited_before_lock');
  assert.strictEqual(behavior.exitedCode, 7);

  console.log('windowsDaemonBehavior.test.js passed');
};
