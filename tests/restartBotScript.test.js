const assert = require('assert');
const fs = require('fs');
const path = require('path');

module.exports = (() => {
  const wrapperPath = path.join(__dirname, '..', 'restart-bot.cmd');
  const powershellPath = path.join(__dirname, '..', 'scripts', 'restart-bot.ps1');
  const indexPath = path.join(__dirname, '..', 'index.js');
  const wrapper = fs.readFileSync(wrapperPath, 'utf8');
  const script = fs.readFileSync(powershellPath, 'utf8');
  const index = fs.readFileSync(indexPath, 'utf8');

  assert.ok(
    wrapper.includes('scripts\\restart-bot.ps1') && wrapper.includes('%*'),
    'cmd wrapper should forward all arguments to scripts/restart-bot.ps1'
  );
  assert.ok(
    !wrapper.includes('POWERSHELL_PAYLOAD'),
    'cmd wrapper should not use the old self-reading embedded payload'
  );

  assert.ok(
    script.includes("bot-main-expected-shutdown.json"),
    'restart script should write the expected-shutdown marker consumed by the daemon'
  );
  assert.ok(
    script.includes('restart-bot.log') && script.includes('Exit-RestartScript'),
    'restart script should write a small stage log and exit explicitly'
  );
  assert.ok(
    script.includes('function Record-ExpectedMainBotShutdownForRestart'),
    'restart script should mark manual restarts before stopping the main bot'
  );
  assert.ok(
    script.includes('function Test-RestartConfirmed'),
    'restart script should require explicit confirmation before stopping processes'
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
    'running restart-bot.cmd without arguments should default to status only'
  );
  assert.ok(
    script.includes('function Get-RunningMainBotProcesses') &&
      script.includes('function Repair-MainPidFileFromProcess') &&
      script.includes('Get-MainBotStatusFromProcessScan'),
    'restart script should scan and repair stale main bot pid state'
  );
  assert.ok(
    script.includes('function Get-RunningPostReplyWorkerProcesses') &&
      script.includes('function Repair-WorkerPidFileFromProcess') &&
      script.includes('Get-WorkerStatusFromProcessScan') &&
      script.includes('post-reply-worker\\.js'),
    'restart script should scan and repair stale post-reply worker pid state'
  );
  assert.ok(
    script.includes('function Test-PidIsRunningMainBot') &&
      script.includes('Test-PidIsRunningMainBot -ProcessId $mainPid'),
    'restart marker should only be written for a live main bot pid'
  );
  assert.ok(
    script.includes('function Test-PidIsRunningPostReplyWorker') &&
      script.includes('Test-PidIsRunningPostReplyWorker -ProcessId $workerPidFromFile') &&
      script.includes('worker pid file ignored before restart'),
    'restart should not stop a stale worker pid that no longer matches the worker command line'
  );
  assert.ok(
    script.includes('main pid file ignored before restart') &&
      script.includes('is not a live main bot'),
    'restart should not stop a stale main pid that no longer matches the main bot command line'
  );
  assert.ok(
    script.includes("Get-RestartMarkerTextEnv -Name 'MIZUKI_RESTART_REASON' -DefaultValue 'manual_restart_script'") &&
      script.includes('MIZUKI_RESTART_SOURCE'),
    'restart marker should preserve the default reason and trigger source'
  );
  assert.ok(
    script.includes('function Start-BotRuntimeDirectly') &&
      script.includes("Start-NodeRestartProcess -NodeExe $nodeExe -ArgumentList @('index.js')") &&
      script.includes("Start-NodeRestartProcess -NodeExe $nodeExe -ArgumentList @('scripts/post-reply-worker.js')"),
    'confirmed restart should start the main bot and worker directly'
  );
  assert.ok(
    script.includes('function Start-NodeRestartProcess') &&
      script.includes("([wmiclass]'Win32_Process').Create") &&
      script.includes('Win32_ProcessStartup') &&
      script.includes('1>>') &&
      script.includes('2>>'),
    'direct restart should launch node through WMI with file redirection detached from the caller stdout pipe'
  );
  assert.ok(
    script.includes('$mainLauncherPid = Start-NodeRestartProcess') &&
      script.includes('started main bot launcher pid=$mainLauncherPid') &&
      script.includes('$workerLauncherPid = Start-NodeRestartProcess') &&
      script.includes('started post-reply worker launcher pid=$workerLauncherPid') &&
      !script.includes('Set-Content -LiteralPath $workerPidFile -Value $workerLauncherPid'),
    'restart actions should report launcher pids without overwriting runtime pid files with cmd launcher pids'
  );
  assert.ok(
    script.includes('function Wait-BotHealthy') &&
      script.includes('bot/worker not healthy after synchronous restart'),
    'confirmed restart should wait for final runtime health'
  );
  assert.ok(
    script.includes('Write-RestartLog -Message') &&
      script.includes('direct start using node=') &&
      script.includes('health wait done'),
    'restart script should log restart stage transitions for debugging'
  );
  assert.ok(
    script.includes('restart-bot-result.json') &&
      script.includes('function Write-RestartResult') &&
      script.includes('restart_bot_result_v1') &&
      script.includes('Write-RestartResult -Status $resultStatus') &&
      script.includes("Write-RestartResult -Status 'failed'"),
    'restart script should persist final restart success/failure for remote feedback'
  );
  assert.ok(
    script.includes('function Wait-PidsGone') &&
      script.includes('stopped process wait'),
    'restart should wait briefly for killed processes to disappear'
  );
  assert.ok(
    script.includes('function Get-RestartLauncherPids') &&
      script.includes('function Test-ProcessLooksLikeRestartLauncher') &&
      script.includes('restart launchers:'),
    'restart should stop verified cmd launchers for the old bot process tree'
  );
  assert.ok(
    script.includes('function Get-CurrentProcessAncestorPids') &&
      script.includes('protected caller pids') &&
      script.includes('Where-Object { $stopRootPids -notcontains [int]$_ }') &&
      script.includes('Stop-PidList -Pids $childPids -Stage') &&
      script.includes('-ProtectedPids $protectedPids'),
    'restart should protect the cmd/powershell caller chain without protecting the target bot process tree'
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
    script.includes('MIZUKI_RESTART_CONFIRM'),
    'remote restart should be able to pass confirmation through the environment'
  );
  assert.ok(
    !script.includes('Start-DaemonScheduledTaskNow'),
    'restart path should not depend on asynchronous scheduled-task triggering'
  );
  assert.ok(
    !script.includes('& $powerShellExe') && !script.includes('-File $runnerPath'),
    'restart path should not wait on a nested PowerShell daemon runner'
  );
  assert.ok(
    !script.includes('watch-bot-daemon-log.ps1') && !script.includes('-NoExit') && !script.includes('start "" powershell'),
    'restart script should not auto-open a separate log window'
  );
  assert.ok(
    script.indexOf('Test-RestartConfirmed -CliArgs $commandArgs') < script.indexOf('foreach ($action in Stop-BotForRestart)'),
    'restart confirmation should be checked before stop/start logic'
  );
  assert.ok(
    script.indexOf('Record-ExpectedMainBotShutdownForRestart -OwnerPid $mainPid') < script.indexOf('Stop-PidList -Pids $childPids'),
    'restart script should write the marker before killing the process tree'
  );
  assert.ok(
    script.indexOf('$mainProcesses = @(Get-RunningMainBotProcesses -Processes $processes)') <
      script.indexOf('Record-ExpectedMainBotShutdownForRestart -OwnerPid $mainPid'),
    'restart script should repair stale pid state before writing the expected-shutdown marker'
  );
  assert.ok(
    index.includes("require('./utils/restartResultFeedback')") &&
      index.includes('function scheduleRestartResultFeedback') &&
      index.includes('maybeSendRestartResultFeedback') &&
      index.includes('sendPrivateMessage'),
    'new main bot process should consume restart result feedback after startup'
  );

  console.log('restartBotScript.test.js passed');
})();
