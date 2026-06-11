const assert = require('assert');
const fs = require('fs');
const path = require('path');

module.exports = (() => {
  const scriptPath = path.join(__dirname, '..', 'scripts', 'run-bot-daemon.ps1');
  const script = fs.readFileSync(scriptPath, 'utf8');

  assert.ok(script.includes('function Wait-MainBotLockOwnership'), 'daemon should wait for main bot lock handoff');
  assert.ok(script.includes("Get-PositiveInt64Env -Name 'BOT_DAEMON_LOCK_WAIT_MS'"), 'daemon lock wait timeout should be configurable');
  assert.ok(script.includes("Get-PositiveInt64Env -Name 'BOT_DAEMON_LOCK_POLL_MS'"), 'daemon lock polling interval should be configurable');
  assert.ok(script.includes('$StartedProcess.Refresh()'), 'daemon should observe whether the newly started bot exits before lock handoff');
  assert.ok(script.includes("Reason = 'process_exited_before_lock'"), 'daemon should report early process exit during lock handoff');
  assert.ok(script.includes('main bot lock acquired after daemon start'), 'daemon should log successful lock handoff timing');
  assert.ok(script.includes('elapsed_ms=$($lockWait.ElapsedMs)'), 'daemon failure logs should include handoff wait duration');
  assert.ok(!script.includes('Start-Sleep -Seconds 2'), 'daemon should not use a fixed two-second lock handoff window');

  console.log('windowsDaemonScript.test.js passed');
})();
