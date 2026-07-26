const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.API_KEY = process.env.API_KEY || 'test-key';

const { createSchedulerRuntime } = require('../core/schedulerRuntime');
const { createScheduledTaskStore } = require('../utils/scheduledTaskStore');

module.exports = (async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scheduler-crash-recovery-'));
  const filePath = path.join(tempDir, 'tasks.json');

  try {
    const store = createScheduledTaskStore({ filePath, debounceMs: 10000, maxDelayMs: 10000 });
    store.saveTask({
      id: 'once-crash',
      ownerUserId: 'admin',
      groupId: 'group-1',
      kind: 'message',
      commandType: 'group_message',
      status: 'active',
      scheduleType: 'once',
      executeAt: '2026-07-12 13:00',
      nextRunAt: '2026-07-12 13:00',
      payload: { message: 'only once' }
    });
    store.flushSync();

    let sends = 0;
    const originalMarkRunResult = store.markRunResult;
    store.markRunResult = () => {
      throw new Error('simulated crash after external side effect');
    };
    const runtime = createSchedulerRuntime({
      store,
      sendGroupMessage: async () => {
        sends += 1;
        return true;
      }
    });

    await assert.rejects(
      () => runtime.scan('2026-07-12 13:00'),
      /simulated crash/
    );
    assert.strictEqual(sends, 1);

    const persistedAfterClaim = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    assert.strictEqual(persistedAfterClaim.tasks[0].status, 'executing');
    assert.ok(persistedAfterClaim.tasks[0].execution?.key);

    store.markRunResult = originalMarkRunResult;
    const recoveredStore = createScheduledTaskStore({ filePath });
    const recoveredTask = recoveredStore.getTask('once-crash');
    assert.strictEqual(recoveredTask.status, 'failed');
    assert.match(recoveredTask.lastResult.reason, /outcome unknown/i);
    assert.deepStrictEqual(recoveredStore.getDueTasks('2026-07-12 13:01'), []);

    const restartedRuntime = createSchedulerRuntime({
      store: recoveredStore,
      sendGroupMessage: async () => {
        sends += 1;
        return true;
      }
    });
    await restartedRuntime.scan('2026-07-12 13:01');
    assert.strictEqual(sends, 1, 'restart must not repeat an uncertain external side effect');

    recoveredStore.saveTask({
      id: 'cron-crash',
      ownerUserId: 'admin',
      groupId: 'group-1',
      kind: 'message',
      commandType: 'group_message',
      status: 'executing',
      scheduleType: 'cron',
      cronExpr: '5 13 * * *',
      nextRunAt: '2026-07-12 13:05',
      payload: { message: 'cron message' },
      execution: {
        key: 'cron-crash:2026-07-12 13:05',
        scheduledAt: '2026-07-12 13:05',
        claimedAt: '2026-07-12T05:05:00.000Z'
      }
    });
    recoveredStore.flushSync();
    const recoveredCronStore = createScheduledTaskStore({ filePath });
    const recoveredCron = recoveredCronStore.getTask('cron-crash');
    assert.strictEqual(recoveredCron.status, 'active');
    assert.ok(recoveredCron.nextRunAt > '2026-07-12 13:05');
    assert.strictEqual(
      recoveredCronStore.getDueTasks('2026-07-12 13:05').some((task) => task.id === 'cron-crash'),
      false
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
})();
