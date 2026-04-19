const assert = require('assert');

const { createForegroundConcurrencyController } = require('../core/foregroundConcurrency');

module.exports = (async () => {
  const controller = createForegroundConcurrencyController({
    globalLimit: 2,
    adminReservedSlots: 0,
    perUserLimit: 1
  });

  const first = await controller.acquire({
    userId: 'same_user',
    sessionKey: 'direct:same_user',
    lane: 'general',
    chatType: 'private'
  });

  const secondPromise = controller.acquire({
    userId: 'same_user',
    sessionKey: 'group:g1:user:same_user',
    lane: 'general',
    chatType: 'group',
    groupId: 'g1'
  });

  const second = await Promise.race([
    secondPromise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('second foreground acquire timed out')), 200))
  ]);

  assert.ok(first && second, 'different session keys should acquire foreground slots concurrently');

  first.release();
  second.release();

  console.log('foregroundConcurrencySessionKey.test.js passed');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
