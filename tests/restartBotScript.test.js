const assert = require('assert');
const fs = require('fs');
const path = require('path');

module.exports = (() => {
  const scriptPath = path.join(__dirname, '..', 'restart-bot.cmd');
  const script = fs.readFileSync(scriptPath, 'utf8');

  assert.ok(
    script.includes("bot-main-expected-shutdown.json"),
    'restart script should write the expected-shutdown marker consumed by the daemon'
  );
  assert.ok(
    script.includes('function Record-ExpectedMainBotShutdownForRestart'),
    'restart script should mark manual restarts before stopping the main bot'
  );
  assert.ok(
    script.includes('function Get-RunningMainBotProcesses'),
    'restart script should scan real main bot processes when the pid file is stale'
  );
  assert.ok(
    script.includes('function Repair-MainPidFileFromProcess'),
    'restart script should repair stale main pid files from a real running process'
  );
  assert.ok(
    script.includes('function Get-RunningPostReplyWorkerProcesses'),
    'restart script should scan real post-reply worker processes when the worker pid file is stale'
  );
  assert.ok(
    script.includes('function Repair-WorkerPidFileFromProcess'),
    'restart script should repair stale worker pid files from a real running process'
  );
  assert.ok(
    script.includes('post-reply-worker\\.js') && script.includes('Get-WorkerStatusFromProcessScan'),
    'restart health checks should accept a live post-reply worker found by process scan'
  );
  assert.ok(
    script.includes("Get-RestartMarkerTextEnv -Name 'MIZUKI_RESTART_REASON' -DefaultValue 'manual_restart_script'"),
    'restart marker should default manual restart as the reason'
  );
  assert.ok(
    script.includes('function Test-RestartConfirmed'),
    'restart script should require an explicit confirmation before stopping processes'
  );
  assert.ok(
    script.includes('restart skipped: explicit confirmation required'),
    'bare restart should not write markers or stop processes'
  );
  assert.ok(
    script.includes('restart-bot.cmd restart confirm'),
    'bare restart output should show the exact confirmed restart command'
  );
  assert.ok(
    script.includes('status only; start skipped (restart requires "restart confirm")'),
    'status-only output should make clear that it did not restart the bot'
  );
  assert.ok(
    script.includes('=== Bot Node Processes ===') && script.includes('=== Other Related Node Processes (diagnostic only) ==='),
    'status output should separate real bot processes from diagnostic node processes'
  );
  assert.ok(
    script.includes('$botPidRoles') && script.includes('diagnostic only'),
    'diagnostic node process listing should be keyed from the runtime bot pid roles'
  );
  assert.ok(
    script.includes('if /i "%~1"=="restart"') && script.includes('if /i "%MIZUKI_RESTART_CONFIRM%"=="confirm"'),
    'confirmed restart detection should remain available for final status output'
  );
  assert.ok(
    script.includes('MIZUKI_RESTART_CONFIRM'),
    'remote restart should be able to pass confirmation through the environment'
  );
  assert.ok(
    script.includes('MIZUKI_RESTART_PRINT_POST_STATUS'),
    'confirmed restart should print a final status report in the current console'
  );
  assert.ok(
    script.includes('[restart] confirmed restart completed; final status:') && script.includes('call "%~f0" status'),
    'confirmed restart should not look silent after the daemon has been triggered'
  );
  assert.ok(
    !script.includes('watch-bot-daemon-log.ps1') && !script.includes('-NoExit') && !script.includes('start "" powershell'),
    'restart script should not auto-open a separate log window'
  );
  assert.ok(
    script.includes('MIZUKI_RESTART_SOURCE'),
    'restart marker should preserve the trigger source for audit'
  );
  assert.ok(
    script.includes('MIZUKI_RESTART_DEFAULT_STATUS'),
    'running restart-bot.cmd without arguments should default to status only'
  );
  assert.ok(
    script.includes('function Test-PidIsRunningMainBot'),
    'restart script should verify a live main bot pid before writing the expected-shutdown marker'
  );
  assert.ok(
    script.includes('Test-PidIsRunningMainBot -ProcessId $mainPid'),
    'restart marker should not be written for stale lock pids'
  );
  assert.ok(
    script.indexOf('Test-RestartConfirmed') < script.indexOf('Stop-BotForRestart'),
    'restart confirmation should be checked before stop/start logic'
  );
  assert.ok(
    script.indexOf('Record-ExpectedMainBotShutdownForRestart -OwnerPid $mainPid') < script.indexOf('Stop-PidList -Pids $childPids'),
    'restart script should write the marker before killing the process tree'
  );
  assert.ok(
    script.indexOf('$mainProcesses = @(Get-RunningMainBotProcesses)') < script.indexOf('Record-ExpectedMainBotShutdownForRestart -OwnerPid $mainPid'),
    'restart script should repair stale pid state before writing the expected-shutdown marker'
  );
  assert.ok(
    script.indexOf('Test-PidIsRunningMainBot -ProcessId $mainPid') < script.indexOf('Record-ExpectedMainBotShutdownForRestart -OwnerPid $mainPid'),
    'restart script should verify a live owner before writing the expected-shutdown marker'
  );

  console.log('restartBotScript.test.js passed');
})();
