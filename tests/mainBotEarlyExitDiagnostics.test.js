const assert = require('assert');
const fs = require('fs');
const path = require('path');

module.exports = (() => {
  const script = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');

  assert.ok(script.includes('bot-main-expected-shutdown.json'), 'main bot should write expected shutdown markers');
  assert.ok(script.includes("process.on('uncaughtException'"), 'main bot should log uncaught exceptions before exit');
  assert.ok(script.includes("process.on('unhandledRejection'"), 'main bot should log unhandled rejections before exit');
  assert.ok(script.includes("console.error(`[fatal] ${kind}`"), 'fatal diagnostics should include a clear marker');
  assert.ok(script.includes('preserveSingleInstanceLockOnExit = true'), 'fatal exits should preserve the lock for daemon early-exit diagnosis');
  assert.ok(script.includes("recordExpectedShutdown('remote_restart_scheduled'"), 'remote restarts should be exempt from crash backoff');
  assert.ok(script.includes("recordExpectedShutdown(reason, { exitCode })"), 'signal shutdowns should be exempt from crash backoff');
  assert.ok(script.includes('[startup] main bot initialized'), 'main bot should log when early startup completes');

  console.log('mainBotEarlyExitDiagnostics.test.js passed');
})();
