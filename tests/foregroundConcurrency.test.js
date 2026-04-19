const assert = require('assert');

const { createForegroundConcurrencyController } = require('../core/foregroundConcurrency');

module.exports = (async () => {
  const controller = createForegroundConcurrencyController({
    globalLimit: 10,
    adminReservedSlots: 1,
    perUserLimit: 1
  });

  const generalLocks = [];
  for (let i = 0; i < 9; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    generalLocks.push(await controller.acquire({
      userId: `user_${i}`,
      lane: 'general',
      messageId: `m_${i}`,
      groupId: 'g1',
      chatType: 'group'
    }));
  }

  assert.strictEqual(controller.getSnapshot().activeGeneral, 9);
  assert.strictEqual(controller.getSnapshot().totalActive, 9);

  const queuedGeneral = controller.acquire({
    userId: 'user_queued',
    lane: 'general',
    messageId: 'm_q',
    groupId: 'g1',
    chatType: 'group'
  });

  let queuedResolved = false;
  queuedGeneral.then(() => {
    queuedResolved = true;
  });

  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.strictEqual(queuedResolved, false, 'general request should queue when 9 general slots are full');

  const adminLock = await controller.acquire({
    userId: 'admin_1',
    lane: 'admin',
    messageId: 'm_admin',
    groupId: 'g1',
    chatType: 'group'
  });
  assert.strictEqual(controller.getSnapshot().activeAdmin, 1);
  assert.strictEqual(controller.getSnapshot().totalActive, 10);

  generalLocks[0].release();
  const releasedQueued = await queuedGeneral;
  assert.ok(releasedQueued, 'queued general request should acquire after a general slot is released');

  releasedQueued.release();
  adminLock.release();
  for (const lock of generalLocks.slice(1)) {
    lock.release();
  }

  const sameUserFirst = await controller.acquire({
    userId: 'same_user',
    lane: 'general',
    messageId: 'same_1',
    groupId: '',
    chatType: 'private'
  });

  const sameUserSecond = controller.acquire({
    userId: 'same_user',
    lane: 'general',
    messageId: 'same_2',
    groupId: '',
    chatType: 'private'
  });

  let sameUserResolved = false;
  sameUserSecond.then(() => {
    sameUserResolved = true;
  });

  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.strictEqual(sameUserResolved, false, 'same user should remain serialized');

  sameUserFirst.release();
  const sameUserSecondLock = await sameUserSecond;
  sameUserSecondLock.release();

  console.log('foregroundConcurrency.test.js passed');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
