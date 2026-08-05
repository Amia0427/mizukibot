const assert = require('assert');

const { createMessageTelemetryCoordinator } = require('../core/messageTelemetry');

module.exports = (async () => {
  const persisted = [];
  const coordinator = createMessageTelemetryCoordinator({
    buildReplyTelemetry: () => ({ onEvent() {} }),
    async runPersistInBackgroundFromCheckpoint(threadId) {
      persisted.push(threadId);
      return { ok: true };
    }
  });

  coordinator.maybeRunDeferredPersist({
    replyOptions: {
      deferPersist: true,
      threadId: 'discord-group-thread',
      routeMeta: {
        chatType: 'group',
        allowLongTermGroupMemory: false,
        userId: 'discord:u1'
      }
    }
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepStrictEqual(persisted, []);

  coordinator.maybeRunDeferredPersist({
    replyOptions: {
      deferPersist: true,
      threadId: 'discord-private-thread',
      routeMeta: {
        chatType: 'private',
        allowLongTermGroupMemory: false,
        userId: 'discord:u1'
      }
    }
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepStrictEqual(persisted, ['discord-private-thread']);

  console.log('platformMemoryIsolation.test.js passed');
})().catch((error) => {
  console.error(error?.stack || error);
  process.exit(1);
});
