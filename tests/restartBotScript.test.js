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
    script.includes("reason = 'manual_restart_script'"),
    'restart marker should identify manual restart as the reason'
  );
  assert.ok(
    script.indexOf('Record-ExpectedMainBotShutdownForRestart -OwnerPid $mainPid') < script.indexOf('Stop-PidList -Pids $childPids'),
    'restart script should write the marker before killing the process tree'
  );
  assert.ok(
    script.indexOf('$mainProcesses = @(Get-RunningMainBotProcesses)') < script.indexOf('Record-ExpectedMainBotShutdownForRestart -OwnerPid $mainPid'),
    'restart script should repair stale pid state before writing the expected-shutdown marker'
  );

  console.log('restartBotScript.test.js passed');
})();
