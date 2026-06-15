const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createBackgroundTaskRuntime } = require('../utils/backgroundTaskRuntime');

module.exports = (async () => {
  const storeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'waifu-bg-runtime-race-'));
  const runtime = createBackgroundTaskRuntime({
    storeDir,
    sessionTtlMs: 1
  });

  const task = runtime.startTask({
    sessionKey: 'session_a',
    userId: 'user_a',
    originalText: 'old task'
  });
  runtime.markTaskRunning(task.id);

  let cancelCalls = 0;
  runtime.attachController(task.id, {
    cancel() {
      cancelCalls += 1;
      runtime.expireSessions();
      runtime.startTask({
        sessionKey: 'session_a',
        userId: 'user_a',
        originalText: 'new task'
      });
    }
  });

  await new Promise((resolve) => setTimeout(resolve, 10));
  runtime.expireSessions();
  runtime.expireSessions();

  assert.strictEqual(cancelCalls, 1, 'expireSessions should not re-enter cancellation for the same task');
  const expiredTask = runtime.getTask(task.id);
  assert.strictEqual(expiredTask.status, 'cancelled');
  assert.strictEqual(expiredTask.error, 'expired');
  const currentSession = runtime.getSessionState('session_a');
  assert.ok(currentSession, 'session recreated during cancellation should not be removed by stale expire iterator');
  assert.notStrictEqual(currentSession.active_task_id, task.id);

  console.log('backgroundTaskRuntimeRace.test.js passed');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
