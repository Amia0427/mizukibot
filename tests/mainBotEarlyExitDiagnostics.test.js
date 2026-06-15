const assert = require('assert');
const fs = require('fs');
const path = require('path');

module.exports = (() => {
  const script = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');

  assert.ok(script.includes('bot-main-expected-shutdown.json'), 'main bot should write expected shutdown markers');
  assert.ok(script.includes('bot-main-runtime-state.json'), 'main bot should persist heartbeat runtime state');
  assert.ok(script.includes('bot-main-exit-observations.jsonl'), 'main bot should append structured exit observations');
  assert.ok(script.includes('function startMainRuntimeHeartbeat'), 'main bot should start a runtime heartbeat after lock acquisition');
  assert.ok(script.includes('function appendMainExitObservation'), 'main bot should have a synchronous exit observation writer');
  assert.ok(script.includes("process.on('uncaughtException'"), 'main bot should log uncaught exceptions before exit');
  assert.ok(script.includes("process.on('unhandledRejection'"), 'main bot should log unhandled rejections before exit');
  assert.ok(script.includes("console.error(`[fatal] ${kind}`"), 'fatal diagnostics should include a clear marker');
  assert.ok(script.includes('configureNodeProcessReports()'), 'main bot should configure Node diagnostic reports for native exits');
  assert.ok(script.includes("process.on('beforeExit'"), 'main bot should log when the event loop is about to empty unexpectedly');
  assert.ok(script.includes("appendMainExitObservation('beforeExit'"), 'beforeExit should be persisted outside stdout');
  assert.ok(script.includes("appendMainExitObservation('exit'"), 'exit should be persisted outside stdout');
  assert.ok(script.includes("process.on('SIGBREAK'"), 'main bot should handle Windows console break shutdowns explicitly');
  assert.ok(script.includes('preserveSingleInstanceLockOnExit = true'), 'fatal exits should preserve the lock for daemon early-exit diagnosis');
  assert.ok(script.includes("recordExpectedShutdown('remote_restart_scheduled'"), 'remote restarts should be exempt from crash backoff');
  assert.ok(script.includes("recordExpectedShutdown(reason, { exitCode })"), 'signal shutdowns should be exempt from crash backoff');
  assert.ok(script.includes('[startup] main bot initialized'), 'main bot should log when early startup completes');

  console.log('mainBotEarlyExitDiagnostics.test.js passed');
})();
