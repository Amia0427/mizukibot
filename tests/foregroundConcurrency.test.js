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

  const raceController = createForegroundConcurrencyController({
    globalLimit: 2,
    adminReservedSlots: 0,
    perUserLimit: 1
  });
  const raceFirst = await raceController.acquire({ userId: 'race_1', sessionKey: 'race_1', lane: 'general', messageId: 'r1' });
  const raceSecond = await raceController.acquire({ userId: 'race_2', sessionKey: 'race_2', lane: 'general', messageId: 'r2' });
  const raceQueuedA = raceController.acquire({ userId: 'race_3', sessionKey: 'race_3', lane: 'general', messageId: 'r3' });
  const raceQueuedB = raceController.acquire({ userId: 'race_4', sessionKey: 'race_4', lane: 'general', messageId: 'r4' });
  const resolvedDuringRelease = [];
  raceQueuedA.then((lock) => {
    resolvedDuringRelease.push(lock.requestId);
    raceSecond.release();
  });
  raceQueuedB.then((lock) => {
    resolvedDuringRelease.push(lock.requestId);
  });
  raceFirst.release();
  const raceLockA = await raceQueuedA;
  const raceLockB = await raceQueuedB;
  assert.strictEqual(raceController.getSnapshot().totalActive, 2, 'nested release during drain should fill available slots once');
  assert.strictEqual(resolvedDuringRelease.length, 2);
  raceLockA.release();
  raceLockB.release();
  assert.strictEqual(raceController.getSnapshot().totalActive, 0);

  console.log('foregroundConcurrency.test.js passed');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
