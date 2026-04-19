const assert = require('assert');
const { createSchedulerRuntime } = require('../core/schedulerRuntime');

module.exports = (async () => {
  const calls = [];
  const store = {
    getDueTasks(nowText) {
      calls.push({ type: 'getDueTasks', nowText });
      return [];
    },
    listTasks() {
      return [{
        id: 't1',
        status: 'active',
        nextRunAt: '2099-01-01 10:05'
      }];
    },
    markRunResult() {},
    advanceCronWithoutExecution() {}
  };

  const runtime = createSchedulerRuntime({
    store,
    scanIntervalMs: 30000,
    sendGroupMessage: async () => true
  });

  runtime.start();
  const planned = runtime.getNextPlannedAt();
  runtime.stop();

  assert.strictEqual(planned, '2099-01-01 10:05');
  assert.ok(calls.some((item) => item.type === 'getDueTasks'));

  console.log('schedulerRuntimeAdaptive.test.js passed');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
