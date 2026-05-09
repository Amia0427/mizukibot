const assert = require('assert');

process.env.API_KEY = process.env.API_KEY || 'test-key';

const { createSchedulerRuntime } = require('../core/schedulerRuntime');

module.exports = (async () => {
  const marked = [];
  let publishInput = null;
  let publishContext = null;
  let publishOptions = null;
  const store = {
    getDueTasks() {
      return [{
        id: 'q1',
        ownerUserId: 'admin',
        groupId: 'g1',
        commandType: 'qzone_post',
        scheduleType: 'once',
        payload: {
          mode: 'agent',
          hint: '夜间随手说说'
        }
      }];
    },
    listTasks() {
      return [];
    },
    markRunResult(id, result) {
      marked.push({ id, result });
    },
    advanceCronWithoutExecution() {}
  };

  const runtime = createSchedulerRuntime({
    store,
    isAdminUser: (userId) => userId === 'admin',
    publishQzoneForContext: async (input, context, options) => {
      publishInput = input;
      publishContext = context;
      publishOptions = options;
      return { ok: true, reason: 'ok', source: 'test' };
    }
  });

  const executed = await runtime.scan('2026-05-09 22:00');

  assert.strictEqual(executed.length, 1);
  assert.strictEqual(publishInput.mode, 'agent');
  assert.strictEqual(publishInput.hint, '夜间随手说说');
  assert.strictEqual(publishInput.publishPolicy, 'auto_publish');
  assert.strictEqual(publishContext.userId, 'admin');
  assert.strictEqual(publishContext.routeMeta.groupId, 'g1');
  assert.strictEqual(publishOptions.publishPolicy, 'auto_publish');
  assert.strictEqual(marked[0].result.status, 'completed');

  console.log('schedulerRuntimeQzone.test.js passed');
})().catch((error) => {
  console.error(error && error.stack ? error.stack : String(error));
  process.exit(1);
});
