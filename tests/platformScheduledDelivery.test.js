const assert = require('assert');

process.env.API_KEY = process.env.API_KEY || 'test-key';

const { createSchedulerRuntime } = require('../core/schedulerRuntime');
const { normalizeTask, validateTaskInput } = require('../utils/scheduledTaskStore/taskShape');

module.exports = (async () => {
  const legacy = normalizeTask({
    id: 'legacy-task',
    ownerUserId: '10001',
    groupId: '12345',
    kind: 'message',
    commandType: 'group_message',
    scheduleType: 'once',
    executeAt: '2026-08-06 10:00',
    payload: { message: 'legacy' }
  });
  assert.strictEqual(legacy.platform, 'qq');
  assert.strictEqual(legacy.deliveryTarget.key, '12345');

  const validated = validateTaskInput({
    ownerUserId: '10001',
    groupId: 'telegram:group::-100:77',
    platform: 'telegram',
    deliveryTarget: {
      platform: 'telegram',
      chatType: 'group',
      conversationId: '-100',
      threadId: '77',
      key: 'telegram:group::-100:77'
    },
    kind: 'message',
    commandType: 'group_message',
    when: '2026-08-06 10:00',
    payload: { message: 'topic message' }
  });
  assert.strictEqual(validated.platform, 'telegram');
  assert.strictEqual(validated.deliveryTarget.threadId, '77');

  const sends = [];
  const marked = [];
  const task = normalizeTask({
    id: 'tg-task',
    ...validated,
    status: 'active',
    nextRunAt: '2026-08-06 10:00'
  });
  const runtime = createSchedulerRuntime({
    store: {
      getDueTasks: () => [task],
      claimDueTask: () => task,
      listTasks: () => [],
      markRunResult: (id, result) => marked.push({ id, result }),
      advanceCronWithoutExecution() {}
    },
    sendGroupMessage: async (target, message, meta) => {
      sends.push({ target, message, meta });
      return true;
    }
  });
  await runtime.scan('2026-08-06 10:00');
  assert.strictEqual(sends.length, 1);
  assert.strictEqual(sends[0].target.platform, 'telegram');
  assert.strictEqual(sends[0].target.threadId, '77');
  assert.strictEqual(sends[0].meta.routeMeta.platform, 'telegram');
  assert.strictEqual(marked[0].result.status, 'completed');
  console.log('platformScheduledDelivery.test.js passed');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
